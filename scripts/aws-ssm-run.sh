#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-alpha-sniper}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-southeast-1}}"
INSTANCE_ID="${INSTANCE_ID:-}"
POLL_SECONDS="${POLL_SECONDS:-5}"
MAX_POLLS="${MAX_POLLS:-120}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/aws-ssm-run.sh <command>

Commands:
  status            Show deployed instance/app status.
  sync              Pull latest main and refresh dependencies/env.
  check             Run npm run check on the instance.
  dry-run           Run the first-block dry-run helper.
  rpc-check         Run npm run rpc:check on the instance.
  rpc-race          Run npm run test:rpc-race on the instance.
  rpc-stress-short  Run a short AWS-side RPC stress ladder.
  broadcast-latency Run invalid-raw-tx broadcast rejection latency test.
  timer-precision   Measure Node.js timer wake-up error on the instance.
  logs              Tail bootstrap and latest run-log names.
  raw -- <command>  Run an explicit shell command through SSM.

Env:
  AWS_REGION=ap-southeast-1
  INSTANCE_ID=i-...
USAGE
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

resolve_instance_id() {
  if [[ -n "$INSTANCE_ID" ]]; then
    echo "$INSTANCE_ID"
    return 0
  fi

  aws ec2 describe-instances \
    --region "$REGION" \
    --filters "Name=tag:Name,Values=$APP_NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[] | sort_by(@,&LaunchTime)[-1].InstanceId' \
    --output text
}

send_and_wait() {
  local instance_id="$1"
  local command="$2"
  local comment="$3"
  local command_id status result

  command_id="$(aws ssm send-command \
    --region "$REGION" \
    --instance-ids "$instance_id" \
    --document-name AWS-RunShellScript \
    --comment "$comment" \
    --parameters "$(jq -nc --arg c "$command" '{commands:[$c]}')" \
    --query 'Command.CommandId' \
    --output text)"

  for _ in $(seq 1 "$MAX_POLLS"); do
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
    sleep "$POLL_SECONDS"
  done

  result="$(aws ssm get-command-invocation \
    --region "$REGION" \
    --command-id "$command_id" \
    --instance-id "$instance_id" \
    --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
    --output json)"

  echo "$result"
  [[ "$(jq -r '.Status' <<<"$result")" == "Success" ]]
}

main() {
  require_cmd aws
  require_cmd jq

  local action="${1:-}"
  if [[ -z "$action" || "$action" == "-h" || "$action" == "--help" ]]; then
    usage
    exit 0
  fi

  local instance_id command
  instance_id="$(resolve_instance_id)"
  if [[ -z "$instance_id" || "$instance_id" == "None" ]]; then
    echo "No $APP_NAME EC2 instance found in $REGION." >&2
    exit 1
  fi

  case "$action" in
    status)
      command='set -e; token=$(curl -fsS -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token || true); if [ -n "$token" ]; then echo instance=$(curl -fsS -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/instance-id || true); fi; echo marker=$(test -f /var/log/alpha-sniper-bootstrap.done && echo yes || echo no); echo dryrun=$(test -x /usr/local/bin/alpha-sniper-dry-run && echo yes || echo no); echo live=$(test -x /usr/local/bin/alpha-sniper-live-first-block && echo yes || echo no); systemctl show alpha-sniper-ready.service -p Result -p ExecMainStatus -p ActiveState --no-pager || true; sudo -u alpha git -C /opt/alpha-sniper rev-parse --short HEAD'
      ;;
    sync)
      command='sudo /usr/local/bin/alpha-sniper-sync'
      ;;
    check)
      command='sudo -u alpha bash -lc "cd /opt/alpha-sniper && npm run check"'
      ;;
    dry-run)
      command='sudo /usr/local/bin/alpha-sniper-dry-run'
      ;;
    rpc-check)
      command='sudo -u alpha bash -lc "cd /opt/alpha-sniper && npm run rpc:check"'
      ;;
    rpc-race)
      command='sudo -u alpha bash -lc "cd /opt/alpha-sniper && npm run test:rpc-race"'
      ;;
    rpc-stress-short)
      command='sudo -u alpha bash -lc "cd /opt/alpha-sniper && npm run rpc:stress -- --duration-ms 5000 --timeout-ms 3000 --steps 4,8,16,32 --max-failure-pct 1 --max-p95-ms 1000"'
      ;;
    broadcast-latency)
      command='sudo -u alpha bash -lc "cd /opt/alpha-sniper && npm run broadcast:latency -- --samples 5 --timeout-ms 3000 --prewarm"'
      ;;
    timer-precision)
      command='sudo -u alpha bash -lc "cd /opt/alpha-sniper && npm run timer:precision -- --samples 1000 --interval-ms 10 --warmup-ms 250"'
      ;;
    logs)
      command='set -e; echo "== cloud-init tail =="; tail -n 80 /var/log/cloud-init-output.log || true; echo "== latest run logs =="; find /opt/alpha-sniper/data/runs -maxdepth 1 -type f 2>/dev/null | sort | tail -10 || true'
      ;;
    raw)
      shift
      if [[ "${1:-}" == "--" ]]; then shift; fi
      command="$*"
      if [[ -z "$command" ]]; then
        echo "raw requires a command after --" >&2
        exit 1
      fi
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac

  send_and_wait "$instance_id" "$command" "alpha-sniper $action"
}

main "$@"
