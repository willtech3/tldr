use std::env;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub processing_queue_url: String,
    pub slack_signing_secret: String,
    pub slack_bot_token: String,
    // OAuth for user-token flow
    pub slack_client_id: String,
    pub slack_client_secret: String,
    pub slack_redirect_url: String,
    pub user_token_param_prefix: String,
    pub openai_api_key: String,
    pub openai_org_id: Option<String>,
    pub openai_model: Option<String>,
}

impl AppConfig {
    /// # Errors
    ///
    /// Returns an error string when required environment variables are missing.
    pub fn from_env() -> Result<Self, String> {
        Ok(Self {
            processing_queue_url: env::var("PROCESSING_QUEUE_URL")
                .map_err(|e| format!("PROCESSING_QUEUE_URL: {e}"))?,
            slack_signing_secret: env::var("SLACK_SIGNING_SECRET")
                .map_err(|e| format!("SLACK_SIGNING_SECRET: {e}"))?,
            slack_bot_token: env::var("SLACK_BOT_TOKEN")
                .map_err(|e| format!("SLACK_BOT_TOKEN: {e}"))?,
            slack_client_id: env::var("SLACK_CLIENT_ID")
                .map_err(|e| format!("SLACK_CLIENT_ID: {e}"))?,
            slack_client_secret: env::var("SLACK_CLIENT_SECRET")
                .map_err(|e| format!("SLACK_CLIENT_SECRET: {e}"))?,
            slack_redirect_url: env::var("SLACK_REDIRECT_URL")
                .map_err(|e| format!("SLACK_REDIRECT_URL: {e}"))?,
            user_token_param_prefix: env::var("USER_TOKEN_PARAM_PREFIX")
                .unwrap_or_else(|_| "/tldr/user_tokens/".to_string()),
            openai_api_key: env::var("OPENAI_API_KEY")
                .map_err(|e| format!("OPENAI_API_KEY: {e}"))?,
            openai_org_id: env::var("OPENAI_ORG_ID").ok(),
            openai_model: env::var("OPENAI_MODEL").ok(),
        })
    }
}
