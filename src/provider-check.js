import { loadProjectEnv } from "./env.js";

loadProjectEnv();

const PUBLIC_BSC_RPC_URL = "https://bsc-dataseed.binance.org";
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
const SHARE = "0x5FCA51aff213bFBEAB0b711b93c3374252fD6aC3";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const CHECKS = [
  "ANKR_MULTICHAIN_RPC_URL",
  "BSC_RPC_URL",
  "CHAINSTACK_BSC_RPC_URL",
  "CHAINSTACK_API_KEY"
];

function presence(name) {
  return process.env[name] ? "present" : "missing";
}

function toHexBlock(number) {
  return `0x${number.toString(16)}`;
}

async function postJson(url, body, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const json = await response.json();
    if (json.error) {
      const error = new Error(json.error.message || "rpc error");
      error.code = json.error.code;
      throw error;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function classifyError(error) {
  if (error.name === "AbortError") return "timeout";
  if (error.code === 401 || error.code === -32001) return "auth";
  if (error.code === 429 || String(error.message).includes("rate")) return "quota";
  if (String(error.message).match(/limit|exceed/i)) return "provider-limit";
  return error.code ? `rpc:${error.code}` : "network";
}

async function safeCheck(fn) {
  try {
    await fn();
    return "ok";
  } catch (error) {
    return `failed:${classifyError(error)}`;
  }
}

async function rpcCall(rpc, method, params = []) {
  const result = await postJson(rpc, {
    jsonrpc: "2.0",
    id: 1,
    method,
    params
  });
  return result.result;
}

async function checkStandardRpc(rpc) {
  if (!rpc) return { available: "missing" };
  const blockNumberHex = await rpcCall(rpc, "eth_blockNumber");
  if (typeof blockNumberHex !== "string") throw new Error("no block number");
  const blockNumber = Number.parseInt(blockNumberHex, 16);

  const checks = {};
  checks.blockNumber = "ok";
  checks.latestBlock = await safeCheck(async () => {
    const block = await rpcCall(rpc, "eth_getBlockByNumber", ["latest", false]);
    if (!block?.timestamp) throw new Error("missing block timestamp");
  });
  checks.ethCall = await safeCheck(async () => {
    const symbol = await rpcCall(rpc, "eth_call", [{ to: BSC_USDT, data: "0x95d89b41" }, "latest"]);
    if (typeof symbol !== "string" || !symbol.startsWith("0x")) throw new Error("bad eth_call result");
  });
  checks.narrowLogs = await safeCheck(async () => {
    const logs = await rpcCall(rpc, "eth_getLogs", [
      {
        address: BSC_USDT,
        fromBlock: toHexBlock(Math.max(0, blockNumber - 5)),
        toBlock: "latest",
        topics: [TRANSFER_TOPIC]
      }
    ]);
    if (!Array.isArray(logs)) throw new Error("bad logs result");
  });

  return { available: "present", ...checks };
}

async function safeStandardRpcCheck(rpc) {
  try {
    return await checkStandardRpc(rpc);
  } catch (error) {
    return { available: `failed:${classifyError(error)}` };
  }
}

async function checkAnkr() {
  const rpc = process.env.ANKR_MULTICHAIN_RPC_URL;
  if (!rpc) return "missing";
  return safeCheck(async () => {
    const result = await postJson(rpc, {
      jsonrpc: "2.0",
      id: 1,
      method: "ankr_getTransactionsByAddress",
      params: {
        blockchain: "bsc",
        address: SHARE,
        descOrder: true,
        includeLogs: false,
        pageSize: 1
      }
    });
    if (!result.result) throw new Error("no result");
  });
}

function printRpcResult(label, result) {
  console.log(`- ${label}: ${result.available}`);
  for (const [key, value] of Object.entries(result)) {
    if (key === "available") continue;
    console.log(`  - ${key}: ${value}`);
  }
}

async function main() {
  console.log("Provider credentials");
  for (const name of CHECKS) {
    console.log(`- ${name}: ${presence(name)}`);
  }
  console.log("");
  console.log("Provider checks");
  printRpcResult(
    "Chainstack/BSC standard RPC",
    await safeStandardRpcCheck(process.env.BSC_RPC_URL || process.env.CHAINSTACK_BSC_RPC_URL)
  );
  console.log(`- Ankr getTransactionsByAddress: ${await checkAnkr()}`);
  printRpcResult("Public BSC fallback", await safeStandardRpcCheck(PUBLIC_BSC_RPC_URL));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
