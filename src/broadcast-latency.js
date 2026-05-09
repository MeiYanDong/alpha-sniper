import { randomBytes } from "node:crypto";
import { parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfigFromArgs } from "./config.js";
import {
  classifyRpcError,
  filterRpcProviders,
  getSafeRpcProviders,
  rawRpcCall
} from "./rpc-providers.js";

const INVALID_RAW_TX = "0x00";
const BSC_CHAIN_ID = 56;

function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function summarizeLatencies(latencies) {
  return {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.length ? Math.max(...latencies) : 0
  };
}

async function buildRawTx({ mode, gasPriceGwei }) {
  if (mode === "invalid") {
    return {
      rawTx: INVALID_RAW_TX,
      description: "invalid raw tx 0x00",
      safety: "expected result is provider rejection, not chain inclusion"
    };
  }

  if (mode === "zero-balance-signed") {
    const privateKey = `0x${randomBytes(32).toString("hex")}`;
    const account = privateKeyToAccount(privateKey);
    const rawTx = await account.signTransaction({
      chainId: BSC_CHAIN_ID,
      to: account.address,
      value: 1n,
      nonce: 0,
      gas: 21_000n,
      gasPrice: parseGwei(String(gasPriceGwei))
    });
    return {
      rawTx,
      description: `zero-balance signed tx from ephemeral ${account.address}`,
      safety: "uses a random one-time wallet with no funds; expected result is insufficient-funds rejection"
    };
  }

  throw new Error(`Unsupported broadcast latency mode: ${mode}`);
}

function printSummary(label, result) {
  const latency = summarizeLatencies(result.latencies);
  console.log(
    `- ${label}: rejected=${result.rejected}/${result.total} accepted=${result.accepted} p50=${latency.p50.toFixed(1)}ms p95=${latency.p95.toFixed(1)}ms p99=${latency.p99.toFixed(1)}ms max=${latency.max.toFixed(1)}ms`
  );
  for (const [error, count] of Object.entries(result.errors)) {
    console.log(`  - ${error}: ${count}`);
  }
}

async function timedRpc(provider, method, params, timeoutMs) {
  const startedAt = performance.now();
  try {
    const value = await rawRpcCall(provider.url, method, params, { timeoutMs });
    return {
      ok: true,
      latencyMs: performance.now() - startedAt,
      value
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: performance.now() - startedAt,
      error
    };
  }
}

async function testProvider(provider, { samples, timeoutMs, prewarm, rawTx }) {
  if (prewarm) {
    await timedRpc(provider, "eth_blockNumber", [], timeoutMs);
  }

  const result = {
    total: samples,
    rejected: 0,
    accepted: 0,
    latencies: [],
    errors: {}
  };

  for (let index = 0; index < samples; index += 1) {
    const response = await timedRpc(provider, "eth_sendRawTransaction", [rawTx], timeoutMs);
    result.latencies.push(response.latencyMs);
    if (response.ok) {
      result.accepted += 1;
      result.errors.accepted_unexpectedly = (result.errors.accepted_unexpectedly || 0) + 1;
      continue;
    }

    result.rejected += 1;
    const key = classifyRpcError(response.error);
    result.errors[key] = (result.errors[key] || 0) + 1;
  }

  return result;
}

async function main() {
  const config = loadConfigFromArgs();
  const samples = Math.floor(toPositiveNumber(getArg("--samples", "5"), 5));
  const timeoutMs = toPositiveNumber(getArg("--timeout-ms", "3000"), 3_000);
  const mode = getArg("--mode", "invalid");
  const gasPriceGwei = toPositiveNumber(getArg("--gas-price-gwei", "1"), 1);
  const includePublic = !hasFlag("--no-public");
  const prewarm = hasFlag("--prewarm");
  const providers = filterRpcProviders(
    getSafeRpcProviders(config, { includePublic }),
    getArg("--providers", "")
  );

  if (providers.length === 0) {
    throw new Error("No RPC providers available for broadcast latency test");
  }

  const tx = await buildRawTx({ mode, gasPriceGwei });

  console.log(
    `Broadcast rejection latency: samples=${samples} timeout=${timeoutMs}ms prewarm=${prewarm ? "yes" : "no"} mode=${mode}`
  );
  console.log(`Safety: ${tx.description}; ${tx.safety}.`);

  for (const provider of providers) {
    printSummary(provider.label, await testProvider(provider, { samples, timeoutMs, prewarm, rawTx: tx.rawTx }));
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
