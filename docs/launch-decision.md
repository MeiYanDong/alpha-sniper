# SHARE launch decision

## Fixed wallet limits

- Wallet: burner only.
- Max single launch spend: `20 USDT`.
- Do not use main wallet.
- Do not buy if approval, quote, or swap simulation fails.

## Decision rules

At or after `2026-05-08 18:00:00 Asia/Shanghai`:

1. If hook is not started: wait and retry.
2. In fast launch mode, hook polling and quote probing run in parallel near launch time.
3. Quote all configured buy tiers in parallel.
4. If every quote fails before the give-up window: do not buy.
5. If average execution price is `< 0.34`: send exactly `20 USDT` exact-input buy.
6. If average execution price is `>= 0.34` and `<= 0.38`: send exactly `10 USDT` exact-input buy.
7. If average execution price is `> 0.38`: do not buy.
8. If current price is `>= 0.48`: do not buy under any condition.
9. If the selected exact tier quote passes but swap simulation fails: do not buy.

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
- At `18:00`, the normal program polls `isPoolStarted`, quotes both buy tiers in parallel, then sends only if the matched tier also passes Universal Router gas simulation.
- In fast launch mode, the program begins quote probing before launch and runs hook polling plus quote probing together. If quote succeeds and the matched tier is inside the configured price rule, that quote can trigger the buy path even if the latest hook poll has not yet observed started.
- Current exact tier semantics remain: `< 0.34` buys exact `20 USDT`; `0.34 - 0.38` buys exact `10 USDT`; above `0.38` skips.
- `npm run test:launch-sim` triggers the real `share-launch-executor` through mock chain and wallet clients. Buy scenarios reach fake `writeContract`; no real RPC, private key, or wallet signing is used.

The active prewarm command now uses the speed-first route:

```bash
npm run share:launch -- --warmup-ms 600000 --fast-launch --poll-ms 100 --sprint-ms 10000 --sprint-poll-ms 50 --quote-probe-lead-ms 10000 --gas-buffer-bps 12000 --gas-price-multiplier-bps 15000 --deadline-seconds 45 --send --multi-rpc-broadcast --broadcast-public --broadcast-timeout-ms 3000 --auto-exit --auto-approve-exit --exit-poll-ms 1000 --exit-max-watch-ms 7200000
```

With `--auto-exit`, a successful buy does not end the process. The executor immediately starts the exit watcher with the actual entry average from the buy quote.

With `--multi-rpc-broadcast --broadcast-public`, the buy transaction is signed once and the same raw transaction is broadcast to Chainstack plus public BSC RPC. This is only a propagation-speed optimization for the user's own wallet transaction; it does not do mempool attacks, sandwiching, node abuse, or any attempt to interfere with other users.

## RPC boundary

2026-05-08 16:54 CST local test result against the Chainstack BSC path:

- Broad ladder: `c=64` stable at about `240 okRps`, `p95=319ms`; `c=96` failed at `25.15%`, mostly quota errors.
- Narrow confirmation: `c=64` stable at about `208.7 okRps`, `p95=632ms`; `c=80` failed at `11.94%`, quota errors across block, slot0, liquidity, and hook calls.

Operational conclusion:

- Do not run sustained monitoring in the `c=80+` bad range.
- `100ms` baseline plus final `50ms` sprint is inside the measured stable envelope for this project.
- If a future run shows `c=64` failing, lower `--sprint-poll-ms` pressure before launch.

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
