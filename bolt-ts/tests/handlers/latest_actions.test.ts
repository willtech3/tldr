import type { App } from '@slack/bolt';
import type { AppConfig } from '../../src/config';
import { registerActionHandlers } from '../../src/handlers/actions';
import { ACTION_SUMMARY_LATEST } from '../../src/summary_latest';
import { checkChannelMembership } from '../../src/security';
import { runSummarization } from '../../src/worker/summarize';
import { ROAST_STYLE } from '../../src/styles';
import { makeThreadKey, setCachedThreadState } from '../../src/thread_state';

jest.mock('../../src/worker/summarize', () => ({ runSummarization: jest.fn().mockResolvedValue('empty') }));
jest.mock('../../src/security', () => ({
  ...jest.requireActual('../../src/security'), checkChannelMembership: jest.fn(),
}));
const value = { v: 1, action: 'refresh_latest', channelId: 'C012345678', count: 5, styleKey: 'roast' };
let serial = 0;
function fixture(payload: unknown = value) {
  type Handler = (args: Record<string, unknown>) => Promise<void>;
  const registered: Record<string, Handler> = {};
  registerActionHandlers({ action: (id: string, handler: Handler) => { registered[id] = handler; } } as unknown as App, {} as AppConfig);
  const client = {
    chat: { postMessage: jest.fn().mockResolvedValue({}) },
    assistant: { threads: { setStatus: jest.fn().mockResolvedValue({}) } },
    conversations: { replies: jest.fn() },
  };
  const args = {
    ack: jest.fn(), client, logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
    body: {
      channel: { id: 'D012345678' }, user: { id: `latest-action-${++serial}` },
      message: { ts: '1788888888.000001', text: 'Old visible recap', metadata: { event_payload: { custom_style: 'private old instructions' } } },
    },
    action: { type: 'overflow', action_id: ACTION_SUMMARY_LATEST, selected_option: { value: JSON.stringify(payload) } },
  };
  return { client, args, run: () => registered[ACTION_SUMMARY_LATEST](args) };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(checkChannelMembership).mockResolvedValue('member');
});

it.each(['refresh_latest', 'expand_latest'])('%s uses the result source and selected count through the normal guard', async (action) => {
  const f = fixture({ ...value, action, count: action === 'expand_latest' ? 200 : 5 });
  setCachedThreadState({
    threadKey: makeThreadKey('D012345678', f.args.body.message.ts), stateMessageTs: f.args.body.message.ts,
    state: { viewingChannelId: 'C087654321', customStyle: 'private new instructions', defaultMessageCount: 500 },
  });
  await f.run();
  expect(f.args.ack).toHaveBeenCalledTimes(1);
  expect(checkChannelMembership).toHaveBeenCalledWith(expect.objectContaining({ channelId: value.channelId, userId: f.args.body.user.id }));
  const request = jest.mocked(runSummarization).mock.calls[0][0].request;
  expect(request).toMatchObject({ channelId: value.channelId, messageCount: action === 'expand_latest' ? 200 : 5, customStyle: ROAST_STYLE });
  expect(request.window).toBeUndefined();
  expect(request.shorter).toBeUndefined();
  expect(request.summaryToShorten).toBeUndefined();
  expect(JSON.stringify(request)).not.toContain('private');
  expect(f.client.conversations.replies).not.toHaveBeenCalled();
});

it('uses explicit Default rather than saved custom instructions', async () => {
  const f = fixture({ ...value, styleKey: 'default' });
  await f.run();
  expect(jest.mocked(runSummarization).mock.calls[0][0].request.customStyle).toBeNull();
});

it.each(['not_member', 'unknown'] as const)('refuses all fresh history and model work when membership is %s', async (membership) => {
  jest.mocked(checkChannelMembership).mockResolvedValue(membership);
  const f = fixture();
  await f.run();
  expect(runSummarization).not.toHaveBeenCalled();
  expect(f.client.assistant.threads.setStatus).not.toHaveBeenCalled();
  expect(f.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'D012345678' }));
});

it.each([
  { ...value, count: 501 }, { ...value, channelId: 'bad' }, { ...value, v: 2 },
  { ...value, styleKey: 'custom' }, { ...value, window: null }, { ...value, action: 'rerun_roast' },
])('rejects malformed options before membership without substituting thread defaults: case %#', async (payload) => {
  const f = fixture(payload);
  await f.run();
  expect(checkChannelMembership).not.toHaveBeenCalled();
  expect(runSummarization).not.toHaveBeenCalled();
  expect(f.client.conversations.replies).not.toHaveBeenCalled();
});
