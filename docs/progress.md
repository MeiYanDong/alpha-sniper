# Alpha Sniper Progress

Last updated: `2026-05-09 11:20 CST`

## Current State

- Repo: `MeiYanDong/alpha-sniper`, branch `main`.
- Latest deployed commit: `2d345c8`.
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
- Added no-key raw broadcaster support for remote multi-region broadcast:
  - server receives only signed raw transactions,
  - server does not load or require `PRIVATE_KEY`,
  - signer can send the same raw tx to remote broadcasters with `--remote-broadcaster-urls`.
- Added AWS deployment script with Free Tier eligible instance selection.
- Added region-isolated AWS role/profile/security group names for parallel region tests.
- Added stable low-permission AWS operator profile support for daily SSM testing:
  - `scripts/aws-stable-operator-profile.sh` can create/check `alpha-sniper-operator`,
  - `scripts/aws-ssm-run.sh` auto-prefers that profile when present,
  - the operator policy can send SSM commands and read command results, but does not read private key or RPC secrets.
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
- AWS US West sync to `b5c1c02` succeeded; remote `check`, `test:rpc-race`, `timer-precision`, and first-block `dry-run` all passed.
- AWS US West timer precision result on `2026-05-09 09:21 CST`:
  - `samples=1000`, `interval=10ms`, `warmup=250ms`,
  - `absErrorMs p50=0.345ms`, `p95=0.784ms`, `p99=0.823ms`, `max=2.714ms`.
- AWS US West dry-run confirmed the new hot-read pressure limit: `RPC race max in-flight: chainstack-primary=4`.
- Local broadcast rejection latency test passed with invalid raw tx `0x00`:
  - Chainstack/Public rejected quickly,
  - Ankr timed out on the local `eth_sendRawTransaction` rejection path,
  - no provider accepted the invalid raw tx.
- Local zero-balance signed broadcast rejection test also passed:
  - Chainstack `p95=593.2ms`,
  - Ankr `p95=253.3ms`,
  - Public BSC `p95=254.2ms`,
  - no provider accepted the zero-balance signed tx.
- AWS US West sync to `4e5df8e` succeeded; remote `check`, `broadcast-latency-signed`, and first-block `dry-run` passed.
- AWS US West zero-balance signed broadcast rejection latency:
  - Chainstack: `p50=111.2ms`, `p95=166.1ms`, accepted `0/5`,
  - Ankr: `p50=35.8ms`, `p95=36.8ms`, accepted `0/5`,
  - Public BSC: `p50=61.0ms`, `p95=61.9ms`, accepted `0/5`.
- Conclusion: Ankr timeout was specific to malformed invalid raw tx handling. For real-format signed tx entry testing, Ankr is currently the fastest us-west-2 broadcast endpoint.
- Local `test:launch-sim` passed with scenario `S17C`, confirming a remote no-key broadcaster receives the same signed raw tx while the local multi-RPC path remains active.
- Local raw broadcaster `/health` and `/prewarm` passed on `127.0.0.1`, returning `privateKeyRequired=false`.
- Local raw broadcaster HTTP behavior passed:
  - unauthorized `/prewarm` returns `401`,
  - authorized `/prewarm` works,
  - zero-balance signed `/broadcast` returns `502` with all providers rejected and `accepted=0`.
- AWS US West sync to `af2f6e1` succeeded; remote `check`, `broadcaster-health`, and first-block `dry-run` passed.
- AWS US West broadcaster health returned `privateKeyRequired=false` with providers `chainstack-primary`, `ankr-bsc`, and `public-bsc`.
- AWS US West sync to `f7a0621` succeeded; remote `check`, `broadcaster-health`, `broadcast-latency-signed`, and first-block `dry-run` passed.
- AWS US West raw broadcaster HTTP behavior passed:
  - unauthorized `/prewarm` returns `401`,
  - authorized `/prewarm` reached all three providers,
  - zero-balance signed `/broadcast` returns `502` with all providers rejected and `accepted=0`.
- Latest AWS signed broadcast rejection latency:
  - Chainstack `p50=259.6ms`, `p95=2973.1ms`,
  - Ankr `p50=34.9ms`, `p95=38.1ms`,
  - Public BSC `p50=60.4ms`, `p95=61.0ms`.
