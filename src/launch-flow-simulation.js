import assert from "node:assert/strict";
import Decimal from "decimal.js";
import { formatUnits, parseUnits } from "viem";
import { loadConfigFromArgs } from "./config.js";
import { runLaunchExecutor } from "./share-launch-executor.js";

const SIM_ACCOUNT = "0x0000000000000000000000000000000000000a11";

const scenarios = [
  {
    id: "S01",
    name: "授权缺失，开盘前直接拦住",
    approvalOk: false,
    expected: { action: "SKIP", reason: "APPROVAL_MISSING" }
  },
  {
    id: "S02",
    name: "USDT 余额不足，开盘前直接拦住",
    balanceOk: false,
    expected: { action: "SKIP", reason: "BALANCE_TOO_LOW" }
  },
  {
    id: "S03",
    name: "hook 到截止时间仍未开始",
    hookStarted: false,
    expected: { action: "WAIT", reason: "HOOK_NOT_STARTED" }
  },
  {
    id: "S04",
    name: "开盘后 Quoter 一直失败",
    quoteAttempts: [
      { quotes: { default: { ok: false, error: "PoolNotStarted/QuoterError" } } },
      { quotes: { default: { ok: false, error: "PoolNotStarted/QuoterError" } } },
      { quotes: { default: { ok: false, error: "PoolNotStarted/QuoterError" } } }
    ],
    expected: { action: "SKIP", reason: "QUOTE_FAILED" }
  },
  {
    id: "S05",
    name: "低价 0.32，真实执行器会走到 fake 发单",
    quoteAttempts: [{ quotes: { default: { ok: true, avg: "0.32" } } }],
    expected: { action: "BUY_EXACT_IN", amountInUsdt: "20", tier: "ideal", sent: true }
  },
  {
    id: "S06",
    name: "贴近低价上沿 0.3399，买 20U",
    quoteAttempts: [{ quotes: { default: { ok: true, avg: "0.3399" } } }],
    expected: { action: "BUY_EXACT_IN", amountInUsdt: "20", tier: "ideal", sent: true }
  },
  {
    id: "S07",
    name: "正好 0.34，切到 10U 档",
    quoteAttempts: [{ quotes: { default: { ok: true, avg: "0.34" } } }],
    expected: { action: "BUY_EXACT_IN", amountInUsdt: "10", tier: "acceptable", sent: true }
  },
  {
    id: "S08",
    name: "可接受区 0.36，买 10U",
    quoteAttempts: [{ quotes: { default: { ok: true, avg: "0.36" } } }],
    expected: { action: "BUY_EXACT_IN", amountInUsdt: "10", tier: "acceptable", sent: true }
  },
  {
    id: "S09",
    name: "正好 0.38，仍买 10U",
    quoteAttempts: [{ quotes: { default: { ok: true, avg: "0.38" } } }],
    expected: { action: "BUY_EXACT_IN", amountInUsdt: "10", tier: "acceptable", sent: true }
  },
  {
    id: "S10",
    name: "刚超过 0.38，不买",
    quoteAttempts: [{ quotes: { default: { ok: true, avg: "0.3801" } } }],
    expected: { action: "SKIP", reason: "NO_AUTO_BUY_TIER_MATCHED" }
  },
  {
    id: "S11",
    name: "第一次全失败，第二次恢复到 0.33，买 20U",
    quoteAttempts: [
      { quotes: { default: { ok: false, error: "temporary revert" } } },
      { quotes: { default: { ok: true, avg: "0.33" } } }
    ],
    expected: { action: "BUY_EXACT_IN", amountInUsdt: "20", tier: "ideal", sent: true }
  },
  {
    id: "S12",
    name: "先冲高 0.41 后回落，但程序第一次成功报价即跳过",
    quoteAttempts: [
      { quotes: { default: { ok: true, avg: "0.41" } } },
      { quotes: { default: { ok: true, avg: "0.35" } } }
    ],
    expected: { action: "SKIP", reason: "NO_AUTO_BUY_TIER_MATCHED" }
  },
  {
    id: "S13",
    name: "报价便宜，但 Universal Router simulation 失败",
    quoteAttempts: [{ quotes: { default: { ok: true, avg: "0.32" } } }],
    simulationOk: false,
    expected: { action: "SKIP", reason: "SWAP_SIMULATION_FAILED" }
  },
  {
    id: "S14",
    name: "报价和 simulation 通过，但 BNB gas 不够",
    quoteAttempts: [{ quotes: { default: { ok: true, avg: "0.32" } } }],
    gasOk: false,
    expected: { action: "SKIP", reason: "BNB_GAS_TOO_LOW" }
  },
  {
    id: "S15",
    name: "20U 档报价失败，但 10U 档 0.35 可用，买 10U",
    quoteAttempts: [
      {
        quotes: {
          "20": { ok: false, error: "amount too large / quoter revert" },
          "10": { ok: true, avg: "0.35" }
        }
      }
    ],
    expected: { action: "BUY_EXACT_IN", amountInUsdt: "10", tier: "acceptable", sent: true }
  },
  {
    id: "S16",
    name: "极速模式下 quote 先恢复，hook 轮询未确认也会触发买入",
    fastLaunch: true,
    hookStarted: false,
    quoteAttempts: [{ quotes: { default: { ok: true, avg: "0.33" } } }],
    expected: { action: "BUY_EXACT_IN", amountInUsdt: "20", tier: "ideal", sent: true }
  },
  {
    id: "S17",
    name: "多 RPC 广播路径签名一次后向多个 RPC 发送同一笔 raw tx",
    multiRpcBroadcast: true,
    quoteAttempts: [{ quotes: { default: { ok: true, avg: "0.32" } } }],
    expected: { action: "BUY_EXACT_IN", amountInUsdt: "20", tier: "ideal", sent: true, writeCalls: 0, broadcastCalls: 1 }
  },
  {
    id: "S17B",
    name: "多 RPC 广播首个成功即返回，但所有 provider 都会收到同一 raw tx",
    multiRpcBroadcast: true,
    broadcastLabels: "configured-1,configured-2",
    rpcUrls: ["mock://one", "mock://two"],
    quoteAttempts: [{ quotes: { default: { ok: true, avg: "0.32" } } }],
    expected: { action: "BUY_EXACT_IN", amountInUsdt: "20", tier: "ideal", sent: true, writeCalls: 0, broadcastCalls: 2 }
  },
  {
    id: "S17C",
    name: "无私钥远端 broadcaster 会收到同一笔 signed raw tx",
    multiRpcBroadcast: true,
    remoteBroadcasterUrls: "http://127.0.0.1:8787",
    remoteBroadcasterToken: "simulation-token",
    quoteAttempts: [{ quotes: { default: { ok: true, avg: "0.32" } } }],
    expected: {
      action: "BUY_EXACT_IN",
      amountInUsdt: "20",
      tier: "ideal",
      sent: true,
      writeCalls: 0,
      broadcastCalls: 1,
      remoteBroadcastCalls: 1
    }
  },
  {
    id: "S18",
    name: "首区块模式预签名并临界广播，不等 quote 成功",
    firstBlock: true,
    quoteAttempts: [{ quotes: { default: { ok: false, error: "quote should not be used" } } }],
    expected: {
      action: "BUY_EXACT_IN",
      reason: "FIRST_BLOCK_PREBROADCAST",
      amountInUsdt: "10",
      tier: "acceptable",
      sent: true,
      writeCalls: 0,
      broadcastCalls: 1,
      quoteCalls: 0
    }
  },
  {
    id: "S19",
    name: "首区块交易失败后，有回执才回落到 quote 安全路径",
    firstBlock: true,
    receiptStatuses: ["reverted", "success"],
    quoteAttempts: [{ quotes: { default: { ok: true, avg: "0.32" } } }],
    expected: {
      action: "BUY_EXACT_IN",
      reason: "MATCHED_TIER_IDEAL",
      amountInUsdt: "20",
      tier: "ideal",
      sent: true,
      writeCalls: 1,
      broadcastCalls: 1,
      quoteCalls: 2
    }
  },
  {
    id: "S20",
    name: "首区块交易 pending 超时后默认等待，不发第二笔",
    firstBlock: true,
    receiptBehaviors: ["pending"],
    quoteAttempts: [{ quotes: { default: { ok: true, avg: "0.32" } } }],
    expected: {
      action: "WAIT",
      reason: "FIRST_BLOCK_TX_PENDING",
      sent: true,
      writeCalls: 0,
      broadcastCalls: 1,
      quoteCalls: 0
    }
  },
  {
    id: "S21",
    name: "首区块 pending 后用同 nonce 更高 gas replacement buy",
    firstBlock: true,
    firstBlockOnPending: "replace",
    receiptBehaviors: ["pending", "success"],
    quoteAttempts: [{ quotes: { default: { ok: true, avg: "0.32" } } }],
    expected: {
      action: "BUY_EXACT_IN",
      reason: "FIRST_BLOCK_REPLACEMENT",
      amountInUsdt: "10",
      tier: "acceptable",
      sent: true,
      writeCalls: 0,
      broadcastCalls: 2,
      quoteCalls: 0
    }
  },
  {
    id: "S22",
    name: "首区块 pending 后用同 nonce cancel 释放队列",
    firstBlock: true,
    firstBlockOnPending: "cancel",
    receiptBehaviors: ["pending", "success"],
    quoteAttempts: [{ quotes: { default: { ok: true, avg: "0.32" } } }],
    expected: {
      action: "SKIP",
      reason: "FIRST_BLOCK_CANCELLED",
      sent: true,
      writeCalls: 0,
      broadcastCalls: 2,
      quoteCalls: 0
    }
  },
  {
    id: "S23",
    name: "首区块 pending 后 replacement 广播失败时等待原 nonce，不回落第二笔买入",
    firstBlock: true,
    firstBlockOnPending: "replace",
    receiptBehaviors: ["pending"],
    broadcastFailures: [false, "replacement rejected"],
    quoteAttempts: [{ quotes: { default: { ok: true, avg: "0.32" } } }],
    expected: {
      action: "WAIT",
      reason: "FIRST_BLOCK_REPLACEMENT_BROADCAST_FAILED",
      sent: true,
      writeCalls: 0,
      broadcastCalls: 2,
      quoteCalls: 0
    }
  }
];

