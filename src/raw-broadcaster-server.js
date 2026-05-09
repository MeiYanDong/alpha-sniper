import http from "node:http";
import { loadConfigFromArgs } from "./config.js";
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

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRawTransaction(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) && value.length > 4;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requireAuth(req, token) {
  const expected = `Bearer ${token}`;
  return req.headers.authorization === expected;
}

async function timedProviderCall(provider, method, params, timeoutMs) {
  const startedAt = performance.now();
  try {
    const value = await rawRpcCall(provider.url, method, params, { timeoutMs });
    return {
      ok: true,
      label: provider.label,
      latencyMs: Math.round(performance.now() - startedAt),
      value
    };
  } catch (error) {
    return {
      ok: false,
      label: provider.label,
      latencyMs: Math.round(performance.now() - startedAt),
      errorType: classifyRpcError(error),
      message: error.shortMessage || error.message || String(error)
    };
  }
}

async function prewarmProviders({ providers, timeoutMs }) {
  return Promise.all(providers.map((provider) => timedProviderCall(provider, "eth_blockNumber", [], timeoutMs)));
}

function summarize(results, { valueKey = "hash" } = {}) {
  return results.map((result) =>
    result.ok
      ? { label: result.label, ok: true, latencyMs: result.latencyMs, [valueKey]: result.value }
      : { label: result.label, ok: false, latencyMs: result.latencyMs, errorType: result.errorType }
  );
}

async function broadcastToProviders({ providers, rawTx, timeoutMs, waitAll }) {
  const startedAt = performance.now();
  const tasks = providers.map((provider) => timedProviderCall(provider, "eth_sendRawTransaction", [rawTx], timeoutMs));
  if (waitAll) {
    const results = await Promise.all(tasks);
    const success = results.find((result) => result.ok);
    return {
      ok: Boolean(success),
      hash: success?.value || null,
      winnerLabel: success?.label || null,
      latencyMs: Math.round(performance.now() - startedAt),
      okCount: results.filter((result) => result.ok).length,
      providerCount: providers.length,
      providers: summarize(results)
    };
  }

  return new Promise((resolve) => {
    const results = [];
    let remaining = tasks.length;
    let settled = false;
    for (const task of tasks) {
      task.then((result) => {
        results.push(result);
        remaining -= 1;
        if (!settled && result.ok) {
          settled = true;
          resolve({
            ok: true,
            hash: result.value,
            winnerLabel: result.label,
            latencyMs: Math.round(performance.now() - startedAt),
            okCount: 1,
            providerCount: providers.length,
            providers: summarize([result])
          });
        }
        if (remaining === 0 && !settled) {
          resolve({
            ok: false,
            hash: null,
            winnerLabel: null,
            latencyMs: Math.round(performance.now() - startedAt),
            okCount: 0,
            providerCount: providers.length,
            providers: summarize(results)
          });
        }
      });
    }
  });
}

async function main() {
  const config = loadConfigFromArgs();
  const host = getArg("--host", process.env.RAW_BROADCASTER_HOST || "127.0.0.1");
  const port = Number(getArg("--port", process.env.RAW_BROADCASTER_PORT || "8787"));
  const timeoutMs = toPositiveNumber(getArg("--timeout-ms", "3000"), 3_000);
  const prewarmTimeoutMs = toPositiveNumber(getArg("--prewarm-timeout-ms", "1000"), 1_000);
  const token = process.env.RAW_BROADCASTER_TOKEN || process.env.REMOTE_BROADCASTER_TOKEN || getArg("--token", "");
  if (!token) throw new Error("RAW_BROADCASTER_TOKEN or REMOTE_BROADCASTER_TOKEN is required");

  const includePublic = hasFlag("--broadcast-public");
  const providers = filterRpcProviders(
    getSafeRpcProviders(config, { includePublic }),
    getArg("--broadcast-labels", "")
  );
  if (providers.length === 0) throw new Error("No RPC providers available for raw broadcaster");

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, {
          ok: true,
          privateKeyRequired: false,
          providers: providers.map((provider) => provider.label)
        });
        return;
      }

      if (req.method !== "POST" || !["/prewarm", "/broadcast"].includes(req.url || "")) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }

      if (!requireAuth(req, token)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      if (req.url === "/prewarm") {
        const results = await prewarmProviders({ providers, timeoutMs: prewarmTimeoutMs });
        sendJson(res, 200, {
          ok: true,
          okCount: results.filter((result) => result.ok).length,
          providerCount: providers.length,
          providers: summarize(results, { valueKey: "blockNumber" })
        });
        return;
      }

      const body = await readJson(req);
      if (!isRawTransaction(body.rawTx)) {
        sendJson(res, 400, { ok: false, error: "rawTx must be a 0x-prefixed signed transaction" });
        return;
      }

      const result = await broadcastToProviders({
        providers,
        rawTx: body.rawTx,
        timeoutMs,
        waitAll: Boolean(body.waitAll)
      });
      sendJson(res, result.ok ? 200 : 502, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
  });

  server.listen(port, host, () => {
    console.log(
      `Raw broadcaster listening on http://${host}:${port} providers=${providers.map((provider) => provider.label).join(",")}`
    );
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
