import { createPublicClient, fallback, http } from "viem";
import { bsc } from "viem/chains";
import {
  clAlphaHookAbi,
  erc20Abi,
  infinityCLQuoterAbi,
  infinityCLPoolManagerAbi,
  infinityInitializeEvent,
  v2FactoryAbi,
  v2PairAbi,
  v3FactoryAbi,
  v3PoolAbi
} from "./abis.js";
import { sameAddress, ZERO_ADDRESS } from "./config.js";
import {
  calculateV2ExactIn,
  quotePerTargetFromSqrtPrice,
  toDecimalAmount
} from "./math.js";
import { parseUnits } from "viem";

export function createBscClient(rpcUrl) {
  const rpcUrls = Array.isArray(rpcUrl) ? rpcUrl : [rpcUrl];
  return createPublicClient({
    chain: bsc,
    transport:
      rpcUrls.length > 1
        ? fallback(rpcUrls.map((url) => http(url, { timeout: 25_000 })))
        : http(rpcUrls[0], { timeout: 25_000 })
  });
}

export async function getTokenMeta(client, address) {
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: "name" }).catch(() => ""),
    client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address, abi: erc20Abi, functionName: "totalSupply" }).catch(() => 0n)
  ]);

  return { address, name, symbol, decimals: Number(decimals), totalSupply };
}

export async function getV2Status({ client, config, targetMeta, quoteMeta }) {
  if (!config.protocols.v2) return null;

  const pair = await client.readContract({
    address: config.addresses.pancakeV2Factory,
    abi: v2FactoryAbi,
    functionName: "getPair",
    args: [config.quoteToken, config.targetToken]
  });

  if (sameAddress(pair, ZERO_ADDRESS)) {
    return { protocol: "PancakeSwap V2", exists: false };
  }

  const [token0, token1, reserves, totalSupply] = await Promise.all([
    client.readContract({ address: pair, abi: v2PairAbi, functionName: "token0" }),
    client.readContract({ address: pair, abi: v2PairAbi, functionName: "token1" }),
    client.readContract({ address: pair, abi: v2PairAbi, functionName: "getReserves" }),
    client.readContract({ address: pair, abi: v2PairAbi, functionName: "totalSupply" })
  ]);

  const [reserve0, reserve1] = reserves;
  const quoteIs0 = sameAddress(token0, config.quoteToken);
  const reserveQuote = quoteIs0 ? reserve0 : reserve1;
  const reserveTarget = quoteIs0 ? reserve1 : reserve0;
  const price =
    reserveTarget === 0n
      ? null
      : toDecimalAmount(reserveQuote, quoteMeta.decimals).div(
          toDecimalAmount(reserveTarget, targetMeta.decimals)
        );

  const probes = [config.rules.probeSpendUsdt, config.rules.maxSpendUsdt].map((amountIn) => {
    const result = calculateV2ExactIn({
      amountIn,
      reserveIn: reserveQuote,
      reserveOut: reserveTarget,
      decimalsIn: quoteMeta.decimals,
      decimalsOut: targetMeta.decimals
    });
    return { amountIn, ...result };
  });

  return {
    protocol: "PancakeSwap V2",
    exists: true,
    pair,
    token0,
    token1,
    reserveQuote,
    reserveTarget,
    totalSupply,
    price,
    probes
  };
}

export async function getV3Statuses({ client, config, targetMeta, quoteMeta }) {
  const tiers = config.protocols.v3FeeTiers || [];
  const results = [];

  for (const fee of tiers) {
    const pool = await client.readContract({
      address: config.addresses.pancakeV3Factory,
      abi: v3FactoryAbi,
      functionName: "getPool",
      args: [config.quoteToken, config.targetToken, fee]
    });

    if (sameAddress(pool, ZERO_ADDRESS)) {
      results.push({ protocol: "PancakeSwap V3", fee, exists: false });
      continue;
    }

    const [token0, token1, liquidity, slot0] = await Promise.all([
      client.readContract({ address: pool, abi: v3PoolAbi, functionName: "token0" }),
      client.readContract({ address: pool, abi: v3PoolAbi, functionName: "token1" }),
      client.readContract({ address: pool, abi: v3PoolAbi, functionName: "liquidity" }),
      client.readContract({ address: pool, abi: v3PoolAbi, functionName: "slot0" })
    ]);

    const token0Decimals = sameAddress(token0, targetMeta.address)
      ? targetMeta.decimals
      : quoteMeta.decimals;
    const token1Decimals = sameAddress(token1, targetMeta.address)
      ? targetMeta.decimals
      : quoteMeta.decimals;
    const price = quotePerTargetFromSqrtPrice({
      sqrtPriceX96: slot0[0],
      token0,
      token1,
      token0Decimals,
      token1Decimals,
      targetToken: config.targetToken,
      quoteToken: config.quoteToken
    });

    results.push({
      protocol: "PancakeSwap V3",
      fee,
      exists: true,
      pool,
      token0,
      token1,
      liquidity,
      sqrtPriceX96: slot0[0],
      tick: slot0[1],
      price
    });
  }

  return results;
}