function createClock(launchAt) {
  let now = launchAt;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += Math.max(1, Number(ms));
    }
  };
}

function createArrayLogger() {
  const events = [];
  return {
    outPath: "memory://launch-flow-simulation",
    events,
    event(name, fields = {}) {
      events.push({ event: name, ...fields });
    }
  };
}

function scenarioConfig(config, scenario, launchAt) {
  return {
    ...config,
    rpcUrls: scenario.rpcUrls || config.rpcUrls,
    launchTime: new Date(launchAt).toISOString(),
    configPath: `${config.configPath || "config/share.json"}#${scenario.id}`
  };
}

function quoteSpecFor({ scenario, exactAmount }) {
  const amountInUsdt = new Decimal(formatUnits(exactAmount, 18)).toFixed();
  const attemptIndex = Math.floor(scenario.quoteCalls / scenario.tiersPerAttempt);
  const attempt = scenario.quoteAttempts?.[Math.min(attemptIndex, scenario.quoteAttempts.length - 1)];
  return attempt?.quotes?.[amountInUsdt] || attempt?.quotes?.default || { ok: false, error: "QUOTE_FAILED" };
}

function createQuoteFn(scenario) {
  return async ({ exactAmount }) => {
    const spec = quoteSpecFor({ scenario, exactAmount });
    scenario.quoteCalls += 1;
    if (!spec || spec.ok === false) {
      const error = new Error(spec?.error || "QUOTE_FAILED");
      error.shortMessage = spec?.error || "QUOTE_FAILED";
      throw error;
    }

    const amountIn = new Decimal(formatUnits(exactAmount, 18));
    const amountOut = amountIn.div(String(spec.avg));
    return [parseUnits(amountOut.toFixed(18), 18), BigInt(spec.quoteGas || 72_000)];
  };
}

