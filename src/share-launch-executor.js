import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Decimal from "decimal.js";
import { createWalletClient, formatEther, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import {
  clAlphaHookAbi,
  erc20Abi,
  infinityCLPoolManagerAbi,
  permit2Abi,
  universalRouterAbi
} from "./abis.js";
import { loadConfigFromArgs, sameAddress } from "./config.js";
import { getExecutionConfig } from "./decision.js";
import { applySlippageBps, buildInfinityExactInputSingleExecute } from "./infinity-swap.js";
import { fmtDecimal, toDecimalAmount } from "./math.js";
import { createProjectCache, getCachedPoolKey, getCachedTokenMeta } from "./project-cache.js";
import { ensureExitApproval, runExitWatcher } from "./exit-watch.js";
import {
  createBscClient,
  getTokenMeta,
  quoteInfinityCLExactInputSingle,
  summarizeContractError
} from "./pools.js";
import {
  classifyRpcError,
  filterRpcProviders,
  getSafeRpcProviders,
  rawRpcCall
} from "./rpc-providers.js";
import { createRaceReadClient, DEFAULT_RPC_RACE_LABELS } from "./rpc-race.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const INCLUSIVE_PRICE_EPSILON = new Decimal("0.000000000001");
let activeLogger = null;

function serialize(value) {
  return JSON.stringify(value, (_, current) => {
    if (typeof current === "bigint") return current.toString();
    if (current && current.constructor?.name === "Decimal") return current.toString();
    return current;
  });
}

export function createRunLogger(config) {
  const outDir = path.resolve(process.cwd(), "data/runs");
  fs.mkdirSync(outDir, { recursive: true });
  const slug = config.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const outPath = path.join(outDir, `${slug || "launch"}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  return {
    outPath,
    event(name, fields = {}) {
      fs.appendFileSync(outPath, `${serialize({ ts: new Date().toISOString(), event: name, ...fields })}\n`);
    }
  };
}

function argValueFrom(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function argValue(name, fallback) {
  return argValueFrom(process.argv, name, fallback);
}

function hasFlag(name, argv = process.argv) {
  return argv.includes(name);
}

function shouldUseRpcRace({ fastLaunch, argv, quoteFn }) {
  if (hasFlag("--no-rpc-race", argv)) return false;
  if (quoteFn !== quoteInfinityCLExactInputSingle) return false;
  return fastLaunch || hasFlag("--rpc-race", argv);
}

function shortErrorMessage(error) {
  return error?.shortMessage || error?.message || String(error);
}

function parseGweiArg(argv, name) {
  const value = argValueFrom(argv, name, null);
  return value === null || value === undefined ? null : parseUnits(String(value), 9);
}

function maxBigInt(a, b) {
  return a > b ? a : b;
}

function minBigInt(a, b) {
  return a < b ? a : b;
}

function loadAccount() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY is missing in .env.local");
  return privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
}

async function readPermit2Allowance({ client, owner, token, permit2, router }) {
  const [erc20Allowance, [permit2Amount, expiration]] = await Promise.all([
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, permit2]
    }),
    client.readContract({
      address: permit2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [owner, token, router]
    })
  ]);
  return {
    erc20Allowance,
    permit2Amount,
    permit2Expired: Number(expiration) <= Math.floor(Date.now() / 1000)
  };
}

async function isPoolStarted(client, hook, poolId) {
  return client.readContract({
    address: hook,
    abi: clAlphaHookAbi,
    functionName: "isPoolStarted",
    args: [poolId]
  });
}

function quoteToAvg({ amountIn, amountOut, quoteDecimals, targetDecimals }) {
  const outHuman = toDecimalAmount(amountOut, targetDecimals);
  if (outHuman.isZero()) return null;
  return toDecimalAmount(amountIn, quoteDecimals).div(outHuman);
}

function tierMatchesAvg(avg, tier) {
  if (!avg) return false;
  if (tier.avgPriceLtUsd !== undefined && !avg.lt(tier.avgPriceLtUsd)) return false;
  if (
    tier.avgPriceLteUsd !== undefined &&
    avg.gt(new Decimal(String(tier.avgPriceLteUsd)).plus(INCLUSIVE_PRICE_EPSILON))
  ) {
    return false;
  }
  if (tier.avgPriceGtUsd !== undefined && !avg.gt(tier.avgPriceGtUsd)) return false;
  if (
    tier.avgPriceGteUsd !== undefined &&
    avg.lt(new Decimal(String(tier.avgPriceGteUsd)).minus(INCLUSIVE_PRICE_EPSILON))
  ) {
    return false;
  }
  return true;
}

function sortedTiers(execution) {
  return [...execution.autoBuyTiers].sort(
    (a, b) => Number(b.amountInUsdt) - Number(a.amountInUsdt)
  );
}

function tierMaxAvgPriceUsd(tier) {
  return tier.firstBlockMaxAvgPriceUsd || tier.avgPriceLteUsd || tier.avgPriceLtUsd || null;
}

function selectFirstBlockTier({ execution, argv }) {
  const requested = argValueFrom(argv, "--first-block-tier", null);
  if (requested) {
    const tier = execution.autoBuyTiers.find((item) => item.name === requested);
    if (!tier) throw new Error(`Unknown first-block tier: ${requested}`);
    return tier;
  }

  const candidates = execution.autoBuyTiers
    .filter((tier) => tierMaxAvgPriceUsd(tier))
    .sort((a, b) => {
      const priceDelta = new Decimal(String(tierMaxAvgPriceUsd(b))).cmp(
        new Decimal(String(tierMaxAvgPriceUsd(a)))
      );
      if (priceDelta !== 0) return priceDelta;
      return new Decimal(String(b.amountInUsdt)).cmp(new Decimal(String(a.amountInUsdt)));
    });
  if (candidates.length === 0) throw new Error("No first-block tier has a max average price");
  return candidates[0];
}

function minOutFromMaxAvgPrice({ amountIn, maxAvgPriceUsd, quoteDecimals, targetDecimals }) {
  const quoteHuman = toDecimalAmount(amountIn, quoteDecimals);
  const minTargetHuman = quoteHuman.div(new Decimal(String(maxAvgPriceUsd)));
  return parseUnits(minTargetHuman.toFixed(targetDecimals, Decimal.ROUND_FLOOR), targetDecimals);
}

async function preflight({ client, account, config, quoteMeta, targetMeta, execution }) {
  const maxSpend = parseUnits(execution.maxSpendUsdt, quoteMeta.decimals);
  const [bnb, quoteBalance, targetBalance, allowance] = await Promise.all([
    client.getBalance({ address: account.address }),
    client.readContract({
      address: config.quoteToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address]
    }),
    client.readContract({
      address: config.targetToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address]
    }),
    readPermit2Allowance({
      client,
      owner: account.address,
      token: config.quoteToken,
      permit2: config.addresses.permit2,
      router: config.addresses.infinityUniversalRouter
    })
  ]);

  console.log(`Wallet: ${account.address}`);
  console.log(`BNB: ${formatEther(bnb)}`);
  console.log(`${quoteMeta.symbol}: ${fmtDecimal(toDecimalAmount(quoteBalance, quoteMeta.decimals), 8)}`);
  console.log(`${targetMeta.symbol}: ${fmtDecimal(toDecimalAmount(targetBalance, targetMeta.decimals), 8)}`);
  console.log(`Max spend: ${fmtDecimal(toDecimalAmount(maxSpend, quoteMeta.decimals), 8)} ${quoteMeta.symbol}`);
  console.log(`ERC20 -> Permit2: ${fmtDecimal(toDecimalAmount(allowance.erc20Allowance, quoteMeta.decimals), 8)} ${quoteMeta.symbol}`);
  console.log(`Permit2 -> Router: ${fmtDecimal(toDecimalAmount(allowance.permit2Amount, quoteMeta.decimals), 8)} ${quoteMeta.symbol}${allowance.permit2Expired ? " (expired)" : ""}`);

  if (quoteBalance < maxSpend) throw new Error("USDT balance is below max spend");
  if (allowance.erc20Allowance < maxSpend) throw new Error("ERC20 approval to Permit2 is below max spend");
  if (allowance.permit2Amount < maxSpend || allowance.permit2Expired) {
    throw new Error("Permit2 approval to Universal Router is below max spend or expired");
  }

  return { bnb, quoteBalance, targetBalance, allowance, maxSpend };
}

async function waitForLaunch({
  client,
  config,
  poolKey,
  logger,
  argv = process.argv,
  nowFn = Date.now,
  sleepFn = sleep
}) {
  const launchAt = new Date(config.launchTime).getTime();
  const warmupMs = Number(argValueFrom(argv, "--warmup-ms", "600000"));
  const pollMs = Number(argValueFrom(argv, "--poll-ms", "250"));
  const slowPollMs = Number(argValueFrom(argv, "--slow-poll-ms", "5000"));
  const deadline = Number(argValueFrom(argv, "--give-up-ms-after-launch", "30000"));
  const poolId = config.protocols.infinityCL.poolId;
  const hook = poolKey[2];

  while (nowFn() < launchAt - warmupMs) {
    const remainingMs = launchAt - nowFn();
    console.log(`Prewarm pending: launch in ${Math.ceil(remainingMs / 1000)}s`);
    await sleepFn(Math.min(slowPollMs, Math.max(1000, remainingMs - warmupMs)));
  }

  console.log(`Prewarm active: polling hook every ${pollMs}ms`);
  logger.event("prewarm_active", { pollMs, launchAt: new Date(launchAt).toISOString() });
  const giveUpAt = launchAt + deadline;
  let nextPollAt = nowFn();
  let polls = 0;
  while (nowFn() <= giveUpAt) {
    const pollStartedAt = performance.now();
    try {
      polls += 1;
      if (await isPoolStarted(client, hook, poolId)) {
        const startedAt = nowFn();
        logger.event("hook_started", {
          polls,
          msFromLaunch: startedAt - launchAt,
          pollLatencyMs: Math.round(performance.now() - pollStartedAt)
        });
        return true;
      }
    } catch (error) {
      const summary = summarizeContractError(error);
      console.log(`Hook poll failed: ${summary.shortMessage}`);
      logger.event("hook_poll_failed", { message: summary.shortMessage, signature: summary.signature });
    }
    nextPollAt += pollMs;
    await sleepFn(Math.max(0, nextPollAt - nowFn()));
  }

  logger.event("hook_give_up", { polls, giveUpAt: new Date(giveUpAt).toISOString() });
  return false;
}

async function chooseTier({
  client,
  config,
  poolKey,
  execution,
  quoteMeta,
  targetMeta,
  quoteFn = quoteInfinityCLExactInputSingle,
  logQuotes = true
}) {
  const zeroForOne = sameAddress(poolKey[0], config.quoteToken);
  const tiers = sortedTiers(execution);
  const quoted = await Promise.all(
    tiers.map(async (tier) => {
      const amountIn = parseUnits(tier.amountInUsdt, quoteMeta.decimals);
      const quoteStart = performance.now();
      try {
        const [amountOut, quoteGas] = await quoteFn({
          client,
          quoter: config.addresses.infinityCLQuoter,
          poolKey,
          zeroForOne,
          exactAmount: amountIn
        });
        const latencyMs = performance.now() - quoteStart;
        const avg = quoteToAvg({
          amountIn,
          amountOut,
          quoteDecimals: quoteMeta.decimals,
          targetDecimals: targetMeta.decimals
        });
        return { ok: true, tier, amountIn, amountOut, avg, quoteGas, latencyMs, zeroForOne };
      } catch (error) {
        return { ok: false, tier, error: summarizeContractError(error) };
      }
    })
  );

  let sawQuoteOk = false;
  for (const result of quoted) {
    if (result.ok) sawQuoteOk = true;
  }
  if (logQuotes) printQuoteResults({ quoted, quoteMeta, targetMeta });

  for (const result of quoted) {
    if (result.ok && tierMatchesAvg(result.avg, result.tier)) {
      return { match: result, sawQuoteOk, quotes: quoted };
    }
  }

  return { match: null, sawQuoteOk, quotes: quoted };
}

function printQuoteResults({ quoted, quoteMeta, targetMeta }) {
  for (const result of quoted) {
    if (!result.ok) {
      console.log(`Tier ${result.tier.name}: quote failed ${result.error.shortMessage}`);
      continue;
    }
    console.log(
      `Tier ${result.tier.name}: ${result.tier.amountInUsdt} ${quoteMeta.symbol} -> ${fmtDecimal(toDecimalAmount(result.amountOut, targetMeta.decimals), 8)} ${targetMeta.symbol}, avg ${fmtDecimal(result.avg, 8)}, quoteGas ${result.quoteGas.toString()}, latency ${result.latencyMs.toFixed(0)}ms`
    );
  }
}

async function chooseTierWithRetry({
  client,
  config,
  poolKey,
  execution,
  quoteMeta,
  targetMeta,
  logger,
  argv = process.argv,
  nowFn = Date.now,
  sleepFn = sleep,
  quoteFn = quoteInfinityCLExactInputSingle
}) {
  const retryMs = Number(argValueFrom(argv, "--quote-retry-ms", "250"));
  const giveUpAt =
    new Date(config.launchTime).getTime() +
    Number(argValueFrom(argv, "--give-up-ms-after-launch", "30000"));
  let attempts = 0;
  let sawAnyQuoteOk = false;

  while (nowFn() <= giveUpAt) {
    attempts += 1;
    const startedAt = performance.now();
    const result = await chooseTier({
      client,
      config,
      poolKey,
      execution,
      quoteMeta,
      targetMeta,
      quoteFn
    });
    logger.event("quote_attempt", {
      attempts,
      latencyMs: Math.round(performance.now() - startedAt),
      sawQuoteOk: result.sawQuoteOk,
      quotes: result.quotes.map((item) =>
        item.ok
          ? {
              tier: item.tier.name,
              amountInUsdt: item.tier.amountInUsdt,
              amountOut: item.amountOut,
              avg: item.avg?.toString(),
              quoteGas: item.quoteGas,
              latencyMs: Math.round(item.latencyMs),
              matched: tierMatchesAvg(item.avg, item.tier)
            }
          : {
              tier: item.tier.name,
              amountInUsdt: item.tier.amountInUsdt,
              error: item.error
            }
      )
    });

    sawAnyQuoteOk ||= result.sawQuoteOk;
    if (result.match) return { match: result.match, reason: null, sawAnyQuoteOk };
    if (result.sawQuoteOk) {
      return {
        match: null,
        reason: "NO_AUTO_BUY_TIER_MATCHED",
        sawAnyQuoteOk
      };
    }
    await sleepFn(retryMs);
  }

  return {
    match: null,
    reason: sawAnyQuoteOk ? "NO_AUTO_BUY_TIER_MATCHED" : "QUOTE_FAILED",
    sawAnyQuoteOk
  };
}

function quoteAttemptPayload(result) {
  return result.quotes.map((item) =>
    item.ok
      ? {
          tier: item.tier.name,
          amountInUsdt: item.tier.amountInUsdt,
          amountOut: item.amountOut,
          avg: item.avg?.toString(),
          quoteGas: item.quoteGas,
          latencyMs: Math.round(item.latencyMs),
          matched: tierMatchesAvg(item.avg, item.tier)
        }
      : {
          tier: item.tier.name,
          amountInUsdt: item.tier.amountInUsdt,
          error: item.error
        }
  );
}

async function waitForFastLaunchChoice({
  client,
  config,
  poolKey,
  execution,
  quoteMeta,
  targetMeta,
  logger,
  argv = process.argv,
  nowFn = Date.now,
  sleepFn = sleep,
  quoteFn = quoteInfinityCLExactInputSingle
}) {
  const launchAt = new Date(config.launchTime).getTime();
  const warmupMs = Number(argValueFrom(argv, "--warmup-ms", "600000"));
  const pollMs = Number(argValueFrom(argv, "--poll-ms", "100"));
  const slowPollMs = Number(argValueFrom(argv, "--slow-poll-ms", "5000"));
  const sprintMs = Number(argValueFrom(argv, "--sprint-ms", "10000"));
  const sprintPollMs = Number(argValueFrom(argv, "--sprint-poll-ms", "50"));
  const quoteProbeLeadMs = Number(argValueFrom(argv, "--quote-probe-lead-ms", String(sprintMs)));
  const deadline = Number(argValueFrom(argv, "--give-up-ms-after-launch", "30000"));
  const poolId = config.protocols.infinityCL.poolId;
  const hook = poolKey[2];
  const giveUpAt = launchAt + deadline;
  let attempts = 0;
  let polls = 0;
  let sawAnyQuoteOk = false;
  let hookStarted = false;

  while (nowFn() < launchAt - warmupMs) {
    const remainingMs = launchAt - nowFn();
    console.log(`Fast prewarm pending: launch in ${Math.ceil(remainingMs / 1000)}s`);
    await sleepFn(Math.min(slowPollMs, Math.max(1000, remainingMs - warmupMs)));
  }

  console.log(
    `Fast prewarm active: hook ${pollMs}ms, sprint ${sprintPollMs}ms in last ${sprintMs}ms, quote probe lead ${quoteProbeLeadMs}ms`
  );
  logger.event("fast_prewarm_active", {
    pollMs,
    sprintMs,
    sprintPollMs,
    quoteProbeLeadMs,
    launchAt: new Date(launchAt).toISOString()
  });

  while (nowFn() <= giveUpAt) {
    attempts += 1;
    const loopStartedAt = performance.now();
    const loopNow = nowFn();
    const intervalMs = loopNow >= launchAt - sprintMs ? sprintPollMs : pollMs;
    const quoteEnabled = hookStarted || loopNow >= launchAt - quoteProbeLeadMs;

    polls += 1;
    const hookPromise = isPoolStarted(client, hook, poolId);
    const quotePromise = quoteEnabled
      ? chooseTier({
          client,
          config,
          poolKey,
          execution,
          quoteMeta,
          targetMeta,
          quoteFn,
          logQuotes: false
        })
      : null;

    const [hookResult, quoteResult] = await Promise.allSettled([
      hookPromise,
      quotePromise ?? Promise.resolve(null)
    ]);

    if (hookResult.status === "fulfilled" && hookResult.value) {
      if (!hookStarted) {
        logger.event("hook_started", {
          polls,
          msFromLaunch: nowFn() - launchAt,
          pollLatencyMs: Math.round(performance.now() - loopStartedAt)
        });
      }
      hookStarted = true;
    } else if (hookResult.status === "rejected") {
      const summary = summarizeContractError(hookResult.reason);
      logger.event("hook_poll_failed", { message: summary.shortMessage, signature: summary.signature });
    }

    if (quoteResult.status === "fulfilled" && quoteResult.value) {
      const result = quoteResult.value;
      sawAnyQuoteOk ||= result.sawQuoteOk;
      logger.event("fast_quote_probe", {
        attempts,
        hookStarted,
        intervalMs,
        latencyMs: Math.round(performance.now() - loopStartedAt),
        sawQuoteOk: result.sawQuoteOk,
        quotes: quoteAttemptPayload(result)
      });

      if (result.match) {
        printQuoteResults({ quoted: result.quotes, quoteMeta, targetMeta });
        logger.event("launch_triggered", {
          signal: hookStarted ? "hook_or_quote_match" : "quote_match",
          attempts,
          msFromLaunch: nowFn() - launchAt
        });
        return { match: result.match, reason: null, sawAnyQuoteOk, signal: "quote_match" };
      }

      if (result.sawQuoteOk) {
        printQuoteResults({ quoted: result.quotes, quoteMeta, targetMeta });
        return {
          match: null,
          reason: "NO_AUTO_BUY_TIER_MATCHED",
          sawAnyQuoteOk,
          signal: "quote_ok_no_match"
        };
      }
    } else if (quoteResult.status === "rejected") {
      const summary = summarizeContractError(quoteResult.reason);
      logger.event("fast_quote_probe_failed", {
        attempts,
        hookStarted,
        message: summary.shortMessage,
        signature: summary.signature
      });
    }

    await sleepFn(Math.max(0, intervalMs - Math.round(performance.now() - loopStartedAt)));
  }

  logger.event("fast_give_up", {
    attempts,
    polls,
    hookStarted,
    sawAnyQuoteOk,
    giveUpAt: new Date(giveUpAt).toISOString()
  });
  return {
    match: null,
    reason: hookStarted || sawAnyQuoteOk ? "QUOTE_FAILED" : "HOOK_NOT_STARTED",
    sawAnyQuoteOk,
    signal: null
  };
}

async function broadcastRawTransaction({ provider, serializedTransaction, timeoutMs }) {
  return rawRpcCall(provider.url, "eth_sendRawTransaction", [serializedTransaction], { timeoutMs });
}

async function resolveGasPrice({ client, argv, fastLaunch }) {
  const fixed = parseGweiArg(argv, "--gas-price-gwei-fixed");
  const floor = parseGweiArg(argv, "--gas-price-gwei-floor");
  const cap = parseGweiArg(argv, "--gas-price-gwei-cap");
  const multiplierBps = BigInt(
    argValueFrom(argv, "--gas-price-multiplier-bps", fastLaunch ? "20000" : "12000")
  );

  if (floor !== null && cap !== null && floor > cap) {
    throw new Error("--gas-price-gwei-floor cannot be greater than --gas-price-gwei-cap");
  }

  if (fixed !== null) {
    return {
      gasPrice: fixed,
      baseGasPrice: null,
      gasPriceMultiplierBps: multiplierBps,
      gasPriceFloor: floor,
      gasPriceCap: cap,
      gasPriceFixed: fixed
    };
  }

  const baseGasPrice = await client.getGasPrice();
  let gasPrice = (baseGasPrice * multiplierBps) / 10_000n;
  if (floor !== null) gasPrice = maxBigInt(gasPrice, floor);
  if (cap !== null) gasPrice = minBigInt(gasPrice, cap);

  return {
    gasPrice,
    baseGasPrice,
    gasPriceMultiplierBps: multiplierBps,
    gasPriceFloor: floor,
    gasPriceCap: cap,
    gasPriceFixed: null
  };
}

function getBroadcastProviders({ config, argv }) {
  const includePublic = hasFlag("--broadcast-public", argv);
  const labelsCsv = argValueFrom(argv, "--broadcast-labels", "");
  const providers = filterRpcProviders(getSafeRpcProviders(config, { includePublic }), labelsCsv);
  if (providers.length === 0) throw new Error("No RPC providers available for raw transaction broadcast");
  return providers;
}

async function signRawBuyTransaction({ config, account, client, tx, gas, gasPrice }) {
  if (typeof account.signTransaction !== "function") {
    throw new Error("Raw transaction broadcast requires a local account that can sign transactions");
  }

  const nonce = tx.nonce ?? (await client.getTransactionCount({ address: account.address, blockTag: "pending" }));
  const serializedTransaction = await account.signTransaction({
    chainId: Number(config.chainId || bsc.id),
    nonce,
    to: config.addresses.infinityUniversalRouter,
    data: tx.calldata,
    gas,
    gasPrice,
    value: 0n,
    type: "legacy"
  });

  return { serializedTransaction, nonce };
}

function resolveReplacementGasPrice({ originalGasPrice, argv }) {
  const fixed = parseGweiArg(argv, "--replacement-gas-price-gwei-fixed");
  const floor = parseGweiArg(argv, "--replacement-gas-price-gwei-floor");
  const cap = parseGweiArg(argv, "--replacement-gas-price-gwei-cap") ?? parseGweiArg(argv, "--gas-price-gwei-cap");
  const bumpBps = BigInt(argValueFrom(argv, "--replacement-gas-price-multiplier-bps", "12500"));

  let gasPrice = fixed ?? ((originalGasPrice * bumpBps) / 10_000n + 1n);
  if (floor !== null) gasPrice = maxBigInt(gasPrice, floor);
  if (cap !== null) gasPrice = minBigInt(gasPrice, cap);
  if (gasPrice <= originalGasPrice) {
    throw new Error("Replacement gas price must be greater than original gas price");
  }

  return {
    gasPrice,
    bumpBps,
    gasPriceFloor: floor,
    gasPriceCap: cap,
    gasPriceFixed: fixed
  };
}

function resolveFirstBlockOnPending(argv) {
  const action = argValueFrom(argv, "--first-block-on-pending", "wait");
  if (!["wait", "replace", "cancel"].includes(action)) {
    throw new Error(`Invalid --first-block-on-pending: ${action}. Use wait, replace, or cancel.`);
  }
  return action;
}

async function signCancelTransaction({ config, account, nonce, gas, gasPrice }) {
  if (typeof account.signTransaction !== "function") {
    throw new Error("Cancel transaction requires a local account that can sign transactions");
  }

  const serializedTransaction = await account.signTransaction({
    chainId: Number(config.chainId || bsc.id),
    nonce,
    to: account.address,
    gas,
    gasPrice,
    value: 0n,
    type: "legacy"
  });
  return { serializedTransaction, nonce };
}

async function waitForTransactionReceiptWithTimeout({ client, hash, timeoutMs, sleepFn = sleep }) {
  if (!timeoutMs || timeoutMs <= 0) {
    return { timedOut: false, receipt: await client.waitForTransactionReceipt({ hash }) };
  }

  return Promise.race([
    client.waitForTransactionReceipt({ hash }).then((receipt) => ({ timedOut: false, receipt })),
    sleepFn(timeoutMs).then(() => ({ timedOut: true, receipt: null }))
  ]);
}

async function broadcastPreparedRawTransaction({
  providers,
  serializedTransaction,
  timeoutMs,
  logger,
  eventName = "multi_rpc_broadcast",
  broadcastRawTransactionFn = broadcastRawTransaction
}) {
  const startedAt = performance.now();
  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        const hash = await broadcastRawTransactionFn({ provider, serializedTransaction, timeoutMs });
        return { ok: true, label: provider.label, hash };
      } catch (error) {
        return {
          ok: false,
          label: provider.label,
          errorType: classifyRpcError(error),
          message: error.shortMessage || error.message || String(error)
        };
      }
    })
  );
  const success = results.find((result) => result.ok);
  logger.event(eventName, {
    latencyMs: Math.round(performance.now() - startedAt),
    providers: results.map((result) =>
      result.ok
        ? { label: result.label, ok: true, hash: result.hash }
        : { label: result.label, ok: false, errorType: result.errorType }
    )
  });

  if (!success) {
    throw new Error(
      `Raw transaction broadcast failed: ${results
        .map((result) => `${result.label}:${result.errorType || "unknown"}`)
        .join(", ")}`
    );
  }

  return {
    hash: success.hash,
    okCount: results.filter((result) => result.ok).length,
    providerCount: results.length,
    winnerLabel: success.label,
    results
  };
}

async function sendBuyTransaction({
  config,
  account,
  client,
  walletClient,
  tx,
  gas,
  gasPrice,
  argv,
  logger,
  broadcastRawTransactionFn = broadcastRawTransaction
}) {
  const multiRpcBroadcast = hasFlag("--multi-rpc-broadcast", argv);
  if (!multiRpcBroadcast) {
    return walletClient.writeContract({
      address: config.addresses.infinityUniversalRouter,
      abi: universalRouterAbi,
      functionName: "execute",
      args: [tx.commands, tx.inputs, tx.deadline],
      gas,
      gasPrice
    });
  }

  if (typeof account.signTransaction !== "function") {
    throw new Error("Multi RPC broadcast requires a local account that can sign raw transactions");
  }

  const timeoutMs = Number(argValueFrom(argv, "--broadcast-timeout-ms", "3000"));
  const providers = getBroadcastProviders({ config, argv });
  const { serializedTransaction } = await signRawBuyTransaction({
    config,
    account,
    client,
    tx,
    gas,
    gasPrice
  });
  const broadcast = await broadcastPreparedRawTransaction({
    providers,
    serializedTransaction,
    timeoutMs,
    logger,
    broadcastRawTransactionFn
  });

  console.log(`Buy tx broadcast: ${broadcast.hash} via ${broadcast.winnerLabel}, ok=${broadcast.okCount}/${broadcast.providerCount}`);
  return broadcast.hash;
}

function actualEntryAvg({ beforeQuote, afterQuote, beforeTarget, afterTarget, quoteMeta, targetMeta, fallbackAvg }) {
  if (beforeQuote <= afterQuote || afterTarget <= beforeTarget) return fallbackAvg || null;
  const quoteSpent = beforeQuote - afterQuote;
  const targetReceived = afterTarget - beforeTarget;
  const targetHuman = toDecimalAmount(targetReceived, targetMeta.decimals);
  if (targetHuman.isZero()) return fallbackAvg || null;
  return toDecimalAmount(quoteSpent, quoteMeta.decimals).div(targetHuman);
}

async function finalizeBuyAfterReceipt({
  config,
  account,
  client,
  walletClient,
  hash,
  receipt,
  sentAt,
  beforeQuote,
  beforeTarget,
  quoteMeta,
  targetMeta,
  chosen,
  autoExit,
  argv,
  logger,
  nowFn,
  sleepFn,
  getTokenMetaFn,
  quoteFn,
  gasBufferBps,
  gasPriceMultiplierBps
}) {
  const confirmedAt = nowFn();
  console.log(`Buy tx status: ${receipt.status}, confirmation ${(confirmedAt - sentAt) / 1000}s`);
  logger.event("tx_confirmed", {
    hash,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    confirmationMs: confirmedAt - sentAt
  });

  const [afterTarget, afterQuote, bnb] = await Promise.all([
    client.readContract({
      address: config.targetToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address]
    }),
    client.readContract({
      address: config.quoteToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address]
    }),
    client.getBalance({ address: account.address })
  ]);
  const entryAvg = actualEntryAvg({
    beforeQuote,
    afterQuote,
    beforeTarget,
    afterTarget,
    quoteMeta,
    targetMeta,
    fallbackAvg: chosen.avg
  });
  console.log(`${quoteMeta.symbol}: ${fmtDecimal(toDecimalAmount(beforeQuote, quoteMeta.decimals), 8)} -> ${fmtDecimal(toDecimalAmount(afterQuote, quoteMeta.decimals), 8)}`);
  console.log(`${targetMeta.symbol}: ${fmtDecimal(toDecimalAmount(beforeTarget, targetMeta.decimals), 8)} -> ${fmtDecimal(toDecimalAmount(afterTarget, targetMeta.decimals), 8)}`);
  console.log(`BNB: ${formatEther(bnb)}`);
  logger.event("final_balances", {
    beforeQuote,
    afterQuote,
    beforeTarget,
    afterTarget,
    bnb,
    entryAvg: entryAvg?.toString()
  });

  let exitResult = null;
  if (autoExit && receipt.status === "success") {
    if (hasFlag("--auto-approve-exit", argv) && afterTarget > 0n) {
      console.log(
        `Auto exit approval: approving actual ${fmtDecimal(toDecimalAmount(afterTarget, targetMeta.decimals), 8)} ${targetMeta.symbol} balance before exit watch.`
      );
      logger.event("auto_exit_approval_starting", { amount: afterTarget });
      await ensureExitApproval({
        client,
        walletClient,
        account,
        config,
        targetMeta,
        amount: afterTarget,
        logger,
        gasBufferBps,
        gasPriceMultiplierBps
      });
      logger.event("auto_exit_approval_finished", { amount: afterTarget });
    }
    logger.event("auto_exit_starting", { entryAvgPriceUsd: entryAvg?.toString() });
    exitResult = await runExitWatcher({
      config,
      account,
      client,
      walletClient,
      entryAvgPriceUsd: entryAvg?.toString(),
      logger,
      argv,
      nowFn,
      sleepFn,
      getTokenMetaFn,
      quoteFn
    });
    logger.event("auto_exit_finished", { exitResult });
  }

  return { exitResult, entryAvg, afterQuote, afterTarget, bnb };
}

async function waitUntil({ targetMs, nowFn, sleepFn }) {
  while (nowFn() < targetMs) {
    await sleepFn(Math.min(1000, Math.max(1, targetMs - nowFn())));
  }
}

async function runFirstBlockPrebroadcast({
  config,
  account,
  client,
  hotReadClient,
  walletClient,
  execution,
  poolKey,
  quoteMeta,
  targetMeta,
  preflightState,
  autoExit,
  send,
  argv,
  logger,
  nowFn,
  sleepFn,
  getTokenMetaFn,
  quoteFn,
  broadcastRawTransactionFn
}) {
  const tier = selectFirstBlockTier({ execution, argv });
  const amountInUsdt = argValueFrom(argv, "--first-block-amount-usdt", tier.amountInUsdt);
  const maxAvgPriceUsd =
    argValueFrom(argv, "--first-block-max-avg-price", tierMaxAvgPriceUsd(tier)) ||
    execution.autoBuyMaxAvgPriceUsd;
  if (!maxAvgPriceUsd) throw new Error("First-block mode requires --first-block-max-avg-price or a tier max price");

  const amountIn = parseUnits(String(amountInUsdt), quoteMeta.decimals);
  const minOut = minOutFromMaxAvgPrice({
    amountIn,
    maxAvgPriceUsd,
    quoteDecimals: quoteMeta.decimals,
    targetDecimals: targetMeta.decimals
  });
  const zeroForOne = sameAddress(poolKey[0], config.quoteToken);
  const launchAt = new Date(config.launchTime).getTime();
  const deadlineSeconds = Number(argValueFrom(argv, "--deadline-seconds", "45"));
  const deadlineBaseMs = Math.max(nowFn(), launchAt);
  const deadline = BigInt(Math.floor(deadlineBaseMs / 1000) + deadlineSeconds);
  const tx = buildInfinityExactInputSingleExecute({
    poolKey,
    zeroForOne,
    amountIn,
    amountOutMinimum: minOut,
    inputCurrency: config.quoteToken,
    outputCurrency: config.targetToken,
    deadline
  });
  const gas = BigInt(argValueFrom(argv, "--first-block-gas-limit", "300000"));
  const gasPriceInfo = await resolveGasPrice({ client: hotReadClient, argv, fastLaunch: true });
  const estimatedGasCost = gas * gasPriceInfo.gasPrice;
  const beforeReadStartedAt = performance.now();
  const [beforeTarget, beforeQuote] = await Promise.all([
    client.readContract({
      address: config.targetToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address]
    }),
    client.readContract({
      address: config.quoteToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address]
    })
  ]);

  if (preflightState.bnb < estimatedGasCost) {
    throw new Error(
      `BNB balance is below first-block gas budget: have ${formatEther(preflightState.bnb)}, need ${formatEther(estimatedGasCost)}`
    );
  }

  const chosen = {
    tier: { ...tier, amountInUsdt: String(amountInUsdt) },
    amountIn,
    amountOut: null,
    avg: new Decimal(String(maxAvgPriceUsd)),
    quoteGas: 0n,
    latencyMs: Math.round(performance.now() - beforeReadStartedAt),
    zeroForOne,
    firstBlock: true
  };
  const broadcastOffsetMs = Number(argValueFrom(argv, "--first-block-broadcast-offset-ms", "-150"));
  const broadcastAt = launchAt + broadcastOffsetMs;
  const timeoutMs = Number(argValueFrom(argv, "--broadcast-timeout-ms", "3000"));
  const providers = getBroadcastProviders({ config, argv });
  const gasBufferBps = BigInt(argValueFrom(argv, "--gas-buffer-bps", "12000"));
  const onPending = resolveFirstBlockOnPending(argv);

  console.log(
    `First-block plan: BUY ${amountInUsdt} ${quoteMeta.symbol}, tier ${tier.name}, maxAvg ${maxAvgPriceUsd}, minOut ${fmtDecimal(toDecimalAmount(minOut, targetMeta.decimals), 8)} ${targetMeta.symbol}, gasLimit ${gas.toString()}, gasPrice ${gasPriceInfo.gasPrice.toString()}`
  );
  logger.event("first_block_prebuild_ready", {
    tier: tier.name,
    amountInUsdt,
    amountIn,
    maxAvgPriceUsd,
    minOut,
    gas,
    gasPrice: gasPriceInfo.gasPrice,
    baseGasPrice: gasPriceInfo.baseGasPrice,
    gasPriceMultiplierBps: gasPriceInfo.gasPriceMultiplierBps,
    gasPriceFloor: gasPriceInfo.gasPriceFloor,
    gasPriceCap: gasPriceInfo.gasPriceCap,
    gasPriceFixed: gasPriceInfo.gasPriceFixed,
    estimatedGasCost,
    deadline,
    broadcastAt: new Date(broadcastAt).toISOString(),
    broadcastOffsetMs,
    onPending,
    providers: providers.map((provider) => provider.label)
  });

  if (!send) {
    logger.event("first_block_dry_run_exit");
    return {
      action: "FIRST_BLOCK_PLAN",
      reason: "DRY_RUN",
      sent: false,
      amountInUsdt: String(amountInUsdt),
      tier: tier.name,
      maxAvgPriceUsd: String(maxAvgPriceUsd),
      minOut: minOut.toString()
    };
  }

  const { serializedTransaction, nonce } = await signRawBuyTransaction({
    config,
    account,
    client,
    tx,
    gas,
    gasPrice: gasPriceInfo.gasPrice
  });
  logger.event("first_block_presigned", {
    nonce,
    gas,
    gasPrice: gasPriceInfo.gasPrice,
    broadcastAt: new Date(broadcastAt).toISOString()
  });

  await waitUntil({ targetMs: broadcastAt, nowFn, sleepFn });
  const sentAt = nowFn();
  const broadcast = await broadcastPreparedRawTransaction({
    providers,
    serializedTransaction,
    timeoutMs,
    logger,
    eventName: "first_block_broadcast",
    broadcastRawTransactionFn
  });
  console.log(
    `First-block tx broadcast: ${broadcast.hash} via ${broadcast.winnerLabel}, ok=${broadcast.okCount}/${broadcast.providerCount}`
  );
  logger.event("tx_sent", {
    hash: broadcast.hash,
    sentAt: new Date(sentAt).toISOString(),
    mode: "first_block_prebroadcast"
  });

  const receiptTimeoutMs = Number(argValueFrom(argv, "--first-block-receipt-timeout-ms", "12000"));
  const receiptResult = await waitForTransactionReceiptWithTimeout({
    client,
    hash: broadcast.hash,
    timeoutMs: receiptTimeoutMs,
    sleepFn
  });
  if (receiptResult.timedOut) {
    console.log(`First-block tx pending after ${receiptTimeoutMs}ms: ${broadcast.hash}; action=${onPending}.`);
    logger.event("first_block_pending_timeout", {
      hash: broadcast.hash,
      nonce,
      timeoutMs: receiptTimeoutMs,
      onPending
    });

    if (onPending === "replace") {
      const replacementGasPrice = resolveReplacementGasPrice({
        originalGasPrice: gasPriceInfo.gasPrice,
        argv
      });
      const { serializedTransaction: replacementSerializedTransaction } = await signRawBuyTransaction({
        config,
        account,
        client,
        tx: { ...tx, nonce },
        gas,
        gasPrice: replacementGasPrice.gasPrice
      });
      logger.event("first_block_replacement_presigned", {
        nonce,
        gas,
        originalGasPrice: gasPriceInfo.gasPrice,
        replacementGasPrice: replacementGasPrice.gasPrice,
        replacementBumpBps: replacementGasPrice.bumpBps,
        replacementGasPriceFloor: replacementGasPrice.gasPriceFloor,
        replacementGasPriceCap: replacementGasPrice.gasPriceCap,
        replacementGasPriceFixed: replacementGasPrice.gasPriceFixed
      });
      const replacementSentAt = nowFn();
      let replacementBroadcast;
      try {
        replacementBroadcast = await broadcastPreparedRawTransaction({
          providers,
          serializedTransaction: replacementSerializedTransaction,
          timeoutMs,
          logger,
          eventName: "first_block_replacement_broadcast",
          broadcastRawTransactionFn
        });
      } catch (error) {
        logger.event("first_block_replacement_broadcast_failed", {
          replacedHash: broadcast.hash,
          nonce,
          message: error.shortMessage || error.message || String(error)
        });
        console.log(`First-block replacement broadcast failed: ${error.shortMessage || error.message || error}`);
        return {
          action: "WAIT",
          reason: "FIRST_BLOCK_REPLACEMENT_BROADCAST_FAILED",
          sent: true,
          hash: broadcast.hash,
          nonce
        };
      }
      console.log(
        `First-block replacement broadcast: ${replacementBroadcast.hash} via ${replacementBroadcast.winnerLabel}, ok=${replacementBroadcast.okCount}/${replacementBroadcast.providerCount}`
      );
      logger.event("tx_sent", {
        hash: replacementBroadcast.hash,
        sentAt: new Date(replacementSentAt).toISOString(),
        mode: "first_block_replacement",
        replacedHash: broadcast.hash
      });

      const replacementReceiptTimeoutMs = Number(
        argValueFrom(argv, "--replacement-receipt-timeout-ms", String(receiptTimeoutMs))
      );
      const replacementReceiptResult = await waitForTransactionReceiptWithTimeout({
        client,
        hash: replacementBroadcast.hash,
        timeoutMs: replacementReceiptTimeoutMs,
        sleepFn
      });
      if (replacementReceiptResult.timedOut) {
        logger.event("first_block_replacement_pending_timeout", {
          hash: replacementBroadcast.hash,
          replacedHash: broadcast.hash,
          nonce,
          timeoutMs: replacementReceiptTimeoutMs
        });
        return {
          action: "WAIT",
          reason: "FIRST_BLOCK_REPLACEMENT_PENDING",
          sent: true,
          hash: replacementBroadcast.hash,
          replacedHash: broadcast.hash,
          nonce
        };
      }

      const replacementReceipt = replacementReceiptResult.receipt;
      if (replacementReceipt.status !== "success") {
        logger.event("first_block_replacement_failed", {
          hash: replacementBroadcast.hash,
          replacedHash: broadcast.hash,
          status: replacementReceipt.status,
          blockNumber: replacementReceipt.blockNumber,
          gasUsed: replacementReceipt.gasUsed,
          effectiveGasPrice: replacementReceipt.effectiveGasPrice
        });
        if (hasFlag("--no-first-block-fallback", argv)) {
          return {
            action: "SKIP",
            reason: "FIRST_BLOCK_REPLACEMENT_FAILED",
            sent: true,
            hash: replacementBroadcast.hash,
            replacedHash: broadcast.hash,
            receiptStatus: replacementReceipt.status
          };
        }
        return {
          fallback: true,
          reason: "FIRST_BLOCK_REPLACEMENT_FAILED",
          hash: replacementBroadcast.hash,
          replacedHash: broadcast.hash,
          receiptStatus: replacementReceipt.status
        };
      }

      const replacementFinalized = await finalizeBuyAfterReceipt({
        config,
        account,
        client,
        walletClient,
        hash: replacementBroadcast.hash,
        receipt: replacementReceipt,
        sentAt: replacementSentAt,
        beforeQuote,
        beforeTarget,
        quoteMeta,
        targetMeta,
        chosen,
        autoExit,
        argv,
        logger,
        nowFn,
        sleepFn,
        getTokenMetaFn,
        quoteFn,
        gasBufferBps,
        gasPriceMultiplierBps: replacementGasPrice.bumpBps
      });

      return {
        action: "BUY_EXACT_IN",
        reason: "FIRST_BLOCK_REPLACEMENT",
        amountInUsdt: String(amountInUsdt),
        tier: tier.name,
        avg: replacementFinalized.entryAvg?.toString(),
        maxAvgPriceUsd: String(maxAvgPriceUsd),
        sent: true,
        hash: replacementBroadcast.hash,
        replacedHash: broadcast.hash,
        receiptStatus: replacementReceipt.status,
        exitResult: replacementFinalized.exitResult
      };
    }

    if (onPending === "cancel") {
      const cancelGasPrice = resolveReplacementGasPrice({
        originalGasPrice: gasPriceInfo.gasPrice,
        argv
      });
      const cancelGas = BigInt(argValueFrom(argv, "--cancel-gas-limit", "21000"));
      const { serializedTransaction: cancelSerializedTransaction } = await signCancelTransaction({
        config,
        account,
        nonce,
        gas: cancelGas,
        gasPrice: cancelGasPrice.gasPrice
      });
      logger.event("first_block_cancel_presigned", {
        nonce,
        gas: cancelGas,
        originalGasPrice: gasPriceInfo.gasPrice,
        cancelGasPrice: cancelGasPrice.gasPrice
      });
      const cancelSentAt = nowFn();
      let cancelBroadcast;
      try {
        cancelBroadcast = await broadcastPreparedRawTransaction({
          providers,
          serializedTransaction: cancelSerializedTransaction,
          timeoutMs,
          logger,
          eventName: "first_block_cancel_broadcast",
          broadcastRawTransactionFn
        });
      } catch (error) {
        logger.event("first_block_cancel_broadcast_failed", {
          cancelledHash: broadcast.hash,
          nonce,
          message: error.shortMessage || error.message || String(error)
        });
        console.log(`First-block cancel broadcast failed: ${error.shortMessage || error.message || error}`);
        return {
          action: "WAIT",
          reason: "FIRST_BLOCK_CANCEL_BROADCAST_FAILED",
          sent: true,
          hash: broadcast.hash,
          nonce
        };
      }
      console.log(
        `First-block cancel broadcast: ${cancelBroadcast.hash} via ${cancelBroadcast.winnerLabel}, ok=${cancelBroadcast.okCount}/${cancelBroadcast.providerCount}`
      );
      logger.event("tx_sent", {
        hash: cancelBroadcast.hash,
        sentAt: new Date(cancelSentAt).toISOString(),
        mode: "first_block_cancel",
        cancelledHash: broadcast.hash
      });

      const cancelReceiptTimeoutMs = Number(argValueFrom(argv, "--cancel-receipt-timeout-ms", String(receiptTimeoutMs)));
      const cancelReceiptResult = await waitForTransactionReceiptWithTimeout({
        client,
        hash: cancelBroadcast.hash,
        timeoutMs: cancelReceiptTimeoutMs,
        sleepFn
      });
      if (cancelReceiptResult.timedOut) {
        logger.event("first_block_cancel_pending_timeout", {
          hash: cancelBroadcast.hash,
          cancelledHash: broadcast.hash,
          nonce,
          timeoutMs: cancelReceiptTimeoutMs
        });
        return {
          action: "WAIT",
          reason: "FIRST_BLOCK_CANCEL_PENDING",
          sent: true,
          hash: cancelBroadcast.hash,
          cancelledHash: broadcast.hash,
          nonce
        };
      }

      const cancelReceipt = cancelReceiptResult.receipt;
      logger.event("first_block_cancel_confirmed", {
        hash: cancelBroadcast.hash,
        cancelledHash: broadcast.hash,
        status: cancelReceipt.status,
        blockNumber: cancelReceipt.blockNumber,
        gasUsed: cancelReceipt.gasUsed,
        effectiveGasPrice: cancelReceipt.effectiveGasPrice
      });
      return {
        action: "SKIP",
        reason: cancelReceipt.status === "success" ? "FIRST_BLOCK_CANCELLED" : "FIRST_BLOCK_CANCEL_FAILED",
        sent: true,
        hash: cancelBroadcast.hash,
        cancelledHash: broadcast.hash,
        receiptStatus: cancelReceipt.status
      };
    }

    return {
      action: "WAIT",
      reason: "FIRST_BLOCK_TX_PENDING",
      sent: true,
      hash: broadcast.hash,
      nonce
    };
  }

  const receipt = receiptResult.receipt;
  if (receipt.status !== "success") {
    console.log(`First-block tx status: ${receipt.status}; ${hasFlag("--no-first-block-fallback", argv) ? "not falling back." : "falling back to quote path."}`);
    logger.event("first_block_failed", {
      hash: broadcast.hash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice
    });
    if (hasFlag("--no-first-block-fallback", argv)) {
      return {
        action: "SKIP",
        reason: "FIRST_BLOCK_TX_FAILED",
        sent: true,
        hash: broadcast.hash,
        receiptStatus: receipt.status
      };
    }
    return { fallback: true, reason: "FIRST_BLOCK_TX_FAILED", hash: broadcast.hash, receiptStatus: receipt.status };
  }

  const finalized = await finalizeBuyAfterReceipt({
    config,
    account,
    client,
    walletClient,
    hash: broadcast.hash,
    receipt,
    sentAt,
    beforeQuote,
    beforeTarget,
    quoteMeta,
    targetMeta,
    chosen,
    autoExit,
    argv,
    logger,
    nowFn,
    sleepFn,
    getTokenMetaFn,
    quoteFn,
    gasBufferBps,
    gasPriceMultiplierBps: gasPriceInfo.gasPriceMultiplierBps
  });

  return {
    action: "BUY_EXACT_IN",
    reason: "FIRST_BLOCK_PREBROADCAST",
    amountInUsdt: String(amountInUsdt),
    tier: tier.name,
    avg: finalized.entryAvg?.toString(),
    maxAvgPriceUsd: String(maxAvgPriceUsd),
    sent: true,
    hash: broadcast.hash,
    receiptStatus: receipt.status,
    exitResult: finalized.exitResult
  };
}

export async function runLaunchExecutor({
  config,
  account,
  client,
  walletClient,
  logger = createRunLogger(config),
  argv = process.argv,
  nowFn = Date.now,
  sleepFn = sleep,
  getTokenMetaFn = getTokenMeta,
  quoteFn = quoteInfinityCLExactInputSingle,
  broadcastRawTransactionFn = broadcastRawTransaction
}) {
  const execution = getExecutionConfig(config);
  activeLogger = logger;

  const send = hasFlag("--send", argv);
  const preflightOnly = hasFlag("--preflight-only", argv);
  const autoExit = hasFlag("--auto-exit", argv);
  const fastLaunch = hasFlag("--fast-launch", argv);
  const firstBlock = hasFlag("--first-block", argv) || hasFlag("--prebuild-first-block", argv);
  const cacheEnabled = !hasFlag("--no-cache", argv) && getTokenMetaFn === getTokenMeta;
  const cache = createProjectCache(config, { enabled: cacheEnabled });
  const [targetMeta, quoteMeta, poolKey] = await Promise.all([
    cacheEnabled
      ? getCachedTokenMeta({
          cache,
          address: config.targetToken,
          load: () => getTokenMetaFn(client, config.targetToken)
        })
      : getTokenMetaFn(client, config.targetToken),
    cacheEnabled
      ? getCachedTokenMeta({
          cache,
          address: config.quoteToken,
          load: () => getTokenMetaFn(client, config.quoteToken)
        })
      : getTokenMetaFn(client, config.quoteToken),
    cacheEnabled
      ? getCachedPoolKey({
          cache,
          load: () =>
            client.readContract({
              address: config.addresses.infinityCLPoolManager,
              abi: infinityCLPoolManagerAbi,
              functionName: "poolIdToPoolKey",
              args: [config.protocols.infinityCL.poolId]
            })
        })
      : client.readContract({
          address: config.addresses.infinityCLPoolManager,
          abi: infinityCLPoolManagerAbi,
          functionName: "poolIdToPoolKey",
          args: [config.protocols.infinityCL.poolId]
        })
  ]);
  const rpcRaceWanted = shouldUseRpcRace({ fastLaunch, argv, quoteFn });
  const rpcRaceLabelsCsv =
    argValueFrom(argv, "--rpc-race-labels", DEFAULT_RPC_RACE_LABELS) || DEFAULT_RPC_RACE_LABELS;
  const rpcRaceTimeoutMs = Number(argValueFrom(argv, "--rpc-race-timeout-ms", "3000") || "3000");
  let hotReadClient = client;
  let rpcRaceEnabled = false;
  let rpcRaceLabels = [];

  if (rpcRaceWanted) {
    try {
      hotReadClient = createRaceReadClient(config, {
        labelsCsv: rpcRaceLabelsCsv,
        timeoutMs: rpcRaceTimeoutMs,
        logger
      });
      rpcRaceEnabled = true;
      rpcRaceLabels = hotReadClient.labels;
    } catch (error) {
      logger.event("rpc_race_unavailable", {
        labelsCsv: rpcRaceLabelsCsv,
        message: shortErrorMessage(error)
      });
    }
  }

  console.log(`${config.name} launch executor`);
  console.log(`Mode: ${send ? "SEND_ENABLED" : "DRY_RUN"}`);
  console.log(`Launch: ${config.launchTime}`);
  console.log(`Pool hook: ${poolKey[2]}`);
  console.log(`Run log: ${logger.outPath}`);
  if (rpcRaceEnabled) {
    console.log(`RPC race: ${rpcRaceLabels.join(", ")} (hot hook/quote/gas reads)`);
  }
  logger.event("run_started", {
    mode: send ? "send" : "dry_run",
    preflightOnly,
    autoExit,
    fastLaunch,
    firstBlock,
    rpcRaceWanted,
    rpcRaceEnabled,
    rpcRaceLabels,
    rpcRaceTimeoutMs: rpcRaceEnabled ? rpcRaceTimeoutMs : null,
    cacheEnabled,
    cacheFile: cacheEnabled ? cache.file : null,
    configName: config.name,
    launchTime: config.launchTime,
    wallet: account.address,
    poolId: config.protocols.infinityCL.poolId,
    poolHook: poolKey[2],
    targetToken: config.targetToken,
    quoteToken: config.quoteToken
  });

  const preflightState = await preflight({ client, account, config, quoteMeta, targetMeta, execution });
  logger.event("preflight_ok", {
    bnb: preflightState.bnb,
    quoteBalance: preflightState.quoteBalance,
    targetBalance: preflightState.targetBalance,
    maxSpend: preflightState.maxSpend,
    erc20Allowance: preflightState.allowance.erc20Allowance,
    permit2Amount: preflightState.allowance.permit2Amount,
    permit2Expired: preflightState.allowance.permit2Expired
  });

  if (preflightOnly) {
    logger.event("preflight_only_exit");
    console.log("Preflight-only: wallet, balance, approvals, token metadata, and pool key are ready.");
    return { action: "PREFLIGHT_ONLY", reason: "PREFLIGHT_OK" };
  }

  if (firstBlock) {
    const firstBlockResult = await runFirstBlockPrebroadcast({
      config,
      account,
      client,
      hotReadClient,
      walletClient,
      execution,
      poolKey,
      quoteMeta,
      targetMeta,
      preflightState,
      autoExit,
      send,
      argv,
      logger,
      nowFn,
      sleepFn,
      getTokenMetaFn,
      quoteFn,
      broadcastRawTransactionFn
    });
    if (!firstBlockResult?.fallback) return firstBlockResult;
    logger.event("first_block_fallback_starting", {
      reason: firstBlockResult.reason,
      hash: firstBlockResult.hash,
      receiptStatus: firstBlockResult.receiptStatus
    });
  }

  let choice;
  if (fastLaunch) {
    choice = await waitForFastLaunchChoice({
      client: hotReadClient,
      config,
      poolKey,
      execution,
      quoteMeta,
      targetMeta,
      logger,
      argv,
      nowFn,
      sleepFn,
      quoteFn
    });
  } else {
    const started = await waitForLaunch({ client: hotReadClient, config, poolKey, logger, argv, nowFn, sleepFn });
    if (!started) throw new Error("Hook did not start before give-up window");

    choice = await chooseTierWithRetry({
      client: hotReadClient,
      config,
      poolKey,
      execution,
      quoteMeta,
      targetMeta,
      logger,
      argv,
      nowFn,
      sleepFn,
      quoteFn
    });
  }
  const chosen = choice.match;
  if (!chosen) {
    console.log(`Decision: SKIP - ${choice.reason}.`);
    logger.event("decision_skip", { reason: choice.reason });
    return { action: "SKIP", reason: choice.reason };
  }

  const minOut = applySlippageBps(chosen.amountOut, execution.maxSlippageBps);
  const deadline = BigInt(Math.floor(nowFn() / 1000) + Number(argValueFrom(argv, "--deadline-seconds", "45")));
  const tx = buildInfinityExactInputSingleExecute({
    poolKey,
    zeroForOne: chosen.zeroForOne,
    amountIn: chosen.amountIn,
    amountOutMinimum: minOut,
    inputCurrency: config.quoteToken,
    outputCurrency: config.targetToken,
    deadline
  });

  const gasBufferBps = BigInt(argValueFrom(argv, "--gas-buffer-bps", "12000"));
  const [gas, gasPriceInfo, beforeTarget, beforeQuote] = await Promise.all([
    hotReadClient.estimateContractGas({
      account,
      address: config.addresses.infinityUniversalRouter,
      abi: universalRouterAbi,
      functionName: "execute",
      args: [tx.commands, tx.inputs, tx.deadline]
    }),
    resolveGasPrice({ client: hotReadClient, argv, fastLaunch }),
    client.readContract({
      address: config.targetToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address]
    }),
    client.readContract({
      address: config.quoteToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address]
    })
  ]);
  const bufferedGas = (gas * gasBufferBps) / 10_000n;
  const boostedGasPrice = gasPriceInfo.gasPrice;
  const estimatedGasCost = bufferedGas * boostedGasPrice;

  if (preflightState.bnb < estimatedGasCost) {
    throw new Error(
      `BNB balance is below boosted gas budget: have ${formatEther(preflightState.bnb)}, need ${formatEther(estimatedGasCost)}`
    );
  }

  console.log(
    `Decision: BUY ${chosen.tier.amountInUsdt} ${quoteMeta.symbol}, tier ${chosen.tier.name}, avg ${fmtDecimal(chosen.avg, 8)}, minOut ${fmtDecimal(toDecimalAmount(minOut, targetMeta.decimals), 8)} ${targetMeta.symbol}`
  );
  if (autoExit && hasFlag("--auto-approve-exit", argv)) {
    console.log(
      `Exit approval estimate: quote ${fmtDecimal(toDecimalAmount(chosen.amountOut, targetMeta.decimals), 8)} ${targetMeta.symbol}, min ${fmtDecimal(toDecimalAmount(minOut, targetMeta.decimals), 8)} ${targetMeta.symbol}; actual post-buy balance will be approved.`
    );
    logger.event("exit_approval_estimate", {
      quotedTargetAmount: chosen.amountOut,
      minTargetAmount: minOut,
      targetSymbol: targetMeta.symbol
    });
  }
  console.log(`Simulation: ok, gas ${gas.toString()}, bufferedGas ${bufferedGas.toString()}, gasPrice ${boostedGasPrice.toString()}`);
  logger.event("simulation_ok", {
    tier: chosen.tier.name,
    amountInUsdt: chosen.tier.amountInUsdt,
    amountIn: chosen.amountIn,
    quotedAmountOut: chosen.amountOut,
    avg: chosen.avg?.toString(),
    minOut,
    quoteGas: chosen.quoteGas,
    quoteLatencyMs: Math.round(chosen.latencyMs),
    gas,
    bufferedGas,
    gasPrice: gasPriceInfo.baseGasPrice,
    gasPriceMultiplierBps: gasPriceInfo.gasPriceMultiplierBps,
    gasPriceFloor: gasPriceInfo.gasPriceFloor,
    gasPriceCap: gasPriceInfo.gasPriceCap,
    gasPriceFixed: gasPriceInfo.gasPriceFixed,
    boostedGasPrice,
    estimatedGasCost
  });

  if (!send) {
    console.log("Mode: DRY_RUN. Re-run with --send for live execution.");
    logger.event("dry_run_exit");
    return {
      action: "BUY_EXACT_IN",
      reason: `MATCHED_TIER_${chosen.tier.name}`.toUpperCase(),
      amountInUsdt: chosen.tier.amountInUsdt,
      tier: chosen.tier.name,
      avg: chosen.avg?.toString(),
      sent: false
    };
  }

  const sentAt = nowFn();
  const hash = await sendBuyTransaction({
    config,
    account,
    client,
    walletClient,
    tx,
    gas: bufferedGas,
    gasPrice: boostedGasPrice,
    argv,
    logger,
    broadcastRawTransactionFn
  });
  console.log(`Buy tx sent: ${hash}`);
  logger.event("tx_sent", { hash, sentAt: new Date(sentAt).toISOString() });
  const receipt = await client.waitForTransactionReceipt({ hash });
  const finalized = await finalizeBuyAfterReceipt({
    config,
    account,
    client,
    walletClient,
    hash,
    beforeQuote,
    beforeTarget,
    receipt,
    sentAt,
    quoteMeta,
    targetMeta,
    chosen,
    autoExit,
    argv,
    logger,
    nowFn,
    sleepFn,
    getTokenMetaFn,
    quoteFn,
    gasBufferBps,
    gasPriceMultiplierBps: gasPriceInfo.gasPriceMultiplierBps
  });

  return {
    action: "BUY_EXACT_IN",
    reason: `MATCHED_TIER_${chosen.tier.name}`.toUpperCase(),
    amountInUsdt: chosen.tier.amountInUsdt,
    tier: chosen.tier.name,
    avg: finalized.entryAvg?.toString(),
    sent: true,
    hash,
    receiptStatus: receipt.status,
    exitResult: finalized.exitResult
  };
}

async function main() {
  const config = loadConfigFromArgs();
  const account = loadAccount();
  const configuredWallet = process.env.WALLET_ADDRESS;
  if (configuredWallet && !sameAddress(account.address, configuredWallet)) {
    throw new Error("PRIVATE_KEY does not match WALLET_ADDRESS");
  }

  const client = createBscClient(config.rpcUrls);
  const walletClient = createWalletClient({
    account,
    chain: bsc,
    transport: http(config.rpcUrl, { timeout: 25_000 })
  });

  await runLaunchExecutor({ config, account, client, walletClient });
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    activeLogger?.event("fatal_error", {
      message: error.shortMessage || error.message || String(error),
      signature: error?.cause?.signature || error?.signature
    });
    console.error(error.shortMessage || error.message || error);
    process.exitCode = 1;
  });
}
