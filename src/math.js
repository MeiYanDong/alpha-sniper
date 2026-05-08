import Decimal from "decimal.js";
import { formatUnits, parseUnits } from "viem";
import { sameAddress } from "./config.js";

Decimal.set({ precision: 50, rounding: Decimal.ROUND_HALF_UP });

const Q192 = new Decimal(2).pow(192);

export function toDecimalAmount(raw, decimals) {
  return new Decimal(formatUnits(raw, decimals));
}

export function sqrtPriceX96ToHumanPrice1Per0(sqrtPriceX96, decimals0, decimals1) {
  const rawPrice = new Decimal(sqrtPriceX96.toString()).pow(2).div(Q192);
  return rawPrice.mul(new Decimal(10).pow(decimals0 - decimals1));
}

export function quotePerTargetFromSqrtPrice({
  sqrtPriceX96,
  token0,
  token1,
  token0Decimals,
  token1Decimals,
  targetToken,
  quoteToken
}) {
  const price1Per0 = sqrtPriceX96ToHumanPrice1Per0(
    sqrtPriceX96,
    token0Decimals,
    token1Decimals
  );

  if (sameAddress(token0, targetToken) && sameAddress(token1, quoteToken)) {
    return price1Per0;
  }

  if (sameAddress(token0, quoteToken) && sameAddress(token1, targetToken)) {
    if (price1Per0.isZero()) return new Decimal(0);
    return new Decimal(1).div(price1Per0);
  }

  return null;
}

export function calculateV2ExactIn({
  amountIn,
  reserveIn,
  reserveOut,
  decimalsIn,
  decimalsOut
}) {
  const amountInRaw = parseUnits(String(amountIn), decimalsIn);
  const amountInWithFee = amountInRaw * 9975n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 10000n + amountInWithFee;
  const amountOutRaw = denominator === 0n ? 0n : numerator / denominator;

  const amountInHuman = new Decimal(String(amountIn));
  const amountOutHuman = toDecimalAmount(amountOutRaw, decimalsOut);
  const avgPrice = amountOutHuman.isZero()
    ? null
    : amountInHuman.div(amountOutHuman);

  const reserveInAfter = reserveIn + amountInRaw;
  const reserveOutAfter = reserveOut - amountOutRaw;
  const endPrice = toDecimalAmount(reserveInAfter, decimalsIn).div(
    toDecimalAmount(reserveOutAfter, decimalsOut)
  );

  return { amountOutRaw, amountOutHuman, avgPrice, endPrice };
}

export function fmtDecimal(value, dp = 8) {
  if (value === null || value === undefined) return "n/a";
  const decimal = Decimal.isDecimal(value) ? value : new Decimal(String(value));
  if (!decimal.isFinite()) return "n/a";
  return decimal.toFixed(dp).replace(/\.?0+$/, "");
}

export function classifyPrice(price, rules) {
  if (!price) return "NO_PRICE";
  const p = Decimal.isDecimal(price) ? price : new Decimal(String(price));
  if (p.lte(rules.idealMaxPriceUsd)) return "IDEAL";
  if (p.lte(rules.maxBuyPriceUsd)) return "OK";
  if (p.lte(rules.cautionPriceUsd)) return "CAUTION";
  if (p.gte(rules.noChasePriceUsd)) return "NO_CHASE";
  return "HIGH";
}
