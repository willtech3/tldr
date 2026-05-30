# Lambda execution role. CDK created this implicitly; in Terraform we declare it
# explicitly and attach the AWS-managed basic execution policy (CloudWatch Logs
# CreateLogStream/PutLogEvents), then add a least-privilege inline policy for the
# SSM parameter reads.

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.function_name}-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# CDK added one PolicyStatement per parameter (all ssm:GetParameter). Collapsing
# them into a single statement with three resource ARNs is functionally identical
# and reads more cleanly.
data "aws_iam_policy_document" "ssm_parameter_read" {
  statement {
    sid       = "ReadConfiguredSsmParameters"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = local.ssm_parameter_arns
  }
}

resource "aws_iam_role_policy" "ssm_parameter_read" {
  name   = "ssm-parameter-read"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.ssm_parameter_read.json
}
