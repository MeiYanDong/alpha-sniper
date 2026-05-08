import { encodeFunctionData } from "viem";
import { loadConfigFromArgs } from "./config.js";
import { clAlphaHookAbi, infinityCLPoolManagerAbi } from "./abis.js";
import {
  classifyRpcError,
  filterRpcProviders,
  getSafeRpcProviders,
  rawRpcCall
} from "./rpc-providers.js";

function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildCalls(config) {
  const poolId = config.protocols.infinityCL.poolId;
  return [
    { name: "eth_blockNumber", method: "eth_blockNumber", params: [] },
    {
      name: "getSlot0",
      method: "eth_call",
      params: [
        {
          to: config.addresses.infinityCLPoolManager,
          data: encodeFunctionData({
            abi: infinityCLPoolManagerAbi,
            functionName: "getSlot0",
            args: [poolId]
          })
        },
        "latest"
      ]
    },
    {
      name: "getLiquidity",
      method: "eth_call",
      params: [
        {
          to: config.addresses.infinityCLPoolManager,
          data: encodeFunctionData({
            abi: infinityCLPoolManagerAbi,
            functionName: "getLiquidity",
            args: [poolId]
          })
        },
        "latest"
      ]
    },
    {
      name: "isPoolStarted",
      method: "eth_call",
      params: [
        {
          to: config.protocols.infinityCL.expectedHook,
          data: encodeFunctionData({
            abi: clAlphaHookAbi,
            functionName: "isPoolStarted",
            args: [poolId]
          })
        },
        "latest"
      ]
    }
  ];
}

function buildAnkrCalls(config) {
  return [
    {
      name: "ankr_getTransactionsByAddress",
      method: "ankr_getTransactionsByAddress",
      params: {
        blockchain: "bsc",
        address: config.targetToken,
        descOrder: true,
        includeLogs: false,
        pageSize: 1
      }
    }
  ];
}

async function runProviderStress({ provider, calls, durationMs, concurrency, timeoutMs }) {
  const deadline = Date.now() + durationMs;
  const latencies = [];
  const errors = new Map();
  let ok = 0;
  let total = 0;
  let cursor = 0;

  async function worker() {
    while (Date.now() < deadline) {
      const call = calls[cursor++ % calls.length];
      const startedAt = Date.now();
      total += 1;
      try {
        await rawRpcCall(provider.url, call.method, call.params, { timeoutMs });
        ok += 1;
        latencies.push(Date.now() - startedAt);
      } catch (error) {
        const key = `${call.name}:${classifyRpcError(error)}`;
        errors.set(key, (errors.get(key) || 0) + 1);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const failed = total - ok;
  return {
    label: provider.label,
    concurrency,
    total,
    ok,
    failed,
    failureRatePct: total ? (failed / total) * 100 : 100,
    rps: total / (durationMs / 1000),
    okRps: ok / (durationMs / 1000),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    maxMs: latencies.length ? Math.max(...latencies) : 0,
    errors: Object.fromEntries(errors)
  };
}

function parseConcurrencySteps(raw) {
  return String(raw)
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function shouldStop(result, { maxFailurePct, maxP95Ms }) {
  if (result.failureRatePct > maxFailurePct) return `failure>${maxFailurePct}%`;
  if (result.p95Ms > maxP95Ms) return `p95>${maxP95Ms}ms`;
  return null;
}

function printResult(result) {
  console.log(
    `  c=${String(result.concurrency).padEnd(2)} ok=${result.ok}/${result.total} fail=${result.failed} (${result.failureRatePct.toFixed(2)}%) rps=${result.rps.toFixed(1)} okRps=${result.okRps.toFixed(1)} p50=${result.p50Ms}ms p95=${result.p95Ms}ms p99=${result.p99Ms}ms max=${result.maxMs}ms`
  );
  for (const [error, count] of Object.entries(result.errors)) {
    console.log(`    - ${error}: ${count}`);
  }
}

async function runStepsForProvider({ provider, calls, steps, durationMs, timeoutMs, maxFailurePct, maxP95Ms }) {
  console.log(`- ${provider.label}`);
  const results = [];
  for (const concurrency of steps) {
    const result = await runProviderStress({ provider, calls, durationMs, concurrency, timeoutMs });
    results.push(result);
    printResult(result);

    const stopReason = shouldStop(result, { maxFailurePct, maxP95Ms });
    if (stopReason) {
      console.log(`    stop: ${stopReason}`);
      break;
    }
  }
  return results;
}

function summarizeBoundary(providerResults, { maxFailurePct, maxP95Ms }) {
  const stable = providerResults.filter((result) => !shouldStop(result, { maxFailurePct, maxP95Ms }));
  const best = stable.at(-1);
  const firstBad = providerResults.find((result) => shouldStop(result, { maxFailurePct, maxP95Ms }));
  if (!best) {
    return {
      label: providerResults[0]?.label || "unknown",
      recommendation: "no stable step",
      firstBad
    };
  }
  return {
    label: best.label,
    recommendation: `stable c=${best.concurrency}, okRps=${best.okRps.toFixed(1)}, p95=${best.p95Ms}ms`,
    firstBad
  };
}

async function main() {
  const config = loadConfigFromArgs();
  const durationMs = toNumber(getArg("--duration-ms", "10000"), 10_000);
  const timeoutMs = toNumber(getArg("--timeout-ms", "5000"), 5_000);
  const steps = parseConcurrencySteps(getArg("--steps", getArg("--concurrency", "1,2,4,8,12,16,24,32")));
  const maxFailurePct = toNumber(getArg("--max-failure-pct", "1"), 1);
  const maxP95Ms = toNumber(getArg("--max-p95-ms", "1000"), 1_000);
  const includePublic = hasFlag("--include-public");
  const providers = filterRpcProviders(
    getSafeRpcProviders(config, { includePublic }),
    getArg("--providers", "")
  );
  const calls = buildCalls(config);

  console.log(
    `RPC stress ladder: duration=${durationMs}ms timeout=${timeoutMs}ms steps=${steps.join(",")} calls=${calls.map((call) => call.name).join(",")}`
  );
  console.log(`Boundary rule: failure<=${maxFailurePct}% and p95<=${maxP95Ms}ms`);

  const allResults = [];
  for (const provider of providers) {
    const results = await runStepsForProvider({
      provider,
      calls,
      steps,
      durationMs,
      timeoutMs,
      maxFailurePct,
      maxP95Ms
    });
    allResults.push(results);
  }

  if (process.env.ANKR_MULTICHAIN_RPC_URL && (hasFlag("--ankr") || providers.length === 0)) {
    const ankrResults = await runStepsForProvider({
      provider: { label: "ankr-wallet-discovery", url: process.env.ANKR_MULTICHAIN_RPC_URL },
      calls: buildAnkrCalls(config),
      steps: steps.map((step) => Math.min(step, 4)).filter((step, index, values) => values.indexOf(step) === index),
      durationMs,
      timeoutMs,
      maxFailurePct,
      maxP95Ms
    });
    allResults.push(ankrResults);
  }

  console.log("");
  console.log("Boundary summary");
  for (const providerResults of allResults.filter((results) => results.length > 0)) {
    const summary = summarizeBoundary(providerResults, { maxFailurePct, maxP95Ms });
    console.log(`- ${summary.label}: ${summary.recommendation}`);
    if (summary.firstBad) {
      console.log(
        `  first bad c=${summary.firstBad.concurrency}, fail=${summary.firstBad.failureRatePct.toFixed(2)}%, p95=${summary.firstBad.p95Ms}ms`
      );
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
