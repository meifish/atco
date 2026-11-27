terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.80, < 7"
    }
  }

  # Keep state in S3 once more than one person runs Terraform, e.g.:
  # backend "s3" {
  #   bucket       = "my-terraform-state"
  #   key          = "atco/terraform.tfstate"
  #   region       = "ca-central-1"
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = var.name }
  }
}

data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" { state = "available" }

locals {
  site_url    = "https://${var.tailscale_hostname}.${var.tailnet_dns_name}"
  azs         = slice(data.aws_availability_zones.available.names, 0, 2)
  web_dns     = "web.${var.name}.internal"
  web_port    = 8000
  account_id  = data.aws_caller_identity.current.account_id
  visibility  = var.compare_timeout_seconds * 6 # AWS guidance: at least 6x the function timeout
  stale_after = var.compare_timeout_seconds + 60
}
