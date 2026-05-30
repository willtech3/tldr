terraform {
  # 1.10 introduced native S3 state locking (use_lockfile), which lets us drop
  # the DynamoDB lock table CDK never needed (CloudFormation locked server-side).
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    # Zips bolt-ts/bundle into the Lambda deployment package at plan time,
    # replacing CDK's lambda.Code.fromAsset(...) asset bundling.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Remote state replaces the implicit, server-side state CloudFormation kept for
  # CDK. Without it, each CI run would start with empty state and try to recreate
  # the whole stack. Configuration is supplied at `terraform init` time via
  # -backend-config (see .github/workflows/deploy.yml and README), so the bucket
  # name is not committed here. Run `terraform init -backend=false` for offline
  # validation (fmt/validate) when you don't need state.
  backend "s3" {}
}

provider "aws" {
  region = var.region

  # Mirrors CDK's pinned `env.account`: refuse to apply against an unexpected
  # account so a misconfigured credential can't deploy into the wrong place.
  # Leave aws_account_id unset ("") to disable the guard.
  allowed_account_ids = var.aws_account_id == "" ? null : [var.aws_account_id]

  default_tags {
    tags = {
      Project   = "tldr"
      ManagedBy = "terraform"
    }
  }
}
