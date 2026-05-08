#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-alpha-sniper}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-southeast-1}}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.nano}"
REPO_URL="${REPO_URL:-https://github.com/MeiYanDong/alpha-sniper.git}"
BRANCH="${BRANCH:-main}"
PARAM_PREFIX="${PARAM_PREFIX:-/alpha-sniper/env}"
ROLE_NAME="${ROLE_NAME:-alpha-sniper-ec2-role}"
PROFILE_NAME="${PROFILE_NAME:-alpha-sniper-ec2-profile}"
SG_NAME="${SG_NAME:-alpha-sniper-ssm-only}"
DRY_RUN_GAS_GWEI="${DRY_RUN_GAS_GWEI:-4.5}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

aws_json() {
  aws --region "$REGION" "$@" --output json
}

aws_text() {
  aws --region "$REGION" "$@" --output text
}

prompt_secret_param() {
  local name="$1"
  local prompt="$2"
  local required="${3:-yes}"
  local value

  while true; do
    read -r -s -p "$prompt: " value
    echo
    if [[ -n "$value" || "$required" != "yes" ]]; then
      break
    fi
    echo "Value is required."
  done

  if [[ -z "$value" ]]; then
    return 0
  fi

  aws ssm put-parameter \
    --region "$REGION" \
    --name "$PARAM_PREFIX/$name" \
    --type SecureString \
    --value "$value" \
    --overwrite >/dev/null
}

prompt_string_param() {
  local name="$1"
  local prompt="$2"
  local default_value="${3:-}"
  local value

  if [[ -n "$default_value" ]]; then
    read -r -p "$prompt [$default_value]: " value
    value="${value:-$default_value}"
  else
    read -r -p "$prompt: " value
  fi

  if [[ -z "$value" ]]; then
    echo "Value is required." >&2
    exit 1
  fi

  aws ssm put-parameter \
    --region "$REGION" \
    --name "$PARAM_PREFIX/$name" \
    --type String \
    --value "$value" \
    --overwrite >/dev/null
}

ensure_role() {
  if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    aws iam create-role \
      --role-name "$ROLE_NAME" \
      --assume-role-policy-document '{
        "Version": "2012-10-17",
        "Statement": [{
          "Effect": "Allow",
          "Principal": {"Service": "ec2.amazonaws.com"},
          "Action": "sts:AssumeRole"
        }]
      }' >/dev/null
  fi

  aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore >/dev/null || true

  local account_id
  account_id="$(aws sts get-caller-identity --query Account --output text)"
  aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name alpha-sniper-read-ssm-env \
    --policy-document "{
      \"Version\": \"2012-10-17\",
      \"Statement\": [
        {
          \"Effect\": \"Allow\",
          \"Action\": [\"ssm:GetParameter\", \"ssm:GetParameters\", \"ssm:GetParametersByPath\"],
          \"Resource\": \"arn:aws:ssm:${REGION}:${account_id}:parameter${PARAM_PREFIX}/*\"
        },
        {
          \"Effect\": \"Allow\",
          \"Action\": \"kms:Decrypt\",
          \"Resource\": \"*\",
          \"Condition\": {
            \"StringEquals\": {
              \"kms:ViaService\": \"ssm.${REGION}.amazonaws.com\"
            }
          }
        }
      ]
    }" >/dev/null

  if ! aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1; then
    aws iam create-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null
  fi

  if ! aws iam get-instance-profile \
    --instance-profile-name "$PROFILE_NAME" \
    --query "InstanceProfile.Roles[?RoleName=='$ROLE_NAME'].RoleName" \
    --output text | grep -q "$ROLE_NAME"; then
    aws iam add-role-to-instance-profile \
      --instance-profile-name "$PROFILE_NAME" \
      --role-name "$ROLE_NAME" >/dev/null
  fi
}

ensure_security_group() {
  local vpc_id="$1"
  local sg_id
  sg_id="$(aws ec2 describe-security-groups \
    --region "$REGION" \
    --filters "Name=vpc-id,Values=$vpc_id" "Name=group-name,Values=$SG_NAME" \
    --query 'SecurityGroups[0].GroupId' \
    --output text)"

  if [[ "$sg_id" == "None" || -z "$sg_id" ]]; then
    sg_id="$(aws ec2 create-security-group \
      --region "$REGION" \
      --group-name "$SG_NAME" \
      --description "Alpha sniper SSM-only egress security group" \
      --vpc-id "$vpc_id" \
      --query GroupId \
      --output text)"
    aws ec2 create-tags --region "$REGION" --resources "$sg_id" --tags "Key=Name,Value=$SG_NAME" >/dev/null
  fi

  echo "$sg_id"
}

