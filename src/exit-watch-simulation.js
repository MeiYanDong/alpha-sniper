import assert from "node:assert/strict";
import Decimal from "decimal.js";
import { formatUnits, parseUnits } from "viem";
import { loadConfigFromArgs } from "./config.js";
import { runExitWatcher } from "./exit-watch.js";

const SIM_ACCOUNT = "0x0000000000000000000000000000000000000e11";

const scenarios = [
  {
    id: "E01",
    name: "跌破止损线，立刻全卖",
    avgExit: "0.28",
    expected: { action: "SELL_EXACT_IN", reason: "STOP_LOSS", sent: true, writeCalls: 1 }
  },
  {
    id: "E02",
    name: "涨幅超过 50%，卖一半",
    avgExit: "0.52",
    expected: { action: "SELL_EXACT_IN", reason: "TAKE_PROFIT_FIRST_PROFIT", sent: true, writeCalls: 1 }
  },
  {
    id: "E03",
    name: "涨幅超过 100%，全卖",
    avgExit: "0.72",
    expected: { action: "SELL_EXACT_IN", reason: "TAKE_PROFIT_FULL_EXIT", sent: true, writeCalls: 1 }
  },
  {
    id: "E04",
    name: "有仓位但还没到止盈止损，继续等",
    avgExit: "0.4",
    expected: { action: "WAIT", reason: "EXIT_WATCH_TIMEOUT", writeCalls: 0 }
  },
  {
    id: "E05",
    name: "达到止盈但 SHARE 授权缺失，未开启自动授权，不卖",
    avgExit: "0.72",
    approvalOk: false,
    expected: { action: "SKIP", reason: "APPROVAL_MISSING", writeCalls: 0 }
  },
  {
    id: "E06",
    name: "达到止盈且自动补 SHARE 授权，然后卖出",
    avgExit: "0.72",
    approvalOk: false,
    autoApprove: true,
    expected: { action: "SELL_EXACT_IN", reason: "TAKE_PROFIT_FULL_EXIT", sent: true, writeCalls: 3 }
  },
  {
    id: "E07",
    name: "达到止盈但卖出 simulation 失败，不卖",
    avgExit: "0.72",
    simulationOk: false,
    expected: { action: "SKIP", reason: "SELL_SIMULATION_FAILED", writeCalls: 0 }
  },
  {
    id: "E08",
    name: "没有 SHARE 仓位，继续等到超时",
    positionShare: "0",
    avgExit: "0.72",
    expected: { action: "WAIT", reason: "EXIT_WATCH_TIMEOUT", writeCalls: 0 }
  }
];

function createClock() {
  let now = Date.parse("2026-05-08T10:05:00.000Z");
  return {
    now: () => now,
    sleep: async (ms) => {
      now += Math.max(1, Number(ms));
    }
  };
}

function createLogger() {
  return {
    outPath: "memory://exit-watch-simulation",
    events: [],
    event(name, fields = {}) {
      this.events.push({ event: name, ...fields });
    }
  };
}

function createMockClient({ config, scenario }) {
  const pool = config.protocols.infinityCL;
  const poolKey = [
    pool.currency0,
    pool.currency1,
    pool.expectedHook,
    config.addresses.infinityCLPoolManager,
    67,
    pool.parameters || "0x00000000000000000000000000000000000000000000000000000000000a0045"
  ];
  const state = {
    targetBalance: parseUnits(scenario.positionShare ?? "100", 18),
    quoteBalance: parseUnits("0", 18),
    bnbBalance: parseUnits("0.0014690241", 18),
    erc20Allowance: scenario.approvalOk === false ? 0n : parseUnits("100", 18),
    permit2Amount: scenario.approvalOk === false ? 0n : parseUnits("100", 18),
    gas: 195_000n,
    gasPrice: parseUnits("0.05", 9)
  };

  return {
    state,
    async readContract({ address, functionName }) {
      if (functionName === "poolIdToPoolKey") return poolKey;
      if (functionName === "balanceOf") {
        return address.toLowerCase() === config.targetToken.toLowerCase()
          ? state.targetBalance
          : state.quoteBalance;
      }
      if (functionName === "allowance" && address.toLowerCase() === config.addresses.permit2.toLowerCase()) {
        return [state.permit2Amount, 4_102_444_800n];
      }
      if (functionName === "allowance") return state.erc20Allowance;
      if (functionName === "isPoolStarted") return true;
      throw new Error(`Unhandled readContract ${functionName}`);
    },
    async getBalance() {
      return state.bnbBalance;
    },
    async getGasPrice() {
      return state.gasPrice;
    },
    async estimateContractGas() {
      if (scenario.simulationOk === false) {
        const error = new Error("SELL_SIMULATION_FAILED");
        error.shortMessage = "SELL_SIMULATION_FAILED";
        throw error;
      }
      return state.gas;
    },
    async waitForTransactionReceipt({ hash }) {
      return {
        hash,
        status: "success",
        blockNumber: 97_000_100n,
        gasUsed: state.gas,
        effectiveGasPrice: state.gasPrice
      };
    }
  };
}

