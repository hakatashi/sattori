#!/bin/bash
# フェーズ92: g6.2xlargeを1台ずつ起動し、run-instancesからコンテナ起動までの時間を測って終了する。
# 同時起動は常に1台(前のインスタンスが消えるまで次を起動しない)。各台は scripts/92_launch_g6.sh の
# 自動終了ガード(25分)でも止まる。遅い起動はコンソール出力を保存する。
#
# Usage: scripts/92_boot_timing_cycle.sh <key.pem> <出力先> <a|b|c> [...]
KEY=$1 OUT=$2; shift 2
HERE=$(cd "$(dirname "$0")" && pwd)
R=eu-south-2
O="-i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -o LogLevel=ERROR"
mkdir -p "$OUT"
n=0
for az in "$@"; do
  n=$((n+1)); d=$OUT/boot$n-$az
  until [ -z "$(aws ec2 describe-instances --region $R \
    --filters Name=tag:Project,Values=touhou-recorder-phase92 Name=instance-state-name,Values=pending,running,stopping,shutting-down \
    --query 'Reservations[].Instances[].InstanceId' --output text)" ]; do sleep 20; done
  if ! "$HERE/92_launch_g6.sh" "$az" 25 40 "$d" > "$d.launch.txt" 2>&1; then
    echo "boot$n az=$az LAUNCH_FAILED $(tail -1 "$d.launch.txt" | cut -c1-160)"
    continue
  fi
  . "$d/instance.env"
  got=0
  for i in $(seq 1 130); do
    if ssh $O ubuntu@$IP 'grep -q userdata_done /var/log/boot_timing.log 2>/dev/null' 2>/dev/null; then got=1; break; fi
    sleep 10
  done
  ssh $O ubuntu@$IP 'cat /var/log/boot_timing.log; uptime -s; systemd-analyze 2>/dev/null | head -1; nvidia-smi -q | grep "License Status"' > "$d/boot_timing.log" 2>&1
  python3 - "$d" "$T0" "$T_RUNNING" "$az" "$n" "$got" <<'PY'
import re, sys
d, t0, tr, az, n, got = sys.argv[1:]
t0, tr = float(t0), float(tr)
stamps = dict(re.findall(r"^(\w+) ([\d.]+)$", open(f"{d}/boot_timing.log").read(), re.M))
g = lambda k: f"{float(stamps[k]) - t0:.0f}" if k in stamps else "-"
print(f"boot{n} az={az} running={tr - t0:.0f}s userdata={g('userdata_start')}s login={g('ecr_login_done')}s "
      f"pull={g('docker_pull_done')}s container={g('container_start')}s ok={got}", flush=True)
PY
  if [ "$got" != 1 ]; then
    aws ec2 get-console-output --region $R --instance-id $INSTANCE_ID --latest --output text > "$d/console.txt" 2>&1
  fi
  aws ec2 terminate-instances --region $R --instance-ids $INSTANCE_ID > /dev/null
  aws ec2 wait instance-terminated --region $R --instance-ids $INSTANCE_ID
  t_term=$(date +%s); echo "  terminated at $t_term"
done
echo ALL_BOOTS_DONE
