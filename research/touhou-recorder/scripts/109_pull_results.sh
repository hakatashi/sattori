#!/bin/bash
# フェーズ109: リモートの ~/out から完了済み(<label>.done)を1本ずつ回収する。
# ラベル名(th12_* / th15_* / それ以外)に応じて /mnt/cache3/sattori-th{12,15}-verify/phase109/<inst>/ へ保存する。
# Usage: scripts/109_pull_results.sh <ip> <秘密鍵> <inst_label>
set -u
IP=$1 KEY=$2 INST=$3
DEST_12="/mnt/cache3/sattori-th12-verify/phase109/$INST"
DEST_15="/mnt/cache3/sattori-th15-verify/phase109/$INST"
mkdir -p "$DEST_12" "$DEST_15"
SSH="ssh -n -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o LogLevel=ERROR"
fails=0
while :; do
  labels=$($SSH "hakatashi@$IP" 'cd ~/out 2>/dev/null && for f in *.done; do [ -f "$f" ] && echo "$f:$(tr " " _ < $f)"; done; [ -f ~/out/ALL_DONE ] && echo ALL_DONE; true') \
    && fails=0 || fails=$((fails+1))
  [ $fails -ge 20 ] && { echo "UNREACHABLE $IP"; exit 1; }
  for d in $labels; do
    [ "$d" = ALL_DONE ] && continue
    l=${d%%.done:*}; content=${d#*.done:}
    case "$l" in
      th12*) DEST="$DEST_12" ;;
      *)     DEST="$DEST_15" ;;
    esac
    [ -f "$DEST/$l.done" ] && [ "$(tr ' ' _ < "$DEST/$l.done")" = "$content" ] && continue
    nice -n 19 rsync -a -e "${SSH/ -n / }" --exclude='*.video.mp4' --exclude='*.audio.pcm' --exclude='*.pollraw' \
      --include="$l.*" --exclude='*' "hakatashi@$IP:out/" "$DEST/" \
      && echo "$(date -Is) pulled $l -> $DEST: $(cat "$DEST/$l.done")"
  done
  case " $labels " in *ALL_DONE*)
    # バッチログ・変換ベンチ結果があれば回収
    nice -n 19 rsync -a -e "${SSH/ -n / }" "hakatashi@$IP:batch.log" "$DEST_15/batch.log" 2>/dev/null || true
    nice -n 19 rsync -a -e "${SSH/ -n / }" "hakatashi@$IP:out/convert_bench.txt" "$DEST_15/convert_bench.txt" 2>/dev/null || true
    echo "ALL_PULLED $IP"; exit 0 ;;
  esac
  sleep 60
done
