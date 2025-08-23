use slack_morphism::SlackHistoryMessage;
use slack_morphism::events::SlackMessageEventType;

/// Filters a list of Slack messages, retaining only those that are from users
/// and are not system messages or from the bot itself.
#[must_use]
pub fn filter_user_messages(
    messages: Vec<SlackHistoryMessage>,
    bot_user_id: Option<&str>,
) -> Vec<SlackHistoryMessage> {
    messages
        .into_iter()
        .filter(|msg| {
            let is_user_message = msg.sender.user.is_some();
            let is_system_message = match &msg.subtype {
                Some(subtype) => matches!(
                    subtype,
                    SlackMessageEventType::ChannelJoin | SlackMessageEventType::ChannelLeave
                ),
                None => false,
            };
            let is_from_this_bot = bot_user_id
                .and_then(|bot_id| msg.sender.user.as_ref().map(|u| u.0 == bot_id))
                .unwrap_or(false);
            let contains_tldr_command = msg
                .content
                .text
                .as_deref()
                .is_some_and(|text| text.contains("/tldr"));

            is_user_message && !is_system_message && !is_from_this_bot && !contains_tldr_command
        })
        .collect()
}