function createMockClient({ config, scenario }) {
  const quoteBalance = scenario.balanceOk === false ? parseUnits("5", 18) : parseUnits("20.59401315", 18);
  const targetBalance = 0n;
  const erc20Allowance = scenario.approvalOk === false ? 0n : parseUnits("20", 18);
  const permit2Amount = scenario.approvalOk === false ? 0n : parseUnits("20", 18);
  const bnbBalance = scenario.gasOk === false ? parseUnits("0.0000000001", 18) : parseUnits("0.0014690241", 18);
  const gasPrice = parseUnits("0.05", 9);
  const gas = 195_000n;
  const pool = config.protocols.infinityCL;
  const poolKey = [
    pool.currency0,
    pool.currency1,
    pool.expectedHook,
    config.addresses.infinityCLPoolManager,
    67,
    pool.parameters || "0x00000000000000000000000000000000000000000000000000000000000a0045"
  ];

  return {
    async readContract({ address, functionName }) {
      if (functionName === "poolIdToPoolKey") return poolKey;
      if (functionName === "balanceOf") {
        return address.toLowerCase() === config.quoteToken.toLowerCase() ? quoteBalance : targetBalance;
      }
      if (functionName === "allowance" && address.toLowerCase() === config.addresses.permit2.toLowerCase()) {
        return [permit2Amount, 4_102_444_800n];
      }
      if (functionName === "allowance") return erc20Allowance;
      if (functionName === "isPoolStarted") return scenario.hookStarted !== false;
      throw new Error(`Unhandled readContract ${functionName}`);
    },
    async getBalance() {
      return bnbBalance;
    },
    async estimateContractGas() {
      if (scenario.simulationOk === false) {
        const error = new Error("SWAP_SIMULATION_FAILED");
        error.shortMessage = "SWAP_SIMULATION_FAILED";
        throw error;
      }
      return gas;
    },
    async getGasPrice() {
      return gasPrice;
    },
    async waitForTransactionReceipt({ hash }) {
      const behavior =
        scenario.receiptBehaviors?.[scenario.receiptCalls] ||
        scenario.receiptStatuses?.[scenario.receiptCalls] ||
        scenario.receiptStatus ||
        "success";
      scenario.receiptCalls += 1;
      if (behavior === "pending") return new Promise(() => {});
      return {
        hash,
        status: behavior,
        blockNumber: 97_000_001n,
        gasUsed: gas,
        effectiveGasPrice: gasPrice
      };
    },
    async getTransactionCount() {
      return 7;
    }
  };
}

