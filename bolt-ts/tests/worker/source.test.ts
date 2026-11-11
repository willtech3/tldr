import type { WebClient } from '@slack/web-api';
import {
  MAX_REPLIES_PER_THREAD,
  MAX_THREADS_EXPANDED,
  MAX_THREAD_REPLIES_TOTAL,
  loadSourceMessages,
} from '../../src/worker/source';

interface RawMessage { ts: string; user?: string; text?: string; thread_ts?: string; reply_count?: number; subtype?: string }

/** `threads` maps a parent ts to its replies (the parent is prepended, as Slack does). */
function makeClient(history: RawMessage[], threads: Record<string, RawMessage[] | Error> = {}) {
  const replies = jest.fn(async ({ ts }: { ts: string }) => {
    const thread = threads[ts];
    if (thread instanceof Error) {
      throw thread;
    }
    const parent = history.find((message) => message.ts === ts) ?? { ts };
    return { messages: [parent, ...(thread ?? [])] };
  });
  const client = {
    conversations: { history: jest.fn().mockResolvedValue({ messages: history }), replies },
    auth: { test: jest.fn().mockResolvedValue({ user_id: 'UBOT' }) },
  } as unknown as WebClient;
  return { client, replies };
}

const reply = (parentTs: string, ts: string, text: string, user = 'U2'): RawMessage =>
  ({ ts, user, text, thread_ts: parentTs });

