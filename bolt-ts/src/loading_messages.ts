/**
 * Slack AI app assistant thread loading messages.
 *
 * Slack will rotate through `loading_messages` while the assistant thread status is active.
 * The API enforces a maximum of 10 messages.
 */

export type SummarizeLoadingMessagesOptions = Readonly<{
  messageCount: number;
  hasCustomStyle: boolean;
}>;

export function buildSummarizeLoadingMessages(
  options: SummarizeLoadingMessagesOptions,
): string[] {
  const { messageCount, hasCustomStyle } = options;

  const messages: string[] = [
    `Reading the last ${messageCount} messages…`,
    'Finding key themes…',
    'Extracting decisions and action items…',
    'Collecting important links…',
    'Noting any image highlights…',
    'Checking for receipts or confirmations…',
    hasCustomStyle ? 'Applying your custom style…' : 'Drafting a clear summary…',
    'Formatting for readability…',
    'Almost done…',
  ];

  // Slack enforces a maximum of 10 messages. Keep us safely under that limit.
  return messages.slice(0, 10);
}


