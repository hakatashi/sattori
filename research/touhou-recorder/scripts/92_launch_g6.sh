#!/bin/bash
# フェーズ92: g6.2xlarge(Spot)を eu-south-2 の本番GPU AMIで1台起動し、時刻を記録する。
# 検証用なので sattori:jobId タグは付けない(孤児掃除の対象になるため)。
#
# Usage: scripts/92_launch_g6.sh <a|b|c> <guard分> <volGiB> <出力ディレクトリ>
#   <出力ディレクトリ>/instance.env に INSTANCE_ID, IP, T0(run-instances直前), T_RUNNING を書く。
# 起動中のインスタンスが他にあれば起動しない(同時1台の制約)。
set -euo pipefail
AZ=$1 GUARD=$2 VOL=$3 OUT=$4
HERE=$(cd "$(dirname "$0")" && pwd)
R=eu-south-2
AMI=<AMI_ID>
KEY=touhou-recorder-g6-key
SG=<SECURITY_GROUP_ID>
case $AZ in
  a) SUBNET=<SUBNET_ID> ;;
  b) SUBNET=<SUBNET_ID> ;;
  c) SUBNET=<SUBNET_ID> ;;
esac
mkdir -p "$OUT"

ACTIVE=$(aws ec2 describe-instances --region $R \
  --filters Name=tag:Project,Values=touhou-recorder-phase92 Name=instance-state-name,Values=pending,running,stopping,shutting-down \
  --query 'Reservations[].Instances[].InstanceId' --output text)
if [ -n "$ACTIVE" ]; then
  echo "ERROR: 別のインスタンスが稼働中です: $ACTIVE" >&2
  exit 2
fi

sed "s/__GUARD_MIN__/$GUARD/" "$HERE/92_userdata_boot_timing.sh" > "$OUT/userdata.sh"
T0=$(date +%s.%N)
if ! INSTANCE_ID=$(aws ec2 run-instances --region $R --image-id $AMI --instance-type g6.2xlarge \
  --key-name $KEY --security-group-ids $SG --subnet-id $SUBNET \
  --associate-public-ip-address \
  --iam-instance-profile Name=touhou-recorder-verify-profile \
  --instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate}' \
  --instance-initiated-shutdown-behavior terminate \
  --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$VOL,VolumeType=gp3,DeleteOnTermination=true}" \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=touhou-recorder-phase92},{Key=Project,Value=touhou-recorder-phase92}]' \
  --user-data "file://$OUT/userdata.sh" \
  --query 'Instances[0].InstanceId' --output text 2> "$OUT/run-instances.err"); then
  cat "$OUT/run-instances.err" >&2
  exit 1
fi
aws ec2 wait instance-running --region $R --instance-ids "$INSTANCE_ID"
T_RUNNING=$(date +%s.%N)
IP=$(aws ec2 describe-instances --region $R --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
cat > "$OUT/instance.env" <<EOF
INSTANCE_ID=$INSTANCE_ID
IP=$IP
AZ=$AZ
T0=$T0
T_RUNNING=$T_RUNNING
EOF
cat "$OUT/instance.env"
