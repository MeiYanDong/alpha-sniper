import { encodeFunctionData } from "viem";
import { loadConfigFromArgs } from "./config.js";
import { clAlphaHookAbi, infinityCLPoolManagerAbi } from "./abis.js";

const PUBLIC_BSC_RPC_URL = "https://bsc-dataseed.binance.org";

function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function classifyError(error) {
  if (error.name === "AbortError") return "timeout";
  if (error.code === 429 || String(error.message).match(/rate/i)) return "quota";
  if (String(error.message).match(/limit|exceed/i)) return "provider-limit";
  return error.code ? `rpc:${error.code}` : "network";
}

async function rpcCall(url, method, params = [], timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal
    });
    const json = await response.json();
    if (json.error) {
      const error = new Error(json.error.message || "rpc error");
      error.code = json.error.code;
      throw error;
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
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

function getProviders(config) {
  const providers = [];
  if (process.env.BSC_RPC_URL) providers.push({ label: "chainstack-primary", url: process.env.BSC_RPC_URL });
  if (process.env.CHAINSTACK_BSC_RPC_URL && process.env.CHAINSTACK_BSC_RPC_URL !== process.env.BSC_RPC_URL) {
    providers.push({ label: "chainstack-alias", url: process.env.CHAINSTACK_BSC_RPC_URL });
  }
  if (config.defaultRpcUrl) providers.push({ label: "config-fallback", url: config.defaultRpcUrl });
  if (!providers.some((provider) => provider.url === PUBLIC_BSC_RPC_URL)) {
    providers.push({ label: "public-bsc", url: PUBLIC_BSC_RPC_URL });
  }
  return providers;
}

async function runProviderStress({ provider, calls, durationMs, concurrency }) {
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
      total++;
      try {
        await rpcCall(provider.url, call.method, call.params);
        ok++;
        latencies.push(Date.now() - startedAt);
      } catch (error) {
        const key = `${call.name}:${classifyError(error)}`;
        errors.set(key, (errors.get(key) || 0) + 1);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    label: provider.label,
    total,
    ok,
    failed: total - ok,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    maxMs: latencies.length ? Math.max(...latencies) : 0,
    errors: Object.fromEntries(errors)
  };
}

async function main() {
  const config = loadConfigFromArgs();
  const durationMs = Number(getArg("--duration-ms", 30_000));
  const concurrency = Number(getArg("--concurrency", 4));
  const calls = buildCalls(config);
  const providers = getProviders(config);

  console.log(`RPC stress: duration=${durationMs}ms concurrency=${concurrency} calls=${calls.map((call) => call.name).join(",")}`);
  for (const provider of providers) {
    const result = await runProviderStress({ provider, calls, durationMs, concurrency });
    console.log(
      `- ${result.label}: ok=${result.ok}/${result.total}, failed=${result.failed}, p50=${result.p50Ms}ms, p95=${result.p95Ms}ms, max=${result.maxMs}ms`
    );
    for (const [error, count] of Object.entries(result.errors)) {
      console.log(`  - ${error}: ${count}`);
    }
  }

  if (process.env.ANKR_MULTICHAIN_RPC_URL) {
    const ankrConcurrency = Math.min(2, concurrency);
    const result = await runProviderStress({
      provider: { label: "ankr-wallet-discovery", url: process.env.ANKR_MULTICHAIN_RPC_URL },
      calls: buildAnkrCalls(config),
      durationMs,
      concurrency: ankrConcurrency
    });
    console.log(
      `- ${result.label}: ok=${result.ok}/${result.total}, failed=${result.failed}, p50=${result.p50Ms}ms, p95=${result.p95Ms}ms, max=${result.maxMs}ms`
    );
    for (const [error, count] of Object.entries(result.errors)) {
      console.log(`  - ${error}: ${count}`);
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
