import fs from "node:fs";
import path from "node:path";
import { loadConfigFromArgs } from "./config.js";
import {
  createBscClient,
  getInfinityCLStatus,
  getTokenMeta,
  getV2Status,
  getV3Statuses
} from "./pools.js";

function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function serialize(value) {
  return JSON.stringify(
    value,
    (_, current) => {
      if (typeof current === "bigint") return current.toString();
      if (current && typeof current.toString === "function" && current.constructor?.name === "Decimal") {
        return current.toString();
      }
      return current;
    }
  );
}

function compactInfinity(status) {
  if (!status) return null;
  return {
    exists: status.exists,
    poolId: status.poolId,
    hook: status.hook,
    hookStarted: status.hookStatus?.started ?? null,
    hookStartTimestamp: status.hookStatus?.startedTimestamp ?? null,
    blockTimestamp: status.hookStatus?.blockTimestamp ?? null,
    liquidity: status.liquidity,
    tick: status.tick,
    price: status.price,
    quotes: (status.quotes || []).map((quote) => ({
      amountIn: quote.amountIn,
      ok: quote.ok,
      amountOutHuman: quote.amountOutHuman || null,
      avgPrice: quote.avgPrice || null,
      error: quote.error?.signature || quote.error?.shortMessage || null
    }))
  };
}

async function collectSample({ client, config, targetMeta, quoteMeta }) {
  const [blockNumber, v2, v3, infinity] = await Promise.all([
    client.getBlockNumber(),
    getV2Status({ client, config, targetMeta, quoteMeta }).catch((error) => ({ exists: false, error: error.message })),
    getV3Statuses({ client, config, targetMeta, quoteMeta }).catch((error) => [{ exists: false, error: error.message }]),
    getInfinityCLStatus({ client, config, targetMeta, quoteMeta }).catch((error) => ({ exists: false, error: error.message }))
  ]);

  return {
    observedAt: new Date().toISOString(),
    blockNumber,
    target: { symbol: targetMeta.symbol, address: targetMeta.address, decimals: targetMeta.decimals },
    quote: { symbol: quoteMeta.symbol, address: quoteMeta.address, decimals: quoteMeta.decimals },
    v2: { exists: Boolean(v2?.exists), pair: v2?.pair || null, price: v2?.price || null },
    v3: v3.map((item) => ({
      fee: item.fee,
      exists: Boolean(item.exists),
      pool: item.pool || null,
      price: item.price || null,
      liquidity: item.liquidity || null
    })),
    infinity: compactInfinity(infinity)
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const config = loadConfigFromArgs();
  const count = Number(getArg("--count", 12));
  const intervalMs = Number(getArg("--interval-ms", 5000));
  const outDir = path.resolve(process.cwd(), "data/samples");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `share-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);

  const client = createBscClient(config.rpcUrls);
  const [targetMeta, quoteMeta] = await Promise.all([
    getTokenMeta(client, config.targetToken),
    getTokenMeta(client, config.quoteToken)
  ]);

  for (let i = 0; i < count; i++) {
    const sample = await collectSample({ client, config, targetMeta, quoteMeta });
    fs.appendFileSync(outPath, `${serialize(sample)}\n`);
    const price = sample.infinity?.price?.toString?.() || "n/a";
    console.log(
      `sample ${i + 1}/${count}: block=${sample.blockNumber.toString()} infinityPrice=${price} hookStarted=${sample.infinity?.hookStarted}`
    );
    if (i < count - 1) await sleep(intervalMs);
  }

  console.log(`Wrote samples: ${outPath}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
