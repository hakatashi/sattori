#!/bin/bash
# フェーズ109: スポットインスタンス1台の起動→構築→録画バッチ→成果物回収→終了を安全に実行する。
# Usage: scripts/109_run_cloud_cell.sh <instance-type> <subnet-id> <inst_label> <mode=cpu|gpu> <batch_args...>
# 環境変数:
#   REGION / AMI / SG / VOL / SETUP_SCRIPT (GPU用の上書き)
#   REMOTE_ENV  リモートバッチに渡す環境変数文字列 (例: "USE_GPU_ENCODE=1 LOAD_WORKERS=8")
#   POST_CMD    バッチ完了後に実行する追加コマンド (例: "python3 scripts/109_bench_convert.py ...")
set -uo pipefail
TYPE=$1 SUBNET=$2 INST=$3 MODE=$4; shift 4
cd "$(dirname "$0")/.."
R=${REGION:-eu-south-2}
KEY=/tmp/touhou-recorder-p109-key.pem
ID=""

cleanup() {
  if [ -n "$ID" ]; then
    echo "$(date -Is) terminating $ID ($R)..."
    aws ec2 terminate-instances --region "$R" --instance-ids "$ID" --query 'TerminatingInstances[0].CurrentState.Name' --output text || true
    aws ec2 wait instance-terminated --region "$R" --instance-ids "$ID" || true
    echo "$(date -Is) terminated $ID"
  fi
}
trap cleanup EXIT

ID=$(scripts/109_launch_spot.sh "$TYPE" "$SUBNET" "p109-$INST") || { echo "LAUNCH_FAILED"; exit 1; }
echo "$(date -Is) launched $ID ($TYPE $SUBNET $R)"
aws ec2 wait instance-running --region "$R" --instance-ids "$ID"
IP=$(aws ec2 describe-instances --region "$R" --instance-ids "$ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "$(date -Is) running ip=$IP"

scripts/109_provision_instance.sh "$IP" "$KEY" || { echo "PROVISION_FAILED"; exit 1; }

SSH="ssh -n -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o LogLevel=ERROR"
POST=${POST_CMD:-true}
RENV=${REMOTE_ENV:-}
timeout 20 $SSH "hakatashi@$IP" "cd touhou-recorder && setsid nohup bash -c 'SKIP_ALL_DONE=1 SETUP_PULSE=1 $RENV bash scripts/109_run_cloud_framesync_batch.sh ~/out $MODE $*; $POST; touch ~/out/ALL_DONE' > ~/batch.log 2>&1 < /dev/null &"
echo "$(date -Is) batch started on $IP"

scripts/109_pull_results.sh "$IP" "$KEY" "$INST"
echo "$(date -Is) pull rc=$?"
