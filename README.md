# Alpha 狙击

这个项目先做一件事：把“开池后到底贵不贵”变成程序自动判断。

默认脚本是只读 / dry-run 模式，不会发交易。只有显式带 `--send` 的授权、swap、launch 或 exit 脚本才会签名发链上交易。它会检查 SHARE 的 BSC 链上状态：

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
npm run share:cache:warm
```

`share:cache:warm` 只缓存静态信息：token metadata 和 Infinity poolKey。价格、quote、hook started、余额、授权、gas 都不缓存，避免交易决策用旧数据。

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

极速开盘模式：

```bash
npm run share:launch -- --warmup-ms 600000 --fast-launch --rpc-race --rpc-race-labels chainstack-primary,ankr-bsc --rpc-race-timeout-ms 3000 --poll-ms 100 --sprint-ms 10000 --sprint-poll-ms 50 --quote-probe-lead-ms 10000 --gas-buffer-bps 12000 --gas-price-multiplier-bps 20000 --deadline-seconds 45 --send --multi-rpc-broadcast --broadcast-public --broadcast-timeout-ms 3000 --auto-exit --auto-approve-exit --exit-poll-ms 1000 --exit-max-watch-ms 7200000
```

首区块竞争模式：

```bash
npm run share:launch -- --first-block --first-block-tier acceptable --first-block-broadcast-offset-ms -150 --first-block-gas-limit 300000 --first-block-receipt-timeout-ms 12000 --first-block-on-pending replace --replacement-gas-price-multiplier-bps 15000 --gas-price-gwei-fixed 4.5 --deadline-seconds 45 --fast-launch --rpc-race --rpc-race-labels chainstack-primary,ankr-bsc --multi-rpc-broadcast --broadcast-public --broadcast-timeout-ms 3000 --broadcast-prewarm-ms 3000 --send --auto-exit --exit-poll-ms 1000 --exit-max-watch-ms 7200000
```

这个模式仍然只走正规链上执行路线：自有 burner wallet、公开 BSC RPC、PancakeSwap quote、Universal Router gas simulation、签名交易、多 RPC 广播。它不做 mempool 攻击、sandwich、节点干扰或绕过平台规则。

关键差异：

- `--fast-launch`：hook 轮询和买入 quote 探测并行。
- `--rpc-race`：热读路径用 Chainstack + Ankr 标准 BSC RPC 同时读 hook、quote、gas simulation 和 gas price，先返回可用结果者胜出；`--fast-launch` 默认会打开，可用 `--no-rpc-race` 关闭。公开 RPC 不进入热读 race。
- `--rpc-race-max-inflight chainstack-primary=4,ankr-bsc=32`：给热读 race 增加每个 provider 的并发上限。默认会把 `chainstack-primary` 限在 `4`，避免云端高并发把它打进 quota 失败档。
- `--quote-probe-lead-ms 10000`：开盘前最后 10 秒开始直接探测 quote，quote 成功且价格匹配就进入买入路径，不只等 hook poll。
- `--sprint-poll-ms 50`：最后 10 秒高频探测。
- `--gas-price-multiplier-bps 20000`：买入 gas price 使用 2x；普通模式仍默认 1.2x。
- `--gas-price-gwei-floor / --gas-price-gwei-cap / --gas-price-gwei-fixed`：给 gas price 加绝对下限、上限或固定值，避免“当前 gas 太低，2x 仍然不够”的问题。
- `--gas-price-gwei-fixed 4.5`：首区块速度优先时推荐固定 gas price，跳过开盘前 gas price RPC 读取，并避免“当前 gas 太低，2x 仍不够”。当前最近观测的 BNB 余额约 `0.0024642891 BNB`，可覆盖 `5 gwei * 300000 gas = 0.0015 BNB`；如果提高到 `5 gwei` 以上，临盘前必须重查 gas budget。
- `--multi-rpc-broadcast --broadcast-public`：签名一次，把同一笔 raw tx 广播到 Chainstack、Ankr 标准 BSC RPC 和公开 BSC RPC；广播默认首个 RPC 接受即返回，剩余 RPC 在后台完成并写入 run log。需要旧行为时加 `--broadcast-wait-all`。
- `--remote-broadcaster-urls https://...`：把同一笔 signed raw tx 同步发送给无私钥 broadcaster。远端只接收 raw tx 并转发到自己的 RPC，不读取也不需要 `PRIVATE_KEY`；必须配 `REMOTE_BROADCASTER_TOKEN` 或 `--remote-broadcaster-token`。
- `--broadcast-prewarm-ms 3000`：在广播前约 3 秒对每个广播 RPC 做轻量读，预热 DNS/TLS/provider 路径。
- `--auto-approve-exit`：买入确认后立刻按实际收到的 SHARE 余额补卖出授权，然后才进入 exit watcher；速度优先时应改为开盘前预授权，不等买入后再授权。
- `--first-block`：不等 quote 成功，开盘前按目标 tier 的最高接受均价反推 `minOut`，预构建并预签名 raw transaction，在 `launchTime + --first-block-broadcast-offset-ms` 广播。默认选择最高价格上限的 tier，也就是当前 `acceptable` 档。
- `--first-block-gas-limit 300000`：首区块路径不做开盘前 gas simulation，因为 hook 未开始时 simulation 会 revert；使用固定 gas limit。`300000 gas * 5 gwei = 0.0015 BNB`，是否超过 `1U` 取决于当时 BNB 价格。
- `--first-block-broadcast-offset-ms -150`：默认提前 150ms 广播，争取进开盘区块；如果太早被前一区块打包，会因为 hook 未开始而 revert。
- `--first-block-receipt-timeout-ms 12000`：首区块交易超过这个时间还没有 receipt，就进入 pending 处理。没有 receipt 时不能用新 nonce 再发普通买入。
- `--first-block-on-pending wait|replace|cancel`：`wait` 只告警等待；`replace` 用同 nonce、更高 gas 重发同一笔买入；`cancel` 用同 nonce 自转账取消队列，不再买。`replace/cancel` 交易会在开盘前预签好，pending 后只广播。
- `--replacement-gas-price-multiplier-bps 15000`：速度优先建议把 replacement/cancel 提高到原 gas price 的 1.5x；也支持 `--replacement-gas-price-gwei-fixed / floor / cap`。

