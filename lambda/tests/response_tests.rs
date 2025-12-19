use tldr::slack::response_builder::create_ephemeral_payload;

/// Tests for the response module functionality
/// These verify that the Slack response payloads are correctly formatted.

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
