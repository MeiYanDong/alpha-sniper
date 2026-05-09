# Speed First-Principles Review

This document is the speed-only view of the SHARE launch executor. It deliberately ignores UI polish and most convenience paths.

## Core Chain

First-block speed is the product of five links:

1. Decide before launch.
2. Build and sign before launch.
3. Send the first network request at the earliest safe time.
4. Reach a BSC node that propagates quickly to validators.
5. Pay enough gas price to win ordering inside the target block.

Polling and quote speed only help the post-open path. They cannot beat transactions already included in the launch block.

## Current Speed Baseline

- First-block mode computes `minOut` from max acceptable average price before launch.
- It signs one raw transaction locally and broadcasts the same raw tx to several standard BSC RPCs.
- RPC race is used for hot reads, not for nonce ownership.
- Pending without receipt is treated as a distinct state, not as failure.
- A failed first-block receipt can fall back to the safer quote path.

## Execution Priorities

### P0: Broadcast First Success

Broadcast should return as soon as the first provider accepts `eth_sendRawTransaction`. Waiting for every provider to finish slows down receipt monitoring and pending handling. The remaining providers should keep draining in the background and write a final broadcast report to JSONL.

### P0: Pre-Sign Recovery Transactions

If `--first-block-on-pending replace` or `cancel` is selected, the recovery transaction must be signed before the broadcast moment with the same nonce.

Pending handler should only broadcast the already signed recovery raw transaction. It should not spend time signing after the timeout.

### P0: Fixed Gas Price For First Block

For first-block mode, prefer fixed gas price:

```bash
--gas-price-gwei-fixed 4.5
```

This skips the live gas price RPC read and avoids underpaying when the current gas price is too low. For small buy sizes, gas price matters more than buy amount for tx ordering.

Current wallet budget note: latest local preflight observed about `0.0024642891 BNB`, enough for `300000 gas * 5 gwei = 0.0015 BNB`. If raising above `5 gwei`, re-check BNB gas budget immediately before launch.

### P0: Pre-Approve Exit Before Launch

Do not wait until the buy receipt to approve selling. Estimate the maximum likely received SHARE and approve before launch:

```bash
npm run share:approve -- --token target --amount 100 --send
```

For current tiers, `20 USDT / 0.32 = 62.5 SHARE`, so `100 SHARE` is a practical buffer. This is a live transaction and should only be run intentionally.

### P1: Broadcast Connection Prewarm

Before the exact broadcast moment, send a cheap read to every broadcast RPC. This warms DNS/TLS/provider paths and records which providers are responsive shortly before launch.

Default speed target: prewarm around 3 seconds before `broadcastAt`.

### P1: Provider Pressure Control

RPC race should not push every provider equally. The measured cloud boundary shows Chainstack can be very low latency but quota-sensitive, while Ankr handles more concurrency in `us-west-2`.

Default hot-read pressure control:

```bash
--rpc-race-max-inflight chainstack-primary=4,ankr-bsc=32
```

If Chainstack is saturated, skip it for that specific race call instead of queueing more requests into a quota-failure range. Ankr remains the high-concurrency provider.

### P1: Timer Precision Check

First-block mode depends on waking near `broadcastAt`. Before a launch, measure the actual Node.js timer error on the execution host:

```bash
npm run timer:precision -- --samples 1000 --interval-ms 10 --warmup-ms 250
```

If p99/max wake-up error is large, increase the broadcast offset or move execution to a quieter instance.

### P1: Cloud Region Selection

Measure from the machine that will run the executor. Pick the region with best p95/p99 to Chainstack, Ankr standard BSC, and public BSC broadcast endpoints. Local home-network latency can dominate code-level improvements.

### P2: Multi-Region Same-Raw-Tx Broadcaster

The safe multi-region architecture is:

- one signer,
- one nonce source,
- one raw signed transaction,
- multiple no-key broadcasters in different regions.

Do not run multiple signers or multiple machines that each create different transactions for the same wallet.

## Recommended Speed Command

Dry run:

```bash
npm run share:launch -- --first-block --first-block-tier acceptable --first-block-broadcast-offset-ms -150 --first-block-gas-limit 300000 --first-block-receipt-timeout-ms 12000 --first-block-on-pending replace --replacement-gas-price-multiplier-bps 15000 --gas-price-gwei-fixed 4.5 --deadline-seconds 45 --fast-launch --rpc-race --rpc-race-labels chainstack-primary,ankr-bsc --multi-rpc-broadcast --broadcast-public --broadcast-timeout-ms 3000 --broadcast-prewarm-ms 3000
```

Live mode adds:

```bash
--send --auto-exit --exit-poll-ms 1000 --exit-max-watch-ms 7200000
```

Only add `--auto-approve-exit` when pre-approval was not completed. The fastest sell path is still pre-approval before launch.

## What Not To Optimize First

- Lowering hook polling from 50ms to 10ms.
- More quote retries on the post-open path.
- Dynamic caching of hook, quote, price, gas, or balances.
- Increasing buy amount without increasing gas price.

These do not solve first-block inclusion.
