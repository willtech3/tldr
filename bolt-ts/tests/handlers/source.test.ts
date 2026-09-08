import type { AppConfig } from '../../src/config';
import { createAssistant } from '../../src/handlers/assistant';
import { registerActionHandlers } from '../../src/handlers/actions';
import { guardAndRunSummarization } from '../../src/handlers/run_summary';
import { checkChannelMembership } from '../../src/security';
import { buildThreadStateMetadata, parseThreadContextFromMetadata, getCachedThreadState, makeThreadKey, setCachedThreadState } from '../../src/thread_state';

jest.mock('@slack/bolt', () => ({ Assistant: jest.fn((options) => options) }));
jest.mock('../../src/handlers/run_summary', () => ({
  ...jest.requireActual('../../src/handlers/run_summary'),
  guardAndRunSummarization: jest.fn(),
}));
jest.mock('../../src/security', () => ({
  ...jest.requireActual('../../src/security'),
  checkChannelMembership: jest.fn().mockResolvedValue('member'),
}));
const config = {} as AppConfig;
const source = 'C012345678';
const replacement = 'C087654321';
let serial = 0;
function fixture() {
  const threadTs = `178884${String(++serial).padStart(4, '0')}.000001`;
  const channelId = 'D012345678';
  const state = { viewingChannelId: source, customStyle: 'be brief', defaultMessageCount: 5 };
  setCachedThreadState({ threadKey: makeThreadKey(channelId, threadTs), stateMessageTs: threadTs, state });
  let persistedState = state;
  const client = {
    chat: { update: jest.fn().mockImplementation(async (args) => {
      persistedState = parseThreadContextFromMetadata(args.metadata.event_payload) as typeof state;
      return { ok: true };
    }), postMessage: jest.fn().mockResolvedValue({ ts: threadTs }) },
    conversations: { replies: jest.fn().mockImplementation(async () => ({ messages: [{ ts: threadTs, metadata: buildThreadStateMetadata(persistedState) }] })) },
    assistant: { threads: { setSuggestedPrompts: jest.fn().mockResolvedValue({}), setTitle: jest.fn() } },
  };
  const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
  const body = { channel: { id: channelId }, message: { ts: threadTs, thread_ts: threadTs }, user: { id: 'U012345678' } };
  const current = () => getCachedThreadState(makeThreadKey(channelId, threadTs))?.state;
  return { threadTs, channelId, state, client, logger, body, current };
}
function actions() {
  const registered: Record<string, (args: any) => Promise<void>> = {};
  registerActionHandlers({ action: (id: string, handler: (args: any) => Promise<void>) => { registered[id] = handler; } } as any, config);
  return registered;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(checkChannelMembership).mockResolvedValue('member');
});

describe('source selection', () => {
  it('persists the source while retaining style and count, then quick summarize uses it', async () => {
    const f = fixture();
    const handlers = actions();
    await handlers.select_source({ ...f, ack: jest.fn(), action: { type: 'conversations_select', selected_conversation: replacement } });
    expect(f.current()).toEqual({ ...f.state, viewingChannelId: replacement });
    const prompts = f.client.assistant.threads.setSuggestedPrompts.mock.calls.at(-1)![0].prompts;
    expect(prompts.every((prompt: { message: string }) => prompt.message.includes(`<#${replacement}>`))).toBe(true);
    expect(f.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ event_payload: expect.objectContaining({ viewing_channel_id: replacement }) }),
    }));
    await handlers.quick_summarize({ ...f, ack: jest.fn() });
    expect(guardAndRunSummarization).toHaveBeenCalledWith(expect.objectContaining({ sourceChannelId: replacement, messageCount: 5, customStyle: 'be brief' }));
  });

  it.each(['not_member', 'unknown'] as const)('does not persist when membership is %s', async (membership) => {
    const f = fixture();
    jest.mocked(checkChannelMembership).mockResolvedValue(membership);
    await actions().select_source({ ...f, ack: jest.fn(), action: { type: 'conversations_select', selected_conversation: replacement } });
    expect(f.client.chat.update).not.toHaveBeenCalled();
    expect(f.current()).toEqual(f.state);
    expect(f.client.chat.postMessage).toHaveBeenCalled();
  });

  it('does not change cached source if Slack rejects the write', async () => {
    const f = fixture();
    f.client.chat.update.mockRejectedValue(new Error('write failed'));
    await actions().select_source({ ...f, ack: jest.fn(), action: { type: 'conversations_select', selected_conversation: replacement } });
    expect(f.current()).toEqual(f.state);
    expect(f.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("couldn't save") }));
  });

  it('does not overwrite a pinned source after a cold-start state read failure', async () => {
    const f = fixture();
    const assistant = createAssistant(config) as any;
    f.client.conversations.replies.mockRejectedValue(new Error('history unavailable'));
    await assistant.threadContextChanged({ ...f, event: { assistant_thread: { channel_id: f.channelId, thread_ts: '1788999999.000002', context: { channel_id: replacement } } } });
    expect(f.client.chat.update).not.toHaveBeenCalled();
    expect(f.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('ignores navigation context once a thread has a source', async () => {
    const f = fixture();
    const assistant = createAssistant(config) as any;
    await assistant.threadContextChanged({ ...f, event: { assistant_thread: { channel_id: f.channelId, thread_ts: f.threadTs, context: { channel_id: replacement } } } });
    expect(f.current()).toEqual(f.state);
    expect(f.client.chat.update).not.toHaveBeenCalled();
  });

  it('uses the saved source over live navigation and pins explicit commands only after the guard', async () => {
    const f = fixture();
    const assistant = createAssistant(config) as any;
    const message = { channel: f.channelId, thread_ts: f.threadTs, ts: f.threadTs, user: 'U012345678', text: 'summarize', app_context: { entities: [{ type: 'slack#/types/channel_id', value: replacement }] } };
    await assistant.userMessage({ ...f, message });
    expect(guardAndRunSummarization).toHaveBeenLastCalledWith(expect.objectContaining({ sourceChannelId: source }));
    await assistant.userMessage({ ...f, message: { ...message, text: `summarize <#${replacement}>` } });
    expect(f.current()?.viewingChannelId).toBe(source);
    const args = jest.mocked(guardAndRunSummarization).mock.calls.at(-1)![0];
    expect(args.sourceChannelId).toBe(replacement);
    await args.beforeRun!();
    expect(f.current()?.viewingChannelId).toBe(replacement);
    await assistant.userMessage({ ...f, message: { ...message, app_context: undefined } });
    expect(guardAndRunSummarization).toHaveBeenLastCalledWith(expect.objectContaining({ sourceChannelId: replacement }));
  });
});