function createMockWalletClient({ config, scenario, client }) {
  return {
    async writeContract({ address, functionName, args }) {
      scenario.writeCalls += 1;
      if (functionName === "approve" && address.toLowerCase() === config.targetToken.toLowerCase()) {
        client.state.erc20Allowance = args[1];
      } else if (functionName === "approve" && address.toLowerCase() === config.addresses.permit2.toLowerCase()) {
        client.state.permit2Amount = args[2];
      }
      return `0x${scenario.id.toLowerCase().padEnd(64, "0")}`;
    }
  };
}

function createQuoteFn(scenario) {
  return async ({ exactAmount }) => {
    const amountIn = new Decimal(formatUnits(exactAmount, 18));
    const amountOut = amountIn.mul(String(scenario.avgExit));
    return [parseUnits(amountOut.toFixed(18), 18), 72_000n];
  };
}

async function runScenario({ baseConfig, rawScenario }) {
  const scenario = {
    approvalOk: true,
    simulationOk: true,
    writeCalls: 0,
    ...rawScenario
  };
  const client = createMockClient({ config: baseConfig, scenario });
  const argv = [
    "node",
    "src/exit-watch.js",
    "--config",
    "config/share.json",
    "--send",
    "--exit-once",
    "--exit-max-watch-ms",
    "0",
    "--exit-poll-ms",
    "1"
  ];
  if (scenario.autoApprove) argv.push("--auto-approve-exit");
  const clock = createClock();
  const result = await runExitWatcher({
    config: baseConfig,
    account: { address: SIM_ACCOUNT },
    client,
    walletClient: createMockWalletClient({ config: baseConfig, scenario, client }),
    entryAvgPriceUsd: "0.34",
    logger: createLogger(),
    argv,
    nowFn: clock.now,
    sleepFn: clock.sleep,
    getTokenMetaFn: async (_client, address) => ({
      address,
      symbol: address.toLowerCase() === baseConfig.quoteToken.toLowerCase() ? "USDT" : "SHARE",
      decimals: 18,
      totalSupply: 0n
    }),
    quoteFn: createQuoteFn(scenario)
  });
  return { ...result, writeCalls: scenario.writeCalls };
}

function assertExpected(scenario, result) {
  for (const [key, value] of Object.entries(scenario.expected)) {
    assert.equal(result[key], value, `${scenario.id} ${key}`);
  }
}

async function main() {
  const baseConfig = loadConfigFromArgs();
  const results = [];
  for (const scenario of scenarios) {
    const result = await runScenario({ baseConfig, rawScenario: scenario });
    assertExpected(scenario, result);
    results.push({ scenario, result });
  }

  console.log("Exit watcher simulation: ok");
  console.log("ID  Action        Sent  Writes  Reason                    Name");
  console.log("--  ------------  ----  ------  ------------------------  ----");
  for (const { scenario, result } of results) {
    console.log(
      [
        scenario.id.padEnd(3),
        result.action.padEnd(12),
        String(result.sent ? "yes" : "no").padEnd(4),
        String(result.writeCalls).padEnd(6),
        String(result.reason || "-").padEnd(24),
        scenario.name
      ].join(" ")
    );
  }
}

main();
