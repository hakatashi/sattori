#!/bin/bash
# フェーズ103: 起動済みインスタンスへ構築スクリプト(scripts/91)を流し、th14の録画に必要な一式を転送する。
# Usage: scripts/103_provision_instance.sh <ip> <秘密鍵>
#   GPUインスタンスは SETUP_SCRIPT=scripts/89_setup_gpu_instance.sh を渡す。
set -uo pipefail
IP=$1 KEY=$2
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR"
cd "$(dirname "$0")/.."
for i in $(seq 60); do $SSH ubuntu@$IP true 2>/dev/null && break; sleep 10; done
$SSH ubuntu@$IP 'cloud-init status --wait >/dev/null 2>&1; true'
scp -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR ${SETUP_SCRIPT:-scripts/91_setup_cpu_instance.sh} ubuntu@$IP:setup_instance.sh
$SSH ubuntu@$IP 'bash setup_instance.sh > setup.log 2>&1; tail -1 setup.log'
# ionice/niceでローカルの録画に干渉しないようにする
nice -n 19 rsync -aR -e "$SSH" recorder scripts assets games/th14 prefixes/th14-wined3d-gl \
  mods/common/build mods/th14_replay_autoplay/build hakatashi@$IP:~/touhou-recorder/
$SSH hakatashi@$IP 'cd touhou-recorder && mkdir -p instances && ls && nproc && wine --version'
echo PROVISION_DONE $IP
