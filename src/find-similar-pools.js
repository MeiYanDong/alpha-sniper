import { parseUnits } from "viem";
import { clAlphaHookAbi, infinityCLPoolManagerAbi, infinityInitializeEvent } from "./abis.js";
import { loadConfigFromArgs, sameAddress, ZERO_ADDRESS } from "./config.js";
import {
  createBscClient,
  getTokenMeta,
  quoteInfinityCLExactInputSingle,
  summarizeContractError
} from "./pools.js";
import { fmtDecimal, toDecimalAmount } from "./math.js";

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function getLogsChunked({ client, config, argName, fromBlock, toBlock, chunkSize }) {
  const logs = [];
  for (let cursor = fromBlock; cursor <= toBlock; cursor += chunkSize + 1n) {
    const end = cursor + chunkSize > toBlock ? toBlock : cursor + chunkSize;
    const page = await client.getLogs({
      address: config.addresses.infinityCLPoolManager,
      event: infinityInitializeEvent,
      args: { [argName]: config.quoteToken },
      fromBlock: cursor,
      toBlock: end
    });
    logs.push(...page);
  }
  return logs;
}

async function hookStarted(client, hook, poolId) {
  if (sameAddress(hook, ZERO_ADDRESS)) return true;
  try {
    return await client.readContract({
      address: hook,
      abi: clAlphaHookAbi,
      functionName: "isPoolStarted",
      args: [poolId]
    });
  } catch {
    return false;
  }
}

async function probeCandidate({ client, config, quoteMeta, log, amountUsdt }) {
  const args = log.args;
  const poolId = args.id;
  const token = sameAddress(args.currency0, config.quoteToken) ? args.currency1 : args.currency0;
  const tokenMeta = await getTokenMeta(client, token);
  const [slot0, liquidity, started] = await Promise.all([
    client.readContract({
      address: config.addresses.infinityCLPoolManager,
      abi: infinityCLPoolManagerAbi,
      functionName: "getSlot0",
      args: [poolId]
    }),
    client.readContract({
      address: config.addresses.infinityCLPoolManager,
      abi: infinityCLPoolManagerAbi,
      functionName: "getLiquidity",
      args: [poolId]
    }),
    hookStarted(client, args.hooks, poolId)
  ]);

  if (liquidity === 0n || !started) return null;

  const poolKey = [
    args.currency0,
    args.currency1,
    args.hooks,
    config.addresses.infinityCLPoolManager,
    args.fee,
    args.parameters
  ];
  const buyZeroForOne = sameAddress(args.currency0, config.quoteToken);
  const sellZeroForOne = sameAddress(args.currency0, token);
  const amountIn = parseUnits(amountUsdt, quoteMeta.decimals);

  const buyStart = performance.now();
  const [buyOut, buyGas] = await quoteInfinityCLExactInputSingle({
    client,
    quoter: config.addresses.infinityCLQuoter,
    poolKey,
    zeroForOne: buyZeroForOne,
    exactAmount: amountIn
  });
  const buyLatencyMs = performance.now() - buyStart;

  const sellStart = performance.now();
  const [sellOut, sellGas] = await quoteInfinityCLExactInputSingle({
    client,
    quoter: config.addresses.infinityCLQuoter,
    poolKey,
    zeroForOne: sellZeroForOne,
    exactAmount: buyOut
  });
  const sellLatencyMs = performance.now() - sellStart;

  const buyOutHuman = toDecimalAmount(buyOut, tokenMeta.decimals);
  const sellOutHuman = toDecimalAmount(sellOut, quoteMeta.decimals);
  const amountInHuman = toDecimalAmount(amountIn, quoteMeta.decimals);
  const avgBuy = buyOutHuman.isZero() ? null : amountInHuman.div(buyOutHuman);
  const avgSell = buyOutHuman.isZero() ? null : sellOutHuman.div(buyOutHuman);
  const roundTripLossPct = amountInHuman.isZero()
    ? null
    : amountInHuman.minus(sellOutHuman).div(amountInHuman).mul(100);

  return {
    poolId,
    token,
    symbol: tokenMeta.symbol,
    hook: args.hooks,
    blockNumber: log.blockNumber,
    tx: log.transactionHash,
    fee: args.fee,
    tick: slot0[1],
    liquidity,
    amountUsdt,
    buyOutHuman,
    sellOutHuman,
    avgBuy,
    avgSell,
    roundTripLossPct,
    buyGas,
    sellGas,
    buyLatencyMs,
    sellLatencyMs
  };
}

