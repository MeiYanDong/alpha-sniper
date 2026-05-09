# AWS Auth Strategy

当前本机 `default` profile 使用的是 AWS CLI login session：

```ini
[default]
login_session = arn:aws:iam::388768426712:root
region = us-west-2
```

这种方式适合临时部署或控制台联动，但会过期。它不适合反复跑 SSM 测试、同步代码、远端 dry-run 和延迟测试。

## Recommended Split

日常操作使用稳定低权限 profile：

- Profile: `alpha-sniper-operator`
- IAM user: `alpha-sniper-operator`
- 用途：`scripts/aws-ssm-run.sh` 的 `status`、`sync`、`check`、`dry-run`、`rpc-stress-short`、`broadcast-latency-signed`、`raw-broadcaster-test` 等。
- 权限边界：
  - 可发现 `Name=alpha-sniper` 的 EC2 instance。
  - 可对已发现的 Alpha EC2 instance 发送 `AWS-RunShellScript` SSM command。
  - 可读取 SSM command 结果。
  - 不读取 `/alpha-sniper/env/*`，不接触 burner private key 或 RPC secret。
  - 不创建 EC2、IAM role、security group 或 SSM Parameter。

部署和改基础设施时，才使用会过期的管理员/控制台登录：

- 创建 EC2。
- 写入 SSM SecureString。
- 修改 IAM role / instance profile / security group。

## Repo Support

`scripts/aws-stable-operator-profile.sh` 提供两种动作：

- `doctor`：检查本地稳定 profile 是否可用。
- `install`：在当前 AWS 管理员 session 可用时，创建或更新低权限 IAM user，生成 access key，并写入本机 `alpha-sniper-operator` profile。

`scripts/aws-ssm-run.sh` 会自动优先使用 `alpha-sniper-operator` profile。只有这个 profile 不存在时，才回落到当前 shell 的 `AWS_PROFILE` 或 `default`。

## Operational Rule

不要给 root 创建长期 access key。稳定路径应该是专用 IAM user + 最小 SSM 操作权限。这个 key 只用于日常远端测试，不用于部署和资金相关 secret 管理。
