import Decimal from "decimal.js";

export function getExecutionConfig(config) {
  const maxSpendUsdt =
    process.env.MAX_SPEND_USDT ||
    config.execution?.maxSpendUsdt ||
    config.execution?.exactSpendUsdt ||
    config.execution?.amountInUsdt ||
    config.rules.maxSpendUsdt;

  return {
    maxSpendUsdt,
    autoBuyTiers:
      config.execution?.autoBuyTiers || [
        {
          name: "default",
          avgPriceLteUsd: config.execution?.autoBuyMaxAvgPriceUsd || config.rules.idealMaxPriceUsd,
          amountInUsdt: maxSpendUsdt
        }
      ],
    autoBuyMaxAvgPriceUsd:
      config.execution?.autoBuyMaxAvgPriceUsd || config.rules.idealMaxPriceUsd,
    maxSlippageBps: Number(
      process.env.MAX_SLIPPAGE_BPS || config.execution?.maxSlippageBps || 500
    )
  };
}

function tierMatches(avg, tier) {
  if (tier.avgPriceLtUsd !== undefined && !avg.lt(tier.avgPriceLtUsd)) return false;
  if (tier.avgPriceLteUsd !== undefined && !avg.lte(tier.avgPriceLteUsd)) return false;
  if (tier.avgPriceGtUsd !== undefined && !avg.gt(tier.avgPriceGtUsd)) return false;
  if (tier.avgPriceGteUsd !== undefined && !avg.gte(tier.avgPriceGteUsd)) return false;
  return true;
}

export function decideAutoBuy({
  config,
  hookStarted,
  quoteOk,
  avgPriceUsd,
  currentPriceUsd,
  approvalOk = true,
  balanceOk = true,
  swapSimulationOk = true
}) {
  const execution = getExecutionConfig(config);

  if (!hookStarted) {
    return { action: "WAIT", reason: "HOOK_NOT_STARTED" };
  }
  if (!approvalOk) {
    return { action: "SKIP", reason: "APPROVAL_MISSING" };
  }
  if (!balanceOk) {
    return { action: "SKIP", reason: "BALANCE_TOO_LOW" };
  }
  if (!quoteOk || !avgPriceUsd) {
    return { action: "SKIP", reason: "QUOTE_FAILED" };
  }
  if (!swapSimulationOk) {
    return { action: "SKIP", reason: "SWAP_SIMULATION_FAILED" };
  }

  const avg = new Decimal(String(avgPriceUsd));
  const current = currentPriceUsd ? new Decimal(String(currentPriceUsd)) : avg;
  const noChase = new Decimal(String(config.rules.noChasePriceUsd));

  if (current.gte(noChase)) {
    return { action: "SKIP", reason: "NO_CHASE_PRICE" };
  }

  const matchedTier = execution.autoBuyTiers.find((tier) => tierMatches(avg, tier));
  if (matchedTier) {
    return {
      action: "BUY_EXACT_IN",
      reason: `MATCHED_TIER_${matchedTier.name || "unnamed"}`.toUpperCase(),
      amountInUsdt: matchedTier.amountInUsdt,
      tier: matchedTier.name || null,
      maxSlippageBps: execution.maxSlippageBps
    };
  }

  return { action: "SKIP", reason: "NO_AUTO_BUY_TIER_MATCHED" };
}

export function getExitConfig(config) {
  return {
    mode: config.exit?.mode || "QUOTE_THEN_EXACT_IN",
    defaultSellBps: Number(config.exit?.defaultSellBps || 10_000),
    maxSlippageBps: Number(config.exit?.maxSlippageBps || config.execution?.maxSlippageBps || 500),
    stopLossFromEntryPct: config.exit?.stopLossFromEntryPct || "15",
    takeProfitTiers:
      config.exit?.takeProfitTiers || [
        { name: "first_profit", gainFromEntryPctGte: "50", sellBps: 5000 },
        { name: "full_exit", gainFromEntryPctGte: "100", sellBps: 10000 }
      ]
  };
}

export function decideAutoSell({
  config,
  hasPosition,
  hookStarted,
  quoteOk,
  avgExitPriceUsd,
  entryAvgPriceUsd,
  approvalOk = true,
  gasOk = true,
  swapSimulationOk = true,
  emergencyExit = false
}) {
  const exit = getExitConfig(config);

  if (!hasPosition) {
    return { action: "WAIT", reason: "NO_POSITION" };
  }
  if (!hookStarted) {
    return { action: "WAIT", reason: "HOOK_NOT_STARTED" };
  }
  if (!approvalOk) {
    return { action: "SKIP", reason: "APPROVAL_MISSING" };
  }
  if (!gasOk) {
    return { action: "SKIP", reason: "BNB_GAS_TOO_LOW" };
  }
  if (!quoteOk || !avgExitPriceUsd) {
    return { action: "SKIP", reason: "SELL_QUOTE_FAILED" };
  }
  if (!swapSimulationOk) {
    return { action: "SKIP", reason: "SELL_SIMULATION_FAILED" };
  }
  if (emergencyExit) {
    return {
      action: "SELL_EXACT_IN",
      reason: "EMERGENCY_EXIT",
      sellBps: 10_000,
      maxSlippageBps: exit.maxSlippageBps
    };
  }
  if (!entryAvgPriceUsd) {
    return {
      action: "WAIT",
      reason: "ENTRY_PRICE_UNKNOWN",
      sellBps: exit.defaultSellBps,
      maxSlippageBps: exit.maxSlippageBps
    };
  }

  const avgExit = new Decimal(String(avgExitPriceUsd));
  const entry = new Decimal(String(entryAvgPriceUsd));
  const stopPrice = entry.mul(new Decimal(100).minus(exit.stopLossFromEntryPct)).div(100);

  if (avgExit.lte(stopPrice)) {
    return {
      action: "SELL_EXACT_IN",
      reason: "STOP_LOSS",
      sellBps: 10_000,
      maxSlippageBps: exit.maxSlippageBps
    };
  }

  const gainPct = avgExit.minus(entry).div(entry).mul(100);
  const matchedTier = [...exit.takeProfitTiers]
    .sort((a, b) => Number(b.gainFromEntryPctGte) - Number(a.gainFromEntryPctGte))
    .find((tier) => gainPct.gte(tier.gainFromEntryPctGte));

  if (matchedTier) {
    return {
      action: "SELL_EXACT_IN",
      reason: `TAKE_PROFIT_${matchedTier.name || "unnamed"}`.toUpperCase(),
      sellBps: Number(matchedTier.sellBps),
      maxSlippageBps: exit.maxSlippageBps
    };
  }

  return { action: "WAIT", reason: "HOLD_POSITION" };
}
