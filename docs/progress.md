# Alpha Sniper Progress

Last updated: `2026-05-09 08:29 CST`

## Current State

- Repo: `MeiYanDong/alpha-sniper`, branch `main`.
- Latest deployed commit: `67c7f4d`.
- AWS region: `ap-southeast-1`.
- AWS instance: `i-0d169ad4de2908544`, `t3.micro`, SSM-only, no inbound ports.
- Runtime wallet: `0xE4447c32C25936e8e800329F3Fe7112AB2582E3b`.
- Runtime secrets live in AWS SSM Parameter Store under `/alpha-sniper/env/*`.
- Current mode is verified dry-run only. No live `--send` command has been run from AWS.

## Completed

- Built the BSC/PancakeSwap Infinity SHARE monitor and readiness checks.
- Added burner wallet balance checks and dual Permit2 approval readiness.
- Added Universal Router buy and sell execution paths.
- Added post-buy exit watcher with stop-loss and profit-taking rules.
- Added auto-exit simulation and exit simulation coverage.
- Added Chainstack + Ankr hot RPC race for hook, quote, gas simulation, and gas price reads.
- Added first-block mode:
  - precomputes `minOut` from the selected price tier,
  - uses fixed gas limit and optional fixed gas price,
  - builds and signs before launch,
  - broadcasts the same raw transaction to multiple RPCs,
  - returns after first accepted broadcast unless `--broadcast-wait-all` is set,
  - pre-signs replacement/cancel transactions for pending handling.
- Added postmortem tooling for run-log and opening-block analysis.
- Added AWS deployment script with Free Tier eligible instance selection.
- Fixed AWS deployment race by waiting for app bootstrap before remote dry-run.
- Fixed AWS SSM IAM policy so the instance can read both `/alpha-sniper/env` and children.

## Verified

- Local `npm run check` passed.
- AWS bootstrap ran `npm ci` and `npm run check` successfully.
- AWS final sync reached commit `67c7f4d`.
- AWS dry-run succeeded with:
  - wallet `0xE4447c32C25936e8e800329F3Fe7112AB2582E3b`,
  - `Mode: DRY_RUN`,
  - first-block acceptable tier,
  - `10 USDT` planned buy,
  - `300000` gas limit,
  - `4.5 gwei` fixed gas price.
- AWS RPC checks:
  - `rpc:check` passed for Chainstack BSC, Ankr BSC, and Ankr transaction API.
  - Public BSC fallback passed basic reads but failed narrow logs with provider limits.
  - `test:rpc-race` passed.

## AWS RPC Measurement

Measured from `i-0d169ad4de2908544` in `ap-southeast-1` on `2026-05-09`.

Short stress with `steps=4,8,16,32`, `duration=5000ms`, `timeout=3000ms`, calls `eth_blockNumber,getSlot0,getLiquidity,isPoolStarted`:

| Provider | Stable step | p50 | p95 | Failure | Note |
| --- | ---: | ---: | ---: | ---: | --- |
| Chainstack primary | `c=4` | `20ms` | `30ms` | `0.00%` | Very low latency, but quota fails at `c=8`. |
| Ankr BSC | `c=32` | `29ms` | `325ms` | `0.00%` | Higher p95 than Chainstack at low load, but much better AWS-side concurrency. |

Chainstack first bad step from AWS:

- `c=8`: `33.67%` quota failures, while p95 stayed low at `29ms`.

Ankr higher-concurrency spot check:

- `c=64`: `0.00%` failures, `p95=240ms`, `okRps=722.0`.

Operational conclusion:

- On the AWS instance, Chainstack should be treated as a low-concurrency, low-latency read source.
- On the AWS instance, Ankr is the safer high-concurrency provider.
- Do not blindly reuse the earlier local Mac Chainstack boundary for cloud execution. Provider limits are execution-location dependent.

## Known Constraints

- SHARE launch window is already over. Current SHARE logic is useful as a proven template and test target, not as an active opportunity.
- Burner BNB was last observed at about `0.0014642891 BNB`, enough for about `4.5 gwei * 300000 gas`, but slightly short for `5 gwei * 300000 gas`.
- First-block execution can still revert if broadcast lands in a pre-open block before the hook starts. At current trade size, this gas loss is usually smaller than the operational risk of missing the block, but nonce occupation must be handled explicitly.
- Increasing buy size does not solve first-block ordering. Gas price, pre-signing, broadcast timing, and RPC propagation matter more.
- Public BSC RPC is useful as fallback/broadcast only. It should not be in the hot quote/read race unless paid providers are unavailable.
- Multi-region broadcasting is not implemented yet. The current architecture is one AWS signer instance with multi-RPC broadcast.

## Next Work

1. Create a reusable new-launch config checklist for the next token: token address, pool id, hook, launch time, price tiers, spend cap, gas budget, and sell rules.
2. Add provider weighting or per-provider pressure control for cloud runs, so Chainstack can stay in the low-latency path without being pushed into quota failure.
3. Decide whether to top up BNB and raise the fixed gas price above `4.5 gwei`.
4. Re-run AWS-side RPC stress immediately before any new launch, because provider limits can change.
5. For a later speed tier, add no-key multi-region broadcasters that only receive one pre-signed raw transaction from the single signer.

## Safe Operating Rule

Default to dry-run. A real launch must explicitly pass `--send`, use only the burner wallet, and have current token config, gas budget, sell authorization, and RPC checks verified for that specific launch.
