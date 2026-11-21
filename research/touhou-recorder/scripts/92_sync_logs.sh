#!/bin/bash
# フェーズ92: 録画中のインスタンスからログを逐次回収し、指定の配信版だけダウンロードする。
# Spot中断でデータを失わないよう完了ごとに回収する(reports/91 §7の反省)。
# 全録画の完了(ALL_DONE)かインスタンス消失で終了する。
#
# Usage: scripts/92_sync_logs.sh <instance.env> <key.pem> <出力先> <配信版を取るlabel...>
ENVFILE=$1 KEY=$2 DEST=$3; shift 3
WANT=" $* "
. "$ENVFILE"
O="-i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -o LogLevel=ERROR -o ServerAliveInterval=30"
mkdir -p "$DEST/logs" "$DEST/delivery"
fails=0
while :; do
  if ! done_list=$(ssh $O ubuntu@$IP 'ls ~/out | grep "^DONE_\|^ALL_DONE$"; true'); then
    fails=$((fails+1))
    if [ $fails -ge 4 ]; then
      echo "SSH_LOST $(aws ec2 describe-instances --region eu-south-2 --instance-ids $INSTANCE_ID --query 'Reservations[0].Instances[0].[State.Name,StateReason.Message]' --output text)"
      exit 1
    fi
    sleep 30; continue
  fi
  fails=0
  rsync -a -e "ssh $O" --exclude '*.mp4' --exclude '*.mov' ubuntu@$IP:out/ "$DEST/logs/" || true
  for d in $done_list; do
    label=${d#DONE_}
    [ "$d" = ALL_DONE ] && continue
    if [[ "$WANT" == *" $label "* ]] && [ ! -e "$DEST/delivery/$label.ok" ]; then
      rsync -a --partial -e "ssh $O" ubuntu@$IP:out/$label/video_delivery.mp4 "$DEST/delivery/${label}_delivery.mp4" \
        && touch "$DEST/delivery/$label.ok" && echo "DOWNLOADED $label"
    fi
  done
  if grep -q '^ALL_DONE$' <<<"$done_list"; then echo ALL_DONE; exit 0; fi
  sleep 120
done
