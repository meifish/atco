output "site_url" {
  description = "Open this with Tailscale connected"
  value       = local.site_url
}

output "web_repository_url" { value = aws_ecr_repository.web.repository_url }
output "compare_repository_url" { value = aws_ecr_repository.compare.repository_url }
output "cognito_user_pool_id" { value = aws_cognito_user_pool.main.id }
output "cognito_client_id" { value = aws_cognito_user_pool_client.web.id }
output "cognito_login_domain" { value = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com" }
output "files_bucket" { value = aws_s3_bucket.files.bucket }
output "state_table" { value = aws_dynamodb_table.state.name }
output "jobs_queue_url" { value = aws_sqs_queue.jobs.url }
output "jobs_dead_letter_queue_url" { value = aws_sqs_queue.jobs_dlq.url }
output "vpc_cidr" { value = var.vpc_cidr }
