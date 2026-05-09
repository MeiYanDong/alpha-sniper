import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import Decimal from "decimal.js";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/;

function usage() {
  return [
    "Usage:",
    "  npm run target:new -- --name NAME --target-token 0x... --pool-id 0x... --hook 0x... --launch-time ISO --ideal-max-price PRICE --max-buy-price PRICE [options]",
    "",
    "Required:",
    "  --name                 Display name for this target",
    "  --target-token         Target token address",
    "  --pool-id              PancakeSwap Infinity CL poolId",
    "  --hook                 Expected hook address",
    "  --launch-time          ISO launch time, for example 2026-05-10T18:00:00+08:00",
    "  --ideal-max-price      Highest average price for the ideal tier",
    "  --max-buy-price        Highest average price for any buy tier",
    "",
    "Options:",
    "  --slug                 Output slug, defaults to name",
    "  --out                  Output config path, defaults to config/<slug>.json",
    "  --template             Template config, defaults to config/share.json",
    "  --quote-token          Quote token, defaults to template quoteToken",
    "  --quote-symbol         Quote symbol, defaults to template quoteSymbol",
    "  --currency0            Pool currency0, defaults to quote token",
    "  --currency1            Pool currency1, defaults to target token",
    "  --from-block           Initialize scan start block, defaults to 0",
    "  --pool-parameters      Optional pool parameters bytes32 if known",
    "  --scan-initialize-logs Enable Initialize log fallback scan",
    "  --max-spend-usdt       Max wallet spend used by readiness checks",
    "  --ideal-spend-usdt     Exact input amount for ideal tier",
    "  --acceptable-spend-usdt Exact input amount for acceptable tier",
    "  --slippage-bps         Max slippage bps for buy and sell",
    "  --force                Overwrite output file"
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      options[name] = true;
      continue;
    }
    options[name] = next;
    i += 1;
  }
  return options;
}

function option(options, name, fallback = undefined) {
  return options[name] ?? fallback;
}

