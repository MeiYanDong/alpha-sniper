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
import { getExitConfig } from "./decision.js";
import { applySlippageBps, buildInfinityExactInputSingleExecute } from "./infinity-swap.js";
import { fmtDecimal, toDecimalAmount } from "./math.js";
import {
  createBscClient,
  getTokenMeta,
  quoteInfinityCLExactInputSingle,
  summarizeContractError
} from "./pools.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function argValueFrom(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function hasFlag(name, argv = process.argv) {
  return argv.includes(name);
}

function loadAccount() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY is missing in .env.local");
  return privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
}

function serialize(value) {
  return JSON.stringify(value, (_, current) => {
    if (typeof current === "bigint") return current.toString();
    if (current && current.constructor?.name === "Decimal") return current.toString();
    return current;
  });
}

function createConsoleLogger() {
  return {
    outPath: "console://exit-watch",
    event(name, fields = {}) {
      console.log(`[exit:${name}] ${serialize(fields)}`);
    }
  };
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

function approvalsOk(allowance, amount) {
  return (
    allowance.erc20Allowance >= amount &&
    allowance.permit2Amount >= amount &&
    !allowance.permit2Expired
  );
}

async function ensureExitApproval({
  client,
  walletClient,
  account,
  config,
  targetMeta,
  amount,
  logger
}) {
  const allowance = await readPermit2Allowance({
    client,
    owner: account.address,
    token: config.targetToken,
    permit2: config.addresses.permit2,
    router: config.addresses.infinityUniversalRouter
  });
  if (approvalsOk(allowance, amount)) return allowance;

  logger.event("exit_approval_needed", {
    required: amount,
    erc20Allowance: allowance.erc20Allowance,
    permit2Amount: allowance.permit2Amount,
    permit2Expired: allowance.permit2Expired
  });

  if (allowance.erc20Allowance < amount) {
    const hash = await walletClient.writeContract({
      address: config.targetToken,
      abi: erc20Abi,
      functionName: "approve",
      args: [config.addresses.permit2, amount]
    });
    console.log(`Exit ERC20 approve tx sent: ${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash });
    console.log(`Exit ERC20 approve tx status: ${receipt.status}`);
    logger.event("exit_erc20_approved", { hash, status: receipt.status, amount });
  }

  if (allowance.permit2Amount < amount || allowance.permit2Expired) {
    const maxUint48 = (1n << 48n) - 1n;
    const maxUint160 = (1n << 160n) - 1n;
    const permitAmount = amount > maxUint160 ? maxUint160 : amount;
    const hash = await walletClient.writeContract({
      address: config.addresses.permit2,
      abi: permit2Abi,
      functionName: "approve",
      args: [config.targetToken, config.addresses.infinityUniversalRouter, permitAmount, maxUint48]
    });
    console.log(`Exit Permit2 approve tx sent: ${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash });
    console.log(`Exit Permit2 approve tx status: ${receipt.status}`);
    logger.event("exit_permit2_approved", { hash, status: receipt.status, amount: permitAmount });
  }

  const refreshed = await readPermit2Allowance({
    client,
    owner: account.address,
    token: config.targetToken,
    permit2: config.addresses.permit2,
    router: config.addresses.infinityUniversalRouter
  });
  console.log(
    `Exit approval ready: ${fmtDecimal(toDecimalAmount(refreshed.erc20Allowance, targetMeta.decimals), 8)} / ${fmtDecimal(toDecimalAmount(refreshed.permit2Amount, targetMeta.decimals), 8)} ${targetMeta.symbol}`
  );
  return refreshed;
}

function pickExitDecision({ config, avgExitPriceUsd, entryAvgPriceUsd, completedTiers, emergencyExit }) {
  const exit = getExitConfig(config);
  if (emergencyExit) {
    return { action: "SELL_EXACT_IN", reason: "EMERGENCY_EXIT", sellBps: 10_000 };
  }
  if (!entryAvgPriceUsd) {
    return { action: "WAIT", reason: "ENTRY_PRICE_UNKNOWN" };
  }

  const avgExit = new Decimal(String(avgExitPriceUsd));
  const entry = new Decimal(String(entryAvgPriceUsd));
  const stopPrice = entry.mul(new Decimal(100).minus(exit.stopLossFromEntryPct)).div(100);
  if (avgExit.lte(stopPrice)) {
    return { action: "SELL_EXACT_IN", reason: "STOP_LOSS", sellBps: 10_000 };
  }

  const gainPct = avgExit.minus(entry).div(entry).mul(100);
  const tier = [...exit.takeProfitTiers]
    .sort((a, b) => Number(b.gainFromEntryPctGte) - Number(a.gainFromEntryPctGte))
    .find((item) => !completedTiers.has(item.name) && gainPct.gte(item.gainFromEntryPctGte));
  if (tier) {
    return {
      action: "SELL_EXACT_IN",
      reason: `TAKE_PROFIT_${tier.name || "unnamed"}`.toUpperCase(),
      sellBps: Number(tier.sellBps),
      tierName: tier.name || null
    };
  }

  return { action: "WAIT", reason: "HOLD_POSITION", gainPct: gainPct.toString() };
}

async function quoteSell({ client, config, poolKey, targetMeta, quoteMeta, amount, quoteFn }) {
  const zeroForOne = sameAddress(poolKey[0], config.targetToken);
  const startedAt = performance.now();
  const [amountOut, quoteGas] = await quoteFn({
    client,
    quoter: config.addresses.infinityCLQuoter,
    poolKey,
    zeroForOne,
    exactAmount: amount
  });
  const latencyMs = performance.now() - startedAt;
  const amountInHuman = toDecimalAmount(amount, targetMeta.decimals);
  const amountOutHuman = toDecimalAmount(amountOut, quoteMeta.decimals);
  return {
    zeroForOne,
    amountOut,
    quoteGas,
    latencyMs,
    avgExitPrice: amountInHuman.isZero() ? null : amountOutHuman.div(amountInHuman)
  };
}

export async function runExitWatcher({
  config,
  account,
  client,
  walletClient,
  entryAvgPriceUsd,
  logger = createConsoleLogger(),
  argv = process.argv,
  nowFn = Date.now,
  sleepFn = sleep,
  getTokenMetaFn = getTokenMeta,
  quoteFn = quoteInfinityCLExactInputSingle
}) {
  const send = hasFlag("--send", argv);
  const autoApprove = hasFlag("--auto-approve-exit", argv);
  const emergencyExit = hasFlag("--emergency-exit", argv);
  const exitOnce = hasFlag("--exit-once", argv);
  const pollMs = Number(argValueFrom(argv, "--exit-poll-ms", argValueFrom(argv, "--poll-ms", "1000")));
  const maxWatchMs = Number(argValueFrom(argv, "--exit-max-watch-ms", "7200000"));
  const gasBufferBps = BigInt(argValueFrom(argv, "--gas-buffer-bps", "12000"));
  const gasPriceMultiplierBps = BigInt(argValueFrom(argv, "--gas-price-multiplier-bps", "12000"));
  const deadlineSeconds = Number(argValueFrom(argv, "--deadline-seconds", "45"));
  const slippageBps = Number(config.exit?.maxSlippageBps || config.execution?.maxSlippageBps || 500);
  const startedAt = nowFn();
  const completedTiers = new Set();
  let sellActions = 0;

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

  console.log(`${config.name} exit watcher`);
  console.log(`Mode: ${send ? "SEND_ENABLED" : "DRY_RUN"}`);
  console.log(`Wallet: ${account.address}`);
  console.log(`Entry avg: ${entryAvgPriceUsd || "unknown"}`);
  logger.event("exit_watch_started", {
    mode: send ? "send" : "dry_run",
    autoApprove,
    emergencyExit,
    entryAvgPriceUsd,
    pollMs,
    maxWatchMs
  });

  while (nowFn() - startedAt <= maxWatchMs) {
    const [targetBalance, bnbBalance, hookStarted] = await Promise.all([
      client.readContract({
        address: config.targetToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address]
      }),
      client.getBalance({ address: account.address }),
      client.readContract({
        address: poolKey[2],
        abi: clAlphaHookAbi,
        functionName: "isPoolStarted",
        args: [config.protocols.infinityCL.poolId]
      })
    ]);

    if (targetBalance === 0n) {
      console.log(`Exit: no ${targetMeta.symbol} position yet.`);
      logger.event("exit_wait", { reason: "NO_POSITION" });
      await sleepFn(pollMs);
      continue;
    }
    if (!hookStarted) {
      console.log("Exit: hook not started.");
      logger.event("exit_wait", { reason: "HOOK_NOT_STARTED" });
      await sleepFn(pollMs);
      continue;
    }

    let fullQuote;
    try {
      fullQuote = await quoteSell({
        client,
        config,
        poolKey,
        targetMeta,
        quoteMeta,
        amount: targetBalance,
        quoteFn
      });
    } catch (error) {
      const summary = summarizeContractError(error);
      console.log(`Exit quote failed: ${summary.shortMessage}`);
      logger.event("exit_quote_failed", { error: summary });
      await sleepFn(pollMs);
      continue;
    }

    const decision = pickExitDecision({
      config,
      avgExitPriceUsd: fullQuote.avgExitPrice?.toString(),
      entryAvgPriceUsd,
      completedTiers,
      emergencyExit
    });
    console.log(
      `Exit quote: ${fmtDecimal(toDecimalAmount(targetBalance, targetMeta.decimals), 8)} ${targetMeta.symbol} -> ${fmtDecimal(toDecimalAmount(fullQuote.amountOut, quoteMeta.decimals), 8)} ${quoteMeta.symbol}, avg ${fmtDecimal(fullQuote.avgExitPrice, 8)}, decision ${decision.reason}`
    );
    logger.event("exit_decision", {
      balance: targetBalance,
      avgExitPrice: fullQuote.avgExitPrice?.toString(),
      decision
    });

    if (decision.action !== "SELL_EXACT_IN") {
      await sleepFn(pollMs);
      continue;
    }

    const sellAmount = (targetBalance * BigInt(decision.sellBps)) / 10_000n;
    const sellQuote =
      sellAmount === targetBalance
        ? fullQuote
        : await quoteSell({
            client,
            config,
            poolKey,
            targetMeta,
            quoteMeta,
            amount: sellAmount,
            quoteFn
          });
    const minOut = applySlippageBps(sellQuote.amountOut, slippageBps);
    const deadline = BigInt(Math.floor(nowFn() / 1000) + deadlineSeconds);
    const tx = buildInfinityExactInputSingleExecute({
      poolKey,
      zeroForOne: sellQuote.zeroForOne,
      amountIn: sellAmount,
      amountOutMinimum: minOut,
      inputCurrency: config.targetToken,
      outputCurrency: config.quoteToken,
      deadline
    });

    let allowance = await readPermit2Allowance({
      client,
      owner: account.address,
      token: config.targetToken,
      permit2: config.addresses.permit2,
      router: config.addresses.infinityUniversalRouter
    });
    if (!approvalsOk(allowance, sellAmount)) {
      if (!send || !autoApprove) {
        console.log("Exit: approval missing for SHARE sell.");
        logger.event("exit_skip", { reason: "APPROVAL_MISSING" });
        return { action: "SKIP", reason: "APPROVAL_MISSING" };
      }
      allowance = await ensureExitApproval({
        client,
        walletClient,
        account,
        config,
        targetMeta,
        amount: targetBalance,
        logger
      });
      if (!approvalsOk(allowance, sellAmount)) {
        return { action: "SKIP", reason: "APPROVAL_MISSING_AFTER_APPROVE" };
      }
    }

    let gas;
    let gasPrice;
    try {
      [gas, gasPrice] = await Promise.all([
        client.estimateContractGas({
          account,
          address: config.addresses.infinityUniversalRouter,
          abi: universalRouterAbi,
          functionName: "execute",
          args: [tx.commands, tx.inputs, tx.deadline]
        }),
        client.getGasPrice()
      ]);
    } catch (error) {
      const summary = summarizeContractError(error);
      console.log(`Exit simulation failed: ${summary.shortMessage}`);
      logger.event("exit_skip", { reason: "SELL_SIMULATION_FAILED", error: summary });
      return { action: "SKIP", reason: "SELL_SIMULATION_FAILED" };
    }

    const bufferedGas = (gas * gasBufferBps) / 10_000n;
    const boostedGasPrice = (gasPrice * gasPriceMultiplierBps) / 10_000n;
    const estimatedGasCost = bufferedGas * boostedGasPrice;
    if (bnbBalance < estimatedGasCost) {
      console.log(`Exit: BNB gas too low, have ${formatEther(bnbBalance)}, need ${formatEther(estimatedGasCost)}`);
      logger.event("exit_skip", { reason: "BNB_GAS_TOO_LOW", bnbBalance, estimatedGasCost });
      return { action: "SKIP", reason: "BNB_GAS_TOO_LOW" };
    }

    console.log(
      `Exit SELL ${fmtDecimal(toDecimalAmount(sellAmount, targetMeta.decimals), 8)} ${targetMeta.symbol}, reason ${decision.reason}, minOut ${fmtDecimal(toDecimalAmount(minOut, quoteMeta.decimals), 8)} ${quoteMeta.symbol}`
    );
    logger.event("exit_simulation_ok", {
      reason: decision.reason,
      sellAmount,
      quotedAmountOut: sellQuote.amountOut,
      minOut,
      gas,
      bufferedGas,
      boostedGasPrice
    });

    if (!send) {
      return {
        action: "SELL_EXACT_IN",
        reason: decision.reason,
        sent: false,
        sellBps: decision.sellBps,
        avgExitPrice: sellQuote.avgExitPrice?.toString()
      };
    }

    const sentAt = nowFn();
    const hash = await walletClient.writeContract({
      address: config.addresses.infinityUniversalRouter,
      abi: universalRouterAbi,
      functionName: "execute",
      args: [tx.commands, tx.inputs, tx.deadline],
      gas: bufferedGas,
      gasPrice: boostedGasPrice
    });
    console.log(`Exit sell tx sent: ${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash });
    console.log(`Exit sell tx status: ${receipt.status}`);
    logger.event("exit_tx_confirmed", {
      hash,
      status: receipt.status,
      reason: decision.reason,
      sellAmount,
      confirmationMs: nowFn() - sentAt
    });
    sellActions += 1;

    if (decision.tierName) completedTiers.add(decision.tierName);
    if (decision.sellBps >= 10_000 || decision.reason === "STOP_LOSS" || decision.reason === "EMERGENCY_EXIT") {
      return {
        action: "SELL_EXACT_IN",
        reason: decision.reason,
        sent: true,
        hash,
        receiptStatus: receipt.status,
        sellActions
      };
    }
    if (exitOnce) {
      return {
        action: "SELL_EXACT_IN",
        reason: decision.reason,
        sent: true,
        hash,
        receiptStatus: receipt.status,
        sellActions
      };
    }
    await sleepFn(pollMs);
  }

  logger.event("exit_watch_timeout");
  return { action: "WAIT", reason: "EXIT_WATCH_TIMEOUT" };
}

async function main() {
  const config = loadConfigFromArgs();
  const account = loadAccount();
  const configuredWallet = process.env.WALLET_ADDRESS;
  if (configuredWallet && !sameAddress(account.address, configuredWallet)) {
    throw new Error("PRIVATE_KEY does not match WALLET_ADDRESS");
  }
  const entryAvgPriceUsd = argValueFrom(process.argv, "--entry-avg-price", process.env.ENTRY_AVG_PRICE_USD);
  if (!entryAvgPriceUsd && !hasFlag("--emergency-exit")) {
    console.log("ENTRY_AVG_PRICE_USD or --entry-avg-price is required for automatic stop-loss / take-profit.");
  }

  const client = createBscClient(config.rpcUrls);
  const walletClient = createWalletClient({
    account,
    chain: bsc,
    transport: http(config.rpcUrl, { timeout: 25_000 })
  });
  await runExitWatcher({ config, account, client, walletClient, entryAvgPriceUsd });
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(error.shortMessage || error.message || error);
    process.exitCode = 1;
  });
}
