import assert from "node:assert/strict";
import Decimal from "decimal.js";
import { formatUnits, parseUnits } from "viem";
import { loadConfigFromArgs } from "./config.js";
import { runLaunchExecutor } from "./share-launch-executor.js";

const SIM_ACCOUNT = "0x0000000000000000000000000000000000000f11";

function createClock() {
  let now = Date.parse("2026-05-08T10:00:00.000Z");
  return {
    now: () => now,
    sleep: async (ms) => {
      now += Math.max(1, Number(ms));
    }
  };
}

function createLogger() {
  return {
    outPath: "memory://auto-flow-simulation",
    events: [],
    event(name, fields = {}) {
      this.events.push({ event: name, ...fields });
    }
  };
}

function createMockClient(config) {
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
    quoteBalance: parseUnits("20.59401315", 18),
    targetBalance: 0n,
    quoteAllowance: parseUnits("20", 18),
    targetAllowance: 0n,
    quotePermit2: parseUnits("20", 18),
    targetPermit2: 0n,
    bnbBalance: parseUnits("0.0014690241", 18),
    gas: 195_000n,
    gasPrice: parseUnits("0.05", 9),
    executeCalls: 0,
    writeCalls: 0,
    lastTxType: null
  };

  return {
    config,
    state,
    async readContract({ address, functionName, args }) {
      if (functionName === "poolIdToPoolKey") return poolKey;
      if (functionName === "balanceOf") {
        return address.toLowerCase() === config.quoteToken.toLowerCase()
          ? state.quoteBalance
          : state.targetBalance;
      }
      if (functionName === "allowance" && address.toLowerCase() === config.addresses.permit2.toLowerCase()) {
        const token = args[1].toLowerCase();
        return [
          token === config.quoteToken.toLowerCase() ? state.quotePermit2 : state.targetPermit2,
          4_102_444_800n
        ];
      }
      if (functionName === "allowance") {
        return address.toLowerCase() === config.quoteToken.toLowerCase()
          ? state.quoteAllowance
          : state.targetAllowance;
      }
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
      return state.gas;
    },
    async waitForTransactionReceipt({ hash }) {
      if (state.lastTxType === "buy") {
        state.quoteBalance -= parseUnits("20", 18);
        state.targetBalance += parseUnits("62.5", 18);
      } else if (state.lastTxType === "sell") {
        state.quoteBalance += parseUnits("45", 18);
        state.targetBalance = 0n;
      }
      return {
        hash,
        status: "success",
        blockNumber: 97_000_200n,
        gasUsed: state.gas,
        effectiveGasPrice: state.gasPrice
      };
    }
  };
}

function createWalletClient(client) {
  return {
    async writeContract({ address, functionName, args }) {
      client.state.writeCalls += 1;
      if (functionName === "approve" && address.toLowerCase() === client.config.targetToken.toLowerCase()) {
        client.state.targetAllowance = args[1];
        client.state.lastTxType = "approve";
        return `0xauto${String(client.state.writeCalls).padEnd(59, "0")}`;
      }
      if (functionName === "approve" && address.toLowerCase() === client.config.addresses.permit2.toLowerCase()) {
        client.state.targetPermit2 = args[2];
        client.state.lastTxType = "approve";
        return `0xauto${String(client.state.writeCalls).padEnd(59, "0")}`;
      }
      if (
        functionName === "execute" &&
        address.toLowerCase() === client.config.addresses.infinityUniversalRouter.toLowerCase()
      ) {
        client.state.executeCalls += 1;
        client.state.lastTxType = client.state.executeCalls === 1 ? "buy" : "sell";
        return `0xauto${String(client.state.writeCalls).padEnd(59, "0")}`;
      }
      client.state.lastTxType = client.state.writeCalls === 1 ? "buy" : "sell";
      return `0xauto${String(client.state.writeCalls).padEnd(59, "0")}`;
    }
  };
}

function createQuoteFn() {
  return async ({ zeroForOne, exactAmount }) => {
    const amountIn = new Decimal(formatUnits(exactAmount, 18));
    if (zeroForOne) {
      const amountOut = amountIn.div("0.32");
      return [parseUnits(amountOut.toFixed(18), 18), 72_000n];
    }
    const amountOut = amountIn.mul("0.72");
    return [parseUnits(amountOut.toFixed(18), 18), 72_000n];
  };
}

async function main() {
  const config = {
    ...loadConfigFromArgs(),
    launchTime: "2026-05-08T10:00:00.000Z"
  };
  const client = createMockClient(config);
  const clock = createClock();
  const result = await runLaunchExecutor({
    config,
    account: { address: SIM_ACCOUNT },
    client,
    walletClient: createWalletClient(client),
    logger: createLogger(),
    argv: [
      "node",
      "src/share-launch-executor.js",
      "--config",
      "config/share.json",
      "--send",
      "--auto-exit",
      "--auto-approve-exit",
      "--exit-once",
      "--warmup-ms",
      "0",
      "--give-up-ms-after-launch",
      "600",
      "--exit-max-watch-ms",
      "600",
      "--exit-poll-ms",
      "1"
    ],
    nowFn: clock.now,
    sleepFn: clock.sleep,
    getTokenMetaFn: async (_client, address) => ({
      address,
      symbol: address.toLowerCase() === config.quoteToken.toLowerCase() ? "USDT" : "SHARE",
      decimals: 18,
      totalSupply: 0n
    }),
    quoteFn: createQuoteFn()
  });

  assert.equal(result.action, "BUY_EXACT_IN");
  assert.equal(result.amountInUsdt, "20");
  assert.equal(result.exitResult?.action, "SELL_EXACT_IN");
  assert.equal(result.exitResult?.reason, "TAKE_PROFIT_FULL_EXIT");
  assert.equal(client.state.writeCalls, 4);
  assert.equal(client.state.executeCalls, 2);

  console.log("Auto flow simulation: ok");
  console.log(`Buy: ${result.action} ${result.amountInUsdt} USDT at avg ${result.avg}`);
  console.log(`Exit: ${result.exitResult.action} ${result.exitResult.reason}`);
  console.log(`Fake writeContract calls: ${client.state.writeCalls}`);
}

main();
