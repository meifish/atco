# Offline plan with a mocked AWS provider: `terraform test` (no credentials needed).
mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["ca-central-1a", "ca-central-1b", "ca-central-1d"] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

variables {
  region                = "ca-central-1"
  tailnet_dns_name      = "tail1234.ts.net"
  cognito_domain_prefix = "atco-login-test"
  image_tag             = "test"
}

run "plan" {
  command = plan

  assert {
    condition     = local.site_url == "https://inceptionai.tail1234.ts.net"
    error_message = "site URL should be the router's tailscale serve name"
  }
  assert {
    condition     = aws_sqs_queue.jobs.visibility_timeout_seconds == 5400
    error_message = "SQS visibility timeout must be 6x the Lambda timeout"
  }
  assert {
    condition     = aws_ecs_service.web.network_configuration[0].assign_public_ip == false
    error_message = "web tasks must not get public IPs"
  }
  assert {
    condition     = aws_cognito_user_pool_client.web.refresh_token_validity == 12
    error_message = "refresh token cap is 12 hours"
  }
  assert {
    condition     = length(aws_security_group.router.ingress) == 1
    error_message = "router accepts nothing from the internet by default"
  }
}
