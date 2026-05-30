# REST API. Endpoint type defaults to EDGE, matching CDK's RestApi default.
resource "aws_api_gateway_rest_api" "tldr" {
  name        = "Tldr API"
  description = "API for Tldr Slack bot integration"
}

# Resource tree: /slack, /slack/interactive, /slack/events
resource "aws_api_gateway_resource" "slack" {
  rest_api_id = aws_api_gateway_rest_api.tldr.id
  parent_id   = aws_api_gateway_rest_api.tldr.root_resource_id
  path_part   = "slack"
}

resource "aws_api_gateway_resource" "interactive" {
  rest_api_id = aws_api_gateway_rest_api.tldr.id
  parent_id   = aws_api_gateway_resource.slack.id
  path_part   = "interactive"
}

resource "aws_api_gateway_resource" "events" {
  rest_api_id = aws_api_gateway_rest_api.tldr.id
  parent_id   = aws_api_gateway_resource.slack.id
  path_part   = "events"
}

# POST methods. authorization = NONE because Slack authenticates via request
# signing, which Bolt verifies inside the Lambda (not at the API Gateway layer).
resource "aws_api_gateway_method" "interactive_post" {
  rest_api_id   = aws_api_gateway_rest_api.tldr.id
  resource_id   = aws_api_gateway_resource.interactive.id
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_method" "events_post" {
  rest_api_id   = aws_api_gateway_rest_api.tldr.id
  resource_id   = aws_api_gateway_resource.events.id
  http_method   = "POST"
  authorization = "NONE"
}

# AWS_PROXY (Lambda proxy) integrations — the Terraform equivalent of CDK's
# LambdaIntegration. integration_http_method is always POST for Lambda proxy,
# regardless of the client-facing method.
resource "aws_api_gateway_integration" "interactive" {
  rest_api_id             = aws_api_gateway_rest_api.tldr.id
  resource_id             = aws_api_gateway_resource.interactive.id
  http_method             = aws_api_gateway_method.interactive_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.tldr.invoke_arn
}

resource "aws_api_gateway_integration" "events" {
  rest_api_id             = aws_api_gateway_rest_api.tldr.id
  resource_id             = aws_api_gateway_resource.events.id
  http_method             = aws_api_gateway_method.events_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.tldr.invoke_arn
}

# Allow API Gateway to invoke the Lambda. CDK generated one permission per
# method; a single statement scoped to this API's execution ARN (any stage, any
# method/path) is the idiomatic Terraform equivalent and stays restricted to
# this API.
resource "aws_lambda_permission" "api_gateway_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.tldr.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.tldr.execution_arn}/*/*"
}

# Deployment snapshot. The triggers hash forces a new deployment whenever the
# routing surface changes; without it, edits to resources/methods/integrations
# would not propagate to the stage.
resource "aws_api_gateway_deployment" "tldr" {
  rest_api_id = aws_api_gateway_rest_api.tldr.id

  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_resource.slack.id,
      aws_api_gateway_resource.interactive.id,
      aws_api_gateway_resource.events.id,
      aws_api_gateway_method.interactive_post.id,
      aws_api_gateway_method.events_post.id,
      aws_api_gateway_integration.interactive.id,
      aws_api_gateway_integration.events.id,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

# The "prod" stage. depends_on the account-level CloudWatch role so that enabling
# INFO logging (below) doesn't fail with "CloudWatch Logs role ARN must be set".
resource "aws_api_gateway_stage" "prod" {
  rest_api_id   = aws_api_gateway_rest_api.tldr.id
  deployment_id = aws_api_gateway_deployment.tldr.id
  stage_name    = "prod"

  depends_on = [aws_api_gateway_account.this]
}

# Stage-level method settings, mirroring CDK deployOptions: INFO access logging,
# CloudWatch metrics on, and data tracing OFF (request/response bodies carry
# workspace data and Slack signature material and must never be logged).
resource "aws_api_gateway_method_settings" "prod" {
  rest_api_id = aws_api_gateway_rest_api.tldr.id
  stage_name  = aws_api_gateway_stage.prod.stage_name
  method_path = "*/*"

  settings {
    logging_level      = "INFO"
    data_trace_enabled = false
    metrics_enabled    = true
  }
}

# ---------------------------------------------------------------------------
# Account-level API Gateway CloudWatch Logs role.
#
# API Gateway can only emit execution/access logs if the ACCOUNT has a CloudWatch
# Logs role configured (a single, region-wide setting). CDK created this because
# stage logging is enabled. Gated behind var.manage_api_gateway_account so a
# multi-stack account doesn't end up with two configs fighting over it.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "apigw_cloudwatch_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["apigateway.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apigw_cloudwatch" {
  count              = var.manage_api_gateway_account ? 1 : 0
  name               = "tldr-apigateway-cloudwatch"
  assume_role_policy = data.aws_iam_policy_document.apigw_cloudwatch_assume_role.json
}

resource "aws_iam_role_policy_attachment" "apigw_cloudwatch" {
  count      = var.manage_api_gateway_account ? 1 : 0
  role       = aws_iam_role.apigw_cloudwatch[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"
}

resource "aws_api_gateway_account" "this" {
  count               = var.manage_api_gateway_account ? 1 : 0
  cloudwatch_role_arn = aws_iam_role.apigw_cloudwatch[0].arn

  depends_on = [aws_iam_role_policy_attachment.apigw_cloudwatch]
}
