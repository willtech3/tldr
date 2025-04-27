use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use percent_encoding::percent_decode_str;

/// Structure representing a Slack slash command event.
/// This contains all the fields that Slack sends when a user invokes a slash command.
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
///
/// # Arguments
/// * `input` - The URL-encoded string to decode
///
/// # Returns
/// * `Ok(String)` - The decoded string if successful
/// * `Err(String)` - An error message if decoding fails
///
/// # Examples
///
/// ```
/// use tldr::slack_parser::decode_url_component;
///
/// let encoded = "hello%20world";
/// let decoded = decode_url_component(encoded).unwrap();
/// assert_eq!(decoded, "hello world");
///
/// let encoded_plus = "hello+world";
/// let decoded_plus = decode_url_component(encoded_plus).unwrap();
/// assert_eq!(decoded_plus, "hello world");
/// ```
pub fn decode_url_component(input: &str) -> Result<String, String> {
    percent_decode_str(input)
        .decode_utf8()
        .map(|s| s.replace('+', " "))
        .map_err(|e| format!("Failed to decode URL component: {}", e))
        .map(|s| s.to_string())
}

/// Parses URL-encoded form data into a SlackCommandEvent structure.
///
/// This function is used to parse the raw body of a Slack slash command request.
/// It handles URL decoding and extraction of all required fields.
///
/// # Arguments
/// * `form_data` - The raw URL-encoded form data string from Slack
///
/// # Returns
/// * `Ok(SlackCommandEvent)` - The parsed event if successful
/// * `Err(String)` - An error message if parsing fails
///
/// # Examples
///
/// ```
/// use tldr::slack_parser::parse_form_data;
///
/// let form_data = "token=abc123&team_id=T123&team_domain=example&\
///                  channel_id=C123&channel_name=general&user_id=U123&\
///                  user_name=username&command=%2Ftldr&text=&\
///                  response_url=https%3A%2F%2Fhooks.slack.com%2F&\
///                  trigger_id=123.456&command_ts=1609753200";
///
/// let event = parse_form_data(form_data).unwrap();
/// assert_eq!(event.command, "/tldr");
/// assert_eq!(event.channel_name, "general");
/// ```
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
