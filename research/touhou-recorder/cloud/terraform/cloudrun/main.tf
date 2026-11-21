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

variable "image" {
  description = "Artifact Registryにpush済みの録画ワーカーイメージ"
  type        = string
}

variable "output_bucket" {
  default = "gs://touhou-recorder-output"
}

variable "cpu" {
  description = "vCPU数(Cloud Run Jobsは常時CPU割り当てなのでジョブの実処理時間に直結する)"
  default     = "4"
}

variable "memory" {
  default = "4Gi"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_service_account" "recorder" {
  account_id   = "th07-recorder-job"
  display_name = "th07 recorder Cloud Run Job"
}

resource "google_storage_bucket_iam_member" "recorder_output_writer" {
  bucket = replace(var.output_bucket, "gs://", "")
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.recorder.email}"
}

resource "google_cloud_run_v2_job" "th07_recorder" {
  name                = "th07-recorder"
  location            = var.region
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.recorder.email
      timeout         = "3600s"
      max_retries     = 0

      containers {
        image = var.image
        resources {
          limits = {
            cpu    = var.cpu
            memory = var.memory
          }
        }
        env {
          name  = "OUTPUT_BUCKET"
          value = var.output_bucket
        }
        env {
          name  = "REPLAY_FILE"
          value = "th7_07.rpy"
        }
      }
    }
  }
}

output "job_name" {
  value = google_cloud_run_v2_job.th07_recorder.name
}