async function main() {
  const config = loadConfigFromArgs();
  const client = createBscClient(config.rpcUrls);
  const latest = await client.getBlockNumber();
  const blocks = BigInt(argValue("--blocks", "300000"));
  const chunkSize = BigInt(argValue("--chunk-size", "5000"));
  const amountUsdt = argValue("--amount-usdt", "1");
  const limit = Number(argValue("--limit", "5"));
  const maxFee = argValue("--max-fee");
  const minLiquidity = BigInt(argValue("--min-liquidity", "0"));
  const includeHooks = process.argv.includes("--include-hooks");
  const sameHookOnly = process.argv.includes("--same-hook");
  const fromBlock = latest > blocks ? latest - blocks : 0n;
  const quoteMeta = await getTokenMeta(client, config.quoteToken);

  console.log(`${config.name} similar Infinity CL pool test`);
  console.log(`Scan: blocks ${fromBlock.toString()} -> ${latest.toString()}, amount ${amountUsdt} ${quoteMeta.symbol}`);
  console.log(`Hook filter: ${sameHookOnly ? "same hook" : includeHooks ? "include hooks" : "no-hook only"}`);
  if (maxFee) console.log(`Max fee filter: ${maxFee}`);
  if (minLiquidity > 0n) console.log(`Min liquidity filter: ${minLiquidity.toString()}`);

  const [currency0Logs, currency1Logs] = await Promise.all([
    getLogsChunked({ client, config, argName: "currency0", fromBlock, toBlock: latest, chunkSize }),
    getLogsChunked({ client, config, argName: "currency1", fromBlock, toBlock: latest, chunkSize })
  ]);

  const byId = new Map();
  for (const log of [...currency0Logs, ...currency1Logs]) {
    byId.set(log.args.id, log);
  }
  const logs = [...byId.values()].reverse();
  const candidates = [];

  for (const log of logs) {
    if (sameAddress(log.args.id, config.protocols.infinityCL.poolId)) continue;
    if (sameHookOnly && !sameAddress(log.args.hooks, config.protocols.infinityCL.expectedHook)) continue;
    if (!includeHooks && !sameHookOnly && !sameAddress(log.args.hooks, ZERO_ADDRESS)) continue;
    if (maxFee && BigInt(log.args.fee) > BigInt(maxFee)) continue;

    try {
      const result = await probeCandidate({ client, config, quoteMeta, log, amountUsdt });
      if (result && result.liquidity < minLiquidity) continue;
      if (result) candidates.push(result);
    } catch (error) {
      if (process.argv.includes("--verbose")) {
        const summary = summarizeContractError(error);
        console.log(`skip ${log.args.id}: ${summary.shortMessage}`);
      }
    }

    if (candidates.length >= limit) break;
  }

  if (candidates.length === 0) {
    console.log("No usable live pool found in this scan window. Try --include-hooks or a larger --blocks value.");
    return;
  }

  for (const item of candidates) {
    console.log("");
    console.log(`${item.symbol}/USDT Infinity CL`);
    console.log(`- poolId: ${item.poolId}`);
    console.log(`- token: ${item.token}`);
    console.log(`- hook: ${item.hook}`);
    console.log(`- block: ${item.blockNumber.toString()}, fee: ${item.fee}, liquidity: ${item.liquidity.toString()}, tick: ${item.tick}`);
    console.log(
      `- buy quote: ${item.amountUsdt} ${quoteMeta.symbol} -> ${fmtDecimal(item.buyOutHuman, 8)} ${item.symbol}, avg ${fmtDecimal(item.avgBuy, 8)}, gas ${item.buyGas.toString()}, latency ${item.buyLatencyMs.toFixed(0)}ms`
    );
    console.log(
      `- sell quote: ${fmtDecimal(item.buyOutHuman, 8)} ${item.symbol} -> ${fmtDecimal(item.sellOutHuman, 8)} ${quoteMeta.symbol}, avg ${fmtDecimal(item.avgSell, 8)}, gas ${item.sellGas.toString()}, latency ${item.sellLatencyMs.toFixed(0)}ms`
    );
    console.log(`- roundtrip quote loss: ${fmtDecimal(item.roundTripLossPct, 4)}%`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
