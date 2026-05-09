import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTargetConfig, writeTargetConfig } from "./new-target-config.js";

const TARGET = "0x1111111111111111111111111111111111111111";
const HOOK = "0x3333333333333333333333333333333333333333";
const POOL_ID = `0x${"2".repeat(64)}`;
const PARAMETERS = `0x${"4".repeat(64)}`;

function loadTemplate() {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "config/share.json"), "utf8"));
}

function baseOptions(extra = {}) {
  return {
    name: "TEST Token",
    "target-token": TARGET,
    "pool-id": POOL_ID,
    hook: HOOK,
    "launch-time": "2026-05-10T18:00:00+08:00",
    "ideal-max-price": "0.1",
    "max-buy-price": "0.12",
    "max-spend-usdt": "20",
    "ideal-spend-usdt": "20",
    "acceptable-spend-usdt": "10",
    "from-block": "123",
    ...extra
  };
}

function testCreateConfig() {
  const config = createTargetConfig(baseOptions({ "pool-parameters": PARAMETERS }), loadTemplate());
  assert.equal(config.name, "TEST Token");
  assert.equal(config.targetToken, TARGET);
  assert.equal(config.quoteSymbol, "USDT");
  assert.equal(config.launchTime, "2026-05-10T18:00:00+08:00");
  assert.equal(config.rules.idealMaxPriceUsd, "0.1");
  assert.equal(config.rules.maxBuyPriceUsd, "0.12");
  assert.equal(config.rules.cautionPriceUsd, "0.138");
  assert.equal(config.rules.noChasePriceUsd, "0.15");
  assert.equal(config.execution.maxSpendUsdt, "20");
  assert.deepEqual(config.execution.autoBuyTiers, [
    { name: "ideal", avgPriceLtUsd: "0.1", amountInUsdt: "20" },
    { name: "acceptable", avgPriceGteUsd: "0.1", avgPriceLteUsd: "0.12", amountInUsdt: "10" }
  ]);
  assert.equal(config.protocols.infinityCL.poolId, POOL_ID);
  assert.equal(config.protocols.infinityCL.expectedHook, HOOK);
  assert.equal(config.protocols.infinityCL.currency0, config.quoteToken);
  assert.equal(config.protocols.infinityCL.currency1, TARGET);
  assert.equal(config.protocols.infinityCL.fromBlock, 123);
  assert.equal(config.protocols.infinityCL.scanInitializeLogs, false);
  assert.equal(config.protocols.infinityCL.parameters, PARAMETERS);
  assert.deepEqual(config.readwiseBenchmarks, []);
}

function testWriteConfig() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-target-"));
  const out = path.join(tmp, "config/generated.json");
  const options = baseOptions({
    template: path.resolve(process.cwd(), "config/share.json"),
    out
  });

  const result = writeTargetConfig({ options, cwd: tmp });
  assert.equal(result.outPath, out);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).targetToken, TARGET);
  assert.throws(
    () => writeTargetConfig({ options, cwd: tmp }),
    /Refusing to overwrite/
  );
  assert.doesNotThrow(() => writeTargetConfig({
    options: { ...options, force: true },
    cwd: tmp
  }));
}

function testValidation() {
  assert.throws(
    () => createTargetConfig(baseOptions({ "max-buy-price": "0.09" }), loadTemplate()),
    /must be >=/
  );
  assert.throws(
    () => createTargetConfig(baseOptions({ "target-token": "0x1234" }), loadTemplate()),
    /20-byte EVM address/
  );
  assert.throws(
    () => createTargetConfig(baseOptions({ "pool-id": "0x1234" }), loadTemplate()),
    /32-byte hex/
  );
  assert.throws(
    () => createTargetConfig(baseOptions({ "take-profit-half-pct": "100", "take-profit-full-pct": "50" }), loadTemplate()),
    /take-profit-full-pct/
  );
  assert.equal(
    createTargetConfig(baseOptions({ "scan-initialize-logs": "true" }), loadTemplate())
      .protocols.infinityCL.scanInitializeLogs,
    true
  );
}

function main() {
  testCreateConfig();
  testWriteConfig();
  testValidation();
  console.log("New target config tests: ok");
}

main();