开盘前卖出预授权：

```bash
npm run share:approve:exit -- --send
```

该命令会给目标 token 预授权 `100 SHARE`。当前估算 `20 USDT / 0.32 = 62.5 SHARE`，`100 SHARE` 留有 buffer。它是真实链上授权交易，只在明确要执行时加 `--send`。

复盘最新一次运行：

```bash
npm run share:postmortem -- --offline
npm run share:postmortem -- --run data/runs/具体文件.jsonl --launch-block 97068324
```

`--offline` 只读本地 run log；不加 `--offline` 会尝试读取链上 receipt、txIndex 和 launch block 里的候选交易。

AWS 部署优先走 CloudShell，避免本机 `aws login` 的 SignIn 400 问题：

```bash
curl -fsSL https://raw.githubusercontent.com/MeiYanDong/alpha-sniper/main/scripts/aws-cloudshell-deploy.sh -o aws-cloudshell-deploy.sh
bash aws-cloudshell-deploy.sh
```

细节见 [docs/aws-deploy.md](docs/aws-deploy.md)。

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
npm run test:rpc-race
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

RPC 压测，默认是阶梯压测：

```bash
npm run rpc:stress
```

开盘前建议跑短测：

```bash
npm run test:scenarios
npm run test:rpc-race
npm run rpc:check
npm run share:cache:warm
npm run rpc:stress -- --duration-ms 5000 --timeout-ms 3000 --steps 64,80,96 --max-failure-pct 1 --max-p95-ms 1000
npm run broadcast:latency -- --samples 5 --timeout-ms 3000 --prewarm
npm run broadcast:latency -- --mode zero-balance-signed --samples 5 --timeout-ms 3000 --prewarm
npm run raw:broadcaster -- --host 127.0.0.1 --port 8787 --broadcast-public
npm run data:sample -- --count 12 --interval-ms 5000
npm run timer:precision -- --samples 1000 --interval-ms 10 --warmup-ms 250
```

