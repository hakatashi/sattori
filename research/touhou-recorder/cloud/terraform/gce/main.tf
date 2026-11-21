terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

variable "project_id" {
  default = "<GCP_PROJECT_ID>"
}

variable "region" {
  default = "asia-northeast1"
}

variable "zone" {
  default = "asia-northeast1-a"
}

variable "image" {
  description = "Artifact Registryにpush済みの録画ワーカーイメージ"
  type        = string
}

variable "output_bucket" {
  default = "gs://touhou-recorder-output"
}

variable "machine_type" {
  description = "検証対象のマシンタイプ(コスト比較用に差し替えて複数回apply/destroyする)"
  type        = string
}

variable "instance_suffix" {
  description = "同時に複数マシンタイプを試す際にインスタンス名を衝突させないためのsuffix"
  type        = string
  default     = "test"
}

variable "spot" {
  description = "SpotVM(旧プリエンプティブル)を使うかどうか"
  type        = bool
  default     = true
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_service_account" "recorder" {
  account_id   = "th07-recorder-vm"
  display_name = "th07 recorder GCE worker"
}

resource "google_storage_bucket_iam_member" "recorder_output_writer" {
  bucket = replace(var.output_bucket, "gs://", "")
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.recorder.email}"
}

resource "google_artifact_registry_repository_iam_member" "recorder_ar_reader" {
  project    = var.project_id
  location   = var.region
  repository = "touhou-recorder"
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.recorder.email}"
}

resource "google_compute_instance" "recorder" {
  name         = "th07-recorder-${var.instance_suffix}"
  machine_type = var.machine_type
  zone         = var.zone

  boot_disk {
    initialize_params {
      image = "cos-cloud/cos-stable"
      size  = 30
      type  = "pd-balanced"
    }
  }

  network_interface {
    network = "default"
    access_config {}
  }

  service_account {
    email  = google_service_account.recorder.email
    scopes = ["cloud-platform"]
  }

  # SpotVMは強制終了時にVMを削除する(再起動での二重課金・ゾンビ化防止)
  scheduling {
    provisioning_model = var.spot ? "SPOT" : "STANDARD"
    preemptible         = var.spot
    automatic_restart   = !var.spot
    instance_termination_action = var.spot ? "DELETE" : null
  }

  metadata = {
    # gce-container-declaration(Konlet)はコンテナ終了後もVMを起動したままにする
    # ため、課金を確実に止められるようstartup-scriptで直接dockerを実行し、
    # 完了後に自分自身をpoweroffする方式にする(コスト計測の正確性のため)。
    startup-script = <<-EOT
      #! /bin/bash
      # execでリダイレクトすると出力がシリアルコンソールに一切出なくなるため、
      # ここでは何もリダイレクトせずcron/journalの標準出力(=シリアルコンソール)
      # にそのまま流す(get-serial-port-outputで進捗を追えるようにするため)。
      set -x
      echo "start: $(date -Is)"
      # COSはルートファイルシステムが読み取り専用のため$HOME=/rootに書き込めない。
      # docker-credential-gcr/dockerの設定先を書き込み可能なパスに変更する。
      export HOME=/tmp/home
      mkdir -p "$HOME"
      docker-credential-gcr configure-docker --registries=asia-northeast1-docker.pkg.dev
      echo "docker-credential-gcr configure exit code: $?"
      docker run --rm \
        -e OUTPUT_BUCKET="${var.output_bucket}" \
        -e REPLAY_FILE="th7_07.rpy" \
        -e RUN_ID="gce-${var.machine_type}-${var.instance_suffix}" \
        "${var.image}"
      echo "docker run exit code: $?"
      echo "end: $(date -Is)"
      sleep 90
      poweroff
    EOT
  }

  labels = {
    container-vm = "cos-stable"
  }
}

output "instance_name" {
  value = google_compute_instance.recorder.name
}
