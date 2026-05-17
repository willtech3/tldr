use serde::{Deserialize, Serialize};

use super::security::{
    is_valid_slack_channel_id, normalize_message_count, sanitize_custom_prompt_for_task,
};

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
pub enum Destination {
    Thread,
    DM,
    Channel,
}

#[derive(Debug, Serialize, Deserialize)]
#[allow(clippy::struct_excessive_bools)] // ProcessingTask models user intent flags; booleans map 1:1 to Slack UX toggles.
pub struct ProcessingTask {
    pub correlation_id: String,
    pub user_id: String,
    pub channel_id: String,
    /// When present, indicates the Slack assistant thread timestamp to reply into
    pub thread_ts: Option<String>,
    /// Original assistant channel id initiating the request (for replies)
    pub origin_channel_id: Option<String>,
    pub response_url: Option<String>,
    pub text: String,
    pub message_count: Option<u32>,
    pub target_channel_id: Option<String>,
    pub custom_prompt: Option<String>,
    pub visible: bool,
    /// Preferred destination for primary delivery. Legacy flags below still apply for
    /// compatibility during migration.
    pub destination: Destination,
    // Destination flags for output routing
    pub dest_dm: bool,
    pub dest_public_post: bool,
}

impl ProcessingTask {
    pub fn enforce_runtime_limits(&mut self) {
        self.message_count = Some(normalize_message_count(self.message_count));
        self.custom_prompt = sanitize_custom_prompt_for_task(self.custom_prompt.as_deref());
    }

    #[must_use]
    pub fn has_valid_source_channel(&self) -> bool {
        is_valid_slack_channel_id(&self.channel_id)
    }
}
