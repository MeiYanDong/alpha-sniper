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
import { runExitWatcher } from "./exit-watch.js";
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

  const includePublic = hasFlag("--broadcast-public", argv);
  const labelsCsv = argValueFrom(argv, "--broadcast-labels", "");
  const timeoutMs = Number(argValueFrom(argv, "--broadcast-timeout-ms", "3000"));
  const providers = filterRpcProviders(getSafeRpcProviders(config, { includePublic }), labelsCsv);
  if (providers.length === 0) throw new Error("No RPC providers available for multi RPC broadcast");

  const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
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
  logger.event("multi_rpc_broadcast", {
    latencyMs: Math.round(performance.now() - startedAt),
    providers: results.map((result) =>
      result.ok
        ? { label: result.label, ok: true, hash: result.hash }
        : { label: result.label, ok: false, errorType: result.errorType }
    )
  });

  if (!success) {
    throw new Error(
      `Multi RPC broadcast failed: ${results
        .map((result) => `${result.label}:${result.errorType || "unknown"}`)
        .join(", ")}`
    );
  }

  const okCount = results.filter((result) => result.ok).length;
  console.log(`Buy tx broadcast: ${success.hash} via ${success.label}, ok=${okCount}/${results.length}`);
  return success.hash;
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
  const [targetMeta, quoteMeta, poolKey] = await Promise.all([
    getTokenMetaFn(client, config.targetToken),
    getTokenMetaFn(client, config.quoteToken),
    client.readContract({
      address: config.addresses.infinityCLPoolManager,
      abi: infinityCLPoolManagerAbi,
      functionName: "poolIdToPoolKey",
      args: [config.protocols.infinityCL.poolId]
    })
  ]);

  console.log(`${config.name} launch executor`);
  console.log(`Mode: ${send ? "SEND_ENABLED" : "DRY_RUN"}`);
  console.log(`Launch: ${config.launchTime}`);
  console.log(`Pool hook: ${poolKey[2]}`);
  console.log(`Run log: ${logger.outPath}`);
  logger.event("run_started", {
    mode: send ? "send" : "dry_run",
    preflightOnly,
    autoExit,
    fastLaunch,
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

  let choice;
  if (fastLaunch) {
    choice = await waitForFastLaunchChoice({
      client,
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
    const started = await waitForLaunch({ client, config, poolKey, logger, argv, nowFn, sleepFn });
    if (!started) throw new Error("Hook did not start before give-up window");

    choice = await chooseTierWithRetry({
      client,
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
  const gasPriceMultiplierBps = BigInt(
    argValueFrom(argv, "--gas-price-multiplier-bps", fastLaunch ? "15000" : "12000")
  );
  const [gas, gasPrice, beforeTarget, beforeQuote] = await Promise.all([
    client.estimateContractGas({
      account,
      address: config.addresses.infinityUniversalRouter,
      abi: universalRouterAbi,
      functionName: "execute",
      args: [tx.commands, tx.inputs, tx.deadline]
    }),
    client.getGasPrice(),
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
  const boostedGasPrice = (gasPrice * gasPriceMultiplierBps) / 10_000n;
  const estimatedGasCost = bufferedGas * boostedGasPrice;

  if (preflightState.bnb < estimatedGasCost) {
    throw new Error(
      `BNB balance is below boosted gas budget: have ${formatEther(preflightState.bnb)}, need ${formatEther(estimatedGasCost)}`
    );
  }

  console.log(
    `Decision: BUY ${chosen.tier.amountInUsdt} ${quoteMeta.symbol}, tier ${chosen.tier.name}, avg ${fmtDecimal(chosen.avg, 8)}, minOut ${fmtDecimal(toDecimalAmount(minOut, targetMeta.decimals), 8)} ${targetMeta.symbol}`
  );
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
    gasPrice,
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
  console.log(`${quoteMeta.symbol}: ${fmtDecimal(toDecimalAmount(beforeQuote, quoteMeta.decimals), 8)} -> ${fmtDecimal(toDecimalAmount(afterQuote, quoteMeta.decimals), 8)}`);
  console.log(`${targetMeta.symbol}: ${fmtDecimal(toDecimalAmount(beforeTarget, targetMeta.decimals), 8)} -> ${fmtDecimal(toDecimalAmount(afterTarget, targetMeta.decimals), 8)}`);
  console.log(`BNB: ${formatEther(bnb)}`);
  logger.event("final_balances", {
    beforeQuote,
    afterQuote,
    beforeTarget,
    afterTarget,
    bnb
  });

  let exitResult = null;
  if (autoExit && receipt.status === "success") {
    logger.event("auto_exit_starting", { entryAvgPriceUsd: chosen.avg?.toString() });
    exitResult = await runExitWatcher({
      config,
      account,
      client,
      walletClient,
      entryAvgPriceUsd: chosen.avg?.toString(),
      logger,
      argv,
      nowFn,
      sleepFn,
      getTokenMetaFn,
      quoteFn
    });
    logger.event("auto_exit_finished", { exitResult });
  }

  return {
    action: "BUY_EXACT_IN",
    reason: `MATCHED_TIER_${chosen.tier.name}`.toUpperCase(),
    amountInUsdt: chosen.tier.amountInUsdt,
    tier: chosen.tier.name,
    avg: chosen.avg?.toString(),
    sent: true,
    hash,
    receiptStatus: receipt.status,
    exitResult
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
