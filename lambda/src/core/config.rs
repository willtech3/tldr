use std::env;
use tokio::sync::OnceCell;

use crate::slack::client::STREAM_MARKDOWN_TEXT_LIMIT;

static APP_CONFIG_CACHE: OnceCell<AppConfig> = OnceCell::const_new();

/// Default chunk size for streaming appends. Set below the Slack limit to allow
/// headroom for prefix text and to balance latency vs. API call frequency.
const DEFAULT_STREAM_MAX_CHUNK_CHARS: usize = 4_000;

/// Default minimum interval between `chat.appendStream` calls (milliseconds).
/// Prevents overwhelming Slack's rate limits while still providing responsive streaming.
const DEFAULT_STREAM_MIN_APPEND_INTERVAL_MS: u64 = 1_000;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub processing_queue_url: String,
    pub slack_signing_secret: String,
    pub slack_bot_token: String,
    pub openai_api_key: String,
    pub openai_org_id: Option<String>,
    pub openai_model: Option<String>,
    pub enable_streaming: bool,
    pub stream_max_chunk_chars: usize,
    pub stream_min_append_interval_ms: u64,
}

impl AppConfig {
    fn env_bool(name: &str) -> bool {
        match env::var(name) {
            Ok(val) => matches!(
                val.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "y" | "on"
            ),
            Err(_) => false,
        }
    }

    fn env_usize(name: &str) -> Result<Option<usize>, String> {
        let Ok(raw) = env::var(name) else {
            return Ok(None);
        };

        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }

        trimmed
            .parse::<usize>()
            .map(Some)
            .map_err(|e| format!("{name}: {e}"))
    }

    fn env_u64(name: &str) -> Result<Option<u64>, String> {
        let Ok(raw) = env::var(name) else {
            return Ok(None);
        };

        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }

        trimmed
            .parse::<u64>()
            .map(Some)
            .map_err(|e| format!("{name}: {e}"))
    }

    async fn read_sensitive_config(
        env_name: &str,
        parameter_env_name: &str,
        aws_config: Option<&aws_config::SdkConfig>,
    ) -> Result<String, String> {
        if let Ok(parameter_name) = env::var(parameter_env_name) {
            let parameter_name = parameter_name.trim().to_string();
            if !parameter_name.is_empty() {
                let sdk_config = aws_config.ok_or_else(|| {
                    format!("{parameter_env_name} is set but AWS config is unavailable")
                })?;
                let client = aws_sdk_ssm::Client::new(sdk_config);
                let response = client
                    .get_parameter()
                    .name(&parameter_name)
                    .with_decryption(true)
                    .send()
                    .await
                    .map_err(|e| {
                        format!("{parameter_env_name}: failed to read SSM parameter: {e}")
                    })?;

                return response
                    .parameter()
                    .and_then(|parameter| parameter.value())
                    .filter(|value| !value.is_empty())
                    .map(std::string::ToString::to_string)
                    .ok_or_else(|| format!("{parameter_env_name}: SSM parameter had no value"));
            }
        }

        env::var(env_name).map_err(|e| format!("{env_name}: {e}"))
    }

    async fn read_optional_sensitive_config(
        env_name: &str,
        parameter_env_name: &str,
        aws_config: Option<&aws_config::SdkConfig>,
    ) -> Result<Option<String>, String> {
        match Self::read_sensitive_config(env_name, parameter_env_name, aws_config).await {
            Ok(value) => Ok(Some(value)),
            Err(err) if err.starts_with(&format!("{env_name}: ")) => Ok(None),
            Err(err) => Err(err),
        }
    }

    fn any_parameter_names_present() -> bool {
        [
            "SLACK_BOT_TOKEN_PARAMETER_NAME",
            "SLACK_SIGNING_SECRET_PARAMETER_NAME",
            "OPENAI_API_KEY_PARAMETER_NAME",
            "OPENAI_ORG_ID_PARAMETER_NAME",
        ]
        .iter()
        .any(|name| env::var(name).is_ok_and(|value| !value.trim().is_empty()))
    }

    /// # Errors
    ///
    /// Returns an error string when required environment variables are missing.
    pub async fn from_env() -> Result<Self, String> {
        let enable_streaming = Self::env_bool("ENABLE_STREAMING");
        let stream_max_chunk_chars =
            Self::env_usize("STREAM_MAX_CHUNK_CHARS")?.unwrap_or(DEFAULT_STREAM_MAX_CHUNK_CHARS);
        if stream_max_chunk_chars == 0 || stream_max_chunk_chars > STREAM_MARKDOWN_TEXT_LIMIT {
            return Err(format!(
                "STREAM_MAX_CHUNK_CHARS must be between 1 and {STREAM_MARKDOWN_TEXT_LIMIT}"
            ));
        }

        let stream_min_append_interval_ms = Self::env_u64("STREAM_MIN_APPEND_INTERVAL_MS")?
            .unwrap_or(DEFAULT_STREAM_MIN_APPEND_INTERVAL_MS);

        let shared_aws_config = if Self::any_parameter_names_present() {
            Some(aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await)
        } else {
            None
        };

        Ok(Self {
            processing_queue_url: env::var("PROCESSING_QUEUE_URL")
                .map_err(|e| format!("PROCESSING_QUEUE_URL: {e}"))?,
            slack_signing_secret: Self::read_sensitive_config(
                "SLACK_SIGNING_SECRET",
                "SLACK_SIGNING_SECRET_PARAMETER_NAME",
                shared_aws_config.as_ref(),
            )
            .await?,
            slack_bot_token: Self::read_sensitive_config(
                "SLACK_BOT_TOKEN",
                "SLACK_BOT_TOKEN_PARAMETER_NAME",
                shared_aws_config.as_ref(),
            )
            .await?,
            openai_api_key: Self::read_sensitive_config(
                "OPENAI_API_KEY",
                "OPENAI_API_KEY_PARAMETER_NAME",
                shared_aws_config.as_ref(),
            )
            .await?,
            openai_org_id: Self::read_optional_sensitive_config(
                "OPENAI_ORG_ID",
                "OPENAI_ORG_ID_PARAMETER_NAME",
                shared_aws_config.as_ref(),
            )
            .await?,
            openai_model: env::var("OPENAI_MODEL").ok(),
            enable_streaming,
            stream_max_chunk_chars,
            stream_min_append_interval_ms,
        })
    }

    /// Retrieves the loaded configuration, caching it after the first successful load.
    ///
    /// # Errors
    ///
    /// Returns an error string when required environment variables are missing.
    pub async fn from_env_cached() -> Result<&'static Self, String> {
        APP_CONFIG_CACHE
            .get_or_try_init(|| async { Self::from_env().await })
            .await
    }
}
