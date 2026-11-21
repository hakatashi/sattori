#!/bin/bash
# フェーズ94: g6f.xlarge(INSTANCE_TYPE環境変数で変更可)を eu-south-2 の本番GPU AMIで1台起動する。Spotを試し、容量不足ならオンデマンドへ落とす。
# 検証用なので sattori:jobId タグは付けない(孤児掃除の対象になるため)。
#
# Usage: scripts/94_launch_g6f.sh <spot|ondemand|auto> <guard分> <volGiB> <出力ディレクトリ>
#   auto: Spot 2a→2b→2c→オンデマンド 2a→2b→2c の順に試す
#   <出力ディレクトリ>/instance.env に INSTANCE_ID, IP, AZ, MARKET, T0, T_RUNNING を書く。
# phase94のインスタンスが他に動いていれば起動しない(同時1台の制約)。
set -uo pipefail
MODE=$1 GUARD=$2 VOL=$3 OUT=$4
HERE=$(cd "$(dirname "$0")" && pwd)
R=eu-south-2
INSTANCE_TYPE=${INSTANCE_TYPE:-g6f.xlarge}
AMI=<AMI_ID>
KEY=touhou-recorder-g6f-key
SG=<SECURITY_GROUP_ID>
mkdir -p "$OUT"

ACTIVE=$(aws ec2 describe-instances --region $R \
  --filters Name=tag:Project,Values=touhou-recorder-phase94 Name=instance-state-name,Values=pending,running,stopping,shutting-down \
  --query 'Reservations[].Instances[].InstanceId' --output text)
if [ -n "$ACTIVE" ]; then
  echo "ERROR: 別のインスタンスが稼働中です: $ACTIVE" >&2
  exit 2
fi

sed "s/__GUARD_MIN__/$GUARD/" "$HERE/92_userdata_boot_timing.sh" > "$OUT/userdata.sh"

try_launch() { # <spot|ondemand> <a|b|c>
  local market=$1 az=$2 subnet opts=()
  case $az in
    a) subnet=<SUBNET_ID> ;;
    b) subnet=<SUBNET_ID> ;;
    c) subnet=<SUBNET_ID> ;;
  esac
  [ "$market" = spot ] && opts=(--instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate}')
  T0=$(date +%s.%N)
  INSTANCE_ID=$(aws ec2 run-instances --region $R --image-id $AMI --instance-type "$INSTANCE_TYPE" \
    --key-name $KEY --security-group-ids $SG --subnet-id "$subnet" \
    --associate-public-ip-address \
    --iam-instance-profile Name=touhou-recorder-verify-profile \
    "${opts[@]}" \
    --instance-initiated-shutdown-behavior terminate \
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$VOL,VolumeType=gp3,DeleteOnTermination=true}" \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=touhou-recorder-phase94},{Key=Project,Value=touhou-recorder-phase94}]' \
    --user-data "file://$OUT/userdata.sh" \
    --query 'Instances[0].InstanceId' --output text 2> "$OUT/run-instances.err")
  local rc=$?
  echo "$(date -Is) $market $az rc=$rc $(tail -1 "$OUT/run-instances.err" | cut -c1-200)" | tee -a "$OUT/launch_attempts.log"
  [ $rc -eq 0 ] || return 1
  MARKET=$market AZ=$az
}

case $MODE in
  spot) ORDER="spot:a spot:b spot:c" ;;
  ondemand) ORDER="ondemand:a ondemand:b ondemand:c" ;;
  auto) ORDER="spot:a spot:b spot:c ondemand:a ondemand:b ondemand:c" ;;
esac
OK=
for t in $ORDER; do
  if try_launch "${t%%:*}" "${t##*:}"; then OK=1; break; fi
done
[ -n "$OK" ] || { echo "ERROR: 全候補で起動失敗" >&2; exit 1; }

aws ec2 wait instance-running --region $R --instance-ids "$INSTANCE_ID"
T_RUNNING=$(date +%s.%N)
IP=$(aws ec2 describe-instances --region $R --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
cat > "$OUT/instance.env" <<EOT
INSTANCE_ID=$INSTANCE_ID
IP=$IP
AZ=$AZ
MARKET=$MARKET
T0=$T0
T_RUNNING=$T_RUNNING
EOT
cat "$OUT/instance.env"
