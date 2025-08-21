use std::env;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub processing_queue_url: String,
    pub slack_signing_secret: String,
    pub slack_bot_token: String,
    pub openai_api_key: String,
    pub openai_org_id: Option<String>,
    pub openai_model: Option<String>,
}

impl AppConfig {
    pub fn from_env() -> Result<Self, String> {
        Ok(Self {
            processing_queue_url: env::var("PROCESSING_QUEUE_URL")
                .map_err(|e| format!("PROCESSING_QUEUE_URL: {}", e))?,
            slack_signing_secret: env::var("SLACK_SIGNING_SECRET")
                .map_err(|e| format!("SLACK_SIGNING_SECRET: {}", e))?,
            slack_bot_token: env::var("SLACK_BOT_TOKEN")
                .map_err(|e| format!("SLACK_BOT_TOKEN: {}", e))?,
            openai_api_key: env::var("OPENAI_API_KEY")
                .map_err(|e| format!("OPENAI_API_KEY: {}", e))?,
            openai_org_id: env::var("OPENAI_ORG_ID").ok(),
            openai_model: env::var("OPENAI_MODEL").ok(),
        })
    }
}
