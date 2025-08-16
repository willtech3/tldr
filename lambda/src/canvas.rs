//! Canvas API helpers for creating and updating Slack canvases.
//!
//! Provides functionality to:
//! - Create or get a channel's canvas
//! - Upsert sections within a canvas
//! - Generate permalink URLs for messages

use crate::errors::SlackError;
use once_cell::sync::Lazy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use slack_morphism::SlackApiToken;
use std::time::Duration;
use tracing::{debug, info, warn};

// Static HTTP client for Canvas API calls (not supported by slack-morphism yet)
static CANVAS_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("Failed to create Canvas HTTP client")
});

/// Response from conversations.canvases.create
#[derive(Debug, Deserialize)]
struct CanvasCreateResponse {
    ok: bool,
    canvas_id: Option<String>,
    error: Option<String>,
}

/// Response from canvases.sections.lookup
#[derive(Debug, Deserialize)]
struct SectionsLookupResponse {
    ok: bool,
    sections: Option<Vec<CanvasSection>>,
    error: Option<String>,
}

/// Canvas section information
#[derive(Debug, Deserialize)]
struct CanvasSection {
    id: String,
    #[serde(rename = "type")]
    #[allow(dead_code)]
    section_type: String,
}

/// Response from canvases.edit
#[derive(Debug, Deserialize)]
struct CanvasEditResponse {
    ok: bool,
    error: Option<String>,
}

/// Response from chat.getPermalink
#[derive(Debug, Deserialize)]
struct PermalinkResponse {
    ok: bool,
    permalink: Option<String>,
    error: Option<String>,
}

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
    token: &'a SlackApiToken,
}

impl<'a> CanvasHelper<'a> {
    /// Create a new Canvas helper with the given token
    pub fn new(token: &'a SlackApiToken) -> Self {
        Self { token }
    }

    /// Ensure a channel has a canvas, creating one if it doesn't exist.
    /// Returns the canvas ID.
    pub async fn ensure_channel_canvas(&self, channel_id: &str) -> Result<String, SlackError> {
        info!("Ensuring canvas exists for channel: {}", channel_id);

        // Try to create a new channel canvas
        let create_payload = json!({
            "channel_id": channel_id
        });

        let resp = CANVAS_CLIENT
            .post("https://slack.com/api/conversations.canvases.create")
            .bearer_auth(&self.token.token_value.0)
            .json(&create_payload)
            .send()
            .await
            .map_err(|e| SlackError::HttpError(format!("Canvas create request failed: {}", e)))?;

        let create_result: CanvasCreateResponse = resp.json().await.map_err(|e| {
            SlackError::ParseError(format!("Failed to parse canvas create response: {}", e))
        })?;

        if create_result.ok {
            if let Some(canvas_id) = create_result.canvas_id {
                info!("Created new canvas: {}", canvas_id);
                return Ok(canvas_id);
            }
        }

        // Handle the case where canvas already exists
        if create_result.error.as_deref() == Some("channel_canvas_already_exists") {
            debug!("Canvas already exists for channel, fetching existing canvas ID");

            // Get channel info to find existing canvas ID
            // Using conversations.info to get canvas ID from channel properties
            let info_payload = json!({
                "channel": channel_id
            });

            let info_resp = CANVAS_CLIENT
                .post("https://slack.com/api/conversations.info")
                .bearer_auth(&self.token.token_value.0)
                .json(&info_payload)
                .send()
                .await
                .map_err(|e| {
                    SlackError::HttpError(format!("Channel info request failed: {}", e))
                })?;

            let info_data: Value = info_resp.json().await.map_err(|e| {
                SlackError::ParseError(format!("Failed to parse channel info: {}", e))
            })?;

            if let Some(canvas_id) = info_data
                .get("channel")
                .and_then(|c| c.get("properties"))
                .and_then(|p| p.get("canvas"))
                .and_then(|c| c.get("id"))
                .and_then(|id| id.as_str())
            {
                info!("Found existing canvas: {}", canvas_id);
                return Ok(canvas_id.to_string());
            }

            return Err(SlackError::ApiError(
                "Canvas exists but couldn't retrieve its ID".to_string(),
            ));
        }

        Err(SlackError::ApiError(format!(
            "Failed to create canvas: {}",
            create_result
                .error
                .unwrap_or_else(|| "Unknown error".to_string())
        )))
    }

