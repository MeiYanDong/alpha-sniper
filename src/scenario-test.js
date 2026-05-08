import assert from "node:assert/strict";
import { loadConfigFromArgs, sameAddress } from "./config.js";
import { decideAutoBuy, decideAutoSell, getExecutionConfig, getExitConfig } from "./decision.js";
import { buildInfinityExactInputSingleExecute } from "./infinity-swap.js";
import { classifyPrice } from "./math.js";

function assertDecision(config, price, expected) {
  assert.equal(classifyPrice(price, config.rules), expected, `${price} should be ${expected}`);
}

function assertIncreasingBenchmarks(config) {
  let previousAmount = 0;
  let previousAvg = 0;
  let previousEnd = 0;
  for (const item of config.readwiseBenchmarks || []) {
    const amount = Number(item.amountInUsdt);
    const avg = Number(item.avgUsd);
    const end = Number(item.endUsd);
    assert.ok(amount > previousAmount, "benchmark amount should increase");
    assert.ok(avg > previousAvg, "benchmark avg price should increase");
    assert.ok(end > previousEnd, "benchmark end price should increase");
    previousAmount = amount;
    previousAvg = avg;
    previousEnd = end;
  }
}

function assertConfigShape(config) {
  assert.equal(config.chainId, 56, "SHARE config should be BSC");
  assert.ok(config.targetToken.startsWith("0x"), "target token should be EVM address");
  assert.ok(config.quoteToken.startsWith("0x"), "quote token should be EVM address");
  assert.ok(!sameAddress(config.targetToken, config.quoteToken), "target and quote token differ");
  assert.ok(config.protocols.infinityCL.poolId.startsWith("0x"), "Infinity poolId should be hex");
  assert.ok(config.protocols.infinityCL.expectedHook.startsWith("0x"), "hook should be EVM address");
  assert.equal(new Date(config.launchTime).toISOString(), "2026-05-08T10:00:00.000Z");
  assert.equal(getExecutionConfig(config).maxSpendUsdt, "20");
  assert.equal(getExitConfig(config).defaultSellBps, 10000);
}

function assertAutoDecision(config, input, expectedAction, expectedReason) {
  const result = decideAutoBuy({ config, ...input });
  assert.equal(result.action, expectedAction);
  assert.equal(result.reason, expectedReason);
}

function main() {
  const config = loadConfigFromArgs();
  assertConfigShape(config);
  assertIncreasingBenchmarks(config);

  assertDecision(config, null, "NO_PRICE");
  assertDecision(config, "0.30", "IDEAL");
  assertDecision(config, config.rules.idealMaxPriceUsd, "IDEAL");
  assertDecision(config, "0.35", "OK");
  assertDecision(config, config.rules.maxBuyPriceUsd, "OK");
  assertDecision(config, "0.40", "CAUTION");
  assertDecision(config, config.rules.cautionPriceUsd, "CAUTION");
  assertDecision(config, "0.45", "HIGH");
  assertDecision(config, config.rules.noChasePriceUsd, "NO_CHASE");

  assertAutoDecision(
    config,
    { hookStarted: false },
    "WAIT",
    "HOOK_NOT_STARTED"
  );
  assertAutoDecision(
    config,
    { hookStarted: true, quoteOk: false },
    "SKIP",
    "QUOTE_FAILED"
  );
  assertAutoDecision(
    config,
    { hookStarted: true, quoteOk: true, avgPriceUsd: "0.3399", currentPriceUsd: "0.30" },
    "BUY_EXACT_IN",
    "MATCHED_TIER_IDEAL"
  );
  assert.equal(
    decideAutoBuy({
      config,
      hookStarted: true,
      quoteOk: true,
      avgPriceUsd: "0.3399",
      currentPriceUsd: "0.30"
    }).amountInUsdt,
    "20"
  );
  assertAutoDecision(
    config,
    { hookStarted: true, quoteOk: true, avgPriceUsd: "0.34", currentPriceUsd: "0.34" },
    "BUY_EXACT_IN",
    "MATCHED_TIER_ACCEPTABLE"
  );
  assert.equal(
    decideAutoBuy({
      config,
      hookStarted: true,
      quoteOk: true,
      avgPriceUsd: "0.38",
      currentPriceUsd: "0.38"
    }).amountInUsdt,
    "10"
  );
  assertAutoDecision(
    config,
    { hookStarted: true, quoteOk: true, avgPriceUsd: "0.3801", currentPriceUsd: "0.30" },
    "SKIP",
    "NO_AUTO_BUY_TIER_MATCHED"
  );

  assert.equal(
    decideAutoSell({
      config,
      hasPosition: false
    }).reason,
    "NO_POSITION"
  );
  assert.equal(
    decideAutoSell({
      config,
      hasPosition: true,
      hookStarted: true,
      quoteOk: true,
      avgExitPriceUsd: "0.28",
      entryAvgPriceUsd: "0.34"
    }).reason,
    "STOP_LOSS"
  );
  assert.equal(
    decideAutoSell({
      config,
      hasPosition: true,
      hookStarted: true,
      quoteOk: true,
      avgExitPriceUsd: "0.52",
      entryAvgPriceUsd: "0.34"
    }).reason,
    "TAKE_PROFIT_FIRST_PROFIT"
  );
  assert.equal(
    decideAutoSell({
      config,
      hasPosition: true,
      hookStarted: true,
      quoteOk: true,
      avgExitPriceUsd: "0.72",
      entryAvgPriceUsd: "0.34"
    }).sellBps,
    10000
  );

  const pool = config.protocols.infinityCL;
  const tx = buildInfinityExactInputSingleExecute({
    poolKey: [
      pool.currency0,
      pool.currency1,
      pool.expectedHook,
      config.addresses.infinityCLPoolManager,
      67,
      pool.parameters || "0x00000000000000000000000000000000000000000000000000000000000a0045"
    ],
    zeroForOne: true,
    amountIn: 20_000000000000000000n,
    amountOutMinimum: 1n,
    inputCurrency: config.quoteToken,
    outputCurrency: config.targetToken,
    deadline: 1778234460n
  });
  assert.equal(tx.commands, "0x10");
  assert.equal(tx.inputs.length, 1);
  assert.ok(tx.calldata.startsWith("0x3593564c"), "router execute calldata selector");

  console.log("Scenario tests: ok");
}

main();
