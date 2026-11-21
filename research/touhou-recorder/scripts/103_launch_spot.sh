#!/bin/bash
# フェーズ103: th14のクラウド検証用にスポットインスタンスを1台起動する(既定はeu-south-2、Ubuntu 24.04)。
# GPU(g6f)は REGION=us-west-2 AMI=<AMI_ID> SG=<SECURITY_GROUP_ID> VOL=150 を環境変数で渡す。
# Usage: scripts/103_launch_spot.sh <instance-type> <subnet-id> <name-tag>
#   キーペア touhou-recorder-p103-key は事前に作成しておく。起動から10時間で自動shutdown(=terminate)。
# 出力: インスタンスID
set -euo pipefail
TYPE=$1 SUBNET=$2 NAME=$3
R=${REGION:-eu-south-2}
AMI=${AMI:-<AMI_ID>}
SG=${SG:-<SECURITY_GROUP_ID>}
VOL=${VOL:-100}
UD=$(printf '#!/bin/bash\nshutdown -h +600\n' | base64 -w0)
aws ec2 run-instances --region $R --image-id $AMI --instance-type "$TYPE" \
  --key-name touhou-recorder-p103-key --security-group-ids $SG --subnet-id "$SUBNET" \
  --associate-public-ip-address --instance-initiated-shutdown-behavior terminate --user-data "$UD" \
  --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$VOL,VolumeType=gp3,DeleteOnTermination=true}" \
  --instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate}' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=Project,Value=touhou-recorder-p103}]" \
  --query 'Instances[0].InstanceId' --output text
