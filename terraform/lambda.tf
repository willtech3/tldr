# Explicit log group with 1-week retention. Creating it ourselves (rather than
# letting Lambda lazily create an unbounded one on first invocation) is the
# Terraform equivalent of CDK's explicit LogGroup + RemovalPolicy.DESTROY. The
# name matches Lambda's default convention (/aws/lambda/<function-name>) so the
# function logs here without any extra wiring; the depends_on below guarantees
# this group wins the create race against Lambda's implicit one.
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = var.log_retention_days
}

# Zips bolt-ts/bundle/ into a deployment package. This runs at plan/apply time,
# so the bundle must already exist (`npm run bundle` in bolt-ts/). It is NOT read
# during `terraform validate`, which keeps offline validation bundle-free.
data "archive_file" "lambda_bundle" {
  type        = "zip"
  source_dir  = local.bundle_dir
  output_path = "${path.module}/.terraform-artifacts/${var.function_name}.zip"
}

# Single Lambda hosting both the Slack signal layer and the inline summarisation
# worker.
resource "aws_lambda_function" "tldr" {
  function_name = var.function_name
  role          = aws_iam_role.lambda.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  memory_size   = var.lambda_memory_size
  timeout       = var.lambda_timeout

  filename         = data.archive_file.lambda_bundle.output_path
  source_code_hash = data.archive_file.lambda_bundle.output_base64sha256

  environment {
    variables = local.lambda_environment
  }

  # Ensure the log group and logging permissions exist before the function, so
  # the first invocation logs into our retention-managed group.
  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy_attachment.lambda_basic_execution,
  ]
}
