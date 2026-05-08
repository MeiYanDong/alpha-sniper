# 狙击程序设计

## 目标

用户不是要学习链上开发，而是要一个能辅助决策、后续可执行的 Alpha 狙击工具。

第一阶段目标不是“自动买”，而是：

1. 发现目标池是否真的开了。
2. 识别池子类型：V2 / V3 / Infinity CL。
3. 读取当前价格、流动性、hook、poolId。
4. 判断价格是否仍在狙击区。
5. 输出清晰动作：可观察、可小仓、等待、禁止追高。

## 为什么不用 Binance / OKX 现货 API 作为主路线

Binance 和 OKX 的现货 API 操作的是交易所订单簿。它们能下 `BTC-USDT` 这种中心化交易所订单，但不能直接在 PancakeSwap 新池里抢第一段流动性。

PancakeSwap 开池狙击发生在 BSC 链上，所以主路线是：

```text
BSC RPC -> PancakeSwap 合约 -> 读池/报价/发 swap 交易
```

RPC 选择按角色分工：

- Chainstack BSC RPC：主读链路，用来读区块、合约状态、交易回执和日志。
- Ankr Advanced：备用于钱包交易发现，例如后续分析 burner 钱包、路由交易和成交记录。
- 公开 BSC RPC：只作为最后 fallback，不作为开盘监控主路线。

本项目会自动读取 `~/.codex/secrets/evm-rpc-providers.env`，不把 provider URL 写进代码、README 或前端。
运行时 viem client 使用多 RPC fallback：`BSC_RPC_URL` -> `CHAINSTACK_BSC_RPC_URL` -> 公开 BSC fallback。
极速买入发送时可以开启 `--multi-rpc-broadcast`：本地 burner wallet 只签名一次，把同一笔 raw transaction 广播到多个 RPC，提高传播成功率。它不改变 nonce，不发多笔不同交易，也不做 mempool 攻击或夹子交易。

状态监控默认不扫大范围 `Initialize` 日志。原因是当前池的 `poolIdToPoolKey` 已经可读，直接读取 poolKey、slot0、liquidity 和 hook 状态更快、更稳定。只有 `poolIdToPoolKey` 不可用时，才考虑打开 `scanInitializeLogs` 做日志回溯。

当前 provider 检查覆盖：

- Chainstack/BSC：`eth_blockNumber`、`eth_getBlockByNumber`、`eth_call`、窄范围 `eth_getLogs`。
- Ankr：`ankr_getTransactionsByAddress`。
- 公开 BSC fallback：基础读可用，但窄范围 `eth_getLogs` 可能触发 provider limit，因此不能作为日志扫描主路线。

## 真实情况测试

测试要覆盖三层，不只看脚本能不能启动：

1. 场景测试：用固定配置和阈值验证规则不会跑偏，例如 `0.30` 是低价区、`0.48` 是不追区、Readwise 滑点表随金额单调上升。
2. 链上数据采样：按固定间隔记录 block、price、liquidity、hookStarted、quote probes，开盘前后形成 JSONL 样本，之后可以复盘价格变化和程序判断。
3. RPC 压力测试：用真实状态读取方法持续请求 Chainstack，统计成功数、失败类型、p50/p95/p99/max latency，并找出第一个坏档。

当前命令：

```bash
npm run test:scenarios
npm run data:sample -- --count 12 --interval-ms 5000
npm run rpc:stress -- --duration-ms 5000 --timeout-ms 3000 --steps 64,80,96 --max-failure-pct 1 --max-p95-ms 1000
```

开盘前的最低门槛：

- `test:scenarios` 必须通过。
- `rpc:check` 中 Chainstack 标准 RPC 必须全 OK。
- `rpc:stress` 中 Chainstack p95 不应明显超过 1 秒，失败率应接近 0；如果触发 quota，实盘参数必须低于第一个坏档。
- `data:sample` 至少能采到连续样本，并且 hook 状态与链上开盘时间一致。

2026-05-08 16:54 CST 实测边界：

