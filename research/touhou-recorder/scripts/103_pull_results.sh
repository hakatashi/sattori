#!/bin/bash
# フェーズ103: リモートの ~/out から、完了済み(<label>.done あり)の録画一式を取り込み続ける。
# Spot中断で成果物を失わないよう、1本終わるごとに回収する(reports/100)。ALL_DONEを取り込んだら終わる。
# Usage: scripts/103_pull_results.sh <ip> <秘密鍵> <取り込み先>
IP=$1 KEY=$2 DEST=$3
SSH="ssh -n -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o LogLevel=ERROR"
mkdir -p "$DEST"
fails=0
while :; do
  labels=$($SSH hakatashi@$IP 'cd ~/out 2>/dev/null && for f in *.done; do [ -f "$f" ] && echo "$f:$(tr " " _ < $f)"; done; [ -f ~/out/ALL_DONE ] && echo ALL_DONE; true') \
    && fails=0 || fails=$((fails+1))
  [ $fails -ge 20 ] && { echo "UNREACHABLE $IP"; exit 1; }
  for d in $labels; do
    [ "$d" = ALL_DONE ] && continue
    l=${d%%.done:*}; content=${d#*.done:}
    # 前回の失敗分など古い.doneが残っていても、内容が変われば取り込み直す
    [ -f "$DEST/$l.done" ] && [ "$(tr ' ' _ < "$DEST/$l.done")" = "$content" ] && continue
    nice -n 19 rsync -a -e "${SSH/ -n / }" --exclude='*.video.mp4' --exclude='*.pollraw' --include="$l.*" --exclude='*' hakatashi@$IP:out/ "$DEST/" \
      && echo "$(date -Is) pulled $l: $(cat $DEST/$l.done)"
  done
  case " $labels " in *ALL_DONE*) echo "ALL_PULLED $IP"; exit 0 ;; esac
  sleep 60
done
