use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

use crate::{
    SlackError,
    slack::command_parser::{SlackCommandEvent, decode_url_component, parse_form_data},
};

pub fn is_interactive_body(body: &str) -> bool {
    body.starts_with("payload=") || body.contains("&payload=")
}

pub fn parse_interactive_payload(form_body: &str) -> Result<Value, SlackError> {
    for pair in form_body.split('&') {
        if let Some(eq_idx) = pair.find('=') {
            let key = &pair[..eq_idx];
            if key == "payload" {
                let raw_val = &pair[eq_idx + 1..];
                let decoded = decode_url_component(raw_val).map_err(|e| {
                    SlackError::ParseError(format!("Failed to decode payload: {}", e))
                })?;
                let v: Value = serde_json::from_str(&decoded)
                    .map_err(|e| SlackError::ParseError(format!("Invalid JSON payload: {}", e)))?;
                return Ok(v);
            }
        }
    }
    Err(SlackError::ParseError("Missing payload field".to_string()))
}

pub fn v_path<'a>(root: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = root;
    for key in path {
        cur = cur.get(*key)?;
    }
    Some(cur)
}

pub fn v_str<'a>(root: &'a Value, path: &[&str]) -> Option<&'a str> {
    v_path(root, path).and_then(|v| v.as_str())
}

pub fn v_array<'a>(root: &'a Value, path: &[&str]) -> Option<&'a Vec<Value>> {
    v_path(root, path).and_then(|v| v.as_array())
}

pub fn parse_slack_event(payload: &str) -> Result<SlackCommandEvent, SlackError> {
    parse_form_data(payload)
        .map_err(|e| SlackError::ParseError(format!("Failed to parse form data: {}", e)))
}

pub fn get_header_value<'a>(headers: &'a serde_json::Value, name: &str) -> Option<&'a str> {
    if let Some(v) = headers.get(name).and_then(|s| s.as_str()) {
        return Some(v);
    }
    headers.as_object().and_then(|map| {
        map.iter().find_map(|(k, v)| {
            if k.eq_ignore_ascii_case(name) {
                v.as_str()
            } else {
                None
            }
        })
    })
}

pub fn parse_kv_params(filtered_text: &str) -> (Option<u32>, Option<String>, Option<String>) {
    static KV_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r#"(\w+)\s*=\s*("[^"]*"|\S+)"#).expect("static regex compile"));

    let mut message_count: Option<u32> = None;
    let mut target_channel_id: Option<String> = None;
    let mut custom_prompt: Option<String> = None;

    for cap in KV_RE.captures_iter(filtered_text) {
        let key = &cap[1].to_lowercase();
        let raw = cap[2].trim_matches('"');
        match key.as_str() {
            "count" => {
                if let Ok(count) = raw.parse::<u32>() {
                    message_count = Some(count);
                }
            }
            "channel" => {
                let channel = if raw.starts_with('#') {
                    raw.trim_start_matches('#').to_string()
                } else {
                    raw.to_string()
                };
                target_channel_id = Some(channel);
            }
            "custom" => {
                // Sanitization handled in view-building step; keep raw here
                custom_prompt = Some(raw.to_string());
            }
            _ => {}
        }
    }

    (message_count, target_channel_id, custom_prompt)
}
