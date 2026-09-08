import type { App } from '@slack/bolt';
import type { AppConfig } from '../../src/config';
import { registerActionHandlers } from '../../src/handlers/actions';
import { guardAndRunSummarization } from '../../src/handlers/run_summary';

jest.mock('../../src/handlers/run_summary', () => ({
  ...jest.requireActual('../../src/handlers/run_summary'), guardAndRunSummarization: jest.fn(),
}));
jest.mock('../../src/security', () => ({
  ...jest.requireActual('../../src/security'), checkChannelMembership: jest.fn().mockResolvedValue('member'),
}));
const source = 'C012345678';
const link = 'https://3kingdomgroup.slack.com/archives/C012345678/p1788888888000001';
const footer = [
  { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Shorter' }, accessibility_label: 'Shorter using the same channel and time window' }] },
  { type: 'context', elements: [{ type: 'mrkdwn', text: 'AI-generated · Get latest' }] },
];
const rich = { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [
  { type: 'text', text: 'Alice won the debate. ' }, { type: 'link', text: 'Read the exchange', url: link },
] }] };
function fixture(actionId: string, blocks: unknown[]) {
  type Handler = (args: Record<string, unknown>) => Promise<void>;
  const registered: Record<string, Handler> = {};
  registerActionHandlers({ action: (id: string, handler: Handler) => { registered[id] = handler; } } as unknown as App, {} as AppConfig);
  const payload = actionId === 'share_summary'
    ? { action: actionId, sourceChannelId: source, count: 3 }
    : { v: 2, action: actionId, channelId: source, count: 3, styleKey: 'custom', shorter: false,
      window: { oldestTs: '1788888800.000001', latestTs: '1788888888.000001' } };
  const client = { chat: { postMessage: jest.fn().mockResolvedValue({ ts: '1788888999.000001' }), getPermalink: jest.fn().mockResolvedValue({ permalink: link }) } };
  const args = {
    ack: jest.fn(), client, logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
    body: { channel: { id: 'D012345678' }, user: { id: 'U012345678' }, message: {
      ts: '1788888889.000001', text: 'Alice won the debate. Shorter using the same channel and time window button AI-generated with interactive elements', blocks,
    } },
    action: { type: 'button', action_id: actionId, value: JSON.stringify(payload) },
  };
  return { client, run: () => registered[actionId](args) };
}

beforeEach(() => jest.clearAllMocks());

it('shares a streamed recap with its source link, without accessibility controls or provenance', async () => {
  const f = fixture('share_summary', [rich, ...footer]);
  await f.run();
  const publicPost = f.client.chat.postMessage.mock.calls[0][0];
  expect(publicPost.channel).toBe(source);
  expect(publicPost.blocks[1].text).toBe(`Alice won the debate. [Read the exchange](${link})`);
  expect(JSON.stringify(publicPost)).not.toMatch(/Shorter|interactive elements|AI-generated/);
});

it('Shorter receives only the structured visible recap and its links', async () => {
  const f = fixture('rerun_shorter', [rich, ...footer]);
  await f.run();
  const request = jest.mocked(guardAndRunSummarization).mock.calls[0][0];
  expect(request.summaryToShorten).toBe(`Alice won the debate. [Read the exchange](${link})`);
  expect(request.customStyle).toBeNull();
});

it.each([{ blocks: footer }, { blocks: [{ type: 'unsupported_future_stream_block', text: 'unknown recap representation' }, ...footer] }])(
  'refuses to share when the structured recap is missing or unsupported: case %#', async ({ blocks }) => {
    const f = fixture('share_summary', blocks);
    await f.run();
    expect(f.client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(f.client.chat.postMessage.mock.calls[0][0].channel).toBe('D012345678');
    expect(f.client.chat.getPermalink).not.toHaveBeenCalled();
  }
);
