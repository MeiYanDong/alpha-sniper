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

- For SHARE, `npm run share:ready` passes spend and approval checks.
- For a new target, generate a separate config with `npm run target:new` first; do not mutate `config/share.json` during launch pressure.
- `npm run target:cache:warm -- --config config/<target>.json` warms static token metadata and poolKey cache.
- `npm run target:ready -- --config config/<target>.json` passes spend and approval checks.
- `npm run target:preflight -- --config config/<target>.json` passes without waiting for launch.
- The generated config's `currency0/currency1`, hook, poolId, and optional pool parameters match the real poolKey.
- USDT is approved to Permit2 before launch.
- RPC stress test passes on Chainstack and Ankr standard BSC RPC.
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
npm run share:launch -- --warmup-ms 600000 --fast-launch --rpc-race --rpc-race-labels chainstack-primary,ankr-bsc --rpc-race-timeout-ms 3000 --poll-ms 100 --sprint-ms 10000 --sprint-poll-ms 50 --quote-probe-lead-ms 10000 --gas-buffer-bps 12000 --gas-price-multiplier-bps 20000 --deadline-seconds 45 --send --multi-rpc-broadcast --broadcast-public --broadcast-timeout-ms 3000 --auto-exit --auto-approve-exit --exit-poll-ms 1000 --exit-max-watch-ms 7200000
```

For first-block competition, use the prebuilt route:

```bash
npm run share:launch -- --first-block --first-block-tier acceptable --first-block-broadcast-offset-ms -150 --first-block-gas-limit 300000 --first-block-receipt-timeout-ms 12000 --first-block-on-pending replace --replacement-gas-price-multiplier-bps 15000 --gas-price-gwei-fixed 4.5 --deadline-seconds 45 --fast-launch --rpc-race --rpc-race-labels chainstack-primary,ankr-bsc --multi-rpc-broadcast --broadcast-public --broadcast-timeout-ms 3000 --broadcast-prewarm-ms 3000 --send --auto-exit --exit-poll-ms 1000 --exit-max-watch-ms 7200000
```

With `--auto-exit`, a successful buy does not end the process. The executor immediately starts the exit watcher with the actual entry average from the buy quote.

With `--multi-rpc-broadcast --broadcast-public`, the buy transaction is signed once and the same raw transaction is broadcast to Chainstack, Ankr standard BSC RPC, and public BSC RPC. Broadcast returns as soon as the first provider accepts the raw tx; the remaining provider results continue in the background and are written to the run log. This is only a propagation-speed optimization for the user's own wallet transaction; it does not do mempool attacks, sandwiching, node abuse, or any attempt to interfere with other users.

For maximum exit speed, pre-approve the target token before launch:

```bash
npm run share:approve:exit -- --send
```

The default pre-approval amount is `100 SHARE`, based on `20 USDT / 0.32 = 62.5 SHARE` plus buffer. With `--auto-approve-exit`, the launch executor can still approve after buy confirmation, but that is slower than pre-approval.

With `--rpc-race`, the hot read path races Chainstack and Ankr standard BSC RPC for hook reads, exact-input quotes, Universal Router gas simulation, and gas price. Public RPC is deliberately excluded from the hot race. Wallet nonce, transaction receipt, balances, and final settlement reads remain on the normal client path.

`--rpc-race` lowers read latency variance. It does not change the execution model: a transaction still has to be signed, broadcast, accepted by the network, and included by a validator.

With `--first-block`, the executor changes execution model:

- It selects a tier before launch. Default is the tier with the highest accepted average price, currently `acceptable`.
- It computes `minOut` from the configured max average price, not from a live quote. For `10 USDT` at `0.38`, `minOut` is about `26.31578947 SHARE`.
- It builds and signs the raw transaction before the broadcast moment.
- It broadcasts at `launchTime + --first-block-broadcast-offset-ms`, defaulting to `-150ms`.
- It uses fixed `--first-block-gas-limit` because pre-open gas simulation reverts on the hook.
- It should use `--gas-price-gwei-fixed` for the speed path, so launch does not wait on a live gas price read.
- Latest local preflight observed about `0.0024642891 BNB`, enough for `5 gwei * 300000 gas = 0.0015 BNB`; if raising above `5 gwei`, re-check BNB gas budget immediately before launch.
- It prewarms broadcast RPCs before the broadcast moment unless `--no-broadcast-prewarm` is provided.
- If the first-block transaction reverts and the receipt is available, it can fall back to the quote-based safe path.
- If the first-block transaction is still pending, do not send a second buy with uncertain nonce state.
- Pending handling is explicit:
  - `--first-block-on-pending wait`: return `FIRST_BLOCK_TX_PENDING`, keep observing.
  - `--first-block-on-pending replace`: pre-sign the same buy calldata with the same nonce and a higher gas price, then broadcast it if the original tx is pending.
  - `--first-block-on-pending cancel`: pre-sign a zero-value self-transfer with the same nonce and a higher gas price, then broadcast it if the original tx is pending.
- Replacement gas defaults to `--replacement-gas-price-multiplier-bps 12500`; speed mode uses `15000`, with optional fixed/floor/cap gwei overrides.

Postmortem command:

```bash
npm run share:postmortem -- --offline
npm run share:postmortem -- --run data/runs/具体文件.jsonl --launch-block 97068324
```

The postmortem report reads JSONL evidence first. Online mode then checks receipt, tx index, launch block timestamp, and candidate router/token transactions in the launch block.

Gas note:

- A failed pre-open hook revert is usually not the main economic risk at this size.
- `300000 gas * 3 gwei = 0.0009 BNB`.
- `300000 gas * 5 gwei = 0.0015 BNB`.
- Whether that is below `1U` depends on live BNB price. The bigger operational risk is nonce occupation, not the gas fee itself.

## 2026-05-08 postmortem

Observed executor timing from the run log:

- `18:00:00.603 Asia/Shanghai`: hook started observed.
- `18:00:00.604 Asia/Shanghai`: first successful buy quote returned.
- `18:00:00.606 Asia/Shanghai`: executor skipped because the quoted average price was already above the configured ceiling.

Observed chain timing:

- Launch block: `97068324`, timestamp `2026-05-08T10:00:00Z`.
- Earliest SHARE buy was already inside the launch block at `txIndex=1`: about `600,000 USDT` in, about `1,425,603 SHARE` out, average price about `0.4209`.
- More large orders in the same block pushed the price far above the configured buy zone before the executor's first successful post-open quote.

Conclusion:

- The program did the right thing by skipping; the quote was already too expensive.
- The main failure cause was not that the configured `20U` amount was too small. Larger size would have made slippage worse.
- The limiting architecture was post-open confirmation: `wait hook/quote -> decide -> sign/broadcast`. That route can react quickly after open, but it cannot beat transactions already included in the launch block.
- First-block mode addresses that by moving calldata construction, minOut calculation, signing, and broadcast scheduling before the successful quote.
- Hot RPC race still helps discovery and fallback, but it is not enough by itself.

## RPC boundary

2026-05-08 16:54 CST local test result against the Chainstack BSC path:

- Broad ladder: `c=64` stable at about `240 okRps`, `p95=319ms`; `c=96` failed at `25.15%`, mostly quota errors.
- Narrow confirmation: `c=64` stable at about `208.7 okRps`, `p95=632ms`; `c=80` failed at `11.94%`, quota errors across block, slot0, liquidity, and hook calls.

Operational conclusion:

- Do not run sustained monitoring in the `c=80+` bad range.
- `100ms` baseline plus final `50ms` sprint is inside the measured stable envelope for this project.
- If a future run shows `c=64` failing, lower `--sprint-poll-ms` pressure before launch.
- Use RPC fallback for reliability and RPC race for latency-critical reads. Do not put public RPC in the hot race unless paid providers are unavailable.

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