async function getLogsChunked({ client, address, event, args, fromBlock, toBlock, chunkSize = 5000n }) {
  const latest = toBlock === "latest" ? await client.getBlockNumber() : BigInt(toBlock);
  const start = BigInt(fromBlock);
  const logs = [];

  for (let cursor = start; cursor <= latest; cursor += chunkSize + 1n) {
    const end = cursor + chunkSize > latest ? latest : cursor + chunkSize;
    const page = await client.getLogs({
      address,
      event,
      args,
      fromBlock: cursor,
      toBlock: end
    });
    logs.push(...page);
  }

  return logs;
}

export async function getInfinityCLStatus({ client, config, targetMeta, quoteMeta }) {
  const poolConfig = config.protocols.infinityCL;
  if (!poolConfig?.enabled) return null;

  let poolKey = null;
  let poolKeyError = null;
  try {
    poolKey = await client.readContract({
      address: config.addresses.infinityCLPoolManager,
      abi: infinityCLPoolManagerAbi,
      functionName: "poolIdToPoolKey",
      args: [poolConfig.poolId]
    });
  } catch (error) {
    poolKeyError = error;
  }

  let logs = [];
  let logError = null;
  if (!poolKey && poolConfig.scanInitializeLogs) {
    try {
      logs = await getLogsChunked({
        client,
        address: config.addresses.infinityCLPoolManager,
        event: infinityInitializeEvent,
        args: { id: poolConfig.poolId },
        fromBlock: BigInt(poolConfig.fromBlock || 0),
        toBlock: "latest",
        chunkSize: BigInt(poolConfig.logChunkSize || 10000)
      });
    } catch (error) {
      logError = error;
    }
  }

  if (!poolKey && logs.length === 0 && (!poolConfig.currency0 || !poolConfig.currency1)) {
    return {
      protocol: "PancakeSwap Infinity CL",
      exists: false,
      poolId: poolConfig.poolId,
      error: poolKeyError || logError
    };
  }

  const initializeLog = logs.length > 0 ? logs[logs.length - 1] : null;
  const args = initializeLog?.args || {
    currency0: poolKey?.[0] || poolConfig.currency0,
    currency1: poolKey?.[1] || poolConfig.currency1,
    hooks: poolKey?.[2] || poolConfig.expectedHook,
    poolManager: poolKey?.[3] || config.addresses.infinityCLPoolManager,
    fee: poolKey?.[4] ?? null,
    parameters: poolKey?.[5] || poolConfig.parameters || null
  };
  const [slot0, liquidity] = await Promise.all([
    client.readContract({
      address: config.addresses.infinityCLPoolManager,
      abi: infinityCLPoolManagerAbi,
      functionName: "getSlot0",
      args: [poolConfig.poolId]
    }),
    client.readContract({
      address: config.addresses.infinityCLPoolManager,
      abi: infinityCLPoolManagerAbi,
      functionName: "getLiquidity",
      args: [poolConfig.poolId]
    })
  ]);

  const token0 = args.currency0;
  const token1 = args.currency1;
  const token0Decimals = sameAddress(token0, targetMeta.address)
    ? targetMeta.decimals
    : quoteMeta.decimals;
  const token1Decimals = sameAddress(token1, targetMeta.address)
    ? targetMeta.decimals
    : quoteMeta.decimals;
  const price = quotePerTargetFromSqrtPrice({
    sqrtPriceX96: slot0[0],
    token0,
    token1,
    token0Decimals,
    token1Decimals,
    targetToken: config.targetToken,
    quoteToken: config.quoteToken
  });
  const hookStatus = await getCLAlphaHookStatus({
    client,
    hook: args.hooks,
    poolId: poolConfig.poolId
  });
  const quotes = hookStatus?.started
    ? await getInfinityCLQuoteProbes({
        client,
        config,
        poolKey: [
          args.currency0,
          args.currency1,
          args.hooks,
          args.poolManager || config.addresses.infinityCLPoolManager,
          args.fee,
          args.parameters
        ],
        zeroForOne: sameAddress(args.currency0, config.quoteToken),
        quoteMeta,
        targetMeta
      })
    : [];

  return {
    protocol: "PancakeSwap Infinity CL",
    exists: true,
    poolId: poolConfig.poolId,
    expectedHook: poolConfig.expectedHook,
    initializeBlock: initializeLog?.blockNumber || null,
    initializeTx: initializeLog?.transactionHash || null,
    logSource: initializeLog ? "rpc-log" : poolKey ? "poolKey" : "config-fallback",
    logError,
    poolKeyError,
    token0,
    token1,
    hook: args.hooks,
    hookStatus,
    fee: args.fee,
    parameters: args.parameters,
    sqrtPriceX96: slot0[0],
    tick: slot0[1],
    protocolFee: slot0[2],
    lpFee: slot0[3],
    liquidity,
    price,
    quotes
  };
}

