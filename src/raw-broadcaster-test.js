import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function createMockRpc({ label, acceptsRawTx }) {
  let sendRawCalls = 0;
  const server = http.createServer(async (req, res) => {
    const body = await readJson(req);
    if (body.method === "eth_blockNumber") {
      sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result: "0x123" });
      return;
    }

    if (body.method === "eth_sendRawTransaction") {
      sendRawCalls += 1;
      if (acceptsRawTx) {
        sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result: `0x${label.padEnd(64, "0")}` });
      } else {
        sendJson(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32000, message: "insufficient funds for gas * price + value" }
        });
      }
      return;
    }

    sendJson(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "not found" } });
  });

  return {
    server,
    get sendRawCalls() {
      return sendRawCalls;
    }
  };
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 5000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`broadcaster did not become healthy; exitCode=${child.exitCode}; last=${lastError?.message || ""}`);
}

async function main() {
  const acceptingRpc = createMockRpc({ label: "a", acceptsRawTx: true });
  const rejectingRpc = createMockRpc({ label: "b", acceptsRawTx: false });
  const [acceptingAddress, rejectingAddress] = await Promise.all([
    listen(acceptingRpc.server),
    listen(rejectingRpc.server)
  ]);

  const broadcasterPortServer = http.createServer();
  const broadcasterAddress = await listen(broadcasterPortServer);
  await close(broadcasterPortServer);
  const broadcasterPort = broadcasterAddress.port;

  const child = spawn(
    process.execPath,
    [
      "src/raw-broadcaster-server.js",
      "--config",
      "config/share.json",
      "--host",
      "127.0.0.1",
      "--port",
      String(broadcasterPort),
      "--broadcast-labels",
      "chainstack-primary,ankr-bsc"
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        RAW_BROADCASTER_TOKEN: "test-token",
        BSC_RPC_URL: `http://127.0.0.1:${acceptingAddress.port}`,
        CHAINSTACK_BSC_RPC_URL: "",
        ANKR_BSC_RPC_URL: `http://127.0.0.1:${rejectingAddress.port}`
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const health = await waitForHealth(broadcasterPort, child);
    assert.equal(health.ok, true);
    assert.equal(health.privateKeyRequired, false);
    assert.deepEqual(health.providers, ["chainstack-primary", "ankr-bsc"]);

    const unauthorized = await fetch(`http://127.0.0.1:${broadcasterPort}/prewarm`, { method: "POST" });
    assert.equal(unauthorized.status, 401);

    const invalidRaw = await fetch(`http://127.0.0.1:${broadcasterPort}/broadcast`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ rawTx: "0x00" })
    });
    assert.equal(invalidRaw.status, 400);

    const prewarm = await fetch(`http://127.0.0.1:${broadcasterPort}/prewarm`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" }
    });
    assert.equal(prewarm.status, 200);
    const prewarmJson = await prewarm.json();
    assert.equal(prewarmJson.ok, true);
    assert.equal(prewarmJson.okCount, 2);

    const broadcast = await fetch(`http://127.0.0.1:${broadcasterPort}/broadcast`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ rawTx: "0x123456", waitAll: true })
    });
    assert.equal(broadcast.status, 200);
    const broadcastJson = await broadcast.json();
    assert.equal(broadcastJson.ok, true);
    assert.equal(broadcastJson.okCount, 1);
    assert.equal(broadcastJson.providerCount, 2);
    assert.equal(acceptingRpc.sendRawCalls, 1);
    assert.equal(rejectingRpc.sendRawCalls, 1);
  } finally {
    child.kill();
    await Promise.all([close(acceptingRpc.server), close(rejectingRpc.server)]);
  }

  if (child.exitCode && child.exitCode !== 0 && !child.killed) {
    throw new Error(`broadcaster exited unexpectedly: stdout=${stdout} stderr=${stderr}`);
  }

  console.log("Raw broadcaster tests: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
