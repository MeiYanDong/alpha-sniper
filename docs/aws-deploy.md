# AWS Deployment

本地 `aws login` 当前会被 AWS SignIn 返回 `400 Bad Request` 卡住。部署改用 AWS CloudShell：CloudShell 已经继承控制台登录态，不需要本机 CLI 登录。

## 推荐部署方式

1. 打开 AWS Console，切到 `ap-southeast-1`。
2. 打开 CloudShell。
3. 执行：

```bash
curl -fsSL https://raw.githubusercontent.com/MeiYanDong/alpha-sniper/main/scripts/aws-cloudshell-deploy.sh -o aws-cloudshell-deploy.sh
bash aws-cloudshell-deploy.sh
```

如果 GitHub 仓库不是 public，先在 CloudShell 里用你自己的 GitHub token 克隆仓库，或把脚本内容上传到 CloudShell 后执行。

## 脚本会做什么

- 使用 `ap-southeast-1`，实例类型默认 `t4g.nano`。
- 创建 EC2 IAM role / instance profile。
- 给实例授权读取 `/alpha-sniper/env/*` 下的 SSM Parameter Store 参数。
- 创建一个无入站端口的 security group，实例只通过 SSM 管理。
- 创建 Amazon Linux 2023 arm64 EC2。
- 把 runtime secrets 写入 SSM SecureString：
  - `PRIVATE_KEY`
  - `BSC_RPC_URL`
  - `CHAINSTACK_BSC_RPC_URL`
  - `ANKR_BSC_RPC_URL`
  - `ANKR_BSC_WS_URL`
  - `ANKR_MULTICHAIN_RPC_URL`
- 在实例上 clone `main` 分支、安装依赖、运行 `npm run check`。
- 运行一次 first-block dry-run 验证。

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

脚本完成后会打印 `InstanceId`。之后可以用 SSM 执行：

```bash
aws ssm send-command \
  --region ap-southeast-1 \
  --instance-ids i-xxxxxxxxxxxxxxxxx \
  --document-name AWS-RunShellScript \
  --parameters commands='sudo /usr/local/bin/alpha-sniper-dry-run'
```

同步最新代码：

```bash
aws ssm send-command \
  --region ap-southeast-1 \
  --instance-ids i-xxxxxxxxxxxxxxxxx \
  --document-name AWS-RunShellScript \
  --parameters commands='sudo /usr/local/bin/alpha-sniper-sync'
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
export INSTANCE_TYPE=t4g.nano
export DRY_RUN_GAS_GWEI=4.5
export REPO_URL=https://github.com/MeiYanDong/alpha-sniper.git
bash aws-cloudshell-deploy.sh
```

当前 burner BNB 余额不足以覆盖 `300000 gas * 5 gwei`，默认使用 `4.5 gwei`。补足 BNB 后可把 `DRY_RUN_GAS_GWEI` 提高。