function requireOption(options, name) {
  const value = option(options, name);
  if (value === undefined || value === true || String(value).trim() === "") {
    throw new Error(`Missing required option --${name}`);
  }
  return String(value).trim();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function slugify(value) {
  return String(value || "target")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "target";
}

function assertAddress(label, value) {
  if (!ADDRESS_RE.test(value)) {
    throw new Error(`${label} must be a 20-byte EVM address`);
  }
}

function assertBytes32(label, value) {
  if (!BYTES32_RE.test(value)) {
    throw new Error(`${label} must be a 32-byte hex value`);
  }
}

function assertDecimal(label, value) {
  const parsed = new Decimal(String(value));
  if (!parsed.isFinite() || parsed.lte(0)) {
    throw new Error(`${label} must be a positive decimal`);
  }
  return parsed;
}

function decimalString(value) {
  return new Decimal(String(value)).toDecimalPlaces(8).toString();
}

function parseInteger(label, value, fallback) {
  const raw = value ?? fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function parseBps(label, value, fallback) {
  const parsed = parseInteger(label, value, fallback);
  if (parsed > 10_000) throw new Error(`${label} must be <= 10000`);
  return parsed;
}

function parseBooleanOption(options, name, fallback = false) {
  const value = option(options, name, fallback);
  if (value === true || value === false) return value;
  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`--${name} must be a boolean flag or true/false value`);
}

function parseCsv(value, fallback = []) {
  const raw = value ?? fallback.join(",");
  return String(raw)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function defaultAutoTierAmount(template, name, fallback) {
  const tier = template.execution?.autoBuyTiers?.find((item) => item.name === name);
  return tier?.amountInUsdt ?? fallback;
}

export function createTargetConfig(options, template) {
  const name = requireOption(options, "name");
  const targetToken = requireOption(options, "target-token");
  const poolId = requireOption(options, "pool-id");
  const expectedHook = requireOption(options, "hook");
  const launchTime = requireOption(options, "launch-time");
  const idealMaxPriceUsd = requireOption(options, "ideal-max-price");
  const maxBuyPriceUsd = requireOption(options, "max-buy-price");

  assertAddress("--target-token", targetToken);
  assertBytes32("--pool-id", poolId);
  assertAddress("--hook", expectedHook);
  assertDecimal("--ideal-max-price", idealMaxPriceUsd);
  assertDecimal("--max-buy-price", maxBuyPriceUsd);
  if (new Decimal(maxBuyPriceUsd).lt(idealMaxPriceUsd)) {
    throw new Error("--max-buy-price must be >= --ideal-max-price");
  }
  if (Number.isNaN(new Date(launchTime).getTime())) {
    throw new Error("--launch-time must be a valid date/time");
  }

  const config = cloneJson(template);
  const quoteToken = String(option(options, "quote-token", template.quoteToken));
  const quoteSymbol = String(option(options, "quote-symbol", template.quoteSymbol || "USDT"));
  const currency0 = String(option(options, "currency0", quoteToken));
  const currency1 = String(option(options, "currency1", targetToken));
  const poolParameters = option(options, "pool-parameters");
  const fromBlock = parseInteger("--from-block", option(options, "from-block"), 0);
  const maxSlippageBps = parseBps(
    "--slippage-bps",
    option(options, "slippage-bps"),
    template.execution?.maxSlippageBps ?? 500
  );
  const maxSpendUsdt = String(option(
    options,
    "max-spend-usdt",
    template.execution?.maxSpendUsdt ?? template.rules?.maxSpendUsdt ?? "20"
  ));
  const idealSpendUsdt = String(option(
    options,
    "ideal-spend-usdt",
    defaultAutoTierAmount(template, "ideal", maxSpendUsdt)
  ));
  const acceptableSpendUsdt = String(option(
    options,
    "acceptable-spend-usdt",
    defaultAutoTierAmount(template, "acceptable", idealSpendUsdt)
  ));
  const probeSpendUsdt = String(option(
    options,
    "probe-spend-usdt",
    template.rules?.probeSpendUsdt ?? maxSpendUsdt
  ));
  const cautionPriceUsd = String(option(
    options,
    "caution-price",
    decimalString(new Decimal(maxBuyPriceUsd).mul("1.15"))
  ));
  const noChasePriceUsd = String(option(
    options,
    "no-chase-price",
    decimalString(new Decimal(maxBuyPriceUsd).mul("1.25"))
  ));
  const quoteProbeAmountsUsdt = parseCsv(
    option(options, "quote-probes"),
    template.quoteProbeAmountsUsdt || [probeSpendUsdt, maxSpendUsdt]
  );
  const stopLossFromEntryPct = String(option(
    options,
    "stop-loss-pct",
    template.exit?.stopLossFromEntryPct ?? "15"
  ));
  const takeProfitHalfPct = String(option(options, "take-profit-half-pct", "50"));
  const takeProfitFullPct = String(option(options, "take-profit-full-pct", "100"));

  assertAddress("--quote-token", quoteToken);
  assertAddress("--currency0", currency0);
  assertAddress("--currency1", currency1);
  if (poolParameters !== undefined && poolParameters !== true) {
    assertBytes32("--pool-parameters", poolParameters);
  }
  for (const [label, value] of [
    ["--max-spend-usdt", maxSpendUsdt],
    ["--ideal-spend-usdt", idealSpendUsdt],
    ["--acceptable-spend-usdt", acceptableSpendUsdt],
    ["--probe-spend-usdt", probeSpendUsdt],
    ["--caution-price", cautionPriceUsd],
    ["--no-chase-price", noChasePriceUsd],
    ["--stop-loss-pct", stopLossFromEntryPct],
    ["--take-profit-half-pct", takeProfitHalfPct],
    ["--take-profit-full-pct", takeProfitFullPct],
    ...quoteProbeAmountsUsdt.map((value, index) => [`--quote-probes[${index}]`, value])
  ]) {
    assertDecimal(label, value);
  }
  if (new Decimal(takeProfitFullPct).lt(takeProfitHalfPct)) {
    throw new Error("--take-profit-full-pct must be >= --take-profit-half-pct");
  }

  config.name = name;
  config.targetToken = targetToken;
  config.quoteToken = quoteToken;
  config.quoteSymbol = quoteSymbol;
  config.launchTime = launchTime;
  config.rules = {
    ...(template.rules || {}),
    idealMaxPriceUsd,
    maxBuyPriceUsd,
    cautionPriceUsd,
    noChasePriceUsd,
    maxSpendUsdt,
    probeSpendUsdt
  };
  config.execution = {
    ...(template.execution || {}),
    mode: "AUTO_TIERED_EXACT_IN",
    maxSpendUsdt,
    autoBuyTiers: [
      {
        name: "ideal",
        avgPriceLtUsd: idealMaxPriceUsd,
        amountInUsdt: idealSpendUsdt
      },
      {
        name: "acceptable",
        avgPriceGteUsd: idealMaxPriceUsd,
        avgPriceLteUsd: maxBuyPriceUsd,
        amountInUsdt: acceptableSpendUsdt
      }
    ],
    maxSlippageBps,
    manualReviewDisabled: true
  };
  config.exit = {
    ...(template.exit || {}),
    mode: "QUOTE_THEN_EXACT_IN",
    maxSlippageBps,
    stopLossFromEntryPct,
    takeProfitTiers: [
      {
        name: "first_profit",
        gainFromEntryPctGte: takeProfitHalfPct,
        sellBps: 5000
      },
      {
        name: "full_exit",
        gainFromEntryPctGte: takeProfitFullPct,
        sellBps: 10000
      }
    ]
  };
  config.quoteProbeAmountsUsdt = quoteProbeAmountsUsdt;
  config.protocols = {
    ...(template.protocols || {}),
    infinityCL: {
      ...(template.protocols?.infinityCL || {}),
      enabled: true,
      poolId,
      expectedHook,
      currency0,
      currency1,
      fromBlock,
      scanInitializeLogs: parseBooleanOption(options, "scan-initialize-logs", false)
    }
  };
  if (poolParameters !== undefined && poolParameters !== true) {
    config.protocols.infinityCL.parameters = poolParameters;
  } else {
    delete config.protocols.infinityCL.parameters;
  }
  config.readwiseBenchmarks = [];

  return config;
}

export function writeTargetConfig({ options, cwd = process.cwd() }) {
  const templatePath = path.resolve(cwd, String(option(options, "template", "config/share.json")));
  const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  const config = createTargetConfig(options, template);
  const slug = slugify(option(options, "slug", config.name));
  const outPath = path.resolve(cwd, String(option(options, "out", `config/${slug}.json`)));

  if (fs.existsSync(outPath) && !option(options, "force", false)) {
    throw new Error(`Refusing to overwrite ${outPath}; pass --force to replace it`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`);
  return { outPath, config };
}

function printNextSteps(outPath, cwd) {
  const relative = path.relative(cwd, outPath);
  const displayPath =
    relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : outPath;
  const configArg = shellArg(displayPath);
  console.log(`Generated: ${displayPath}`);
  console.log("");
  console.log("Next safe checks:");
  console.log(`  npm run target:status -- --config ${configArg}`);
  console.log(`  npm run target:cache:warm -- --config ${configArg}`);
  console.log(`  npm run target:ready -- --config ${configArg}`);
  console.log(`  npm run target:preflight -- --config ${configArg}`);
  console.log("");
  console.log("No live transaction is sent unless a later command explicitly adds --send.");
  console.log("Verify currency0/currency1 against poolKey before launch if the pool order is unknown.");
}

function shellArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }
  const options = parseArgs(argv);
  const { outPath } = writeTargetConfig({ options, cwd });
  printNextSteps(outPath, cwd);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    console.error("");
    console.error(usage());
    process.exitCode = 1;
  }
}
