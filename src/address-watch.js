import { decodeEventLog, formatUnits, parseAbiItem } from "viem";
import { loadConfigFromArgs, sameAddress } from "./config.js";
import { getV2Status, getV3Statuses, getTokenMeta, createBscClient } from "./pools.js";
import { erc20Abi } from "./abis.js";
import { fmtDecimal, toDecimalAmount } from "./math.js";

const transferEvent = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
const approvalEvent = parseAbiItem("event Approval(address indexed owner,address indexed spender,uint256 value)");
const zeroAddress = "0x0000000000000000000000000000000000000000";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function normalize(address) {
  return String(address || "").toLowerCase();
}

function buildLabelMap(config) {
  const entries = config.watch?.addresses || [];
  const labels = new Map();
  for (const item of entries) {
    labels.set(normalize(item.address), item.label || item.address);
  }
  labels.set(normalize(config.targetToken), "target_token");
  labels.set(normalize(config.quoteToken), config.quoteSymbol || "quote_token");
  labels.set(normalize(zeroAddress), "zero");
  return labels;
}

function labelAddress(labels, address) {
  const label = labels.get(normalize(address));
  return label ? `${label}(${address})` : address;
}

async function getLogsChunked({ client, address, events, fromBlock, toBlock, chunkSize }) {
  const logs = [];
  for (let cursor = fromBlock; cursor <= toBlock; cursor += chunkSize + 1n) {
    const end = cursor + chunkSize > toBlock ? toBlock : cursor + chunkSize;
    for (const event of events) {
      const page = await client.getLogs({
        address,
        event,
        fromBlock: cursor,
        toBlock: end
      });
      logs.push(...page);
    }
  }
  return logs.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
}

function decodeTokenEvent(log) {
  for (const event of [transferEvent, approvalEvent]) {
    try {
      return decodeEventLog({
        abi: [event],
        data: log.data,
        topics: log.topics
      });
    } catch {
      // Try the next event signature.
    }
  }
  return null;
}

function formatTokenAmount(value, decimals) {
  return fmtDecimal(toDecimalAmount(value, decimals), 8);
}

async function printWatchedBalances({ client, config, targetMeta, labels }) {
  const addresses = config.watch?.addresses || [];
  if (addresses.length === 0) return;

  console.log("Watched address balances");
  const rows = await Promise.all(
    addresses.map(async (item) => {
      const [balance, code] = await Promise.all([
        client.readContract({
          address: config.targetToken,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [item.address]
        }).catch(() => 0n),
        client.getCode({ address: item.address }).catch(() => undefined)
      ]);
      return { item, balance, codeBytes: code ? (code.length - 2) / 2 : 0 };
    })
  );

  rows.sort((a, b) => (a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1));
  for (const row of rows) {
    console.log(
      `- ${row.item.label}: ${formatTokenAmount(row.balance, targetMeta.decimals)} ${targetMeta.symbol}, codeBytes=${row.codeBytes}, ${row.item.address}`
    );
  }
  console.log("");
}

async function printPools({ client, config, targetMeta, quoteMeta }) {
  const [v2, v3] = await Promise.all([
    getV2Status({ client, config, targetMeta, quoteMeta }).catch((error) => ({ error })),
    getV3Statuses({ client, config, targetMeta, quoteMeta }).catch((error) => [{ error }])
  ]);

  console.log("Pool discovery");
  if (v2?.exists) {
    console.log(
      `- Pancake V2 LIVE: ${v2.pair}, price ${fmtDecimal(v2.price)} ${quoteMeta.symbol}/${targetMeta.symbol}`
    );
  } else {
    console.log("- Pancake V2: not found");
  }

  const existingV3 = v3.filter((item) => item.exists);
  if (existingV3.length === 0) {
    console.log("- Pancake V3: not found in configured fee tiers");
  } else {
    for (const pool of existingV3) {
      console.log(
        `- Pancake V3 LIVE fee=${pool.fee}: ${pool.pool}, price ${fmtDecimal(pool.price)} ${quoteMeta.symbol}/${targetMeta.symbol}, liquidity=${pool.liquidity.toString()}`
      );
    }
  }
  console.log("");
}

async function printRecentEvents({ client, config, targetMeta, labels }) {
  const latest = await client.getBlockNumber();
  const recentBlocks = BigInt(argValue("--blocks", config.watch?.recentBlocks || 20000));
  const fromBlock = latest > recentBlocks ? latest - recentBlocks : 0n;
  const chunkSize = BigInt(argValue("--chunk-size", config.watch?.logChunkSize || 5000));
  const limit = Number(argValue("--limit", "30"));

  const logs = await getLogsChunked({
    client,
    address: config.targetToken,
    events: [transferEvent, approvalEvent],
    fromBlock,
    toBlock: latest,
    chunkSize
  });

  console.log(`Recent token events: ${logs.length} logs from block ${fromBlock.toString()} to ${latest.toString()}`);
  const decoded = logs
    .map((log) => ({ log, decoded: decodeTokenEvent(log) }))
    .filter((item) => item.decoded)
    .slice(-limit);

  for (const item of decoded) {
    const { log, decoded: event } = item;
    if (event.eventName === "Transfer") {
      console.log(
        `- #${log.blockNumber.toString()} Transfer ${formatTokenAmount(event.args.value, targetMeta.decimals)} ${targetMeta.symbol}: ${labelAddress(labels, event.args.from)} -> ${labelAddress(labels, event.args.to)} tx=${log.transactionHash}`
      );
    } else if (event.eventName === "Approval") {
      console.log(
        `- #${log.blockNumber.toString()} Approval ${formatTokenAmount(event.args.value, targetMeta.decimals)} ${targetMeta.symbol}: owner=${labelAddress(labels, event.args.owner)} spender=${labelAddress(labels, event.args.spender)} tx=${log.transactionHash}`
      );
    }
  }
  console.log("");
}

async function runOnce() {
  const config = loadConfigFromArgs();
  const client = createBscClient(config.rpcUrls);
  const labels = buildLabelMap(config);
  const [blockNumber, targetMeta, quoteMeta] = await Promise.all([
    client.getBlockNumber(),
    getTokenMeta(client, config.targetToken),
    getTokenMeta(client, config.quoteToken)
  ]);

  console.log(`${config.name} watch`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`BSC block: ${blockNumber.toString()}`);
  console.log(`Target: ${targetMeta.symbol} ${targetMeta.address}, totalSupply=${formatUnits(targetMeta.totalSupply, targetMeta.decimals)}`);
  console.log(`Quote: ${quoteMeta.symbol} ${quoteMeta.address}`);
  console.log(`Mode: MONITOR_ONLY. No signing and no transaction sending.`);
  console.log("");

  await printPools({ client, config, targetMeta, quoteMeta });
  await printWatchedBalances({ client, config, targetMeta, labels });
  await printRecentEvents({ client, config, targetMeta, labels });
}

async function main() {
  const watch = hasFlag("--watch");
  const intervalMs = Number(argValue("--interval-ms", "15000"));
  do {
    await runOnce();
    if (watch) await sleep(intervalMs);
  } while (watch);
}

main().catch((error) => {
  console.error(error.shortMessage || error.message || error);
  process.exitCode = 1;
});
