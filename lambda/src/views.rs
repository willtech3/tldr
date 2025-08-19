use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Prefill values collected from legacy slash flags or context.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Prefill {
    pub initial_conversation: Option<String>,
    pub last_n: Option<u32>,
    pub custom_prompt: Option<String>,
    pub dest_canvas: bool,
    pub dest_dm: bool,
    pub dest_public_post: bool,
}

/// Build the Block Kit modal for TLDR configuration.
///
/// This matches the JSON shape described in the implementation plan:
/// - conversations_select (default to current, or prefilled)
/// - range radio (unread_since_last_run | last_n | date_range)
/// - number_input for last N
/// - datepickers for from/to
/// - destination checkboxes
/// - style/prompt multiline input
pub fn build_tldr_modal(prefill: &Prefill) -> Value {
    let mut conv_element = json!({
        "type": "conversations_select",
        "action_id": "conv_id",
        "default_to_current_conversation": true,
        "response_url_enabled": true
    });

    if let Some(conv) = &prefill.initial_conversation {
        // When explicit conversation is provided, Slack requires using initial_conversation
        // and not default_to_current_conversation
        conv_element["initial_conversation"] = Value::String(conv.clone());
        conv_element
            .as_object_mut()
            .unwrap()
            .remove("default_to_current_conversation");
    }

    let mut dest_initial_options: Vec<Value> = vec![];

    if prefill.dest_canvas {
        dest_initial_options.push(json!({
            "text": { "type": "plain_text", "text": "Update channel Canvas (recommended)" },
            "value": "canvas"
        }));
    }
    if prefill.dest_dm {
        dest_initial_options.push(json!({
            "text": { "type": "plain_text", "text": "DM me the summary" },
            "value": "dm"
        }));
    }
    if prefill.dest_public_post {
        dest_initial_options.push(json!({
            "text": { "type": "plain_text", "text": "Post publicly in channel" },
            "value": "public_post"
        }));
    }

    let blocks = vec![
        json!({
            "type": "input",
            "block_id": "conv",
            "label": { "type": "plain_text", "text": "Conversation" },
            "element": conv_element
        }),
        json!({
            "type": "input",
            "block_id": "range",
            "label": { "type": "plain_text", "text": "Range" },
            "element": {
                "type": "radio_buttons",
                "action_id": "mode",
                "options": [
                    { "text": { "type": "plain_text", "text": "Unread since last run" }, "value": "unread_since_last_run" },
                    { "text": { "type": "plain_text", "text": "Last N messages" }, "value": "last_n" },
                    { "text": { "type": "plain_text", "text": "Date range" }, "value": "date_range" }
                ],
                "initial_option": { "text": { "type": "plain_text", "text": "Last N messages" }, "value": "last_n" }
            }
        }),
        json!({
            "type": "input",
            "block_id": "lastn",
            "optional": true,
            "label": { "type": "plain_text", "text": "How many messages?" },
            "element": { "type": "number_input", "is_decimal_allowed": false, "action_id": "n", "initial_value": prefill.last_n.map(|n| n.to_string()).unwrap_or_else(|| "100".to_string()), "min_value": "10", "max_value": "500" }
        }),
        json!({
            "type": "input",
            "block_id": "from",
            "optional": true,
            "label": { "type": "plain_text", "text": "From date" },
            "element": { "type": "datepicker", "action_id": "from_date" }
        }),
        json!({
            "type": "input",
            "block_id": "to",
            "optional": true,
            "label": { "type": "plain_text", "text": "To date" },
            "element": { "type": "datepicker", "action_id": "to_date" }
        }),
        json!({
            "type": "section",
            "block_id": "dest",
            "text": { "type": "mrkdwn", "text": "*Destination*" },
            "accessory": {
                "type": "checkboxes",
                "action_id": "dest_flags",
                "options": [
                    { "text": { "type": "plain_text", "text": "Update channel Canvas (recommended)" }, "value": "canvas" },
                    { "text": { "type": "plain_text", "text": "DM me the summary" }, "value": "dm" },
                    { "text": { "type": "plain_text", "text": "Post publicly in channel" }, "value": "public_post" }
                ],
                "initial_options": dest_initial_options
            }
        }),
        json!({
            "type": "input",
            "block_id": "style",
            "optional": true,
            "label": { "type": "plain_text", "text": "Style / prompt override" },
            "element": { "type": "plain_text_input", "action_id": "custom", "multiline": true, "initial_value": prefill.custom_prompt.clone().unwrap_or_default() }
        }),
    ];

    json!({
        "type": "modal",
        "callback_id": "tldr_config_submit",
        "title": { "type": "plain_text", "text": "TLDR" },
        "submit": { "type": "plain_text", "text": "Summarize" },
        "close": { "type": "plain_text", "text": "Cancel" },
        "blocks": blocks
    })
}

/// Minimal validation for `view_submission` payloads.
/// Returns a map of `block_id -> error` suitable for Slack's interactive response.
pub fn validate_view_submission(view: &Value) -> Result<(), serde_json::Map<String, Value>> {
    // Slack sends view.state.values.{block_id}.{action_id}.value
    let mut errors = serde_json::Map::new();

    let Some(values) = view
        .get("state")
        .and_then(|s| s.get("values"))
        .and_then(|v| v.as_object())
    else {
        return Ok(());
    };

    // Validate last N if present
    let lastn_value = values
        .get("lastn")
        .and_then(|block| block.get("n"))
        .and_then(|n| n.get("value"))
        .and_then(|v| v.as_str());

    if let Some(n_str) = lastn_value {
        let trimmed = n_str.trim();
        if !trimmed.is_empty() {
            match trimmed.parse::<i32>() {
                Ok(n) if !(2..=500).contains(&n) => {
                    errors.insert(
                        "lastn".to_string(),
                        Value::String("Please enter a number between 2 and 500".to_string()),
                    );
                }
                Err(_) => {
                    errors.insert(
                        "lastn".to_string(),
                        Value::String("Please enter a whole number".to_string()),
                    );
                }
                _ => {}
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}
