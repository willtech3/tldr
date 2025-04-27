use tldr::format_summary_message;

/// Tests for the message formatting logic
/// These tests verify that the response formatting remains consistent during refactoring.

#[test]
fn test_visible_response_format() {
    // Test data
    let user_id = "U12345";
    let source_channel_id = "C12345";
    let text = "last 10";
    let summary = "*Summary from #general*\n\nThis is a test summary.";
    let visible = true;
    
    let formatted = format_summary_message(
        user_id,
        source_channel_id,
        text,
        summary,
        visible
    );
    
    // Verify visible response format
    assert!(formatted.contains("<@U12345> ran `/tldr` in <#C12345>"), 
        "Visible response should contain user and channel information");
    assert!(formatted.contains("with parameters: `last 10`"), 
        "Visible response should contain command parameters");
    assert!(formatted.contains("*Summary from #general*"), 
        "Response should contain channel information");
    assert!(formatted.contains("This is a test summary."), 
        "Response should contain the summary text");
}

#[test]
fn test_not_visible_response_format() {
    // Test data
    let user_id = "U12345";
    let source_channel_id = "C12345";
    let text = "last 10";
    let summary = "*Summary from #general*\n\nThis is a test summary.";
    let visible = false;
    
    let formatted = format_summary_message(
        user_id,
        source_channel_id,
        text,
        summary,
        visible
    );
    
    // Verify not visible response format
    assert!(!formatted.contains("<@U12345> ran `/tldr`"), 
        "Not visible response should not contain user information");
    assert!(!formatted.contains("with parameters:"), 
        "Not visible response should not contain command parameters");
    assert_eq!(formatted, summary, 
        "Not visible response should only contain the summary");
}

#[test]
fn test_empty_text_format() {
    // Test data with empty text parameter
    let user_id = "U12345";
    let source_channel_id = "C12345";
    let text = "";
    let summary = "*Summary from #general*\n\nThis is a test summary.";
    let visible = true;
    
    let formatted = format_summary_message(
        user_id,
        source_channel_id,
        text,
        summary,
        visible
    );
    
    // Verify response format with empty text
    assert!(formatted.contains("<@U12345> ran `/tldr` in <#C12345>"), 
        "Response should contain user and channel information");
    assert!(!formatted.contains("with parameters:"), 
        "Response should not contain parameters section when text is empty");
}
