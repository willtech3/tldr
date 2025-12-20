use std::env;

const STREAM_MARKDOWN_TEXT_LIMIT: usize = 12_000;
const DEFAULT_STREAM_MAX_CHUNK_CHARS: usize = 4_000;
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

    /// # Errors
    ///
    /// Returns an error string when required environment variables are missing.
    pub fn from_env() -> Result<Self, String> {
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

        Ok(Self {
            processing_queue_url: env::var("PROCESSING_QUEUE_URL")
                .map_err(|e| format!("PROCESSING_QUEUE_URL: {e}"))?,
            slack_signing_secret: env::var("SLACK_SIGNING_SECRET")
                .map_err(|e| format!("SLACK_SIGNING_SECRET: {e}"))?,
            slack_bot_token: env::var("SLACK_BOT_TOKEN")
                .map_err(|e| format!("SLACK_BOT_TOKEN: {e}"))?,
            openai_api_key: env::var("OPENAI_API_KEY")
                .map_err(|e| format!("OPENAI_API_KEY: {e}"))?,
            openai_org_id: env::var("OPENAI_ORG_ID").ok(),
            openai_model: env::var("OPENAI_MODEL").ok(),
            enable_streaming,
            stream_max_chunk_chars,
            stream_min_append_interval_ms,
        })
    }
}
