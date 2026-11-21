#!/bin/bash
# フェーズ109: スポットインスタンスを1台起動する(MaxPrice=0.20 USD/h 厳守、並列起動チェック付き)。
# Usage: scripts/109_launch_spot.sh <instance-type> <subnet-id> <name-tag>
#   CPU(eu-south-2): 既定 (AMI=<AMI_ID>, SG=<SECURITY_GROUP_ID>, VOL=100)
#   GPU(us-west-2):  REGION=us-west-2 AMI=<AMI_ID> SG=<SECURITY_GROUP_ID> VOL=150
set -euo pipefail
TYPE=$1 SUBNET=$2 NAME=$3
R=${REGION:-eu-south-2}
AMI=${AMI:-<AMI_ID>}
SG=${SG:-<SECURITY_GROUP_ID>}
VOL=${VOL:-100}
KEY_NAME=${KEY_NAME:-touhou-recorder-p109-key}

# 並列起動禁止ガード: 全検証リージョンに生存インスタンスが無いことを確認する
for chk_r in eu-south-2 us-west-2; do
  live=$(aws ec2 describe-instances --region "$chk_r" \
    --filters Name=instance-state-name,Values=pending,running,stopping,stopped \
    --query 'Reservations[*].Instances[*].InstanceId' --output text)
  if [ -n "$live" ]; then
    echo "ERROR: $chk_r に既存のインスタンス($live)が残っています。先にterminateしてください" >&2
    exit 1
  fi
done

UD=$(printf '#!/bin/bash\nshutdown -h +600\n' | base64 -w0)
aws ec2 run-instances --region "$R" --image-id "$AMI" --instance-type "$TYPE" \
  --key-name "$KEY_NAME" --security-group-ids "$SG" --subnet-id "$SUBNET" \
  --associate-public-ip-address --instance-initiated-shutdown-behavior terminate \
  --user-data "$UD" \
  --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$VOL,VolumeType=gp3,DeleteOnTermination=true}" \
  --instance-market-options 'MarketType=spot,SpotOptions={MaxPrice=0.20,SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate}' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=Project,Value=touhou-recorder-p109}]" \
  --query 'Instances[0].InstanceId' --output text