function createMockWalletClient(scenario) {
  return {
    async writeContract() {
      scenario.writeCalls += 1;
      return `0x${scenario.id.toLowerCase().padEnd(64, "0")}`;
    }
  };
}

async function runActualExecutorScenario({ baseConfig, rawScenario }) {
  const scenario = {
    balanceOk: true,
    approvalOk: true,
    hookStarted: true,
    simulationOk: true,
    gasOk: true,
    quoteCalls: 0,
    writeCalls: 0,
    broadcastCalls: 0,
    remoteBroadcastCalls: 0,
    receiptCalls: 0,
    tiersPerAttempt: baseConfig.execution.autoBuyTiers.length,
    ...rawScenario
  };
  const launchAt = Date.parse("2026-05-08T10:00:00.000Z");
  const clock = createClock(launchAt);
  const config = scenarioConfig(baseConfig, scenario, launchAt);
  const logger = createArrayLogger();
  const argv = [
    "node",
    "src/share-launch-executor.js",
    "--config",
    "config/share.json",
    "--send",
    "--warmup-ms",
    "0",
    "--poll-ms",
    "250",
    "--quote-retry-ms",
    "250",
    "--give-up-ms-after-launch",
    "600"
  ];
  if (scenario.fastLaunch) {
    argv.push("--fast-launch", "--sprint-ms", "600", "--sprint-poll-ms", "50", "--quote-probe-lead-ms", "600");
  }
  if (scenario.multiRpcBroadcast) {
    argv.push("--multi-rpc-broadcast", "--broadcast-public", "--broadcast-labels", scenario.broadcastLabels || "public-bsc");
  }
  if (scenario.remoteBroadcasterUrls) {
    argv.push(
      "--remote-broadcaster-urls",
      scenario.remoteBroadcasterUrls,
      "--remote-broadcaster-token",
      scenario.remoteBroadcasterToken || "simulation-token"
    );
  }
  if (scenario.firstBlock) {
    argv.push(
      "--first-block",
      "--broadcast-public",
      "--broadcast-labels",
      "public-bsc",
      "--first-block-broadcast-offset-ms",
      "0",
      "--first-block-receipt-timeout-ms",
      "5",
      "--no-broadcast-prewarm"
    );
    if (scenario.firstBlockOnPending) {
      argv.push("--first-block-on-pending", scenario.firstBlockOnPending);
    }
  }
  const account = {
    address: SIM_ACCOUNT,
    async signTransaction() {
      return `0x${"f".repeat(128)}`;
    }
  };

  try {
    const result = await runLaunchExecutor({
      config,
      account,
      client: createMockClient({ config, scenario }),
      walletClient: createMockWalletClient(scenario),
      logger,
      argv,
      nowFn: clock.now,
      sleepFn: clock.sleep,
      getTokenMetaFn: async (_client, address) => ({
        address,
        symbol: address.toLowerCase() === config.quoteToken.toLowerCase() ? "USDT" : "SHARE",
        decimals: 18,
        totalSupply: 0n
      }),
      quoteFn: createQuoteFn(scenario),
      broadcastRawTransactionFn: async () => {
        const failure = scenario.broadcastFailures?.[scenario.broadcastCalls];
        scenario.broadcastCalls += 1;
        if (failure) {
          const error = new Error(String(failure));
          error.shortMessage = String(failure);
          throw error;
        }
        return `0x${scenario.id.toLowerCase().padEnd(64, "b")}`;
      },
      broadcastRemoteRawTransactionFn: async () => {
        scenario.remoteBroadcastCalls += 1;
        return {
          hash: `0x${scenario.id.toLowerCase().padEnd(64, "c")}`,
          winnerLabel: "remote-sim",
          okCount: 1,
          providerCount: 1
        };
      }
    });
    return {
      ...result,
      events: logger.events,
      writeCalls: scenario.writeCalls,
      broadcastCalls: scenario.broadcastCalls,
      remoteBroadcastCalls: scenario.remoteBroadcastCalls,
      quoteCalls: scenario.quoteCalls
    };
  } catch (error) {
    const message = error.shortMessage || error.message || String(error);
    const reason =
      message.includes("approval") || message.includes("Permit2")
        ? "APPROVAL_MISSING"
        : message.includes("balance is below max spend")
          ? "BALANCE_TOO_LOW"
          : message.includes("Hook did not start")
            ? "HOOK_NOT_STARTED"
            : message.includes("SWAP_SIMULATION_FAILED")
              ? "SWAP_SIMULATION_FAILED"
              : message.includes("BNB balance is below boosted gas budget")
                ? "BNB_GAS_TOO_LOW"
                : message;
    const action = reason === "HOOK_NOT_STARTED" ? "WAIT" : "SKIP";
    return {
      action,
      reason,
      events: logger.events,
      writeCalls: scenario.writeCalls,
      broadcastCalls: scenario.broadcastCalls,
      remoteBroadcastCalls: scenario.remoteBroadcastCalls,
      quoteCalls: scenario.quoteCalls
    };
  }
}

