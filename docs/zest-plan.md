# ZEST Launch Plan

Last updated: `2026-05-18 22:36 CST`

## Current Verified State

- Token: Zest Protocol `ZEST`
- BSC contract: `0x5506599c722389a60580b5213ea1da60d64754a1`
- On-chain metadata: `name=Zest`, `symbol=ZEST`, `decimals=18`, `totalSupply=1,000,000,000`
- KuCoin lists `ZEST/USDT` for `2026-05-19 13:00 UTC`, which is `2026-05-19 21:00 Asia/Shanghai`.
- Sources checked: KuCoin listing announcement and BscScan token page. Binance Alpha timing is still treated as user-provided unless re-verified from an official Binance page/API immediately before launch.
- Current BSC checks show no PancakeSwap V2 `ZEST/USDT`, no PancakeSwap V2 `ZEST/WBNB`, and no PancakeSwap V3 pool in fee tiers `100,500,2500,10000`.
- Current repo mode for ZEST is `MONITOR_ONLY_UNTIL_POOL_TYPE_CONFIRMED`; no buy/sell execution path is enabled for ZEST yet.

## Why This Is Not a Direct SHARE Reuse

SHARE used PancakeSwap Infinity CL with a known `poolId` and hook. ZEST is reported to use Arrakis for liquidity management. Arrakis usually means the project may add liquidity through a managed V3-style vault/strategy, while the actual trade route is still determined by the underlying pool and router.

Until the live pool exists, do not generate a live buy config or approve a sell route for ZEST.

## Active Monitoring

Use the ZEST watch config:

```bash
npm run zest:status
npm run zest:watch -- --blocks 12000 --limit 20
```

Run continuous watch near launch:

```bash
npm run zest:watch -- --watch --interval-ms 3000 --blocks 12000 --limit 30
```

What this watches:

- PancakeSwap V2 pair creation.
- PancakeSwap V3 pool creation across configured fee tiers.
- Watched project/allocation/CEX-test address balances.
- Recent ZEST `Transfer` and `Approval` events.

## Watched Addresses

The watchlist is in `config/zest.json`.

Current notable balances from the latest local read:

- `ecosystem`: `76,500,000 ZEST`
- `kucoin_hot_wallet_2`: `1,500,000 ZEST`
- `cex_test_a`: `5 ZEST`

Recent notable approval:

- `approval_owner_3` approved `1,000,000,000 ZEST` to `approval_spender_3` at block `99011590`.
- `approval_spender_3` then emitted a max-style approval to itself at block `99011591`.

These spender identities still need live verification before treating them as Arrakis, CEX, or project infrastructure.

## Price Rules For Now

Temporary monitoring rules:

- Ideal: `<= 0.0205`
- Buy ceiling: `<= 0.026`
- Caution: `<= 0.035`
- No chase: `>= 0.054`

These are not final execution rules. Update them after the actual pool is created and the program can quote the real route.

## Execution Decision

Current decision: do not send live ZEST trades yet.

Next implementation gate:

1. Detect the actual live pool and router path.
2. If it is Pancake V3/Arrakis-managed V3, add a V3 exact-input execution path or route through the correct router with strict `minOut`.
3. Re-run local and AWS RPC race tests using ZEST config.
4. Only then decide whether to pre-approve and enable a live `--send` command.
