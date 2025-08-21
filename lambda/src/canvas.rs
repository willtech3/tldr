//! Canvas API helpers for creating and updating Slack canvases.
//!
//! Provides functionality to:
//! - Create or get a channel's canvas
//! - Upsert sections within a canvas
//! - Generate permalink URLs for messages

use crate::clients::SlackClient;
use crate::errors::SlackError;
use serde::Serialize;
use tracing::{debug, info};

/// Document content for Canvas operations  
#[derive(Debug, Serialize)]
struct DocumentContent {
    #[serde(rename = "type")]
    content_type: String,
    markdown: String,
}

/// Canvas edit operation
#[derive(Debug, Serialize)]
struct CanvasEditChange {
    operation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    section_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    document_content: Option<DocumentContent>,
}

/// Canvas helper functions
pub struct CanvasHelper<'a> {
    slack_client: &'a SlackClient,
}

impl<'a> CanvasHelper<'a> {
    /// Create a new Canvas helper with the given Slack client
    pub fn new(slack_client: &'a SlackClient) -> Self {
        Self { slack_client }
    }

    /// Try to fetch the existing canvas ID for a channel via conversations.info
    async fn get_existing_canvas_id(&self, channel_id: &str) -> Result<Option<String>, SlackError> {
        let canvas_id_opt = self.slack_client.get_channel_canvas_id(channel_id).await?;

        if let Some(ref cid) = canvas_id_opt {
            info!("Found existing canvas: {}", cid);
        }

        Ok(canvas_id_opt)
    }

    /// Ensure a channel has a TLDR canvas with a custom title.
    /// Returns the canvas ID.
    pub async fn ensure_tldr_canvas(&self, channel_id: &str) -> Result<String, SlackError> {
        info!("Ensuring TLDR canvas exists for channel: {}", channel_id);

        // 1) Prefer reusing an existing channel canvas if one is already present
        if let Some(existing) = self.get_existing_canvas_id(channel_id).await? {
            return Ok(existing);
        }

        // Try to create a new canvas with a title
        let title = "📋 TLDR Summaries";
        let content = "# 📋 TLDR Summaries\n\n*This canvas contains AI-generated summaries of channel conversations. Latest summaries appear at the top.*\n\n---\n";

        match self
            .slack_client
            .create_canvas(channel_id, title, content)
            .await
        {
            Ok(canvas_id) => {
                info!("Created new canvas: {}", canvas_id);
                Ok(canvas_id)
            }
            Err(e) => {
                // Check if it's because the canvas already exists
                if e.to_string().contains("channel_canvas_already_exists") {
                    debug!("Canvas already exists for channel, fetching existing canvas ID");
                    if let Some(existing) = self.get_existing_canvas_id(channel_id).await? {
                        return Ok(existing);
                    }
                    return Err(SlackError::ApiError(
                        "Canvas exists but couldn't retrieve its ID".to_string(),
                    ));
                }
                Err(e)
            }
        }
    }

    /// Ensure a channel has a canvas, creating one if it doesn't exist.
    /// Returns the canvas ID.
    pub async fn ensure_channel_canvas(&self, channel_id: &str) -> Result<String, SlackError> {
        self.ensure_tldr_canvas(channel_id).await
    }

    /// Prepend a new summary section at the top of the canvas.
    /// Each summary gets its own timestamped section for history.
    pub async fn prepend_summary_section(
        &self,
        canvas_id: &str,
        heading: &str,
        markdown_content: &str,
    ) -> Result<(), SlackError> {
        info!(
            "Prepending summary section '{}' to canvas {}",
            heading, canvas_id
        );

        // Prepare the markdown content with the heading
        let full_content = format!("## {heading}\n\n{markdown_content}\n\n---\n");

        // Always insert at the beginning to keep latest summary at top
        let _change = CanvasEditChange {
            operation: "insert_at_start".to_string(),
            section_id: None,
            document_content: Some(DocumentContent {
                content_type: "markdown".to_string(),
                markdown: full_content.clone(),
            }),
        };

        // For now, we'll use update_canvas_section with a generated section ID
        // In the future, we might want to extend SlackClient to support insert_at_start
        let section_id = format!("summary_{}", chrono::Utc::now().timestamp());

        self.slack_client
            .update_canvas_section(canvas_id, &section_id, &full_content)
            .await?;
        info!("Successfully updated canvas section");
        Ok(())
    }

    /// Get a permalink for a message
    pub async fn get_message_permalink(
        &self,
        channel_id: &str,
        message_ts: &str,
    ) -> Result<String, SlackError> {
        self.slack_client
            .get_message_permalink(channel_id, message_ts)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_document_content_serialization() {
        let content = DocumentContent {
            content_type: "markdown".to_string(),
            markdown: "# Test Content".to_string(),
        };

        let json = serde_json::to_value(&content).unwrap();
        assert_eq!(json["type"], "markdown");
        assert_eq!(json["markdown"], "# Test Content");
    }

    #[test]
    fn test_canvas_edit_change_serialization() {
        let change = CanvasEditChange {
            operation: "replace".to_string(),
            section_id: Some("section123".to_string()),
            document_content: Some(DocumentContent {
                content_type: "markdown".to_string(),
                markdown: "Updated content".to_string(),
            }),
        };

        let json = serde_json::to_value(&change).unwrap();
        assert_eq!(json["operation"], "replace");
        assert_eq!(json["section_id"], "section123");
        assert!(json["document_content"].is_object());
    }
}
