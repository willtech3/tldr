use crate::bot::SlackBot;
use crate::errors::SlackError;
use slack_morphism::prelude::*;
use slack_morphism::{SlackChannelId, SlackMessageContent};

impl SlackBot {
    pub async fn send_dm(&self, user_id: &str, message: &str) -> Result<(), SlackError> {
        self.with_retry(|| async {
            let session = crate::bot::SLACK_CLIENT.open_session(&self.token);
            let im_channel = self.get_user_im_channel(user_id).await?;

            let post_req = SlackApiChatPostMessageRequest::new(
                SlackChannelId(im_channel),
                SlackMessageContent::new().with_text(message.to_string()),
            );

            session.chat_post_message(&post_req).await?;

            Ok(())
        })
        .await
    }

    pub async fn send_message_to_channel(
        &self,
        channel_id: &str,
        message: &str,
    ) -> Result<(), SlackError> {
        self.with_retry(|| async {
            let session = crate::bot::SLACK_CLIENT.open_session(&self.token);

            let post_req = SlackApiChatPostMessageRequest::new(
                SlackChannelId(channel_id.to_string()),
                SlackMessageContent::new().with_text(message.to_string()),
            );

            session.chat_post_message(&post_req).await?;

            Ok(())
        })
        .await
    }
}
