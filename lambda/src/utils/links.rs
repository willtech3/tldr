use regex::Regex;
use serde_json::Value;
use slack_morphism::SlackHistoryMessage;
use std::collections::HashSet;
use url::Url;

/// Extract HTTP(S) links from Slack messages in a best-effort way.
///
/// We intentionally support:
/// - raw URLs like `https://example.com/foo`
/// - Slack link markup like `<https://example.com|label>` or `<https://example.com>`
/// - URLs embedded in `blocks` / `attachments` (by JSON string scanning)
///
/// We intentionally do **not** attempt to keep Slack "unfurl metadata" such as titles,
/// because slack-morphism's attachment model does not preserve all unfurl fields.
///
/// The output is normalized, deduped, and filtered to prefer non-Slack "message receipts".
#[must_use]
pub fn extract_links_from_messages(messages: &[SlackHistoryMessage]) -> Vec<String> {
    let mut raw: Vec<String> = Vec::new();
    for msg in messages {
        raw.extend(extract_links_from_message(msg));
    }
    normalize_and_dedupe_links(raw)
}

#[must_use]
pub fn extract_links_from_message(msg: &SlackHistoryMessage) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    if let Some(text) = msg.content.text.as_deref() {
        out.extend(extract_links_from_text(text));
    }

    if let Some(blocks) = msg.content.blocks.as_ref()
        && let Ok(v) = serde_json::to_value(blocks)
    {
        out.extend(extract_links_from_json_value(&v));
    }

    if let Some(atts) = msg.content.attachments.as_ref()
        && let Ok(v) = serde_json::to_value(atts)
    {
        out.extend(extract_links_from_json_value(&v));
    }

    out
}

#[must_use]
pub fn extract_links_from_text(text: &str) -> Vec<String> {
    // Slack link formatting uses angle brackets:
    // - <http://example.com/>
    // - <http://www.example.com|This message *is* a link>
    // Source: https://docs.slack.dev/messaging/formatting-message-text/#linking-urls
    static SLACK_LINK_RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"<(https?://[^>|\\s>]+)(?:\\|[^>]+)?>").unwrap_or_else(|_| {
            // Extremely defensive: in practice this cannot fail.
            Regex::new(r"$^").expect("fallback regex compiles")
        })
    });

    static RAW_URL_RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r#"https?://[^\s<>()\[\]{}"']+"#)
            .unwrap_or_else(|_| Regex::new(r"$^").expect("fallback regex compiles"))
    });

    let mut out: Vec<String> = Vec::new();

    for caps in SLACK_LINK_RE.captures_iter(text) {
        if let Some(m) = caps.get(1) {
            out.push(trim_trailing_punctuation(m.as_str()).to_string());
        }
    }

    for m in RAW_URL_RE.find_iter(text) {
        out.push(trim_trailing_punctuation(m.as_str()).to_string());
    }

    out
}

#[must_use]
fn extract_links_from_json_value(v: &Value) -> Vec<String> {
    // We don't attempt to fully model Slack block schema. Instead, scan any string
    // values for URLs. This catches fields like `url`, as well as markdown text
    // that contains a link.
    static RAW_URL_RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r#"https?://[^\s<>()\[\]{}"']+"#)
            .unwrap_or_else(|_| Regex::new(r"$^").expect("fallback regex compiles"))
    });

    let mut out: Vec<String> = Vec::new();

    walk_value_for_links(v, &mut out, &RAW_URL_RE);
    out
}

fn walk_value_for_links(node: &Value, out: &mut Vec<String>, re: &Regex) {
    match node {
        Value::String(s) => {
            for m in re.find_iter(s) {
                out.push(trim_trailing_punctuation(m.as_str()).to_string());
            }
        }
        Value::Array(arr) => {
            for item in arr {
                walk_value_for_links(item, out, re);
            }
        }
        Value::Object(map) => {
            for (_, val) in map {
                walk_value_for_links(val, out, re);
            }
        }
        _ => {}
    }
}

#[must_use]
pub fn normalize_and_dedupe_links<I>(raw_links: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();

    for raw in raw_links {
        let trimmed = trim_trailing_punctuation(raw.trim());
        if let Some(norm) = normalize_link(trimmed)
            && seen.insert(norm.clone())
        {
            out.push(norm);
        }
    }

    out
}

#[must_use]
fn normalize_link(raw: &str) -> Option<String> {
    let raw = raw
        .trim()
        .trim_matches(|c: char| matches!(c, '<' | '>' | '"' | '\''));
    if !(raw.starts_with("http://") || raw.starts_with("https://")) {
        return None;
    }

    let mut url = Url::parse(raw).ok()?;
    url.set_fragment(None);

    // Filter out Slack message permalinks and Slack file URLs from "Links shared";
    // these are better surfaced as "Receipts" (permalinks) or handled in image context.
    if let Some(host) = url.host_str().map(str::to_ascii_lowercase) {
        let path = url.path();
        let is_message_permalink = host.ends_with("slack.com") && path.contains("/archives/");
        let is_file_url = host == "slack-files.com"
            || host == "files.slack.com"
            || (host.ends_with("slack.com") && path.contains("/files-pri/"));

        if is_message_permalink || is_file_url {
            return None;
        }
    }

    // Prefer a slightly cleaner presentation.
    let rendered = url.to_string();
    let rendered = rendered.trim_end_matches('/').to_string();

    Some(rendered)
}

#[must_use]
fn trim_trailing_punctuation(s: &str) -> &str {
    s.trim_end_matches(&['.', ',', ';', ':', '!', '?', ')', ']', '}'][..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_links_from_slack_markup_and_raw_urls() {
        let text = "See <https://www.example.com|example> and also https://foo.bar/baz).";
        let links = extract_links_from_text(text);
        assert!(links.contains(&"https://www.example.com".to_string()));
        assert!(links.contains(&"https://foo.bar/baz".to_string()));
    }

    #[test]
    fn normalize_and_dedupe_filters_slack_message_permalinks() {
        let raw = vec![
            "https://example.com/a".to_string(),
            "https://example.com/a".to_string(),
            "https://acme.slack.com/archives/C123/p1234567890".to_string(),
        ];
        let norm = normalize_and_dedupe_links(raw);
        assert_eq!(norm, vec!["https://example.com/a".to_string()]);
    }
}
