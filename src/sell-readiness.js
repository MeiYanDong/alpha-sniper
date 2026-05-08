import { formatEther, parseUnits } from "viem";
import { erc20Abi, infinityCLPoolManagerAbi, permit2Abi, universalRouterAbi } from "./abis.js";
import { loadConfigFromArgs, sameAddress } from "./config.js";
import { applySlippageBps, buildInfinityExactInputSingleExecute } from "./infinity-swap.js";
import {
  createBscClient,
  getInfinityCLStatus,
  getTokenMeta,
  quoteInfinityCLExactInputSingle,
  summarizeContractError
} from "./pools.js";
import { fmtDecimal, toDecimalAmount } from "./math.js";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sellAmountFromArgs({ balance, decimals }) {
  const amount = argValue("--amount-share");
  if (amount) return parseUnits(amount, decimals);

  const bps = BigInt(argValue("--sell-bps") || "10000");
  return (balance * bps) / 10000n;
}

function formatPermit2Allowance(allowance, now) {
  const [amount, expiration, nonce] = allowance;
  const expiresAt = Number(expiration);
  return {
    amount,
    expiration,
    nonce,
    expired: expiresAt === 0 || expiresAt <= now
  };
}

function formatPermit2Expiration(permit2Allowance) {
  if (permit2Allowance.expired) return " (expired/missing)";
  const expiresAt = Number(permit2Allowance.expiration);
  const maxDateSeconds = Math.floor(8640000000000000 / 1000);
  if (expiresAt > maxDateSeconds) return " (expires far future)";
  return ` (expires ${new Date(expiresAt * 1000).toISOString()})`;
}

