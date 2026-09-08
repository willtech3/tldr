import type { App } from '@slack/bolt';
import type { AppConfig } from '../../src/config';
import { registerActionHandlers, parseSummaryTransformValue } from '../../src/handlers/actions';
import { guardAndRunSummarization } from '../../src/handlers/run_summary';
import { checkChannelMembership } from '../../src/security';
import { ROAST_STYLE } from '../../src/styles';
import { makeThreadKey, setCachedThreadState } from '../../src/thread_state';

jest.mock('../../src/handlers/run_summary', () => ({
  ...jest.requireActual('../../src/handlers/run_summary'), guardAndRunSummarization: jest.fn(),
}));
jest.mock('../../src/security', () => ({
  ...jest.requireActual('../../src/security'), checkChannelMembership: jest.fn().mockResolvedValue('member'),
}));
const window = { oldestTs: '1788825600.000001', latestTs: '1788827400.000002' };
const value = { v: 2, action: 'rerun_shorter', channelId: 'C012345678', count: 5, window, styleKey: 'roast', shorter: false };
function fixture(actionId = 'rerun_shorter', payload: unknown = value) {
  type Handler = (args: Record<string, unknown>) => Promise<void>;
  const registered: Record<string, Handler> = {};
  registerActionHandlers({ action: (id: string, handler: Handler) => { registered[id] = handler; } } as unknown as App, {} as AppConfig);
  const client = {
    chat: {
      postMessage: jest.fn().mockResolvedValue({ ts: '1788840000.000001' }),
      getPermalink: jest.fn().mockResolvedValue({ permalink: 'https://3kingdomgroup.slack.com/archives/C012345678/p1788840000000001' }),
    },
    conversations: { replies: jest.fn() },
  };
  const message = { ts: '1788830000.000001', thread_ts: '1788829999.000001', text: '**Summary of #testing-bots**\n\n3 messages\n\nA recap with <!channel>.' };
  const args = {
    ack: jest.fn(), client, logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
    body: { channel: { id: 'D012345678' }, user: { id: 'U012345678' }, message },
    action: { type: 'button', action_id: actionId, value: JSON.stringify(payload) },
  };
  return { client, message, args, run: () => registered[actionId](args) };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(checkChannelMembership).mockResolvedValue('member');
});

describe('summary transformations', () => {
  it('Shorter retains the source, count, window, and original preset without reading current thread settings', async () => {
    const f = fixture();
    await f.run();
    expect(guardAndRunSummarization).toHaveBeenCalledWith(expect.objectContaining({
      sourceChannelId: value.channelId, messageCount: 5, window, shorter: true, customStyle: ROAST_STYLE, summaryToShorten: f.message.text,
    }));
    expect(f.client.conversations.replies).not.toHaveBeenCalled();
  });
  it('shortens the original visible recap without reading changed thread style or metadata', async () => {
    const f = fixture('rerun_shorter', { ...value, styleKey: 'custom' });
    f.message.text = 'Alice tried to roast the coffee; the coffee won.';
    setCachedThreadState({
      threadKey: makeThreadKey('D012345678', f.message.thread_ts), stateMessageTs: f.message.thread_ts,
      state: { viewingChannelId: 'C087654321', customStyle: 'Private new instructions: discuss my family.', defaultMessageCount: 500 },
    });
    Object.assign(f.message, { metadata: { event_type: 'tldr_summary_v1', event_payload: {
      custom_style: 'Private old instructions that must not be reused.',
    } } });
    await f.run();
    expect(guardAndRunSummarization).toHaveBeenCalledWith(expect.objectContaining({
      customStyle: null, window, shorter: true, summaryToShorten: f.message.text,
    }));
    expect(JSON.stringify(jest.mocked(guardAndRunSummarization).mock.calls[0][0])).not.toContain('Private');
    expect(f.client.conversations.replies).not.toHaveBeenCalled();
  });
  it('uses the visible Markdown block rather than a notification fallback', async () => {
    const f = fixture('rerun_shorter', { ...value, styleKey: 'custom' });
    f.message.text = 'Notification fallback';
    Object.assign(f.message, { blocks: [{ type: 'markdown', text: 'The actual recap with its original tone.' }] });
    await f.run();
    expect(guardAndRunSummarization).toHaveBeenCalledWith(expect.objectContaining({
      customStyle: null, summaryToShorten: 'The actual recap with its original tone.',
    }));
    expect(f.client.conversations.replies).not.toHaveBeenCalled();
  });
  it.each(['', '   ', 'x'.repeat(12001)])('rejects missing or oversized visible recap without a metadata lookup', async (text) => {
    const f = fixture('rerun_shorter', { ...value, styleKey: 'custom' });
    f.message.text = text;
    await f.run();
    expect(guardAndRunSummarization).not.toHaveBeenCalled();
    expect(f.client.conversations.replies).not.toHaveBeenCalled();
    expect(f.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('smaller message limit') }));
  });
  it.each([
    { ...value, window: undefined }, { ...value, window: { ...window, oldestTs: 'bad' } },
    { ...value, count: 501 }, { ...value, count: 0 }, { ...value, count: 2.5 },
    { ...value, window: { oldestTs: window.latestTs, latestTs: window.oldestTs } },
    { ...value, v: 1 }, { action: 'rerun_roast', channelId: value.channelId, count: 5 },
  ])('asks for refresh instead of widening a malformed or legacy payload (%p)', async (payload) => {
    const f = fixture('rerun_shorter', payload);
    await f.run();
    expect(guardAndRunSummarization).not.toHaveBeenCalled();
    expect(f.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Refresh the source') }));
  });
  it('bounds JSON parsing before interpreting action data', () => {
    expect(parseSummaryTransformValue('x'.repeat(2001))).toBeNull();
    expect(parseSummaryTransformValue('null')).toBeNull();
    expect(parseSummaryTransformValue('{')).toBeNull();
  });
});