describe('loadSourceMessages', () => {
  it('returns channel messages oldest first when there are no threads, without calling conversations.replies', async () => {
    const { client, replies } = makeClient([
      { ts: '300.000000', user: 'U1', text: 'third' },
      { ts: '100.000000', user: 'U1', text: 'first' },
      { ts: '200.000000', user: 'U1', text: 'second' },
    ]);
    const messages = await loadSourceMessages(client, 'C1', 50);
    expect(messages.map((m) => m.text)).toEqual(['first', 'second', 'third']);
    expect(replies).not.toHaveBeenCalled();
  });

  it('puts thread replies directly under their parent, in order, and never repeats the parent', async () => {
    const { client, replies } = makeClient(
      [
        { ts: '300.000000', user: 'U1', text: 'unrelated later message' },
        { ts: '100.000000', user: 'U1', text: 'Ship Friday?', thread_ts: '100.000000', reply_count: 2 },
      ],
      { '100.000000': [reply('100.000000', '400.000000', 'Decided: ship Monday'), reply('100.000000', '150.000000', 'QA is not done')] }
    );
    const messages = await loadSourceMessages(client, 'C1', 50);
    expect(messages.map((m) => m.text)).toEqual([
      'Ship Friday?', 'QA is not done', 'Decided: ship Monday', 'unrelated later message',
    ]);
    expect(messages.map((m) => m.parentTs)).toEqual([undefined, '100.000000', '100.000000', undefined]);
    expect(messages[0]).toMatchObject({ repliesShown: 2, repliesOmitted: 0 });
    expect(replies).toHaveBeenCalledWith({ channel: 'C1', ts: '100.000000', limit: 200, inclusive: true });
  });

  it("drops TLDR's own posts, the threads under them, and its replies inside other threads", async () => {
    const { client, replies } = makeClient(
      [
        { ts: '200.000000', user: 'UBOT', text: 'a shared recap', thread_ts: '200.000000', reply_count: 3 },
        { ts: '100.000000', user: 'U1', text: 'question', thread_ts: '100.000000', reply_count: 2 },
      ],
      { '100.000000': [reply('100.000000', '110.000000', 'bot answer', 'UBOT'), reply('100.000000', '120.000000', 'human answer')] }
    );
    const messages = await loadSourceMessages(client, 'C1', 50);
    expect(messages.map((m) => m.text)).toEqual(['question', 'human answer']);
    expect(replies).toHaveBeenCalledTimes(1);
  });

  it('returns nothing, and reads no threads, when only the bot has posted', async () => {
    const { client, replies } = makeClient([{ ts: '1.000000', user: 'UBOT', text: 'me', reply_count: 4 }]);
    expect(await loadSourceMessages(client, 'C1', 50)).toEqual([]);
    expect(replies).not.toHaveBeenCalled();
  });

  it('keeps the recap alive when one thread cannot be read, and marks its replies as omitted', async () => {
    const { client } = makeClient(
      [
        { ts: '200.000000', user: 'U1', text: 'readable', reply_count: 1 },
        { ts: '100.000000', user: 'U1', text: 'unreadable', reply_count: 7 },
      ],
      { '200.000000': [reply('200.000000', '210.000000', 'ok')], '100.000000': new Error('ratelimited') }
    );
    const messages = await loadSourceMessages(client, 'C1', 50);
    expect(messages.map((m) => m.text)).toEqual(['unreadable', 'readable', 'ok']);
    expect(messages[0]).toMatchObject({ repliesShown: 0, repliesOmitted: 7 });
  });

  it('keeps one copy of a reply that was also sent to the channel', async () => {
    const broadcast = { ...reply('100.000000', '150.000000', 'also sent to channel'), subtype: 'thread_broadcast' };
    const { client } = makeClient(
      [broadcast, { ts: '100.000000', user: 'U1', text: 'parent', reply_count: 1 }],
      { '100.000000': [broadcast] }
    );
    const messages = await loadSourceMessages(client, 'C1', 50);
    expect(messages.map((m) => m.text)).toEqual(['parent', 'also sent to channel']);
    expect(messages[1].parentTs).toBe('100.000000');
  });

  it('trims a long thread to its opening and its ending, and says how many replies were left out', async () => {
    const long = Array.from({ length: 100 }, (_, i) => reply('100.000000', `${1000 + i}.000000`, `reply ${i}`));
    const { client } = makeClient([{ ts: '100.000000', user: 'U1', text: 'parent', reply_count: 100 }], { '100.000000': long });
    const messages = await loadSourceMessages(client, 'C1', 50);
    const kept = messages.slice(1).map((m) => m.text);
    expect(kept).toHaveLength(MAX_REPLIES_PER_THREAD);
    expect(kept[0]).toBe('reply 0');
    expect(kept[9]).toBe('reply 9');
    expect(kept[10]).toBe('reply 50');
    expect(kept[kept.length - 1]).toBe('reply 99');
    expect(messages[0]).toMatchObject({ repliesShown: 60, repliesOmitted: 40 });
  });

  it('reads the busiest threads first and marks the rest as omitted', async () => {
    const history = Array.from({ length: MAX_THREADS_EXPANDED + 2 }, (_, i) => ({
      ts: `${100 + i}.000000`, user: 'U1', text: `thread ${i}`, reply_count: i + 1,
    }));
    const { client, replies } = makeClient(history);
    const messages = await loadSourceMessages(client, 'C1', 50);
    expect(replies).toHaveBeenCalledTimes(MAX_THREADS_EXPANDED);
    const fetched = replies.mock.calls.map(([params]) => params.ts);
    expect(fetched).not.toContain('100.000000');
    expect(fetched).not.toContain('101.000000');
    expect(messages.find((m) => m.ts === '100.000000')).toMatchObject({ repliesShown: 0, repliesOmitted: 1 });
  });

  it('never exceeds the total reply allowance across threads', async () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ ts: `${100 + i}.000000`, user: 'U1', text: `t${i}`, reply_count: 80 }));
    const threads = Object.fromEntries(history.map((parent, i) => [
      parent.ts, Array.from({ length: 80 }, (_, j) => reply(parent.ts, `${10_000 + i * 100 + j}.000000`, `r${i}-${j}`)),
    ]));
    const { client } = makeClient(history, threads);
    const messages = await loadSourceMessages(client, 'C1', 50);
    expect(messages.filter((m) => m.parentTs !== undefined)).toHaveLength(MAX_THREAD_REPLIES_TOTAL);
    const shown = messages.filter((m) => m.parentTs === undefined).map((m) => m.repliesShown);
    expect(shown.filter((count) => count === 0)).toHaveLength(3);
  });

  it('bounds thread replies to a frozen summary window', async () => {
    const window = { oldestTs: '100.000000', latestTs: '500.000000' };
    const { client, replies } = makeClient([{ ts: '100.000000', user: 'U1', text: 'parent', reply_count: 1 }]);
    await loadSourceMessages(client, 'C1', 50, window);
    expect(replies).toHaveBeenCalledWith({ channel: 'C1', ts: '100.000000', limit: 200, inclusive: true, latest: '500.000000' });
  });
});
