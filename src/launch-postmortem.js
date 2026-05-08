import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatGwei } from "viem";
import { loadConfigFromArgs } from "./config.js";
import { createBscClient } from "./pools.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function latestRunFile() {
  const dir = path.resolve(process.cwd(), "data/runs");
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => path.join(dir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (files.length === 0) throw new Error("No run logs found in data/runs");
  return files[0];
}

function loadEvents(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function firstEvent(events, name) {
  return events.find((event) => event.event === name) || null;
}

function lastEvent(events, name) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].event === name) return events[index];
  }
  return null;
}

function eventsByName(events, name) {
  return events.filter((event) => event.event === name);
}

function shortHash(hash) {
  return hash ? `${hash.slice(0, 10)}...${hash.slice(-8)}` : "-";
}

function formatMaybeGwei(value) {
  if (value === undefined || value === null) return "-";
  try {
    return `${formatGwei(BigInt(value))} gwei`;
  } catch {
    return String(value);
  }
}

function printEventSummary({ file, events }) {
  const started = firstEvent(events, "run_started");
  const firstBlockPlan = firstEvent(events, "first_block_prebuild_ready");
  const txSent = eventsByName(events, "tx_sent");
  const txConfirmed = eventsByName(events, "tx_confirmed");
  const pending = firstEvent(events, "first_block_pending_timeout");
  const replacement = firstEvent(events, "first_block_replacement_broadcast");
  const cancel = firstEvent(events, "first_block_cancel_broadcast");
  const dryRunExit = firstEvent(events, "first_block_dry_run_exit");
  const skip = lastEvent(events, "decision_skip");
  const balances = lastEvent(events, "final_balances");

  console.log("Launch postmortem");
  console.log(`Run log: ${file}`);
  if (started) {
    console.log(`Config: ${started.configName || "-"} mode=${started.mode || "-"} launch=${started.launchTime || "-"}`);
    console.log(
      `Flags: firstBlock=${Boolean(started.firstBlock)} fastLaunch=${Boolean(started.fastLaunch)} rpcRace=${Boolean(started.rpcRaceEnabled)}`
    );
  }

  if (firstBlockPlan) {
    console.log("");
    console.log("First-block plan");
    console.log(`- tier: ${firstBlockPlan.tier}`);
    console.log(`- amountIn: ${firstBlockPlan.amountInUsdt} USDT`);
    console.log(`- maxAvg: ${firstBlockPlan.maxAvgPriceUsd}`);
    console.log(`- minOut: ${firstBlockPlan.minOut}`);
    console.log(`- gas: ${firstBlockPlan.gas}`);
    console.log(`- gasPrice: ${formatMaybeGwei(firstBlockPlan.gasPrice)}`);
    console.log(`- broadcastAt: ${firstBlockPlan.broadcastAt}`);
    console.log(`- providers: ${(firstBlockPlan.providers || []).join(", ")}`);
  }

  if (txSent.length > 0) {
    console.log("");
    console.log("Transactions sent");
    for (const item of txSent) {
      console.log(`- ${item.mode || "quote_path"} ${shortHash(item.hash)} at ${item.sentAt}`);
    }
  }

  if (txConfirmed.length > 0) {
    console.log("");
    console.log("Confirmations");
    for (const item of txConfirmed) {
      console.log(
        `- ${shortHash(item.hash)} status=${item.status} block=${item.blockNumber || "-"} gasUsed=${item.gasUsed || "-"} effectiveGas=${formatMaybeGwei(item.effectiveGasPrice)}`
      );
    }
  }

  if (pending) {
    console.log("");
    console.log(`Pending timeout: ${shortHash(pending.hash)} timeout=${pending.timeoutMs}ms action=${pending.onPending}`);
  }
  if (replacement) console.log(`Replacement broadcast observed: latency=${replacement.latencyMs}ms`);
  if (cancel) console.log(`Cancel broadcast observed: latency=${cancel.latencyMs}ms`);
  if (dryRunExit) console.log("Dry-run exit: first-block transaction was built but not sent.");
  if (skip) console.log(`Decision skip: ${skip.reason}`);
  if (balances?.entryAvg) console.log(`Entry avg from balances: ${balances.entryAvg}`);

  console.log("");
  console.log("Diagnosis");
  if (pending && !replacement && !cancel) {
    console.log("- First-block tx was still pending at timeout. Do not send a second buy unless using replacement or cancel.");
  } else if (replacement) {
    console.log("- Replacement path was used; compare replacement gas with original gas and receipt status.");
  } else if (cancel) {
    console.log("- Cancel path was used; buy was intentionally stopped to clear the nonce.");
  } else if (txConfirmed.some((event) => event.status === "success")) {
    console.log("- Buy transaction confirmed successfully. Use on-chain section for block position.");
  } else if (txConfirmed.some((event) => event.status !== "success")) {
    console.log("- Transaction reverted. Likely causes: hook not open yet, minOut too strict, or calldata/path mismatch.");
  } else if (dryRunExit) {
    console.log("- Dry-run completed after building the first-block transaction plan. No live transaction was sent.");
  } else if (skip) {
    console.log("- Executor skipped before sending. Check quote/price and readiness events above.");
  } else {
    console.log("- No terminal transaction or skip event found. The process may have been interrupted.");
  }
}

