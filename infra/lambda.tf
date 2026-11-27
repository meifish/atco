# Comparison worker: SQS -> Lambda, one job per invocation. Runs outside the VPC,
# so it reaches S3, DynamoDB and SQS directly and never uses the NAT instance.
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "compare" {
  name               = "${var.name}-compare"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_cloudwatch_log_group" "compare" {
  name              = "/aws/lambda/${var.name}-compare"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "compare" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.compare.arn}:*"]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.files.arn}/users/*"]
  }
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.state.arn]
  }
  statement {
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.jobs.arn]
  }
}

resource "aws_iam_role_policy" "compare" {
  role   = aws_iam_role.compare.id
  policy = data.aws_iam_policy_document.compare.json
}

resource "aws_lambda_function" "compare" {
  function_name = "${var.name}-compare"
  role          = aws_iam_role.compare.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.compare.repository_url}:${var.image_tag}"
  architectures = ["arm64"]
  memory_size   = var.compare_memory_mb
  timeout       = var.compare_timeout_seconds
  ephemeral_storage { size = 1024 }

  environment {
    variables = {
      ATCO_TABLE  = aws_dynamodb_table.state.name
      ATCO_BUCKET = aws_s3_bucket.files.bucket
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.compare.name
  }
}

resource "aws_lambda_event_source_mapping" "compare" {
  event_source_arn = aws_sqs_queue.jobs.arn
  function_name    = aws_lambda_function.compare.arn
  batch_size       = 1
  scaling_config { maximum_concurrency = max(2, var.compare_max_concurrency) }
}
