# ---------------------------------------------------------------------------
# Deployment target
# ---------------------------------------------------------------------------

variable "region" {
  description = "AWS region to deploy into. Matches the CI AWS_REGION and the CDK app default."
  type        = string
  default     = "us-east-2"
}

variable "aws_account_id" {
  description = "Optional. If set, the provider refuses to apply against any other account (mirrors CDK's pinned env.account)."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Lambda runtime sizing
# ---------------------------------------------------------------------------

variable "function_name" {
  description = "Name of the Lambda function (also the CloudWatch log group suffix)."
  type        = string
  default     = "tldr-bolt"
}

variable "lambda_memory_size" {
  description = "Lambda memory in MB. 1 GB leaves headroom for inline images."
  type        = number
  default     = 1024
}

variable "lambda_timeout" {
  description = "Lambda timeout in seconds. 15 min matches the max Slack streaming session length."
  type        = number
  default     = 900
}

variable "log_retention_days" {
  description = "CloudWatch log retention for the Lambda log group."
  type        = number
  default     = 7
}

# ---------------------------------------------------------------------------
# Runtime configuration (becomes the Lambda's environment variables).
# Required parameter names point at SSM SecureString parameters; the Lambda
# resolves the actual secret values at cold start. Optional values are passed
# as "" to omit them, faithfully reproducing the CDK conditional-spread logic.
# ---------------------------------------------------------------------------

variable "slack_bot_token_parameter_name" {
  description = "SSM SecureString parameter name holding the Slack bot OAuth token."
  type        = string
  default     = "/tldr/slack/bot-token"
}

variable "slack_signing_secret_parameter_name" {
  description = "SSM SecureString parameter name holding the Slack signing secret."
  type        = string
  default     = "/tldr/slack/signing-secret"
}

variable "anthropic_api_key_parameter_name" {
  description = "SSM SecureString parameter name holding the Anthropic API key."
  type        = string
  default     = "/tldr/anthropic/api-key"
}

variable "anthropic_model" {
  description = "Optional Anthropic model override. Empty string omits the env var (Lambda defaults to claude-sonnet-4-6)."
  type        = string
  default     = ""
}

variable "anthropic_max_output_tokens" {
  description = "Optional max output token cap. Empty string omits the env var (Lambda default 16000, cap 64000)."
  type        = string
  default     = ""
}

variable "enable_streaming" {
  description = "'true' to stream summaries into the assistant thread via Slack chat.*Stream APIs."
  type        = string
  default     = "true"
}

variable "stream_min_append_interval_ms" {
  description = "Optional floor between chat.appendStream calls (ms). Empty string omits the env var (default 500)."
  type        = string
  default     = ""
}

variable "stream_max_chunk_chars" {
  description = "Optional per-append chunk size. Empty string omits the env var (default 8000, max 12000)."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# API Gateway
# ---------------------------------------------------------------------------

variable "manage_api_gateway_account" {
  description = <<-EOT
    Whether to manage the account-level API Gateway CloudWatch Logs role and
    settings. CDK created these because stage logging is set to INFO. This is an
    ACCOUNT-GLOBAL, REGION-WIDE setting shared by every REST API in the account;
    set to false if another stack/Terraform config already owns it (otherwise
    the two will fight over aws_api_gateway_account).
  EOT
  type        = bool
  default     = true
}