    /// Upsert a section in a canvas. Looks for an existing section with the given heading,
    /// and either replaces it or inserts a new one at the end.
    pub async fn upsert_section(
        &self,
        canvas_id: &str,
        heading: &str,
        markdown_content: &str,
    ) -> Result<(), SlackError> {
        info!("Upserting section '{}' in canvas {}", heading, canvas_id);

        // First, look up existing sections to find if our heading exists
        let lookup_payload = json!({
            "canvas_id": canvas_id,
            "criteria": {
                "section_types": ["h2"],  // Look for h2 headings
                "contains_text": heading
            }
        });

        let lookup_resp = CANVAS_CLIENT
            .post("https://slack.com/api/canvases.sections.lookup")
            .bearer_auth(&self.token.token_value.0)
            .json(&lookup_payload)
            .send()
            .await
            .map_err(|e| SlackError::HttpError(format!("Section lookup failed: {}", e)))?;

        let lookup_result: SectionsLookupResponse = lookup_resp.json().await.map_err(|e| {
            SlackError::ParseError(format!("Failed to parse section lookup: {}", e))
        })?;

        let mut section_id_to_replace = None;

        if lookup_result.ok {
            if let Some(sections) = lookup_result.sections {
                if !sections.is_empty() {
                    section_id_to_replace = Some(sections[0].id.clone());
                    debug!(
                        "Found existing section to replace: {:?}",
                        section_id_to_replace
                    );
                }
            }
        } else {
            warn!("Section lookup failed: {:?}", lookup_result.error);
        }

        // Prepare the markdown content with the heading
        let full_content = format!("## {}\n\n{}", heading, markdown_content);

        // Prepare the edit operation
        let change = if let Some(section_id) = section_id_to_replace {
            // Replace existing section
            CanvasEditChange {
                operation: "replace".to_string(),
                section_id: Some(section_id),
                document_content: Some(DocumentContent {
                    content_type: "markdown".to_string(),
                    markdown: full_content,
                }),
            }
        } else {
            // Insert at the end if section doesn't exist
            CanvasEditChange {
                operation: "insert_at_end".to_string(),
                section_id: None,
                document_content: Some(DocumentContent {
                    content_type: "markdown".to_string(),
                    markdown: full_content,
                }),
            }
        };

        let edit_payload = json!({
            "canvas_id": canvas_id,
            "changes": [change]
        });

        let edit_resp = CANVAS_CLIENT
            .post("https://slack.com/api/canvases.edit")
            .bearer_auth(&self.token.token_value.0)
            .json(&edit_payload)
            .send()
            .await
            .map_err(|e| SlackError::HttpError(format!("Canvas edit failed: {}", e)))?;

        let edit_result: CanvasEditResponse = edit_resp.json().await.map_err(|e| {
            SlackError::ParseError(format!("Failed to parse canvas edit response: {}", e))
        })?;

        if edit_result.ok {
            info!("Successfully updated canvas section");
            Ok(())
        } else {
            Err(SlackError::ApiError(format!(
                "Failed to edit canvas: {}",
                edit_result
                    .error
                    .unwrap_or_else(|| "Unknown error".to_string())
            )))
        }
    }

    /// Get a permalink for a message
    pub async fn get_message_permalink(
        &self,
        channel_id: &str,
        message_ts: &str,
    ) -> Result<String, SlackError> {
        let payload = json!({
            "channel": channel_id,
            "message_ts": message_ts
        });

        let resp = CANVAS_CLIENT
            .post("https://slack.com/api/chat.getPermalink")
            .bearer_auth(&self.token.token_value.0)
            .json(&payload)
            .send()
            .await
            .map_err(|e| SlackError::HttpError(format!("Permalink request failed: {}", e)))?;

        let result: PermalinkResponse = resp.json().await.map_err(|e| {
            SlackError::ParseError(format!("Failed to parse permalink response: {}", e))
        })?;

        if result.ok {
            result
                .permalink
                .ok_or_else(|| SlackError::ApiError("Permalink response missing URL".to_string()))
        } else {
            Err(SlackError::ApiError(format!(
                "Failed to get permalink: {}",
                result.error.unwrap_or_else(|| "Unknown error".to_string())
            )))
        }
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
