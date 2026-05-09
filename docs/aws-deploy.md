# AWS Deployment

当前已验证两种部署入口：

- 优先：本地 AWS CLI。当前本机 `aws login` 已恢复，可以直接运行部署脚本。
- 备用：AWS CloudShell。CloudShell 继承控制台登录态，适合本机 AWS 登录再次失效时使用。

## 推荐部署方式

### 本地 AWS CLI

```bash
AWS_REGION=ap-southeast-1 bash scripts/aws-cloudshell-deploy.sh
```

脚本会从交互输入读取钱包和 RPC 参数，写入 AWS SSM Parameter Store。

### CloudShell 备用路径

1. 打开 AWS Console，切到 `ap-southeast-1`。
2. 打开 CloudShell。
3. 执行：

```bash
curl -fsSL https://raw.githubusercontent.com/MeiYanDong/alpha-sniper/main/scripts/aws-cloudshell-deploy.sh -o aws-cloudshell-deploy.sh
bash aws-cloudshell-deploy.sh
```

如果 GitHub 仓库不是 public，先在 CloudShell 里用你自己的 GitHub token 克隆仓库，或把脚本内容上传到 CloudShell 后执行。

## 脚本会做什么

- 使用 `ap-southeast-1`，默认自动选择 Free Tier eligible 实例，优先 `t3.micro`，再回退 `t2.micro`。
- 创建 EC2 IAM role / instance profile。
- 给实例授权读取 `/alpha-sniper/env/*` 下的 SSM Parameter Store 参数。
- 创建一个无入站端口的 security group，实例只通过 SSM 管理。
- IAM role、instance profile 和 security group 默认带 region 后缀，避免平行部署其它区域时互相覆盖权限。
- 按实例架构创建对应的 Amazon Linux 2023 EC2。
- 把 runtime secrets 写入 SSM SecureString：
  - `PRIVATE_KEY`
  - `BSC_RPC_URL`
  - `CHAINSTACK_BSC_RPC_URL`
  - `ANKR_BSC_RPC_URL`
  - `ANKR_BSC_WS_URL`
  - `ANKR_MULTICHAIN_RPC_URL`
- 在实例上 clone `main` 分支、安装依赖、运行 `npm run check`。
- 运行一次 first-block dry-run 验证。
- 等待 bootstrap 完成后再运行 dry-run，避免 SSM 已在线但应用脚本还没生成的假失败。

脚本不会运行真实 `--send`。

## 需要你输入的值

CloudShell 执行时会提示输入：

- burner wallet address
- burner private key
- primary BSC RPC URL
- Chainstack BSC RPC URL
- Ankr standard BSC RPC URL
- optional WSS / Advanced URL

私钥和 RPC URL 会写入 SSM SecureString，不会写进 GitHub。

## 远程常用命令

脚本完成后会打印 `InstanceId`。推荐用仓库里的 SSM wrapper：

```bash
scripts/aws-ssm-run.sh status
scripts/aws-ssm-run.sh sync
scripts/aws-ssm-run.sh check
scripts/aws-ssm-run.sh rpc-check
scripts/aws-ssm-run.sh rpc-race
scripts/aws-ssm-run.sh rpc-stress-short
scripts/aws-ssm-run.sh broadcast-latency
scripts/aws-ssm-run.sh timer-precision
scripts/aws-ssm-run.sh dry-run
```

必要时也可以直接发一条 raw shell 命令：

```bash
scripts/aws-ssm-run.sh raw -- 'sudo /usr/local/bin/alpha-sniper-dry-run'
```

真实首区块命令已经放在实例上，但不会自动执行：

```bash
sudo /usr/local/bin/alpha-sniper-live-first-block
```

只有明确准备好以后，才通过 SSM 手动触发真实命令。

## 可调整项

运行脚本前可通过环境变量调整：

```bash
export AWS_REGION=ap-southeast-1
export INSTANCE_TYPE=t3.micro
export INSTANCE_TYPE_CANDIDATES="t3.micro t2.micro"
export DRY_RUN_GAS_GWEI=4.5
export REPO_URL=https://github.com/MeiYanDong/alpha-sniper.git
bash aws-cloudshell-deploy.sh
```

如果不设置 `INSTANCE_TYPE`，脚本会自动从 `INSTANCE_TYPE_CANDIDATES` 中挑一个 AWS 标记为 Free Tier eligible 的实例。只有账户明确允许非 Free Tier EC2 时，才建议手动指定其它实例类型。

平行测试其它区域时，只改 `AWS_REGION`：

```bash
AWS_REGION=us-west-2 bash scripts/aws-cloudshell-deploy.sh
AWS_REGION=us-west-2 scripts/aws-ssm-run.sh status
```

当前最近观测的 burner BNB 余额约 `0.0024642891 BNB`，可覆盖 `300000 gas * 5 gwei = 0.0015 BNB`。如果把 `DRY_RUN_GAS_GWEI` 提到 `5 gwei` 以上，临盘前必须重新检查 BNB gas budget。

## 当前已部署实例

- Singapore: `i-0d169ad4de2908544`, `ap-southeast-1`, `t3.micro`, SSM only, no inbound ports.
- US West: `i-004854b92bf43622c`, `us-west-2`, `t3.micro`, SSM only, no inbound ports.
- Latest verified commit: `74ae9ae`
- Last verified mode: first-block `DRY_RUN`

更多当前状态见 [progress.md](progress.md)。
