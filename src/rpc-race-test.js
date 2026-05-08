import assert from "node:assert/strict";
import { createRaceReadClientFromEntries } from "./rpc-race.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createLogger() {
  return {
    events: [],
    event(name, fields = {}) {
      this.events.push({ event: name, ...fields });
    }
  };
}

function entry(label, methods) {
  return {
    label,
    client: methods
  };
}

async function testFirstSuccessWins() {
  const logger = createLogger();
  const race = createRaceReadClientFromEntries(
    [
      entry("slow", {
        async readContract() {
          await sleep(25);
          return 1n;
        }
      }),
      entry("fast", {
        async readContract() {
          await sleep(2);
          return 2n;
        }
      })
    ],
    { logger }
  );

  const value = await race.readContract({ functionName: "quoteExactInputSingle" });
  assert.equal(value, 2n);
  assert.equal(logger.events[0].event, "rpc_race_read");
  assert.equal(logger.events[0].winner, "fast");
}

async function testPoolStartedTrueWinsOverFastFalse() {
  const logger = createLogger();
  const race = createRaceReadClientFromEntries(
    [
      entry("fast-false", {
        async readContract() {
          await sleep(1);
          return false;
        }
      }),
      entry("slow-true", {
        async readContract() {
          await sleep(10);
          return true;
        }
      })
    ],
    { logger }
  );

  const value = await race.readContract({ functionName: "isPoolStarted" });
  assert.equal(value, true);
  assert.equal(logger.events[0].winner, "slow-true");
  assert.equal(logger.events[0].mode, "true_if_any");
}

async function testPoolStartedFalseWhenNoProviderSeesStart() {
  const race = createRaceReadClientFromEntries([
    entry("fast-false", {
      async readContract() {
        await sleep(1);
        return false;
      }
    }),
    entry("slow-false", {
      async readContract() {
        await sleep(5);
        return false;
      }
    })
  ]);

  assert.equal(await race.readContract({ functionName: "isPoolStarted" }), false);
}

async function testAllFailThrows() {
  const logger = createLogger();
  const race = createRaceReadClientFromEntries(
    [
      entry("a", {
        async readContract() {
          throw new Error("boom-a");
        }
      }),
      entry("b", {
        async readContract() {
          throw new Error("boom-b");
        }
      })
    ],
    { logger }
  );

  await assert.rejects(
    () => race.readContract({ functionName: "quoteExactInputSingle" }),
    /RPC race failed/
  );
  assert.equal(logger.events[0].event, "rpc_race_failed");
  assert.equal(logger.events[0].failures.length, 2);
}

async function testGasMethodsRace() {
  const race = createRaceReadClientFromEntries([
    entry("slow", {
      async estimateContractGas() {
        await sleep(10);
        return 300000n;
      },
      async getGasPrice() {
        await sleep(10);
        return 3n;
      }
    }),
    entry("fast", {
      async estimateContractGas() {
        await sleep(1);
        return 200000n;
      },
      async getGasPrice() {
        await sleep(1);
        return 2n;
      }
    })
  ]);

  assert.equal(await race.estimateContractGas({ functionName: "execute" }), 200000n);
  assert.equal(await race.getGasPrice(), 2n);
}

async function main() {
  await testFirstSuccessWins();
  await testPoolStartedTrueWinsOverFastFalse();
  await testPoolStartedFalseWhenNoProviderSeesStart();
  await testAllFailThrows();
  await testGasMethodsRace();
  console.log("RPC race tests: ok");
}

main();
