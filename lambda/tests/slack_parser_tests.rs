use tldr::slack::command_parser::{decode_url_component, parse_form_data};

#[test]
fn test_decode_url_component() {
    // Test URL decoding with percent-encoded characters
    let encoded = "hello%20world";
    let decoded = decode_url_component(encoded).unwrap();
    assert_eq!(decoded, "hello world");

    // Test URL decoding with plus signs representing spaces
    let encoded_plus = "hello+world";
    let decoded_plus = decode_url_component(encoded_plus).unwrap();
    assert_eq!(decoded_plus, "hello world");

    // Test decoding with special characters
    let special_chars = "test%40example.com%26param%3Dvalue";
    let decoded_special = decode_url_component(special_chars).unwrap();
    assert_eq!(decoded_special, "test@example.com&param=value");
}

#[test]
fn test_parse_form_data_success() {
    // Create valid form data mimicking a Slack slash command
    let form_data = "token=abc123&team_id=T123&team_domain=example&\
                    channel_id=C123&channel_name=general&user_id=U123&\
                    user_name=username&command=%2Ftldr&text=&\
                    response_url=https%3A%2F%2Fhooks.slack.com%2F&\
                    trigger_id=123.456&command_ts=1609753200";

    let event = parse_form_data(form_data).unwrap();

    // Verify fields were parsed correctly
    assert_eq!(event.token, "abc123");
    assert_eq!(event.team_id, "T123");
    assert_eq!(event.channel_id, "C123");
    assert_eq!(event.channel_name, "general");
    assert_eq!(event.user_id, "U123");
    assert_eq!(event.command, "/tldr");
    assert_eq!(event.response_url, "https://hooks.slack.com/");
}

#[test]
fn test_parse_form_data_with_text() {
    // Test with text parameter containing flags and parameters
    let form_data = "token=abc123&team_id=T123&team_domain=example&\
                    channel_id=C123&channel_name=general&user_id=U123&\
                    user_name=username&command=%2Ftldr&text=--visible+count%3D10&\
                    response_url=https%3A%2F%2Fhooks.slack.com%2F&\
                    trigger_id=123.456&command_ts=1609753200";

    let event = parse_form_data(form_data).unwrap();

    // Verify text field was decoded correctly with its flags
    assert_eq!(event.text, "--visible count=10");
}

#[test]
fn test_parse_form_data_missing_fields() {
    // Test that missing fields get default values
    let incomplete_data = "token=abc123&team_id=T123";
    let result = parse_form_data(incomplete_data);

    // Expect success with default values for missing fields
    assert!(result.is_ok());
    let event = result.unwrap();

    // Verify provided fields are parsed correctly
    assert_eq!(event.token, "abc123");
    assert_eq!(event.team_id, "T123");

    // Verify missing fields get default values
    assert_eq!(event.command, "");
    assert_eq!(event.text, "");
    assert_eq!(event.channel_id, "");
}