- AWS US West sync to `74ae9ae` succeeded; remote `check`, `broadcast:latency`, and first-block `dry-run` passed.
- AWS US West broadcast rejection latency with invalid raw tx `0x00`:
  - Chainstack: `p50=130.8ms`, `p95=185.9ms`, accepted `0/5`,
  - Ankr: timed out on all `5/5` samples,
  - Public BSC: `p50=60.9ms`, `p95=62.3ms`, accepted `0/5`.
- AWS RPC checks in both regions:
  - `rpc:check` passed for Chainstack BSC, Ankr BSC, and Ankr transaction API.
  - Public BSC fallback passed basic reads but failed narrow logs with provider limits.
  - `test:rpc-race` passed.
- Stable AWS operator profile was installed and verified:
  - `alpha-sniper-operator` resolves to `arn:aws:iam::388768426712:user/alpha-sniper-operator`,
  - `scripts/aws-ssm-run.sh status` works with `AWS_PROFILE` unset, proving it auto-selected the stable profile,
  - AWS US West was synced to `2d345c8`,
  - remote `check` passed on `2d345c8`.
- Local next-step tests on `2026-05-09 10:28-10:36 CST` passed:
  - `timer:precision`: `absErrorMs p95=1.033ms`, `max=1.232ms`.
  - `rpc:stress`: Chainstack stable at `c=32`, `okRps=128.4`, `p95=310ms`; Ankr stable at `c=32`, `okRps=100.6`, `p95=564ms`.
  - `broadcast:latency` invalid raw tx: Chainstack/Public rejected, Ankr timed out on malformed raw handling, accepted `0/15`.
  - `broadcast:latency --mode zero-balance-signed`: Chainstack `p95=581.5ms`, Ankr `p95=238.2ms`, Public `p95=330.2ms`, accepted `0/15`.
- AWS US West sync to `e518054` succeeded; remote `check`, `raw-broadcaster-test`, and first-block `dry-run` passed.
- AWS US West first-block dry-run confirmed the new default hot-read pressure limit: `RPC race max in-flight: chainstack-primary=4,ankr-bsc=32`.
- AWS US West timer precision latest result:
  - `absErrorMs p50=0.288ms`, `p95=0.726ms`, `p99=1.516ms`, `max=1.544ms`.
- AWS US West latest RPC stress:
  - Chainstack stable at `c=16`, `okRps=144.4`, `p95=161ms`; first bad `c=32`, fail `9.85%`.
  - Ankr stable at `c=32`, `okRps=672.2`, `p95=70ms`.
- AWS US West latest signed broadcast rejection latency:
  - Chainstack `p50=110.9ms`, `p95=143.3ms`, accepted `0/5`,
  - Ankr `p50=33.9ms`, `p95=36.2ms`, accepted `0/5`,
  - Public BSC `p50=65.4ms`, `p95=70.2ms`, accepted `0/5`.

## RPC Measurement

Measured on `2026-05-09` with identical parameters:

- `duration=10000ms`
- `timeout=3000ms`
- `steps=1,2,4,8,16,32`
- calls: `eth_blockNumber,getSlot0,getLiquidity,isPoolStarted`
- stable boundary: failure `<=1%` and `p95<=1000ms`

| Location | Provider | Stable step | p50 at stable | p95 at stable | First bad step | Note |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Local Mac | Chainstack | `c=32` | `246ms` | `310ms` | none tested | Stable but much slower than cloud low-latency paths. |
| Local Mac | Ankr | `c=32` | `238ms` | `564ms` | none tested in latest short run | Slower than AWS, acceptable only for development and safety checks. |
| AWS Singapore | Chainstack | `c=4` | `18ms` | `25ms` | `c=8`, fail `37.20%` | Lowest low-concurrency latency, strict quota ceiling. |
| AWS Singapore | Ankr | `c=32` | `29ms` | `177ms` | none tested | Good cloud high-concurrency path. |
| AWS US West | Chainstack | `c=16` | `99ms` | `161ms` | `c=32`, fail `9.85%` | More concurrency headroom than Singapore, still quota-sensitive at high c. |
| AWS US West | Ankr | `c=32` | `44ms` | `70ms` | none tested | Best overall result for high-concurrency hot reads. |