async function main() {
  const config = loadConfigFromArgs();
  const owner = process.env.WALLET_ADDRESS;
  if (!owner || owner === "0xYourBurnerWalletAddress") {
    throw new Error("Set WALLET_ADDRESS in .env.local to your burner wallet address.");
  }

  const client = createBscClient(config.rpcUrls);
  const [targetMeta, quoteMeta, bnbBalance, block] = await Promise.all([
    getTokenMeta(client, config.targetToken),
    getTokenMeta(client, config.quoteToken),
    client.getBalance({ address: owner }),
    client.getBlock()
  ]);

  const [targetBalance, poolKey, infinity] = await Promise.all([
    client.readContract({
      address: config.targetToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner]
    }),
    client.readContract({
      address: config.addresses.infinityCLPoolManager,
      abi: infinityCLPoolManagerAbi,
      functionName: "poolIdToPoolKey",
      args: [config.protocols.infinityCL.poolId]
    }),
    getInfinityCLStatus({ client, config, targetMeta, quoteMeta })
  ]);

  const sellAmount = sellAmountFromArgs({ balance: targetBalance, decimals: targetMeta.decimals });
  const zeroForOne = sameAddress(poolKey[0], config.targetToken);
  const [erc20Allowance, rawPermit2Allowance] = await Promise.all([
    client.readContract({
      address: config.targetToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, config.addresses.permit2]
    }),
    client.readContract({
      address: config.addresses.permit2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [owner, config.targetToken, config.addresses.infinityUniversalRouter]
    })
  ]);
  const permit2Allowance = formatPermit2Allowance(rawPermit2Allowance, Number(block.timestamp));

  console.log(`${config.name} sell readiness`);
  console.log(`Wallet: ${owner}`);
  console.log(`BNB: ${formatEther(bnbBalance)}`);
  console.log(`${targetMeta.symbol}: ${fmtDecimal(toDecimalAmount(targetBalance, targetMeta.decimals), 8)}`);
  console.log(`Planned sell amount: ${fmtDecimal(toDecimalAmount(sellAmount, targetMeta.decimals), 8)} ${targetMeta.symbol}`);
  console.log(`ERC20 allowance to Permit2: ${fmtDecimal(toDecimalAmount(erc20Allowance, targetMeta.decimals), 8)} ${targetMeta.symbol}`);
  console.log(
    `Permit2 allowance to Universal Router: ${fmtDecimal(toDecimalAmount(permit2Allowance.amount, targetMeta.decimals), 8)} ${targetMeta.symbol}${formatPermit2Expiration(permit2Allowance)}`
  );
  console.log(`Trading started: ${Boolean(infinity.hookStatus?.started)}`);

  if (targetBalance === 0n || sellAmount === 0n) {
    console.log("Decision: WAIT - no SHARE position to sell.");
    console.log("Mode: READ_ONLY. No transaction sending.");
    return;
  }
  if (sellAmount > targetBalance) {
    console.log("Decision: SKIP - planned sell amount is above wallet balance.");
    console.log("Mode: READ_ONLY. No transaction sending.");
    return;
  }
  if (!infinity.hookStatus?.started) {
    console.log("Decision: WAIT - hook has not opened trading yet.");
    console.log("Mode: READ_ONLY. No transaction sending.");
    return;
  }

  let quote;
  try {
    const started = performance.now();
    const [amountOut, gasEstimate] = await quoteInfinityCLExactInputSingle({
      client,
      quoter: config.addresses.infinityCLQuoter,
      poolKey,
      zeroForOne,
      exactAmount: sellAmount
    });
    quote = {
      ok: true,
      amountOut,
      gasEstimate,
      latencyMs: performance.now() - started
    };
  } catch (error) {
    quote = { ok: false, error: summarizeContractError(error) };
  }

  if (!quote.ok) {
    console.log(`Sell quote: failed (${quote.error.signature || "no signature"}) ${quote.error.shortMessage}`);
    console.log("Decision: SKIP - sell quote failed.");
    console.log("Mode: READ_ONLY. No transaction sending.");
    return;
  }

  const amountOutHuman = toDecimalAmount(quote.amountOut, quoteMeta.decimals);
  const amountInHuman = toDecimalAmount(sellAmount, targetMeta.decimals);
  const avgExitPrice = amountInHuman.isZero() ? null : amountOutHuman.div(amountInHuman);
  const minOut = applySlippageBps(quote.amountOut, config.exit?.maxSlippageBps || config.execution?.maxSlippageBps || 500);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60);
  const tx = buildInfinityExactInputSingleExecute({
    poolKey,
    zeroForOne,
    amountIn: sellAmount,
    amountOutMinimum: minOut,
    inputCurrency: config.targetToken,
    outputCurrency: config.quoteToken,
    deadline
  });

  console.log(
    `Sell quote: ${fmtDecimal(amountInHuman, 8)} ${targetMeta.symbol} -> ${fmtDecimal(amountOutHuman, 8)} ${quoteMeta.symbol}, avg ${fmtDecimal(avgExitPrice, 8)} ${quoteMeta.symbol}/${targetMeta.symbol}, latency ${quote.latencyMs.toFixed(0)}ms`
  );
  console.log(`Min out with slippage guard: ${fmtDecimal(toDecimalAmount(minOut, quoteMeta.decimals), 8)} ${quoteMeta.symbol}`);

  const approvalsOk =
    erc20Allowance >= sellAmount &&
    permit2Allowance.amount >= sellAmount &&
    !permit2Allowance.expired;
  if (!approvalsOk) {
    console.log("Simulation: skipped - SHARE needs ERC20->Permit2 approval and Permit2->UniversalRouter allowance first.");
    console.log("Decision: SKIP - approval missing.");
    console.log("Mode: READ_ONLY. No transaction sending.");
    return;
  }

  try {
    const gas = await client.estimateContractGas({
      account: owner,
      address: config.addresses.infinityUniversalRouter,
      abi: universalRouterAbi,
      functionName: "execute",
      args: [tx.commands, tx.inputs, tx.deadline]
    });
    console.log(`Simulation: gas estimate ${gas.toString()}`);
    console.log("Decision: SELL_READY - quote, approvals, and gas estimate passed.");
  } catch (error) {
    const summary = summarizeContractError(error);
    console.log(`Simulation: failed (${summary.signature || "no signature"}) ${summary.shortMessage}`);
    console.log("Decision: SKIP - sell simulation failed.");
  }

  console.log("Mode: READ_ONLY. No transaction sending.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
