import {
  FILE_ATTACHMENT_NOTE,
  FILE_SHARE_NO_CAPTION_REPLY,
  appContextChannelId,
  routeAssistantUserMessage,
  shouldIgnoreAssistantUserMessage,
} from '../../src/handlers/assistant';

describe('shouldIgnoreAssistantUserMessage', () => {
  it('drops bot messages so we cannot loop on our own posts', () => {
    expect(shouldIgnoreAssistantUserMessage({ bot_id: 'B1' })).toBe(true);
    expect(shouldIgnoreAssistantUserMessage({ bot_id: 'B1', subtype: 'file_share' })).toBe(true);
  });

  it('drops edits and other system subtypes', () => {
    expect(shouldIgnoreAssistantUserMessage({ subtype: 'message_changed' })).toBe(true);
    expect(shouldIgnoreAssistantUserMessage({ subtype: 'message_deleted' })).toBe(true);
  });

  it('lets ordinary user text and file shares through', () => {
    expect(shouldIgnoreAssistantUserMessage({})).toBe(false);
    expect(shouldIgnoreAssistantUserMessage({ subtype: undefined })).toBe(false);
    expect(shouldIgnoreAssistantUserMessage({ subtype: 'file_share' })).toBe(false);
  });
});

describe('routeAssistantUserMessage', () => {
  it('answers a captionless file share with the canned no-caption reply', () => {
    expect(routeAssistantUserMessage({ subtype: 'file_share' })).toEqual({
      kind: 'file_share_no_caption',
    });
    expect(routeAssistantUserMessage({ text: '   ', subtype: 'file_share' })).toEqual({
      kind: 'file_share_no_caption',
    });
  });

  it('sends captioned file shares to chat with the attachment note', () => {
    const route = routeAssistantUserMessage({
      text: '  what color is this?  ',
      subtype: 'file_share',
    });
    expect(route).toEqual({
      kind: 'chat',
      userText: `what color is this?\n${FILE_ATTACHMENT_NOTE}`,
    });
  });

  it('never runs command captions on a file share — "tldr" means the file, not the channel', () => {
    for (const caption of ['tldr', 'summarize', 'summarize #general', 'help', 'style: be brief']) {
      const route = routeAssistantUserMessage({ text: caption, subtype: 'file_share' });
      expect(route.kind).toBe('chat');
    }
  });

  it('parses typed commands exactly as before', () => {
    const summarize = routeAssistantUserMessage({ text: 'summarize' });
    expect(summarize.kind).toBe('command');
    expect(summarize.kind === 'command' && summarize.intent.type).toBe('summarize');

    const help = routeAssistantUserMessage({ text: 'help' });
    expect(help.kind === 'command' && help.intent.type).toBe('help');

    const style = routeAssistantUserMessage({ text: 'style: write as a haiku' });
    expect(style.kind === 'command' && style.intent.type).toBe('style');
  });

  it('routes non-command text to chat unchanged', () => {
    expect(routeAssistantUserMessage({ text: 'hey, who are you?' })).toEqual({
      kind: 'chat',
      userText: 'hey, who are you?',
    });
  });

  it('keeps the canned reply and the attachment note honest about being text-only', () => {
    expect(FILE_SHARE_NO_CAPTION_REPLY).toContain("can't open files");
    expect(FILE_ATTACHMENT_NOTE).toContain('cannot see attachments');
  });
});

describe('appContextChannelId', () => {
  it('returns the first channel entity from the message app_context', () => {
    expect(
      appContextChannelId({
        app_context: {
          entities: [
            { type: 'slack#/types/thread_ts', value: '123.456' },
            { type: 'slack#/types/channel_id', value: 'C012345678' },
            { type: 'slack#/types/channel_id', value: 'C099999999' },
          ],
        },
      })
    ).toBe('C012345678');
  });

  it('returns null when the field is absent (legacy assistant_view manifest)', () => {
    expect(appContextChannelId({})).toBeNull();
    expect(appContextChannelId({ app_context: {} })).toBeNull();
    expect(appContextChannelId({ app_context: { entities: [] } })).toBeNull();
  });

  it('rejects malformed channel ids rather than passing them to Slack calls', () => {
    expect(
      appContextChannelId({
        app_context: { entities: [{ type: 'slack#/types/channel_id', value: 'not-a-channel' }] },
      })
    ).toBeNull();
  });
});
