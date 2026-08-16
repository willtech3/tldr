import {
  EMPTY_FILE_SHARE_TEXT,
  assistantUserText,
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

describe('assistantUserText', () => {
  it('uses the caption when the user typed one', () => {
    expect(assistantUserText({ text: '  what is this?  ', subtype: 'file_share' })).toBe(
      'what is this?'
    );
    expect(assistantUserText({ text: 'hello' })).toBe('hello');
  });

  it('uses a placeholder when a file is shared with no caption', () => {
    expect(assistantUserText({ subtype: 'file_share' })).toBe(EMPTY_FILE_SHARE_TEXT);
    expect(assistantUserText({ text: '   ', subtype: 'file_share' })).toBe(EMPTY_FILE_SHARE_TEXT);
  });

  it('returns empty for a blank ordinary message', () => {
    expect(assistantUserText({ text: '' })).toBe('');
    expect(assistantUserText({})).toBe('');
  });
});
