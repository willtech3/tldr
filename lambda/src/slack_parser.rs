use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use percent_encoding::percent_decode_str;

#[derive(Debug, Deserialize, Serialize)]
pub struct SlackCommandEvent {
    pub token: String,
    pub team_id: String,
    pub team_domain: String,
    pub channel_id: String,
    pub channel_name: String,
    pub user_id: String,
    pub user_name: String,
    pub command: String,
    pub text: String,
    pub response_url: String,
    pub trigger_id: String,
    pub command_ts: String,
}

/// Decodes URL encoded string using percent_encoding crate
fn decode_url_component(input: &str) -> Result<String, String> {
    percent_decode_str(input)
        .decode_utf8()
        .map(|s| s.replace('+', " "))
        .map_err(|e| format!("Failed to decode URL component: {}", e))
        .map(|s| s.to_string())
}

pub fn parse_form_data(form_data: &str) -> Result<SlackCommandEvent, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    
    // Parse the form data
    for pair in form_data.split('&') {
        if let Some(idx) = pair.find('=') {
            let key = decode_url_component(&pair[..idx])
                .map_err(|e| format!("Failed to decode key: {}", e))?;
                
            let value = decode_url_component(&pair[idx + 1..])
                .map_err(|e| format!("Failed to decode value: {}", e))?;
                
            map.insert(key, value);
        }
    }
    
    // Create the SlackCommandEvent from the parsed data
    let event = SlackCommandEvent {
        token: map.get("token").cloned().unwrap_or_default(),
        team_id: map.get("team_id").cloned().unwrap_or_default(),
        team_domain: map.get("team_domain").cloned().unwrap_or_default(),
        channel_id: map.get("channel_id").cloned().unwrap_or_default(),
        channel_name: map.get("channel_name").cloned().unwrap_or_default(),
        user_id: map.get("user_id").cloned().unwrap_or_default(),
        user_name: map.get("user_name").cloned().unwrap_or_default(),
        command: map.get("command").cloned().unwrap_or_default(),
        text: map.get("text").cloned().unwrap_or_default(),
        response_url: map.get("response_url").cloned().unwrap_or_default(),
        trigger_id: map.get("trigger_id").cloned().unwrap_or_default(),
        command_ts: map.get("command_ts").cloned().unwrap_or_default(),
    };
    
    Ok(event)
}
