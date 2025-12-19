use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Prefill values collected from legacy slash flags or context.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Prefill {
    pub initial_conversation: Option<String>,
    pub last_n: Option<u32>,
    pub custom_prompt: Option<String>,
}

/// Build the Block Kit modal for TLDR configuration.
///
/// Modal contains:
/// - `conversations_select` (default to current, or prefilled)
/// - `number_input` for message count
/// - style/prompt multiline input
/// # Panics
///
/// Panics if the `conversations_select` element cannot be represented as a JSON object
/// when removing `default_to_current_conversation`. This is a construction-time invariant
/// in our code and would indicate an internal programming error if violated.
#[allow(clippy::too_many_lines)]
#[must_use]
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

    let blocks = vec![
        json!({
            "type": "input",
            "block_id": "conv",
            "label": { "type": "plain_text", "text": "Conversation" },
            "element": conv_element
        }),
        json!({
            "type": "input",
            "block_id": "lastn",
            "label": { "type": "plain_text", "text": "How many messages?" },
            "element": { "type": "number_input", "is_decimal_allowed": false, "action_id": "n", "initial_value": prefill.last_n.map_or_else(|| "100".to_string(), |n| n.to_string()), "min_value": "2", "max_value": "500" }
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
/// # Errors
///
/// Returns a map of field errors when validation fails; otherwise returns `Ok(())`.
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
