use tldr::response::{create_ephemeral_payload, create_replace_original_payload};

/// Tests for the response module functionality
/// These verify that the Slack response payloads are correctly formatted
/// for both command hiding and ephemeral messages.

#[test]
fn test_replace_original_payload_with_text() {
    // Create payload with text
    let payload = create_replace_original_payload(Some("Test message"));

    // Convert to string for easy comparison
    let payload_str = serde_json::to_string(&payload).unwrap();

    // Verify payload structure
    assert!(
        payload_str.contains("\"replace_original\":true"),
        "Payload should include replace_original field"
    );
    assert!(
        payload_str.contains("\"text\":\"Test message\""),
        "Payload should include the text field with correct content"
    );
}

#[test]
fn test_replace_original_payload_hide_command() {
    // Create payload with None to hide command
    let payload = create_replace_original_payload(None);

    // Convert to string for easy comparison
    let payload_str = serde_json::to_string(&payload).unwrap();

    // Verify payload structure
    assert!(
        payload_str.contains("\"replace_original\":true"),
        "Payload should include replace_original field"
    );
    assert!(
        payload_str.contains("\"text\":\" \""),
        "Payload should include a space for text to hide the command"
    );
}

#[test]
fn test_replace_original_payload_with_empty_text() {
    // Create payload with empty string (should behave like None)
    let payload = create_replace_original_payload(Some(""));

    // Convert to string for easy comparison
    let payload_str = serde_json::to_string(&payload).unwrap();

    // Verify payload structure
    assert!(
        payload_str.contains("\"replace_original\":true"),
        "Payload should include replace_original field"
    );
    assert!(
        payload_str.contains("\"text\":\" \""),
        "Payload should include a space for text to hide the command"
    );
}

#[test]
fn test_ephemeral_payload() {
    // Create ephemeral payload
    let payload = create_ephemeral_payload("Test ephemeral message");

    // Convert to string for easy comparison
    let payload_str = serde_json::to_string(&payload).unwrap();

    // Verify payload structure
    assert!(
        payload_str.contains("\"response_type\":\"ephemeral\""),
        "Payload should include ephemeral response_type"
    );
    assert!(
        payload_str.contains("\"text\":\"Test ephemeral message\""),
        "Payload should include the text field with correct content"
    );
}

#[test]
fn test_replace_original_payload_blank_min() {
    let v = create_replace_original_payload(None);
    assert_eq!(
        v.get("replace_original").and_then(|b| b.as_bool()),
        Some(true)
    );
}

/// Integration test: Verify the ephemeral response payload matches the format
/// used in the worker for command responses
#[test]
fn test_worker_response_format_consistency() {
    // Create ephemeral payload the same way worker.rs would
    let message = "Processing your request...";
    let payload = create_ephemeral_payload(message);

    // Convert to string for comparison
    let payload_str = serde_json::to_string(&payload).unwrap();

    // Ensure it has the key properties needed for worker.rs
    assert!(
        payload_str.contains("\"response_type\":\"ephemeral\""),
        "Worker responses must be ephemeral"
    );
    assert!(
        payload_str.contains("\"text\":\"Processing your request...\""),
        "Worker responses should contain the correct message text"
    );
}