describe('sharing', () => {
  const share = { action: 'share_summary', sourceChannelId: value.channelId, count: 3, styleKind: 'default' };
  it('shares only to the named source with actual count, sanitized text, and a success permalink', async () => {
    const f = fixture('share_summary', share);
    await f.run();
    const post = f.client.chat.postMessage.mock.calls[0][0];
    expect(post.channel).toBe(value.channelId);
    expect(post.text).toContain('these 3 messages');
    expect(JSON.stringify(post.blocks)).toContain('`<!channel>`');
    const success = f.client.chat.postMessage.mock.calls[1][0];
    expect(success.channel).toBe('D012345678');
    expect(success.text).toContain('|View message>');
  });
  it.each(['not_member', 'unknown'] as const)('does not post publicly when source membership is %s', async (membership) => {
    jest.mocked(checkChannelMembership).mockResolvedValue(membership);
    const f = fixture('share_summary', share);
    await f.run();
    expect(f.client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(f.client.chat.postMessage.mock.calls[0][0].channel).toBe('D012345678');
    expect(f.client.chat.getPermalink).not.toHaveBeenCalled();
  });
});


describe('retry scope and confirmation failures', () => {
  it('never retries a custom transform with mutable thread settings', async () => {
    const f = fixture('retry_summary', { channelId: value.channelId, count: 5, window, shorter: true, requiresOriginal: true });
    await f.run();
    expect(guardAndRunSummarization).not.toHaveBeenCalled();
    expect(f.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('original summary') }));
    expect(f.client.conversations.replies).not.toHaveBeenCalled();
  });
  it('preserves a valid saved retry window and preset', async () => {
    const f = fixture('retry_summary', { channelId: value.channelId, count: 5, window, shorter: true, styleKey: 'roast' });
    await f.run();
    expect(guardAndRunSummarization).toHaveBeenCalledWith(expect.objectContaining({ window, messageCount: 5, shorter: true, customStyle: ROAST_STYLE }));
  });
  it.each([
    { channelId: value.channelId, count: 5, window: null },
    { channelId: value.channelId, count: 900, window },
    { channelId: value.channelId, count: 5, window, styleKey: 'made-up' },
  ])('refuses malformed retries without substituting a fresh fetch', async (payload) => {
    const f = fixture('retry_summary', payload);
    await f.run();
    expect(guardAndRunSummarization).not.toHaveBeenCalled();
    expect(f.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Refresh') }));
  });
  it('does not claim a successful public share failed if its private confirmation fails', async () => {
    const f = fixture('share_summary', { action: 'share_summary', sourceChannelId: value.channelId, count: 3 });
    f.client.chat.postMessage.mockResolvedValueOnce({ ts: '1788840000.000001' }).mockRejectedValueOnce(new Error('confirmation failed'));
    await f.run();
    expect(f.client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(f.args.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Summary shared'), expect.any(Error));
    expect(f.args.logger.error).not.toHaveBeenCalled();
  });
});
