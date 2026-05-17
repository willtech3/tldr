use regex::Regex;
use std::sync::LazyLock;

pub const DEFAULT_MESSAGE_COUNT: u32 = 50;
pub const MIN_MESSAGE_COUNT: u32 = 1;
pub const MAX_MESSAGE_COUNT: u32 = 500;
pub const MAX_CUSTOM_PROMPT_CHARS: usize = 800;

static SLACK_CHANNEL_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Z][A-Z0-9]{8,}$").expect("valid Slack channel id regex"));

#[must_use]
pub fn normalize_message_count(count: Option<u32>) -> u32 {
    count
        .unwrap_or(DEFAULT_MESSAGE_COUNT)
        .clamp(MIN_MESSAGE_COUNT, MAX_MESSAGE_COUNT)
}

#[must_use]
pub fn is_valid_slack_channel_id(channel_id: &str) -> bool {
    SLACK_CHANNEL_ID_RE.is_match(channel_id)
}

#[must_use]
pub fn sanitize_custom_prompt_for_task(prompt: Option<&str>) -> Option<String> {
    let cleaned: String = prompt?
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_CUSTOM_PROMPT_CHARS)
        .collect::<String>()
        .trim()
        .to_string();

    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_message_count() {
        assert_eq!(normalize_message_count(None), DEFAULT_MESSAGE_COUNT);
        assert_eq!(normalize_message_count(Some(0)), MIN_MESSAGE_COUNT);
        assert_eq!(normalize_message_count(Some(1_000_000)), MAX_MESSAGE_COUNT);
        assert_eq!(normalize_message_count(Some(42)), 42);
    }

    #[test]
    fn validates_slack_channel_ids() {
        assert!(is_valid_slack_channel_id("C123456789"));
        assert!(is_valid_slack_channel_id("G123456789"));
        assert!(is_valid_slack_channel_id("D123456789"));
        assert!(!is_valid_slack_channel_id("not-a-channel"));
    }

    #[test]
    fn sanitizes_custom_prompt() {
        assert_eq!(
            sanitize_custom_prompt_for_task(Some("  concise\u{0000} please  ")).as_deref(),
            Some("concise please")
        );
        assert_eq!(sanitize_custom_prompt_for_task(Some(" \n\t ")), None);
        assert_eq!(
            sanitize_custom_prompt_for_task(Some(&"a".repeat(MAX_CUSTOM_PROMPT_CHARS + 50)))
                .unwrap()
                .chars()
                .count(),
            MAX_CUSTOM_PROMPT_CHARS
        );
    }
}
