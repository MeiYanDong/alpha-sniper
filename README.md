# Alpha 狙击

这个项目先做一件事：把“开池后到底贵不贵”变成程序自动判断。

默认脚本是只读模式，不会发交易。只有带 `--send` 的 approve 脚本会签名发授权交易，而且需要你明确同意后才运行。它会检查 SHARE 的 BSC 链上状态：

- PancakeSwap V2 是否有池
- PancakeSwap V3 哪些费率池存在
- PancakeSwap Infinity CL 指定 poolId 是否初始化
- Infinity hook 是否已经允许交易
- 当前价格落在低价区、可接受区、追高区还是不追区

## 运行

```bash
npm install
cp .env.example .env
npm run share:status
```

RPC 会自动优先读取本机共享配置：

```text
~/.codex/secrets/evm-rpc-providers.env
```

所以正常不需要把 Chainstack / Ankr URL 写进项目目录。检查本机 provider 是否可用：

```bash
npm run rpc:check
```

连续监控：

```bash
npm run share:watch
```

检查 burner 钱包余额和授权：

```bash
WALLET_ADDRESS=0x你的钱包地址 npm run share:wallet
```

检查真实执行前准备度，只 dry-run，不发交易：

```bash
npm run share:ready
```

开盘执行器，建议 17:50 启动；默认 dry-run，真实执行需要显式 `--send`：

```bash
npm run share:launch -- --preflight-only
npm run share:launch
npm run share:launch -- --send
```

`--preflight-only` 只验证钱包、余额、双层授权、token metadata 和 pool key，不等待开盘，也不会报价或发交易。`share:launch` 会把关键事件写到 `data/runs/*.jsonl`，用于复盘每次 hook 轮询、报价、模拟和发交易结果。

检查卖出准备度，只 dry-run，不发交易：

```bash
npm run share:sell:ready
```

买入后自动卖出监控：

```bash
npm run share:exit:watch -- --entry-avg-price 0.34 --send
```

开盘买入并在买入成功后继续自动监控卖出：

```bash
npm run share:launch -- --send --auto-exit --auto-approve-exit
```

`--auto-exit` 会在买入成功后继续运行 exit watcher。默认卖出规则：买入均价下跌 15% 全卖；上涨 50% 卖一半；上涨 100% 全卖剩余。每次卖出前都必须通过卖出报价和 Universal Router simulation。`--auto-approve-exit` 只在买入后发现 SHARE 卖出授权缺失时，给 burner 钱包当前 SHARE 余额补授权。

通用真实买/卖测试走同一个 Infinity Universal Router 路径：

```bash
npm run infinity:swap -- --config config/bill-test.json --direction buy --amount-in 1 --send
npm run infinity:swap -- --config config/bill-test.json --direction sell --send
```

这个脚本现在只读取必要 hook 状态，并并行执行报价、授权检查、gas 估算和 gas price 读取；默认也带 gas buffer 和 gas price multiplier。

扫描真实同类 PancakeSwap Infinity CL 池，测试买入/卖出双向报价延迟：

```bash
npm run infinity:test-pools -- --blocks 1000000 --chunk-size 10000 --amount-usdt 1 --limit 3 --same-hook
```

授权脚本默认拒绝发送，只有显式加 `--send` 才会发链上交易：

```bash
npm run share:approve -- --token quote --send
npm run share:approve -- --token target --send
```

## 测试

规则测试和真实执行器模拟：

```bash
npm run test:scenarios
npm run test:launch-sim
npm run test:exit-sim
npm run test:auto-flow-sim
```

`test:launch-sim` 会离线模拟开盘执行流程，覆盖授权失败、余额不足、hook 不开、报价失败、低价买 20U、可接受价买 10U、追高跳过、先失败后恢复、先高后回落、simulation 失败、gas 不够等多种情况。

这里的模拟不是另写一套思想推演：它会直接调用 `share-launch-executor` 的 `runLaunchExecutor`，用 mock chain client 和 mock wallet client 触发同一个开盘执行器；买入场景会走到 fake `writeContract`，但不会连接真实 RPC，也不会使用真实私钥。

`test:exit-sim` 会直接触发真实 exit watcher 的止损、止盈、授权缺失、自动补授权、simulation 失败等场景。`test:auto-flow-sim` 会触发真实买入执行器，fake 买入成功后继续进入真实 exit watcher，再 fake 卖出。

真实链上状态采样，默认每 5 秒采 12 次：

```bash
npm run data:sample
```

RPC 压测，默认 30 秒、4 并发：

```bash
npm run rpc:stress
```

开盘前建议跑短测：

```bash
npm run test:scenarios
npm run rpc:check
npm run rpc:stress -- --duration-ms 10000 --concurrency 4
npm run data:sample -- --count 12 --interval-ms 5000
```

## 当前默认规则

- `0.30 - 0.34`：低价狙击区
- `0.34 - 0.38`：可接受狙击区
- `0.38 - 0.43`：偏追高
- `0.48+`：不追，等回落

这些规则来自你给的 SHARE Readwise 信息和截图里的滑点估算表。

## 当前 SHARE 结论

链上真实池子不是 V2/V3，而是 PancakeSwap Infinity CL：

- poolId: `0x7cc59be0a3754a33144a091e7b62dbcbf1a7a6f8540f224f4798fb739fd742e9`
- hook: `0xb0BAa371b899950B4Ef6A27c21bAf5ef7c434d0f`
- start: `2026-05-08 18:00:00 Asia/Shanghai`

我核对了 hook 已验证源码。这个 hook 的核心限制很直接：交易开始前 `beforeSwap` 会 `PoolNotStarted`，所以现在普通 Quoter 报价失败是正常的。到开始时间后，程序会重新跑报价探针，再看是否满足买入规则。

## Binance / OKX API 的位置

Binance 现货 API、OKX 现货 API 只适合交易所订单簿下单。PancakeSwap 开池狙击是在 BSC 链上完成，主路线应该是 RPC + PancakeSwap 合约。

OKX DEX API 可以作为备用报价/聚合交易来源，但新池刚开时不应作为第一执行路径，因为它可能还没及时收录新池或 hook 池。

## 下一步

1. 先让只读监控和真实同类池报价稳定跑通。
2. 开盘后让 Infinity CL Quoter 真实模拟不同买入金额的成交均价。
3. 买入和卖出都必须检查余额、双层 Permit2 授权、gas、滑点保护。
4. 最后才打开真实下单。

真实交易只能用 burner wallet，小额资金，不用主钱包。
