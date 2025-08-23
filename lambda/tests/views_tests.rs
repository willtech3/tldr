use serde_json::json;
use tldr::slack::modal_builder::{Prefill, build_tldr_modal, validate_view_submission};

#[test]
fn build_modal_with_prefill_defaults() {
    let prefill = Prefill::default();
    let view = build_tldr_modal(&prefill);
    assert_eq!(view["type"], "modal");
    assert_eq!(view["callback_id"], "tldr_config_submit");
    let blocks = view["blocks"].as_array().expect("blocks array");
    assert!(blocks.len() >= 6);
    // conversations_select present
    assert_eq!(blocks[0]["type"], "input");
    assert_eq!(blocks[0]["block_id"], "conv");
    assert_eq!(blocks[0]["element"]["type"], "conversations_select");
}

#[test]
fn build_modal_prefill_values() {
    let prefill = Prefill {
        initial_conversation: Some("C123".into()),
        last_n: Some(250),
        custom_prompt: Some("Bulleted, action items".into()),
        dest_canvas: true,
        dest_dm: true,
        dest_public_post: false,
    };
    let view = build_tldr_modal(&prefill);
    // Check initial conversation applied
    assert_eq!(view["blocks"][0]["element"]["initial_conversation"], "C123");
    // Check number input prefill
    assert_eq!(view["blocks"][2]["element"]["initial_value"], "250");
}

#[test]
fn validate_view_submission_lastn_errors() {
    // Too low (less than 2)
    let view = json!({
        "state": { "values": { "lastn": { "n": { "value": "1" } } } }
    });
    let err = validate_view_submission(&view).unwrap_err();
    assert!(err.contains_key("lastn"));

    // Not a number
    let view2 = json!({
        "state": { "values": { "lastn": { "n": { "value": "abc" } } } }
    });
    let err2 = validate_view_submission(&view2).unwrap_err();
    assert!(err2.contains_key("lastn"));
}

#[test]
fn validate_view_submission_ok() {
    // Valid N within range
    let view = json!({
        "state": { "values": { "lastn": { "n": { "value": "100" } } } }
    });
    let ok = validate_view_submission(&view);
    assert!(ok.is_ok());
}

#[test]
fn modal_contains_required_fields() {
    let view = build_tldr_modal(&Prefill::default());
    assert_eq!(view["type"], "modal");
    assert!(view["title"].is_object());
    assert!(view["blocks"].is_array());
    // Must include submit for input blocks per Slack docs
    assert_eq!(view["submit"]["type"], "plain_text");
}
