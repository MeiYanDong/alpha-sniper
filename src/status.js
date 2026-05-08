import Decimal from "decimal.js";
import { loadConfigFromArgs, sameAddress } from "./config.js";
import { classifyPrice, fmtDecimal, toDecimalAmount } from "./math.js";
import {
  createBscClient,
  getInfinityCLStatus,
  getTokenMeta,
  getV2Status,
  getV3Statuses
} from "./pools.js";

function printRuleSummary(config) {
  console.log("Rules");
  console.log(`- ideal: <= ${config.rules.idealMaxPriceUsd} ${config.quoteSymbol}`);
  console.log(`- buy ceiling: <= ${config.rules.maxBuyPriceUsd} ${config.quoteSymbol}`);
  console.log(`- caution: <= ${config.rules.cautionPriceUsd} ${config.quoteSymbol}`);
  console.log(`- no chase: >= ${config.rules.noChasePriceUsd} ${config.quoteSymbol}`);
  console.log("");
}

function printBenchmarks(config) {
  console.log("Readwise benchmark");
  for (const item of config.readwiseBenchmarks || []) {
    console.log(
      `- ${item.amountInUsdt} USDT -> avg ${item.avgUsd}, end ${item.endUsd}`
    );
  }
  console.log("");
}

function printDecision(price, config, prefix = "Decision") {
  const state = classifyPrice(price, config.rules);
  const label = {
    IDEAL: "低价狙击区",
    OK: "可接受狙击区",
    CAUTION: "偏追高，只适合小仓或等待",
    HIGH: "高位，不按低价狙击处理",
    NO_CHASE: "不追，等回落",
    NO_PRICE: "还没有有效价格"
  }[state];
  console.log(`${prefix}: ${state} - ${label}`);
}

