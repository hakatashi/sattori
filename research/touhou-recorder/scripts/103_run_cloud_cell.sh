#!/bin/bash
# フェーズ103: スポットインスタンスの起動→構築→録画バッチ開始→成果物の回収までを1台ぶん通しで行う。
# Usage: scripts/103_run_cloud_cell.sh <instance-type> <subnet-id> <name> <秘密鍵> <取り込み先> <102バッチの引数...>
#   バッチ引数は scripts/102_run_text_filter_batch.sh の <game> <label> <replay> <mode> <hz> <secs> の繰り返し。
#   REMOTE_EXTRA_ARGS があればリモートの EXTRA_ARGS として渡す(例: --max-duplicate-rate 95)。
# 全録画の回収が終わったらインスタンスを終了する。
set -uo pipefail
TYPE=$1 SUBNET=$2 NAME=$3 KEY=$4 DEST=$5; shift 5
cd "$(dirname "$0")/.."
R=eu-south-2
ID=$(scripts/103_launch_spot.sh $TYPE $SUBNET $NAME) || { echo "LAUNCH_FAILED"; exit 1; }
echo "instance $ID"
aws ec2 wait instance-running --region $R --instance-ids $ID
IP=$(aws ec2 describe-instances --region $R --instance-ids $ID --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "ip $IP"
scripts/103_provision_instance.sh $IP $KEY
SSH="ssh -n -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o LogLevel=ERROR"
# バックグラウンド起動後もsshが戻らないことがあるのでtimeoutで切る(バッチ自体は残る)
timeout 20 $SSH hakatashi@$IP "cd touhou-recorder && EXTRA_ARGS='${REMOTE_EXTRA_ARGS:-}' SETUP_PULSE=1 setsid nohup bash scripts/102_run_text_filter_batch.sh ~/out $* > ~/batch.log 2>&1 < /dev/null &"
echo "$(date -Is) batch started"
scripts/103_pull_results.sh $IP $KEY $DEST
echo "pull rc=$?"
aws ec2 terminate-instances --region $R --instance-ids $ID --query 'TerminatingInstances[0].CurrentState.Name' --output text
echo "CELL_DONE $NAME"
