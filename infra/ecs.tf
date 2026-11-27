# FastAPI web service on Fargate in the private subnets. No ALB: users reach it
# through the Tailscale router, which proxies to web.<name>.internal (Cloud Map).
resource "aws_ecs_cluster" "main" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${var.name}-web"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "web_execution" {
  name               = "${var.name}-web-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "web_execution" {
  role       = aws_iam_role.web_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "web_task" {
  name               = "${var.name}-web-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "web_task" {
  statement {
    sid       = "UserFiles"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.files.arn}/users/*"]
  }
  statement {
    sid       = "ListUserFilesForLogout"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.files.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["users/*"]
    }
  }
  statement {
    sid = "JobState"
    actions = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
    "dynamodb:Query", "dynamodb:BatchWriteItem"]
    resources = [aws_dynamodb_table.state.arn]
  }
  statement {
    sid       = "SendJobs"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.jobs.arn]
  }
}

resource "aws_iam_role_policy" "web_task" {
  role   = aws_iam_role.web_task.id
  policy = data.aws_iam_policy_document.web_task.json
}

resource "aws_security_group" "web" {
  name        = "${var.name}-web"
  description = "ECS web tasks; reachable only from inside the VPC (the Tailscale router)"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP from the router and subnet-routed Tailscale clients"
    from_port   = local.web_port
    to_port     = local.web_port
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web_cpu
  memory                   = var.web_memory
  execution_role_arn       = aws_iam_role.web_execution.arn
  task_role_arn            = aws_iam_role.web_task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name         = "web"
    image        = "${aws_ecr_repository.web.repository_url}:${var.image_tag}"
    essential    = true
    portMappings = [{ containerPort = local.web_port, protocol = "tcp" }]
    environment = [
      { name = "REDLINE_MODE", value = "aws" },
      { name = "AWS_REGION", value = var.region },
      { name = "REDLINE_BUCKET", value = aws_s3_bucket.files.bucket },
      { name = "REDLINE_TABLE", value = aws_dynamodb_table.state.name },
      { name = "REDLINE_QUEUE_URL", value = aws_sqs_queue.jobs.url },
      { name = "REDLINE_COGNITO_USER_POOL_ID", value = aws_cognito_user_pool.main.id },
      { name = "REDLINE_COGNITO_CLIENT_ID", value = aws_cognito_user_pool_client.web.id },
      { name = "REDLINE_COGNITO_DOMAIN", value = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com" },
      { name = "REDLINE_SITE_URL", value = local.site_url },
      { name = "REDLINE_JOB_STALE_SECONDS", value = tostring(local.stale_after) },
    ]
    healthCheck = {
      command     = ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${local.web_port}/healthz', timeout=3)"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.web.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "web"
      }
    }
  }])
}

resource "aws_ecs_service" "web" {
  name                               = "${var.name}-web"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.web.arn
  desired_count                      = var.web_desired_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200
  enable_execute_command             = false

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.web.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.web.arn
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Tasks pull images through the NAT instance, so it must exist first.
  depends_on = [aws_autoscaling_group.router]
}
