use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessingTask {
    pub correlation_id: String,
    pub user_id: String,
    pub channel_id: String,
    pub response_url: Option<String>,
    pub text: String,
    pub message_count: Option<u32>,
    pub target_channel_id: Option<String>,
    pub custom_prompt: Option<String>,
    pub visible: bool,
    // Destination flags for output routing
    pub dest_canvas: bool,
    pub dest_dm: bool,
    pub dest_public_post: bool,
}
