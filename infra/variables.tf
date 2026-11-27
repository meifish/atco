variable "region" {
  description = "AWS region, e.g. ca-central-1"
  type        = string
}

variable "name" {
  description = "Prefix for resource names"
  type        = string
  default     = "redline-diff"
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

# ---- Tailscale -------------------------------------------------------------
variable "tailnet_dns_name" {
  description = "Your tailnet's MagicDNS suffix, e.g. tail1234.ts.net (Tailscale admin > DNS)"
  type        = string
}

variable "tailscale_hostname" {
  description = "Machine name of the router; the site becomes https://<this>.<tailnet_dns_name>"
  type        = string
  default     = "redline-diff"
}

variable "tailscale_auth_key_parameter" {
  description = "SSM Parameter Store name of a SecureString holding a reusable, ephemeral, pre-approved, tagged Tailscale auth key"
  type        = string
  default     = "/redline-diff/tailscale-auth-key"
}

variable "tailscale_tag" {
  description = "Tag the auth key assigns to the router (must exist in the tailnet policy's tagOwners)"
  type        = string
  default     = "tag:redline-diff-router"
}

variable "router_instance_type" {
  type    = string
  default = "t4g.micro"
}

variable "allow_tailscale_direct_udp" {
  description = "Open UDP 41641 inbound for direct Tailscale connections. Usually unnecessary: AWS public IPs are 1:1 NAT, so hole punching works with no open ports."
  type        = bool
  default     = false
}

# ---- Application -----------------------------------------------------------
variable "image_tag" {
  description = "Tag of the web and compare images in ECR (scripts/push-images.sh prints it)"
  type        = string
}

variable "web_desired_count" {
  description = "Web containers. 1 saves about US$9/month but deploys briefly interrupt the site."
  type        = number
  default     = 2
}

variable "web_cpu" {
  type    = number
  default = 256
}

variable "web_memory" {
  type    = number
  default = 512
}

variable "compare_memory_mb" {
  description = "Comparison Lambda memory (max 10240). Measure with the largest drawings and adjust."
  type        = number
  default     = 3008
}

variable "compare_timeout_seconds" {
  description = "Comparison Lambda timeout (max 900)"
  type        = number
  default     = 900
}

variable "compare_max_concurrency" {
  description = "How many comparisons may run at the same time"
  type        = number
  default     = 10
}

# ---- Cognito ---------------------------------------------------------------
variable "cognito_domain_prefix" {
  description = "Globally unique prefix for the Cognito hosted login page"
  type        = string
}

variable "log_retention_days" {
  type    = number
  default = 14
}