function assertExpected(scenario, result) {
  for (const [key, value] of Object.entries(scenario.expected)) {
    assert.equal(
      result[key],
      value,
      `${scenario.id} ${key}: ${JSON.stringify(result, (_key, current) =>
        typeof current === "bigint" ? current.toString() : current
      )}`
    );
  }
}

async function main() {
  const baseConfig = loadConfigFromArgs();
  const results = [];
  for (const scenario of scenarios) {
    const result = await runActualExecutorScenario({ baseConfig, rawScenario: scenario });
    assertExpected(scenario, result);
    const expectedWriteCalls = scenario.expected.writeCalls ?? (result.action === "BUY_EXACT_IN" ? 1 : 0);
    const expectedBroadcastCalls = scenario.expected.broadcastCalls ?? 0;
    const expectedRemoteBroadcastCalls = scenario.expected.remoteBroadcastCalls ?? 0;
    assert.equal(
      result.writeCalls,
      expectedWriteCalls,
      `${scenario.id} should trigger expected fake writeContract calls`
    );
    assert.equal(
      result.broadcastCalls,
      expectedBroadcastCalls,
      `${scenario.id} should trigger expected fake raw broadcasts`
    );
    assert.equal(
      result.remoteBroadcastCalls,
      expectedRemoteBroadcastCalls,
      `${scenario.id} should trigger expected fake remote raw broadcasts`
    );
    if (scenario.expected.quoteCalls !== undefined) {
      assert.equal(
        result.quoteCalls,
        scenario.expected.quoteCalls,
        `${scenario.id} should trigger expected quote calls`
      );
    }
    results.push({ scenario, result });
  }

  console.log("Launch executor simulation: ok");
  console.log("This triggers runLaunchExecutor with mocked chain/wallet clients. No real RPC or wallet is used.");
  console.log("ID  Action        Amount  Tier        Sent  Reason                         Name");
  console.log("--  ------------  ------  ----------  ----  -----------------------------  ----");
  for (const { scenario, result } of results) {
    console.log(
      [
        scenario.id.padEnd(3),
        result.action.padEnd(12),
        String(result.amountInUsdt || "-").padEnd(6),
        String(result.tier || "-").padEnd(10),
        String(result.sent ? "yes" : "no").padEnd(4),
        String(result.reason || "-").padEnd(29),
        scenario.name
      ].join(" ")
    );
  }
}

main();