write_user_data() {
  local file="$1"
  cat > "$file" <<'USER_DATA'
#!/bin/bash
set -euo pipefail

APP_DIR="/opt/alpha-sniper"
APP_USER="alpha"
PARAM_PREFIX="__PARAM_PREFIX__"
REGION="__REGION__"
REPO_URL="__REPO_URL__"
BRANCH="__BRANCH__"
DRY_RUN_GAS_GWEI="__DRY_RUN_GAS_GWEI__"

dnf update -y
dnf install -y git jq nodejs npm

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "$APP_USER"
fi

mkdir -p "$APP_DIR"
chown "$APP_USER:$APP_USER" "$APP_DIR"

if [[ ! -d "$APP_DIR/.git" ]]; then
  sudo -u "$APP_USER" git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && git fetch origin '$BRANCH' && git reset --hard 'origin/$BRANCH'"
fi

cat > /usr/local/bin/alpha-sniper-load-env <<'LOAD_ENV'
#!/bin/bash
set -euo pipefail

APP_DIR="/opt/alpha-sniper"
PARAM_PREFIX="__PARAM_PREFIX__"
REGION="__REGION__"
OUT_FILE="$APP_DIR/.env.local"

tmp="$(mktemp)"
aws ssm get-parameters-by-path \
  --region "$REGION" \
  --path "$PARAM_PREFIX" \
  --recursive \
  --with-decryption \
  --query 'Parameters[].{Name:Name,Value:Value}' \
  --output json \
  | jq -r '.[] | ((.Name | split("/")[-1]) + "=" + .Value)' > "$tmp"

install -m 0600 -o alpha -g alpha "$tmp" "$OUT_FILE"
rm -f "$tmp"
LOAD_ENV
chmod 0755 /usr/local/bin/alpha-sniper-load-env

/usr/local/bin/alpha-sniper-load-env

sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm ci"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm run check"

cat > /usr/local/bin/alpha-sniper-sync <<'SYNC'
#!/bin/bash
set -euo pipefail
cd /opt/alpha-sniper
sudo -u alpha git fetch origin main
sudo -u alpha git reset --hard origin/main
/usr/local/bin/alpha-sniper-load-env
sudo -u alpha npm ci
SYNC
chmod 0755 /usr/local/bin/alpha-sniper-sync

cat > /usr/local/bin/alpha-sniper-dry-run <<DRY_RUN
#!/bin/bash
set -euo pipefail
/usr/local/bin/alpha-sniper-load-env
cd /opt/alpha-sniper
sudo -u alpha npm run share:launch -- --first-block --first-block-tier acceptable --first-block-broadcast-offset-ms -150 --first-block-gas-limit 300000 --first-block-receipt-timeout-ms 12000 --first-block-on-pending replace --replacement-gas-price-multiplier-bps 15000 --gas-price-gwei-fixed "$DRY_RUN_GAS_GWEI" --deadline-seconds 45 --fast-launch --rpc-race --rpc-race-labels chainstack-primary,ankr-bsc --multi-rpc-broadcast --broadcast-public --broadcast-timeout-ms 3000 --broadcast-prewarm-ms 3000
DRY_RUN
chmod 0755 /usr/local/bin/alpha-sniper-dry-run

cat > /usr/local/bin/alpha-sniper-live-first-block <<LIVE
#!/bin/bash
set -euo pipefail
/usr/local/bin/alpha-sniper-load-env
cd /opt/alpha-sniper
sudo -u alpha npm run share:launch -- --first-block --first-block-tier acceptable --first-block-broadcast-offset-ms -150 --first-block-gas-limit 300000 --first-block-receipt-timeout-ms 12000 --first-block-on-pending replace --replacement-gas-price-multiplier-bps 15000 --gas-price-gwei-fixed "$DRY_RUN_GAS_GWEI" --deadline-seconds 45 --fast-launch --rpc-race --rpc-race-labels chainstack-primary,ankr-bsc --multi-rpc-broadcast --broadcast-public --broadcast-timeout-ms 3000 --broadcast-prewarm-ms 3000 --send --auto-exit --exit-poll-ms 1000 --exit-max-watch-ms 7200000
LIVE
chmod 0750 /usr/local/bin/alpha-sniper-live-first-block

cat > /etc/systemd/system/alpha-sniper-ready.service <<'SERVICE'
[Unit]
Description=Alpha Sniper dry-run readiness check
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/alpha-sniper
ExecStart=/usr/local/bin/alpha-sniper-dry-run

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable alpha-sniper-ready.service
systemctl start alpha-sniper-ready.service || true

echo "Alpha sniper bootstrap complete" > /var/log/alpha-sniper-bootstrap.done
USER_DATA

  perl -0pi \
    -e "s#__PARAM_PREFIX__#$PARAM_PREFIX#g; s#__REGION__#$REGION#g; s#__REPO_URL__#$REPO_URL#g; s#__BRANCH__#$BRANCH#g; s#__DRY_RUN_GAS_GWEI__#$DRY_RUN_GAS_GWEI#g" \
    "$file"
}

wait_for_ssm() {
  local instance_id="$1"
  echo "Waiting for SSM registration: $instance_id"
  for _ in {1..60}; do
    local ping
    ping="$(aws ssm describe-instance-information \
      --region "$REGION" \
      --filters "Key=InstanceIds,Values=$instance_id" \
      --query 'InstanceInformationList[0].PingStatus' \
      --output text 2>/dev/null || true)"
    if [[ "$ping" == "Online" ]]; then
      echo "SSM online."
      return 0
    fi
    sleep 10
  done
  echo "SSM did not come online in time. Check EC2 console system log." >&2
  return 1
}

