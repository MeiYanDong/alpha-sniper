import { createPublicClient, http } from "viem";
import { bsc } from "viem/chains";
import {
  classifyRpcError,
  filterRpcProviders,
  getSafeRpcProviders
} from "./rpc-providers.js";

export const DEFAULT_RPC_RACE_LABELS = "chainstack-primary,ankr-bsc";

function summarizeFailure(result) {
  return {
    label: result.label,
    errorType: classifyRpcError(result.error),
    message: result.error?.shortMessage || result.error?.message || String(result.error),
    latencyMs: Math.round(result.latencyMs)
  };
}

function buildRaceError({ method, functionName, failures }) {
  const suffix = functionName ? ` ${functionName}` : "";
  const error = new Error(
    `RPC race failed for ${method}${suffix}: ${failures
      .map((failure) => `${failure.label}:${classifyRpcError(failure.error)}`)
      .join(", ")}`
  );
  error.failures = failures.map(summarizeFailure);
  return error;
}

function createTasks(entries, runner) {
  return entries.map((entry) => {
    const startedAt = performance.now();
    return Promise.resolve()
      .then(() => runner(entry.client))
      .then((value) => ({
        ok: true,
        label: entry.label,
        value,
        latencyMs: performance.now() - startedAt
      }))
      .catch((error) => ({
        ok: false,
        label: entry.label,
        error,
        latencyMs: performance.now() - startedAt
      }));
  });
}

async function raceFirstSuccess({ entries, runner, method, functionName }) {
  const tasks = createTasks(entries, runner);
  const failures = [];

  return new Promise((resolve, reject) => {
    let settled = false;
    let remaining = tasks.length;

    for (const task of tasks) {
      task.then((result) => {
        if (settled) return;
        if (result.ok) {
          settled = true;
          resolve(result);
          return;
        }

        failures.push(result);
        remaining -= 1;
        if (remaining === 0) {
          settled = true;
          reject(buildRaceError({ method, functionName, failures }));
        }
      });
    }
  });
}

async function raceTrueIfAny({ entries, runner, method, functionName }) {
  const tasks = createTasks(entries, runner);
  const failures = [];

  return new Promise((resolve, reject) => {
    let settled = false;
    let remaining = tasks.length;
    let falseResult = null;

    for (const task of tasks) {
      task.then((result) => {
        if (settled) return;
        remaining -= 1;

        if (result.ok && result.value === true) {
          settled = true;
          resolve(result);
          return;
        }

        if (result.ok && result.value === false) {
          falseResult ||= result;
        } else if (!result.ok) {
          failures.push(result);
        }

        if (remaining === 0) {
          settled = true;
          if (falseResult) {
            resolve(falseResult);
          } else {
            reject(buildRaceError({ method, functionName, failures }));
          }
        }
      });
    }
  });
}

function raceModeForReadContract(args) {
  return args?.functionName === "isPoolStarted" ? "true_if_any" : "first_success";
}

export function createRaceReadClientFromEntries(entries, { logger } = {}) {
  const safeEntries = entries.filter((entry) => entry?.label && entry?.client);
  if (safeEntries.length === 0) {
    throw new Error("RPC race requires at least one provider");
  }

  async function runRace({ method, args, runner, mode = "first_success" }) {
    const functionName = args?.functionName || null;
    const startedAt = performance.now();
    try {
      const result =
        mode === "true_if_any"
          ? await raceTrueIfAny({ entries: safeEntries, runner, method, functionName })
          : await raceFirstSuccess({ entries: safeEntries, runner, method, functionName });

      logger?.event?.("rpc_race_read", {
        method,
        functionName,
        mode,
        winner: result.label,
        winnerLatencyMs: Math.round(result.latencyMs),
        latencyMs: Math.round(performance.now() - startedAt),
        providerLabels: safeEntries.map((entry) => entry.label),
        result: typeof result.value === "boolean" ? result.value : undefined
      });
      return result.value;
    } catch (error) {
      logger?.event?.("rpc_race_failed", {
        method,
        functionName,
        mode,
        latencyMs: Math.round(performance.now() - startedAt),
        failures: error.failures || []
      });
      throw error;
    }
  }

  return {
    labels: safeEntries.map((entry) => entry.label),
    readContract(args) {
      return runRace({
        method: "readContract",
        args,
        mode: raceModeForReadContract(args),
        runner: (client) => client.readContract(args)
      });
    },
    estimateContractGas(args) {
      return runRace({
        method: "estimateContractGas",
        args,
        runner: (client) => client.estimateContractGas(args)
      });
    },
    getGasPrice(args) {
      return runRace({
        method: "getGasPrice",
        args,
        runner: (client) => client.getGasPrice(args)
      });
    }
  };
}

export function createRaceReadClient(config, {
  labelsCsv = DEFAULT_RPC_RACE_LABELS,
  timeoutMs = 3000,
  logger
} = {}) {
  const providers = filterRpcProviders(
    getSafeRpcProviders(config, { includePublic: false }),
    labelsCsv
  );
  if (providers.length === 0) {
    throw new Error(`No RPC providers available for race labels: ${labelsCsv || "all"}`);
  }

  return createRaceReadClientFromEntries(
    providers.map((provider) => ({
      label: provider.label,
      client: createPublicClient({
        chain: bsc,
        transport: http(provider.url, { timeout: timeoutMs })
      })
    })),
    { logger }
  );
}