async function getCLAlphaHookStatus({ client, hook, poolId }) {
  try {
    const [startedTimestamp, enabled, started, owner, block] = await Promise.all([
      client.readContract({
        address: hook,
        abi: clAlphaHookAbi,
        functionName: "poolStartedTimestamp",
        args: [poolId]
      }),
      client.readContract({
        address: hook,
        abi: clAlphaHookAbi,
        functionName: "isPoolEnabled",
        args: [poolId]
      }),
      client.readContract({
        address: hook,
        abi: clAlphaHookAbi,
        functionName: "isPoolStarted",
        args: [poolId]
      }),
      client.readContract({ address: hook, abi: clAlphaHookAbi, functionName: "owner" }),
      client.getBlock()
    ]);

    return {
      enabled,
      started,
      owner,
      startedTimestamp,
      blockTimestamp: block.timestamp
    };
  } catch (error) {
    return { error: summarizeContractError(error) };
  }
}

export async function quoteInfinityCLExactInputSingle({
  client,
  quoter,
  poolKey,
  zeroForOne,
  exactAmount
}) {
  return client.readContract({
    address: quoter,
    abi: infinityCLQuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [[poolKey, zeroForOne, exactAmount, "0x"]]
  });
}

async function getInfinityCLQuoteProbes({ client, config, poolKey, zeroForOne, quoteMeta, targetMeta }) {
  if (!poolKey?.[4] || !poolKey?.[5]) return [];
  const amounts = config.quoteProbeAmountsUsdt || [
    config.rules.probeSpendUsdt,
    config.rules.maxSpendUsdt
  ];

  const results = [];
  for (const amountIn of amounts) {
    try {
      const exactAmount = parseUnits(String(amountIn), quoteMeta.decimals);
      const [amountOut, gasEstimate] = await quoteInfinityCLExactInputSingle({
        client,
        quoter: config.addresses.infinityCLQuoter,
        poolKey,
        zeroForOne,
        exactAmount
      });
      const amountOutHuman = toDecimalAmount(amountOut, targetMeta.decimals);
      const avgPrice = amountOutHuman.isZero()
        ? null
        : toDecimalAmount(exactAmount, quoteMeta.decimals).div(amountOutHuman);
      results.push({
        ok: true,
        amountIn,
        amountOut,
        amountOutHuman,
        avgPrice,
        gasEstimate
      });
    } catch (error) {
      results.push({
        ok: false,
        amountIn,
        error: summarizeContractError(error)
      });
    }
  }

  return results;
}

export function summarizeContractError(error) {
  const signature = error?.cause?.signature || error?.signature;
  const shortMessage = error?.shortMessage || error?.message || "unknown error";
  const data = error?.cause?.raw || error?.cause?.data?.data || error?.cause?.data || error?.data;
  return {
    signature,
    shortMessage,
    data: typeof data === "string" ? data.slice(0, 74) : undefined
  };
}
