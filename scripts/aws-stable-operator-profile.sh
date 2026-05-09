#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-alpha-sniper}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-west-2}}"
OPERATOR_PROFILE="${AWS_OPERATOR_PROFILE:-alpha-sniper-operator}"
OPERATOR_USER="${AWS_OPERATOR_USER:-alpha-sniper-operator}"
POLICY_NAME="${AWS_OPERATOR_POLICY_NAME:-alpha-sniper-operator-ssm}"
DELETE_OLDEST_KEY="${DELETE_OLDEST_KEY:-no}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/aws-stable-operator-profile.sh doctor
  scripts/aws-stable-operator-profile.sh install

Actions:
  doctor   Check whether the stable operator profile works.
  install  Create/update a low-permission IAM user, create one access key,
           and write it to the local AWS profile.

Env:
  AWS_REGION=us-west-2
  AWS_OPERATOR_PROFILE=alpha-sniper-operator
  AWS_OPERATOR_USER=alpha-sniper-operator
  DELETE_OLDEST_KEY=yes   Delete the oldest existing key if the user already has 2 keys.
USAGE
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

profile_exists() {
  aws configure get "profile.${OPERATOR_PROFILE}.aws_access_key_id" >/dev/null 2>&1 ||
    aws configure get aws_access_key_id --profile "$OPERATOR_PROFILE" >/dev/null 2>&1
}

discover_instance_ids() {
  aws ec2 describe-instances \
    --region "$REGION" \
    --filters "Name=tag:Name,Values=$APP_NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' \
    --output json |
    jq -r '.[]'
}

build_policy_document() {
  local account_id="$1"
  shift
  local instances_json

  instances_json="$(
    printf "%s\n" "$@" |
      jq -R --arg region "$REGION" --arg account "$account_id" \
        'select(length > 0) | "arn:aws:ec2:\($region):\($account):instance/\(.)"' |
      jq -s .
  )"

  jq -n \
    --arg region "$REGION" \
    --argjson instances "$instances_json" \
    '{
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "ReadAlphaInstanceDiscovery",
          Effect: "Allow",
          Action: [
            "ec2:DescribeInstances"
          ],
          Resource: "*"
        },
        {
          Sid: "SendAlphaSsmCommand",
          Effect: "Allow",
          Action: [
            "ssm:SendCommand"
          ],
          Resource: ($instances + ["arn:aws:ssm:\($region)::document/AWS-RunShellScript"])
        },
        {
          Sid: "ReadAlphaSsmCommandResult",
          Effect: "Allow",
          Action: [
            "ssm:GetCommandInvocation"
          ],
          Resource: "*"
        }
      ]
    }'
}

ensure_operator_user() {
  if ! aws iam get-user --user-name "$OPERATOR_USER" >/dev/null 2>&1; then
    aws iam create-user --user-name "$OPERATOR_USER" >/dev/null
  fi
}

ensure_key_capacity() {
  local keys_json key_count oldest_key
  keys_json="$(aws iam list-access-keys --user-name "$OPERATOR_USER" --output json)"
  key_count="$(jq '.AccessKeyMetadata | length' <<<"$keys_json")"

  if (( key_count < 2 )); then
    return 0
  fi

  if [[ "$DELETE_OLDEST_KEY" != "yes" ]]; then
    echo "IAM user $OPERATOR_USER already has 2 access keys." >&2
    echo "Set DELETE_OLDEST_KEY=yes to let this script delete the oldest key and create a fresh one." >&2
    exit 1
  fi

  oldest_key="$(jq -r '.AccessKeyMetadata | sort_by(.CreateDate)[0].AccessKeyId' <<<"$keys_json")"
  aws iam update-access-key --user-name "$OPERATOR_USER" --access-key-id "$oldest_key" --status Inactive >/dev/null
  aws iam delete-access-key --user-name "$OPERATOR_USER" --access-key-id "$oldest_key" >/dev/null
}

write_local_profile_from_new_key() {
  local key_json access_key_id secret_access_key
  key_json="$(aws iam create-access-key --user-name "$OPERATOR_USER" --output json)"
  access_key_id="$(jq -r '.AccessKey.AccessKeyId' <<<"$key_json")"
  secret_access_key="$(jq -r '.AccessKey.SecretAccessKey' <<<"$key_json")"

  aws configure set aws_access_key_id "$access_key_id" --profile "$OPERATOR_PROFILE"
  aws configure set aws_secret_access_key "$secret_access_key" --profile "$OPERATOR_PROFILE"
  aws configure set region "$REGION" --profile "$OPERATOR_PROFILE"
  chmod 600 "$HOME/.aws/credentials" 2>/dev/null || true
  chmod 600 "$HOME/.aws/config" 2>/dev/null || true
}

doctor() {
  if ! profile_exists; then
    echo "Stable AWS profile not found: $OPERATOR_PROFILE"
    return 1
  fi

  local identity
  identity="$(aws sts get-caller-identity --profile "$OPERATOR_PROFILE" --region "$REGION" --query Arn --output text)"
  echo "Stable AWS profile ok: $OPERATOR_PROFILE"
  echo "Identity: $identity"
  echo "Region: $REGION"
}

install() {
  local account_id policy_file instance_id
  local instance_ids=()

  while IFS= read -r instance_id; do
    [[ -n "$instance_id" ]] && instance_ids+=("$instance_id")
  done < <(discover_instance_ids)

  if (( ${#instance_ids[@]} == 0 )); then
    echo "No $APP_NAME EC2 instances found in $REGION." >&2
    exit 1
  fi

  account_id="$(aws sts get-caller-identity --query Account --output text)"
  policy_file="$(mktemp)"
  build_policy_document "$account_id" "${instance_ids[@]}" > "$policy_file"

  ensure_operator_user
  aws iam put-user-policy \
    --user-name "$OPERATOR_USER" \
    --policy-name "$POLICY_NAME" \
    --policy-document "file://$policy_file" >/dev/null
  rm -f "$policy_file"

  ensure_key_capacity
  write_local_profile_from_new_key
  doctor
}

main() {
  require_cmd aws
  require_cmd jq

  case "${1:-}" in
    doctor)
      doctor
      ;;
    install)
      install
      ;;
    -h|--help|"")
      usage
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
