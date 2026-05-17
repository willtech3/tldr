use regex::Regex;
use std::sync::LazyLock;

static BROADCAST_MENTION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"<!(channel|here|everyone)>").expect("valid broadcast mention regex")
});
static USER_MENTION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<@[UW][A-Z0-9]+>").expect("valid user mention regex"));
static USER_GROUP_MENTION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<!subteam\^[^>]+>").expect("valid user group mention regex"));

#[must_use]
pub fn sanitize_generated_slack_mrkdwn(text: &str) -> String {
    let sanitized = BROADCAST_MENTION_RE.replace_all(text, "`$0`");
    let sanitized = USER_GROUP_MENTION_RE.replace_all(&sanitized, "`$0`");
    USER_MENTION_RE.replace_all(&sanitized, "`$0`").to_string()
}

#[cfg(test)]
mod tests {
    use super::sanitize_generated_slack_mrkdwn;

    #[test]
    fn wraps_generated_mentions_in_code_spans() {
        let text = "Ping <!channel>, <!subteam^S123|ops>, and <@U123ABC456>";

        assert_eq!(
            sanitize_generated_slack_mrkdwn(text),
            "Ping `<!channel>`, `<!subteam^S123|ops>`, and `<@U123ABC456>`"
        );
    }

    #[test]
    fn leaves_links_alone() {
        let text = "<https://example.com|Example>";
        assert_eq!(sanitize_generated_slack_mrkdwn(text), text);
    }
}
