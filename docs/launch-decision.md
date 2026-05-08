# SHARE launch decision

## Fixed wallet limits

- Wallet: burner only.
- Max single launch spend: `20 USDT`.
- Do not use main wallet.
- Do not buy if approval, quote, or swap simulation fails.

## Decision rules

At or after `2026-05-08 18:00:00 Asia/Shanghai`:

1. If hook is not started: wait and retry.
2. Quote all configured buy tiers in parallel.
3. If every quote fails before the give-up window: do not buy.
4. If average execution price is `< 0.34`: send exactly `20 USDT` exact-input buy.
5. If average execution price is `>= 0.34` and `<= 0.38`: send exactly `10 USDT` exact-input buy.
6. If average execution price is `> 0.38`: do not buy.
7. If current price is `>= 0.48`: do not buy under any condition.
8. If the selected exact tier quote passes but swap simulation fails: do not buy.

There is no "up to" sizing. The program can only buy exact `20 USDT`, exact `10 USDT`, or skip.

## Exact transaction semantics

- Input amount tier 1: exactly `20 USDT` when avg price is `< 0.34`.
- Input amount tier 2: exactly `10 USDT` when avg price is `>= 0.34` and `<= 0.38`.
- The quote must pass for the exact tier being sent. If the `20 USDT` tier quote fails but the `10 USDT` tier quote passes and matches the acceptable range, the current program can still buy exact `10 USDT`.
- Inclusive boundaries use a tiny decimal tolerance for chain integer rounding, so an intended exact `0.38` average is still treated as inside the `10 USDT` tier, while `0.3801` still skips.
- Slippage guard: `MAX_SLIPPAGE_BPS=500`, so minimum received token amount must be computed from the verified quote before sending.
- If actual output is below `minOut`, the transaction must revert.
- Program action can only be `WAIT`, `SKIP`, or `BUY_EXACT_IN`.

## Pre-launch checklist

- `npm run share:ready` passes spend and approval checks.
- `npm run share:launch -- --preflight-only` passes without waiting for launch.
- USDT is approved to Permit2 before launch.
- RPC stress test passes on Chainstack.
- Swap execution path is implemented and dry-run reaches the expected hook gate before launch.
- Launch execution writes JSONL evidence to `data/runs/*.jsonl`.

## Launch execution timing

- Start the one-shot prewarm around `2026-05-08 17:50:00 Asia/Shanghai`.
- Prewarm is for enabling the process and hook scanning; authorization must already be done before then.
- At `18:00`, the program polls `isPoolStarted`, quotes both buy tiers in parallel, then sends only if the matched tier also passes Universal Router gas simulation.
- Current exact tier semantics remain: `< 0.34` buys exact `20 USDT`; `0.34 - 0.38` buys exact `10 USDT`; above `0.38` skips.
- `npm run test:launch-sim` triggers the real `share-launch-executor` through mock chain and wallet clients. Buy scenarios reach fake `writeContract`; no real RPC, private key, or wallet signing is used.

The active prewarm command now uses:

```bash
npm run share:launch -- --warmup-ms 600000 --poll-ms 250 --gas-buffer-bps 12000 --gas-price-multiplier-bps 12000 --send --auto-exit --auto-approve-exit --exit-poll-ms 1000 --exit-max-watch-ms 7200000
```

With `--auto-exit`, a successful buy does not end the process. The executor immediately starts the exit watcher with the actual entry average from the buy quote.

## Current blocker

The program can monitor, quote, build PancakeSwap Infinity Universal Router calldata, check dual Permit2 approvals, and dry-run readiness. It should not send a real buy or sell until the SHARE hook is started and the exact SHARE transaction simulation passes from the burner wallet.

## Sell rules

Sell uses the reverse direction of the same Infinity CL pool: `SHARE -> USDT`.

- The program must quote exact-input sell before any sell.
- The program must simulate the Universal Router transaction before any sell.
- Do not sell if hook is not started, quote fails, simulation fails, BNB gas is too low, or approval is missing.
- Default sell amount is exact-input all current SHARE balance.
- If entry price is known, default stop loss is 15% below entry.
- If entry price is known, default profit taking is 50% of position at +50%, and full exit at +100%.
- If entry price is unknown, the program should only report `ENTRY_PRICE_UNKNOWN` and wait for manual/explicit sell instruction.
- With `--auto-approve-exit`, if SHARE sell approval is missing after a successful buy, the program can send the required ERC20-to-Permit2 approval and Permit2-to-UniversalRouter approval for the current burner wallet SHARE balance before monitoring/selling.
- `npm run test:exit-sim` triggers the real exit watcher with mock clients. `npm run test:auto-flow-sim` triggers the real buy executor, then the real exit watcher, and reaches fake buy and fake sell `writeContract` calls.

Permit2 has two layers:

1. ERC20 approval: token approves Permit2.
2. Permit2 allowance: owner authorizes Universal Router as spender inside Permit2.

Both layers are required for buy and sell execution.