function formatDateTimeFromUnix(seconds) {
  if (!seconds) return "n/a";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false
  }).format(new Date(Number(seconds) * 1000));
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "0s";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours}h ${minutes}m ${secs}s`;
}

function printV2(status, config, targetMeta, quoteMeta) {
  console.log("PancakeSwap V2");
  if (!status?.exists) {
    console.log("- pair: not found");
    console.log("");
    return;
  }

  console.log(`- pair: ${status.pair}`);
  console.log(`- price: ${fmtDecimal(status.price)} ${config.quoteSymbol}/${targetMeta.symbol}`);
  console.log(
    `- reserves: ${fmtDecimal(toDecimalAmount(status.reserveQuote, quoteMeta.decimals), 2)} ${quoteMeta.symbol} / ${fmtDecimal(toDecimalAmount(status.reserveTarget, targetMeta.decimals), 2)} ${targetMeta.symbol}`
  );
  for (const probe of status.probes) {
    console.log(
      `- buy ${probe.amountIn} ${quoteMeta.symbol}: out ${fmtDecimal(probe.amountOutHuman, 4)} ${targetMeta.symbol}, avg ${fmtDecimal(probe.avgPrice)} ${quoteMeta.symbol}, end ${fmtDecimal(probe.endPrice)} ${quoteMeta.symbol}`
    );
  }
  printDecision(status.price, config, "- current");
  console.log("");
}

function printV3(statuses, config, targetMeta) {
  console.log("PancakeSwap V3");
  const existing = statuses.filter((item) => item.exists);
  if (existing.length === 0) {
    console.log("- pools: not found in configured fee tiers");
    console.log("");
    return;
  }

  for (const status of existing) {
    console.log(
      `- fee ${status.fee}: ${status.pool}, price ${fmtDecimal(status.price)} ${config.quoteSymbol}/${targetMeta.symbol}, liquidity ${status.liquidity.toString()}, tick ${status.tick}`
    );
    printDecision(status.price, config, "  current");
  }
  console.log("");
}

function printInfinity(status, config, targetMeta) {
  console.log("PancakeSwap Infinity CL");
  if (!status?.exists) {
    console.log(`- poolId: ${status?.poolId || config.protocols.infinityCL.poolId}`);
    console.log("- initialize event: not found in configured block window");
    console.log("");
    return;
  }

  const hookOk = sameAddress(status.hook, status.expectedHook);
  console.log(`- poolId: ${status.poolId}`);
  if (status.initializeBlock) {
    console.log(`- initialized: block ${status.initializeBlock.toString()}, tx ${status.initializeTx}`);
  } else if (status.logSource === "poolKey") {
    console.log("- initialized: poolKey read directly; Initialize log scan skipped");
  } else {
    console.log(`- initialized: ${status.logSource}; Initialize log not available from current RPC`);
  }
  console.log(`- token0/token1: ${status.token0} / ${status.token1}`);
  console.log(`- hook: ${status.hook} (${hookOk ? "matches expected" : "DIFFERS FROM EXPECTED"})`);
  if (status.hookStatus?.error) {
    console.log(`- hook status warning: ${status.hookStatus.error.shortMessage}`);
  } else if (status.hookStatus) {
    const startAt = Number(status.hookStatus.startedTimestamp || 0n);
    const blockAt = Number(status.hookStatus.blockTimestamp || 0n);
    const remaining = Math.max(0, startAt - blockAt);
    console.log(`- hook owner: ${status.hookStatus.owner}`);
    console.log(`- trading enabled: ${status.hookStatus.enabled}`);
    console.log(
      `- trading started: ${status.hookStatus.started} (starts ${formatDateTimeFromUnix(startAt)}, countdown ${formatCountdown(remaining)})`
    );
  }
  console.log(`- fee: ${status.fee ?? "n/a"}, lpFee: ${status.lpFee}, protocolFee: ${status.protocolFee}`);
  console.log(`- parameters: ${status.parameters ?? "n/a"}`);
  if (status.poolKeyError) {
    console.log(`- poolKey warning: ${status.poolKeyError.shortMessage || status.poolKeyError.message}`);
  }
  if (status.logError) {
    console.log(`- log warning: ${status.logError.shortMessage || status.logError.message}`);
  }
  console.log(`- liquidity: ${status.liquidity.toString()}`);
  console.log(`- tick: ${status.tick}`);
  console.log(`- price: ${fmtDecimal(status.price)} ${config.quoteSymbol}/${targetMeta.symbol}`);
  if (status.hookStatus && !status.hookStatus.error && !status.hookStatus.started) {
    console.log("- quote probes: skipped until hook reports trading started");
  }
  if (status.quotes?.length) {
    console.log("- quote probes:");
    for (const quote of status.quotes) {
      if (quote.ok) {
        console.log(
          `  ${quote.amountIn} ${config.quoteSymbol} -> ${fmtDecimal(quote.amountOutHuman, 4)} ${targetMeta.symbol}, avg ${fmtDecimal(quote.avgPrice)} ${config.quoteSymbol}, gas ${quote.gasEstimate.toString()}`
        );
      } else {
        console.log(
          `  ${quote.amountIn} ${config.quoteSymbol} -> quote failed (${quote.error.signature || "no signature"}): ${quote.error.shortMessage.split("\n")[0]}`
        );
      }
    }
  }
  if (status.hookStatus && !status.hookStatus.error && !status.hookStatus.started) {
    console.log("- current: WAIT - hook has not opened trading yet");
  } else {
    printDecision(status.price, config, "- current");
  }
  console.log("");
}

async function main() {
  const config = loadConfigFromArgs();
  const client = createBscClient(config.rpcUrls);
  const [blockNumber, targetMeta, quoteMeta] = await Promise.all([
    client.getBlockNumber(),
    getTokenMeta(client, config.targetToken),
    getTokenMeta(client, config.quoteToken)
  ]);

  console.log(`${config.name} status`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`BSC block: ${blockNumber.toString()}`);
  console.log(`Target: ${targetMeta.symbol} ${targetMeta.address} decimals=${targetMeta.decimals}`);
  console.log(`Quote: ${quoteMeta.symbol} ${quoteMeta.address} decimals=${quoteMeta.decimals}`);
  console.log(`Launch time: ${config.launchTime}`);
  console.log("");

  printRuleSummary(config);
  printBenchmarks(config);

  const [v2, v3, infinity] = await Promise.all([
    getV2Status({ client, config, targetMeta, quoteMeta }).catch((error) => ({
      protocol: "PancakeSwap V2",
      exists: false,
      error
    })),
    getV3Statuses({ client, config, targetMeta, quoteMeta }).catch((error) => [
      { protocol: "PancakeSwap V3", exists: false, error }
    ]),
    getInfinityCLStatus({ client, config, targetMeta, quoteMeta }).catch((error) => ({
      protocol: "PancakeSwap Infinity CL",
      exists: false,
      poolId: config.protocols.infinityCL.poolId,
      error
    }))
  ]);

  printV2(v2, config, targetMeta, quoteMeta);
  if (v2?.error) console.error(`V2 error: ${v2.error.message}`);

  printV3(v3, config, targetMeta);
  for (const item of v3) {
    if (item.error) console.error(`V3 error: ${item.error.message}`);
  }

  printInfinity(infinity, config, targetMeta);
  if (infinity.error) console.error(`Infinity error: ${infinity.error.message}`);

  const livePrices = [
    v2?.price,
    ...v3.filter((item) => item.price).map((item) => item.price),
    infinity?.price
  ].filter(Boolean);
  if (livePrices.length > 0) {
    const best = livePrices.reduce((a, b) => (new Decimal(a).lt(b) ? a : b));
    console.log(`Best observed price: ${fmtDecimal(best)} ${config.quoteSymbol}/${targetMeta.symbol}`);
    if (infinity?.hookStatus && !infinity.hookStatus.error && !infinity.hookStatus.started) {
      const startAt = Number(infinity.hookStatus.startedTimestamp || 0n);
      const blockAt = Number(infinity.hookStatus.blockTimestamp || 0n);
      console.log(
        `Decision: WAIT - hook has not opened trading yet, starts ${formatDateTimeFromUnix(startAt)} (${formatCountdown(Math.max(0, startAt - blockAt))})`
      );
    } else {
      printDecision(best, config);
    }
  }

  console.log("");
  console.log("Mode: READ_ONLY. No wallet signing and no transaction sending.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
