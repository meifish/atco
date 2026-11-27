# One small EC2 instance is both the Tailscale subnet router and the NAT for the
# private subnets (fck-nat style). It has the only public IPv4 in the system and
# accepts no inbound connections from the internet: Tailscale dials out.
# An Auto Scaling Group (min = max = 1) replaces it if it fails; expect a few
# minutes of downtime. To move to a NAT Gateway later, point the private route
# table's 0.0.0.0/0 at the gateway; the application does not change.
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_security_group" "router" {
  name        = "${var.name}-router"
  description = "Tailscale subnet router and NAT instance"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "NAT and replies from the VPC"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  dynamic "ingress" {
    for_each = var.allow_tailscale_direct_udp ? [1] : []
    content {
      description = "Tailscale direct connections"
      from_port   = 41641
      to_port     = 41641
      protocol    = "udp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "router" {
  name               = "${var.name}-router"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

# Session Manager instead of SSH, for maintenance.
resource "aws_iam_role_policy_attachment" "router_ssm" {
  role       = aws_iam_role.router.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "router" {
  statement {
    sid       = "TakeOverDefaultRoute"
    actions   = ["ec2:ReplaceRoute", "ec2:CreateRoute"]
    resources = ["arn:aws:ec2:${var.region}:${local.account_id}:route-table/${aws_route_table.private.id}"]
  }
  statement {
    sid       = "DisableSourceDestCheckOnSelf"
    actions   = ["ec2:ModifyInstanceAttribute"]
    resources = ["arn:aws:ec2:${var.region}:${local.account_id}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/app-role"
      values   = ["router"]
    }
  }
  statement {
    sid       = "ReadTailscaleAuthKey"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.region}:${local.account_id}:parameter/${trimprefix(var.tailscale_auth_key_parameter, "/")}"]
  }
}

resource "aws_iam_role_policy" "router" {
  role   = aws_iam_role.router.id
  policy = data.aws_iam_policy_document.router.json
}

resource "aws_iam_instance_profile" "router" {
  name = "${var.name}-router"
  role = aws_iam_role.router.name
}

resource "aws_launch_template" "router" {
  name_prefix   = "${var.name}-router-"
  image_id      = data.aws_ssm_parameter.al2023_arm64.value
  instance_type = var.router_instance_type
  user_data = base64encode(templatefile("${path.module}/router-user-data.sh.tftpl", {
    region             = var.region
    vpc_cidr           = var.vpc_cidr
    route_table_id     = aws_route_table.private.id
    auth_key_parameter = var.tailscale_auth_key_parameter
    tailscale_hostname = var.tailscale_hostname
    tailscale_tag      = var.tailscale_tag
    web_target         = "http://${local.web_dns}:${local.web_port}"
  }))

  iam_instance_profile { arn = aws_iam_instance_profile.router.arn }

  network_interfaces {
    associate_public_ip_address = true
    security_groups             = [aws_security_group.router.id]
    delete_on_termination       = true
  }

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size = 8
      volume_type = "gp3"
      encrypted   = true
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.name}-router", "app-role" = "router" }
  }
}

resource "aws_autoscaling_group" "router" {
  name                      = "${var.name}-router"
  min_size                  = 1
  max_size                  = 1
  desired_capacity          = 1
  vpc_zone_identifier       = aws_subnet.public[*].id
  health_check_type         = "EC2"
  health_check_grace_period = 120

  launch_template {
    id      = aws_launch_template.router.id
    version = aws_launch_template.router.latest_version
  }

  instance_refresh {
    strategy = "Rolling"
    preferences { min_healthy_percentage = 0 }
  }
}
