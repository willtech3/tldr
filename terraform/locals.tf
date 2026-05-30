data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  # Path to the esbuild output that `npm run bundle` produces in bolt-ts/.
  bundle_dir = "${path.module}/../bolt-ts/bundle"

  # The three SSM SecureString parameters the Lambda may read at cold start.
  ssm_parameter_names = [
    var.slack_bot_token_parameter_name,
    var.slack_signing_secret_parameter_name,
    var.anthropic_api_key_parameter_name,
  ]

  # Build each parameter ARN the same way CDK's Stack.formatArn did: strip the
  # leading slash from the parameter name, since the ARN's "parameter/" prefix
  # supplies it (e.g. "/tldr/slack/bot-token" -> ".../parameter/tldr/slack/bot-token").
  ssm_parameter_arns = [
    for name in local.ssm_parameter_names :
    "arn:${data.aws_partition.current.partition}:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/${trimprefix(name, "/")}"
  ]

  # Reproduces the CDK conditional-spread: required vars are always present;
  # optional vars are included only when set to a non-empty string.
  lambda_environment = merge(
    {
      SLACK_BOT_TOKEN_PARAMETER_NAME      = var.slack_bot_token_parameter_name
      SLACK_SIGNING_SECRET_PARAMETER_NAME = var.slack_signing_secret_parameter_name
      ANTHROPIC_API_KEY_PARAMETER_NAME    = var.anthropic_api_key_parameter_name
      ENABLE_STREAMING                    = var.enable_streaming
      NODE_OPTIONS                        = "--enable-source-maps"
    },
    var.anthropic_model != "" ? { ANTHROPIC_MODEL = var.anthropic_model } : {},
    var.anthropic_max_output_tokens != "" ? { ANTHROPIC_MAX_OUTPUT_TOKENS = var.anthropic_max_output_tokens } : {},
    var.stream_min_append_interval_ms != "" ? { STREAM_MIN_APPEND_INTERVAL_MS = var.stream_min_append_interval_ms } : {},
    var.stream_max_chunk_chars != "" ? { STREAM_MAX_CHUNK_CHARS = var.stream_max_chunk_chars } : {},
  )
}