| 并发档 | 结果 |
| ---: | --- |
| 64 | 稳定，`0%` 失败，约 `208-240 okRps`，`p95=319-632ms` |
| 80 | 已坏，`11.94%` quota 失败 |
| 96 | 明显坏，`25.15%` quota 失败 |

所以当前极速方案不是无限加压，而是把最后冲刺保持在实测稳定区间内：常规 `100ms`，最后 10 秒 `50ms`。

OKX DEX API 可以后面作为备用聚合器，但不作为第一版核心。原因是新池、指定 hook 池、Infinity 池在聚合器侧可能存在收录延迟。

## 当前 SHARE 情报

来自 Readwise 和截图：

- token: `0x5FCA51aff213bFBEAB0b711b93c3374252fD6aC3`
- pair: `SHARE/USDT`
- chain: BSC
- startedTime: `2026-05-08 18:00:00 UTC+8`
- Infinity poolId: `0x7cc59be0a3754a33144a091e7b62dbcbf1a7a6f8540f224f4798fb739fd742e9`
- hook: `0xb0BAa371b899950B4Ef6A27c21bAf5ef7c434d0f`

我从 BscScan 已验证源码确认了 hook 类型：`CLAlphaHook`。关键逻辑：

- `poolStartedTimestamp(poolId)` 是实际开盘时间。
- `beforeSwap` 在开盘前会直接 `PoolNotStarted`。
- `beforeSwap` 不要求特殊 `hookData`，开盘后空 `hookData` 应该可以继续走 Quoter/Swap。

当前链上读到的开始时间是 `2026-05-08 18:00:00 Asia/Shanghai`。

截图滑点表给出的经验锚点：

| 买入 USDT | 平均价 | 买完后价格 |
| --- | ---: | ---: |
| 100,000 | 0.32016088 | 0.34163086 |
| 200,000 | 0.34030167 | 0.38596569 |
| 300,000 | 0.36044245 | 0.43300450 |
| 400,000 | 0.38058323 | 0.48274729 |
| 500,000 | 0.40072401 | 0.53519406 |
| 600,000 | 0.42086480 | 0.59034488 |

## 程序分层

### 1. 情报层

配置目标 token、quote token、开盘时间、poolId、hook、最大买入价格、最大投入金额。

文件：`config/share.json`

### 2. 监听层

读取：

- V2 factory `getPair`
- V3 factory `getPool`
- Infinity CL `Initialize` event
- Infinity CL `getSlot0`
- Infinity CL `getLiquidity`

### 3. 估价层

当前已支持：

- V2 constant product 买入模拟
- V3 / Infinity 当前价格读取
- Infinity CL hook 开盘状态读取
- Readwise 滑点基准表展示

当前已支持：

- 开盘后的 Infinity CL Quoter 精确报价。
- `20U` / `10U` 买入档并行报价。
- 极速模式下 quote 探测和 hook 轮询并行，quote 成功即可触发买入决策。

### 4. 风控层

当前规则：

- `<= 0.34`：低价狙击区
- `<= 0.38`：可接受
- `<= 0.43`：偏追高
- `>= 0.48`：不追

真实下单前必须增加：

- 最大投入
- 最大滑点
- 最低收到 token 数量
- hook 是否匹配
- poolId 是否匹配
- 能否卖出模拟
- gas 上限

### 5. 执行层

暂不打开。

当前真实执行路线：

```text
burner wallet -> Permit2/approve -> PancakeSwap Universal Router -> Infinity swap
```

真实执行必须先通过 readiness、quote、Universal Router gas simulation、BNB gas budget 和滑点保护。极速模式额外支持一次签名多 RPC 广播；买入成功后可自动进入 exit watcher。

## 我负责什么

- 维护程序和配置。
- 联网核对官方合约地址。
- 读取链上状态。
- 把复杂链上信息转成明确动作。
- 后续接入报价、dry-run、真实下单。

## 用户需要做什么

只需要做三件事：

1. 提供目标项目情报：合约、开盘时间、池子截图或链接。
2. 准备小额 burner wallet，不用主钱包。
3. 决定最大可亏金额。

其余细节由程序和我处理。