async function findFirstBlockAtOrAfter(client, timestampSeconds, lowBlock) {
  let low = BigInt(lowBlock);
  let high = await client.getBlockNumber();

  while (low < high) {
    const mid = (low + high) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (Number(block.timestamp) >= timestampSeconds) high = mid;
    else low = mid + 1n;
  }
  return low;
}

async function printChainSummary({ config, events }) {
  const hashes = [...new Set(eventsByName(events, "tx_sent").map((event) => event.hash).filter(Boolean))];
  const client = createBscClient(config.rpcUrls);

  console.log("");
  console.log("On-chain check");
  for (const hash of hashes) {
    try {
      const [tx, receipt] = await Promise.all([
        client.getTransaction({ hash }),
        client.getTransactionReceipt({ hash })
      ]);
      console.log(
        `- ${shortHash(hash)} block=${receipt.blockNumber} txIndex=${receipt.transactionIndex} status=${receipt.status} gasPrice=${formatMaybeGwei(tx.gasPrice)}`
      );
    } catch (error) {
      console.log(`- ${shortHash(hash)} chain lookup failed: ${error.shortMessage || error.message || error}`);
    }
  }

  const launchTime = new Date(config.launchTime).getTime();
  if (!Number.isFinite(launchTime)) return;

  const launchBlockArg = argValue("--launch-block", null);
  const launchBlock = launchBlockArg
    ? BigInt(launchBlockArg)
    : await findFirstBlockAtOrAfter(
        client,
        Math.floor(launchTime / 1000),
        config.protocols.infinityCL?.fromBlock || 0
      );
  const block = await client.getBlock({ blockNumber: launchBlock, includeTransactions: true });
  console.log("");
  console.log(`Launch block: ${launchBlock.toString()} timestamp=${new Date(Number(block.timestamp) * 1000).toISOString()}`);

  const router = config.addresses.infinityUniversalRouter?.toLowerCase();
  const targetNeedle = config.targetToken.slice(2).toLowerCase();
  const candidates = block.transactions
    .filter((tx) => tx.to?.toLowerCase() === router || String(tx.input || "").toLowerCase().includes(targetNeedle))
    .slice(0, Number(argValue("--limit", "20")));

  if (candidates.length === 0) {
    console.log("No obvious router/target-token txs found in launch block.");
    return;
  }

  console.log("Launch block candidate txs");
  for (const tx of candidates) {
    console.log(
      `- idx=${tx.transactionIndex ?? "-"} ${shortHash(tx.hash)} to=${shortHash(tx.to || "")} gasPrice=${formatMaybeGwei(tx.gasPrice)} from=${shortHash(tx.from)}`
    );
  }
}

async function main() {
  const config = loadConfigFromArgs();
  const runArg = argValue("--run", null);
  const runFile = path.resolve(process.cwd(), runArg || latestRunFile());
  const events = loadEvents(runFile);
  printEventSummary({ file: runFile, events });
  if (!hasFlag("--offline")) {
    await printChainSummary({ config, events });
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(error.shortMessage || error.message || error);
    process.exitCode = 1;
  });
}