2026-05-08 16:54 CST 本机到 Chainstack 的实测边界：

- `c=64` 稳定：`0%` 失败，约 `208-240 okRps`，`p95=319-632ms`。
- `c=80` 已坏：`11.94%` quota 失败。
- `c=96` 明显坏：`25.15%` quota 失败。

所以实盘极速轮询用 `100ms` 常规探测、最后 10 秒 `50ms` sprint，不把持续压力打到 `c=80+` 的坏档。
热路径现在不是单 RPC fallback，而是 Chainstack 和 Ankr 标准 BSC RPC race；fallback 用来保可用性，race 用来压尾部延迟。

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

2026-05-08 实盘复盘：程序在 `18:00:00.603` 观察到 hook started，`18:00:00.604` 拿到第一笔成功 quote，均价已经约 `0.740876`，因此按规则跳过。首个大额买单已经在开盘区块 `97068324` 内，`txIndex=1`，约 `600,000 USDT`，均价约 `0.4209`。这说明主要问题不是 `20U` 金额太小，而是“开盘后确认 quote 再发单”的架构天然晚于同区块抢跑资金；后续要进首区块，需要预构建交易、严格 `minOut`、预签名和同一 raw tx 多 RPC 临界广播，而不是单纯加轮询频率。

## Binance / OKX API 的位置

Binance 现货 API、OKX 现货 API 只适合交易所订单簿下单。PancakeSwap 开池狙击是在 BSC 链上完成，主路线应该是 RPC + PancakeSwap 合约。

OKX DEX API 可以作为备用报价/聚合交易来源，但新池刚开时不应作为第一执行路径，因为它可能还没及时收录新池或 hook 池。

## 当前进度

当前 SHARE 开盘窗口已经结束，项目已经转为“可复用首区块狙击模板 + AWS dry-run 部署”状态。最新进度见 [docs/progress.md](docs/progress.md)。

已部署 AWS 实例：

- Singapore: `i-0d169ad4de2908544`, `ap-southeast-1`, `t3.micro`, SSM only.
- US West: `i-004854b92bf43622c`, `us-west-2`, `t3.micro`, SSM only.
- Verified mode: first-block `DRY_RUN`.

当前延迟测试结论：`us-west-2` 的 Ankr 路径最好，`c=32 p95=63ms`；新加坡 Chainstack 的低并发延迟最低，但 `c=8` 开始 quota 失败。细节见 [docs/progress.md](docs/progress.md)。

远端运维统一走：

```bash
scripts/aws-ssm-run.sh status
scripts/aws-ssm-run.sh sync
scripts/aws-ssm-run.sh dry-run
scripts/aws-ssm-run.sh rpc-stress-short
```

指定区域：

```bash
AWS_REGION=us-west-2 INSTANCE_ID=i-004854b92bf43622c scripts/aws-ssm-run.sh status
```

下一轮新标的的准备顺序：

1. 更新 token、poolId、hook、launch time、价格 tier 和最大投入。
2. 跑 `share:ready`、`share:cache:warm`、`rpc:check`、`test:rpc-race`、`share:launch -- --preflight-only`。
3. 在执行机器上实测 RPC 延迟和失败率，不复用旧标的的本地网络结论。
4. 开盘前完成买入 USDT 授权和卖出目标 token 预授权。
5. 如果要把固定 gas 提高到 `5 gwei` 以上，先重查 burner BNB 是否覆盖目标 gas budget。
6. 真实执行必须显式使用 `--send`，否则默认只 dry-run。

真实交易只能用 burner wallet，小额资金，不用主钱包。
