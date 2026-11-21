terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "region" {
  default = "us-east-1"
}

variable "image" {
  description = "ECRにpush済みの録画ワーカーイメージ(タグ込みURI)"
  type        = string
}

variable "instance_type" {
  description = "検証対象のインスタンスタイプ(コスト比較用に差し替えて複数回apply/destroyする)"
  type        = string
  default     = "c6i.xlarge"
}

variable "instance_suffix" {
  description = "同時に複数インスタンスタイプを試す際に名前を衝突させないためのsuffix"
  type        = string
  default     = "test"
}

variable "spot" {
  description = "EC2 Spotインスタンスを使うかどうか"
  type        = bool
  default     = true
}

variable "replay_file" {
  default = "th7_07.rpy"
}

variable "watermark_path" {
  description = "コンテナ内のウォーターマーク動画パス(空文字なら合成しない)。reports/18参照"
  type        = string
  default     = ""
}

variable "watermark_width" {
  default = "285"
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "current" {}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  # us-east-1bはc6i.xlarge Spotのキャパシティ不足(InsufficientInstanceCapacity)を
  # 実機検証で確認したため除外する。
  filter {
    name   = "availability-zone"
    values = ["us-east-1a", "us-east-1c", "us-east-1d", "us-east-1f"]
  }
}

data "aws_ami" "amazon_linux" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }
}

# --- S3出力バケット(録画動画・ログの保存先) ---

resource "aws_s3_bucket" "output" {
  bucket = "touhou-recorder-output-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "output" {
  bucket                  = aws_s3_bucket.output.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "output" {
  bucket = aws_s3_bucket.output.id

  rule {
    id     = "expire-after-7-days"
    status = "Enabled"
    filter {}

    expiration {
      days = 7
    }
  }
}

# --- CloudFront(S3を非公開のまま、OAC経由でegress検証用に配信) ---

resource "aws_cloudfront_origin_access_control" "output" {
  name                              = "th07-recorder-output-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "output" {
  enabled = true

  origin {
    domain_name              = aws_s3_bucket.output.bucket_regional_domain_name
    origin_id                = "s3-output"
    origin_access_control_id = aws_cloudfront_origin_access_control.output.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-output"
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

resource "aws_s3_bucket_policy" "output_cloudfront" {
  bucket = aws_s3_bucket.output.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontServicePrincipal"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.output.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.output.arn
        }
      }
    }]
  })
}

# --- EC2用IAMロール(S3書き込み・ECR pull) ---

resource "aws_iam_role" "recorder" {
  name = "th07-recorder-ec2"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "recorder" {
  name = "th07-recorder-ec2-policy"
  role = aws_iam_role.recorder.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.output.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ]
        Resource = "arn:aws:ecr:${var.region}:${data.aws_caller_identity.current.account_id}:repository/touhou-recorder"
      },
    ]
  })
}

resource "aws_iam_instance_profile" "recorder" {
  name = "th07-recorder-ec2"
  role = aws_iam_role.recorder.name
}

resource "aws_security_group" "recorder" {
  name_prefix = "th07-recorder-"
  vpc_id      = data.aws_vpc.default.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- EC2インスタンス本体(Spot、録画完了後に自己終了) ---
# 既知の問題: Spotキャパシティ不足(InsufficientInstanceCapacity)のAZに当たると、
# terraform-provider-aws(v5.100.0で確認)がエラーを報告せず無限にハングすることがある
# (実機検証で確認、reports/16_phase16_cloud_deployment_aws.md参照)。applyがCreating...の
# まま進まない場合は、AWS CLIで直接 run-instances --dry-run し、Insufficient
# InstanceCapacityが出ないか確認すること。上のdata "aws_subnets" "default"で
# us-east-1bを除外済みだが、他のAZでも同様の事象が起き得る。

resource "aws_instance" "recorder" {
  ami                         = data.aws_ami.amazon_linux.id
  instance_type               = var.instance_type
  subnet_id                   = data.aws_subnets.default.ids[0]
  vpc_security_group_ids      = [aws_security_group.recorder.id]
  iam_instance_profile        = aws_iam_instance_profile.recorder.name
  associate_public_ip_address = true

  instance_initiated_shutdown_behavior = "terminate"

  dynamic "instance_market_options" {
    for_each = var.spot ? [1] : []
    content {
      market_type = "spot"
      spot_options {
        spot_instance_type          = "one-time"
        instance_interruption_behavior = "terminate"
      }
    }
  }

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
  }

  user_data = <<-EOT
    #!/bin/bash
    set -x
    echo "start: $(date -Is)"
    dnf install -y docker
    systemctl enable --now docker
    aws ecr get-login-password --region ${var.region} | docker login --username AWS --password-stdin ${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com
    echo "ecr login exit code: $?"
    docker run --rm \
      -e OUTPUT_BUCKET="${aws_s3_bucket.output.bucket}" \
      -e REPLAY_FILE="${var.replay_file}" \
      -e RUN_ID="ec2-${var.instance_type}-${var.instance_suffix}" \
      -e WATERMARK_PATH="${var.watermark_path}" \
      -e WATERMARK_WIDTH="${var.watermark_width}" \
      "${var.image}"
    echo "docker run exit code: $?"
    echo "end: $(date -Is)"
    shutdown -h now
  EOT

  tags = {
    Name = "th07-recorder-${var.instance_suffix}"
  }
}

output "instance_id" {
  value = aws_instance.recorder.id
}

output "output_bucket" {
  value = aws_s3_bucket.output.bucket
}

output "cloudfront_domain" {
  value = aws_cloudfront_distribution.output.domain_name
}
