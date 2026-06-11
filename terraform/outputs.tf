# aws_api_gateway_stage.invoke_url has NO trailing slash, e.g.
# https://abc123.execute-api.us-east-2.amazonaws.com/prod

# Mirrors CDK's ApiUrl (api.url), which includes a trailing slash.
output "api_url" {
  description = "Base invoke URL of the prod stage (with trailing slash)."
  value       = "${aws_api_gateway_stage.prod.invoke_url}/"
}

# Mirrors CDK's ApiGatewayUrl (api.url with the trailing slash stripped). This is
# the value to paste into the Slack app manifest; CI prints it after apply.
output "api_gateway_url" {
  description = "API Gateway URL for the Slack app manifest (no trailing slash)."
  value       = aws_api_gateway_stage.prod.invoke_url
}

output "lambda_function_name" {
  description = "Name of the deployed Lambda function."
  value       = aws_lambda_function.tldr.function_name
}

output "lambda_function_arn" {
  description = "ARN of the deployed Lambda function."
  value       = aws_lambda_function.tldr.arn
}