run_ssm_command() {
  local instance_id="$1"
  local command="$2"
  local comment="$3"
  local command_id

  command_id="$(aws ssm send-command \
    --region "$REGION" \
    --instance-ids "$instance_id" \
    --document-name AWS-RunShellScript \
    --comment "$comment" \
    --parameters commands="$command" \
    --query 'Command.CommandId' \
    --output text)"

  for _ in {1..60}; do
    local status
    status="$(aws ssm get-command-invocation \
      --region "$REGION" \
      --command-id "$command_id" \
      --instance-id "$instance_id" \
      --query 'Status' \
      --output text 2>/dev/null || true)"
    case "$status" in
      Success|Cancelled|Failed|TimedOut|Cancelling)
        break
        ;;
    esac
    sleep 5
  done

  aws ssm get-command-invocation \
    --region "$REGION" \
    --command-id "$command_id" \
    --instance-id "$instance_id" \
    --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
    --output json
}

main() {
  require_cmd aws
  require_cmd jq
  require_cmd perl

  aws configure set region "$REGION"
  echo "Using region: $REGION"
  aws sts get-caller-identity --output table

  echo
  echo "Writing runtime secrets to SSM Parameter Store: $PARAM_PREFIX/*"
  prompt_string_param "WALLET_ADDRESS" "Burner wallet address"
  prompt_secret_param "PRIVATE_KEY" "Burner private key"
  prompt_secret_param "BSC_RPC_URL" "Primary BSC RPC URL"
  prompt_secret_param "CHAINSTACK_BSC_RPC_URL" "Chainstack BSC RPC URL (blank to skip)" "no"
  prompt_secret_param "ANKR_BSC_RPC_URL" "Ankr standard BSC RPC URL"
  prompt_secret_param "ANKR_BSC_WS_URL" "Ankr standard BSC WSS URL (blank to skip)" "no"
  prompt_secret_param "ANKR_MULTICHAIN_RPC_URL" "Ankr Advanced multichain URL (blank to skip)" "no"
  aws ssm put-parameter \
    --region "$REGION" \
    --name "$PARAM_PREFIX/WATCH_INTERVAL_MS" \
    --type String \
    --value "5000" \
    --overwrite >/dev/null

  ensure_role
  echo "Waiting for IAM instance profile propagation..."
  sleep 15

  local vpc_id subnet_id sg_id ami_id user_data instance_id
  vpc_id="$(aws_text ec2 describe-vpcs --filters "Name=is-default,Values=true" --query 'Vpcs[0].VpcId')"
  if [[ "$vpc_id" == "None" || -z "$vpc_id" ]]; then
    echo "No default VPC found in $REGION. Create a VPC first or set AWS_REGION to a region with a default VPC." >&2
    exit 1
  fi

  subnet_id="$(aws_text ec2 describe-subnets \
    --filters "Name=vpc-id,Values=$vpc_id" "Name=default-for-az,Values=true" \
    --query 'sort_by(Subnets,&AvailabilityZone)[0].SubnetId')"
  if [[ "$subnet_id" == "None" || -z "$subnet_id" ]]; then
    subnet_id="$(aws_text ec2 describe-subnets \
      --filters "Name=vpc-id,Values=$vpc_id" \
      --query 'sort_by(Subnets,&AvailabilityZone)[0].SubnetId')"
  fi

  sg_id="$(ensure_security_group "$vpc_id")"
  ami_id="$(aws_text ssm get-parameter \
    --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
    --query 'Parameter.Value')"

  user_data="$(mktemp)"
  write_user_data "$user_data"

  instance_id="$(aws_text ec2 run-instances \
    --image-id "$ami_id" \
    --instance-type "$INSTANCE_TYPE" \
    --iam-instance-profile "Name=$PROFILE_NAME" \
    --subnet-id "$subnet_id" \
    --security-group-ids "$sg_id" \
    --metadata-options HttpTokens=required \
    --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":12,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
    --user-data "file://$user_data" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$APP_NAME},{Key=App,Value=$APP_NAME}]" \
    --query 'Instances[0].InstanceId')"
  rm -f "$user_data"

  echo "Launched EC2 instance: $instance_id"
  aws ec2 wait instance-running --region "$REGION" --instance-ids "$instance_id"
  wait_for_ssm "$instance_id"

  echo
  echo "Running remote dry-run validation..."
  run_ssm_command "$instance_id" "sudo /usr/local/bin/alpha-sniper-dry-run" "alpha-sniper dry-run"

  echo
  echo "Deployment complete."
  echo "InstanceId: $instance_id"
  echo "Region: $REGION"
  echo "Dry-run command via SSM:"
  echo "aws ssm send-command --region $REGION --instance-ids $instance_id --document-name AWS-RunShellScript --parameters commands='sudo /usr/local/bin/alpha-sniper-dry-run'"
  echo
  echo "Live command exists on the instance but was NOT run:"
  echo "sudo /usr/local/bin/alpha-sniper-live-first-block"
}

main "$@"