Operational conclusion:

- `us-west-2` is currently the best candidate for primary execution because Ankr is both fast and stable there, including the zero-balance signed broadcast rejection path.
- `ap-southeast-1` Chainstack is still the fastest low-concurrency read path, but quota breaks hard at `c=8`.
- Local Mac is acceptable for development and safety checks, not for first-block speed.
- Provider behavior is location-dependent. Re-run this test near any real launch.

Current deployment recommendation:

- Keep `us-west-2` as the active test candidate.
- Keep `ap-southeast-1` only until the user decides whether to terminate it; running both doubles EC2 hours.
- Provider pressure control, broadcast-response latency testing, and no-key raw broadcaster foundation are now implemented.

## Known Constraints

- SHARE launch window is already over. Current SHARE logic is useful as a proven template and test target, not as an active opportunity.
- Burner BNB was last observed locally at about `0.0024642891 BNB`, enough for `5 gwei * 300000 gas = 0.0015 BNB`; still recheck before launch.
- First-block execution can still revert if broadcast lands in a pre-open block before the hook starts. At current trade size, this gas loss is usually smaller than the operational risk of missing the block, but nonce occupation must be handled explicitly.
- Increasing buy size does not solve first-block ordering. Gas price, pre-signing, broadcast timing, and RPC propagation matter more.
- Public BSC RPC is useful as fallback/broadcast only. It should not be in the hot quote/read race unless paid providers are unavailable.
- Multi-region remote broadcaster support is code-complete but not externally exposed or production-wired. The current deployed instances still have no inbound ports. Do not run live sends from two signer instances for the same wallet at the same time.
- The current `default` AWS CLI login session can expire. For repeated AWS testing, use the stable `alpha-sniper-operator` profile path in [aws-auth.md](aws-auth.md).

## Next Work

1. Create a reusable new-launch config checklist for the next token: token address, pool id, hook, launch time, price tiers, spend cap, gas budget, and sell rules.
2. Re-run AWS-side RPC stress immediately before any new launch, because provider limits can change.
3. Re-run timer precision on the intended execution instance immediately before any new launch.
4. Decide whether to raise the fixed gas price above `4.5 gwei`; current observed BNB can cover `5 gwei * 300000 gas`, but higher settings need a fresh budget check.
5. Decide whether to expose a no-key broadcaster in a second region, and if yes, add network-level allowlisting plus token rotation before any live use.
6. Build a reusable new-token config generator/checklist so launch-time target changes do not require manual file edits across multiple places.

## Implemented Improvements After Comparison

- `rpc-race` now supports per-provider max in-flight limits.
- Default race limit is `chainstack-primary=4,ankr-bsc=32`, so cloud runs do not push Chainstack into the quota-failure range and still cap Ankr at the validated high-concurrency boundary.
- Override with:

```bash
--rpc-race-max-inflight chainstack-primary=4,ankr-bsc=32
```

- Added `npm run timer:precision` to measure Node.js wake-up error for launch-time scheduling.
- Added `scripts/aws-ssm-run.sh timer-precision` for remote instance timing checks.
- Added `npm run broadcast:latency` plus `scripts/aws-ssm-run.sh broadcast-latency` / `broadcast-latency-signed` to measure `eth_sendRawTransaction` rejection-path latency with invalid raw tx and zero-balance signed tx modes.
- Added no-key raw broadcaster support:
  - `npm run raw:broadcaster` starts a token-protected broadcaster that does not load `PRIVATE_KEY`.
  - `--remote-broadcaster-urls` lets the signer send the same signed raw tx to remote broadcasters in parallel with local RPC broadcast.
  - `scripts/aws-ssm-run.sh broadcaster-health` validates the broadcaster health path locally on an instance.
  - `npm run test:raw-broadcaster` runs a mock-RPC integration test covering health, auth failure, invalid raw tx rejection, prewarm, and mixed success/rejection broadcast.

## Safe Operating Rule

Default to dry-run. A real launch must explicitly pass `--send`, use only the burner wallet, and have current token config, gas budget, sell authorization, and RPC checks verified for that specific launch.
