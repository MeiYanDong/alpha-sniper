# Alpha Sniper Progress

Last updated: `2026-05-09 09:06 CST`

## Current State

- Repo: `MeiYanDong/alpha-sniper`, branch `main`.
- Latest deployed commit: `32c868d`.
- AWS Singapore instance: `i-0d169ad4de2908544`, `ap-southeast-1`, `t3.micro`, SSM-only, no inbound ports.
- AWS US West instance: `i-004854b92bf43622c`, `us-west-2`, `t3.micro`, SSM-only, no inbound ports.
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
- Added region-isolated AWS role/profile/security group names for parallel region tests.
- Fixed AWS deployment race by waiting for app bootstrap before remote dry-run.
- Fixed AWS SSM IAM policy so the instance can read both `/alpha-sniper/env` and children.
- Fixed AWS deploy SSM command parameter encoding for shell commands containing brackets.

## Verified

- Local `npm run check` passed.
- AWS bootstrap ran `npm ci` and `npm run check` successfully.
- AWS Singapore dry-run succeeded with:
  - wallet `0xE4447c32C25936e8e800329F3Fe7112AB2582E3b`,
  - `Mode: DRY_RUN`,
  - first-block acceptable tier,
  - `10 USDT` planned buy,
  - `300000` gas limit,
  - `4.5 gwei` fixed gas price.
- AWS US West deploy and dry-run succeeded with the same first-block `DRY_RUN` plan.
- AWS RPC checks in both regions:
  - `rpc:check` passed for Chainstack BSC, Ankr BSC, and Ankr transaction API.
  - Public BSC fallback passed basic reads but failed narrow logs with provider limits.
  - `test:rpc-race` passed.

## RPC Measurement

Measured on `2026-05-09` with identical parameters:

- `duration=10000ms`
- `timeout=3000ms`
- `steps=1,2,4,8,16,32`
- calls: `eth_blockNumber,getSlot0,getLiquidity,isPoolStarted`
- stable boundary: failure `<=1%` and `p95<=1000ms`

| Location | Provider | Stable step | p50 at stable | p95 at stable | First bad step | Note |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Local Mac | Chainstack | `c=32` | `246ms` | `288ms` | none tested | Stable but much slower than cloud low-latency paths. |
| Local Mac | Ankr | `c=4` | `237ms` | `541ms` | `c=8`, p95 `1487ms` | No failures, but tail latency breaks at `c=8`. |
| AWS Singapore | Chainstack | `c=4` | `18ms` | `25ms` | `c=8`, fail `37.20%` | Lowest low-concurrency latency, strict quota ceiling. |
| AWS Singapore | Ankr | `c=32` | `29ms` | `177ms` | none tested | Good cloud high-concurrency path. |
| AWS US West | Chainstack | `c=16` | `105ms` | `129ms` | `c=32`, fail `10.64%` | More concurrency headroom than Singapore, slower than Singapore at low c. |
| AWS US West | Ankr | `c=32` | `39ms` | `63ms` | none tested | Best overall result for high-concurrency hot reads. |

Operational conclusion:

- `us-west-2` is currently the best candidate for primary execution because Ankr is both fast and stable there.
- `ap-southeast-1` Chainstack is still the fastest low-concurrency read path, but quota breaks hard at `c=8`.
- Local Mac is acceptable for development and safety checks, not for first-block speed.
- Provider behavior is location-dependent. Re-run this test near any real launch.

Current deployment recommendation:

- Keep `us-west-2` as the active test candidate.
- Keep `ap-southeast-1` only until the user decides whether to terminate it; running both doubles EC2 hours.
- Next code optimization should add provider weighting/pressure control: do not let Chainstack receive the same pressure as Ankr in cloud runs.

## Known Constraints

- SHARE launch window is already over. Current SHARE logic is useful as a proven template and test target, not as an active opportunity.
- Burner BNB was last observed locally at about `0.0024642891 BNB`, enough for `5 gwei * 300000 gas = 0.0015 BNB`; still recheck before launch.
- First-block execution can still revert if broadcast lands in a pre-open block before the hook starts. At current trade size, this gas loss is usually smaller than the operational risk of missing the block, but nonce occupation must be handled explicitly.
- Increasing buy size does not solve first-block ordering. Gas price, pre-signing, broadcast timing, and RPC propagation matter more.
- Public BSC RPC is useful as fallback/broadcast only. It should not be in the hot quote/read race unless paid providers are unavailable.
- Multi-region broadcasting is not implemented yet. The current architecture is one signer instance per deployed region with multi-RPC broadcast. Do not run live sends from both regions for the same wallet at the same time.

## Next Work

1. Create a reusable new-launch config checklist for the next token: token address, pool id, hook, launch time, price tiers, spend cap, gas budget, and sell rules.
2. Re-run AWS-side RPC stress immediately before any new launch, because provider limits can change.
3. Measure timer precision on the intended execution instance with `npm run timer:precision` or `scripts/aws-ssm-run.sh timer-precision`.
4. Decide whether to raise the fixed gas price above `4.5 gwei`; current observed BNB can cover `5 gwei * 300000 gas`, but higher settings need a fresh budget check.
5. Add a broadcast-response latency test for `eth_sendRawTransaction` rejection paths. This should not be treated as proof of validator propagation speed, but it can expose cold provider/network delay.
6. For a later speed tier, add no-key multi-region broadcasters that only receive one pre-signed raw transaction from the single signer.

## Implemented Improvements After Comparison

- `rpc-race` now supports per-provider max in-flight limits.
- Default race limit is `chainstack-primary=4`, so cloud runs do not push Chainstack into the quota-failure range observed in Singapore.
- Override with:

```bash
--rpc-race-max-inflight chainstack-primary=4,ankr-bsc=32
```

- Added `npm run timer:precision` to measure Node.js wake-up error for launch-time scheduling.
- Added `scripts/aws-ssm-run.sh timer-precision` for remote instance timing checks.

## Safe Operating Rule

Default to dry-run. A real launch must explicitly pass `--send`, use only the burner wallet, and have current token config, gas budget, sell authorization, and RPC checks verified for that specific launch.
