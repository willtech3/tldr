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
    expect(replies).toHaveBeenCalledWith({ channel: 'C1', ts: '100.000000', limit: 999, inclusive: true });
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
    expect(shown).toEqual(Array(10).fill(40));
  });

  it('reads short threads whole even when long threads could use the entire allowance', async () => {
    const big = Array.from({ length: 7 }, (_, i) => ({ ts: `${100 + i}.000000`, user: 'U1', text: `big${i}`, reply_count: 80 }));
    const small = Array.from({ length: 13 }, (_, i) => ({ ts: `${200 + i}.000000`, user: 'U1', text: `small${i}`, reply_count: 2 }));
    const threads = Object.fromEntries([...big, ...small].map((parent, i) => [
      parent.ts, Array.from({ length: parent.reply_count }, (_, j) => reply(parent.ts, `${10_000 + i * 100 + j}.000000`, `r${i}-${j}`)),
    ]));
    const { client } = makeClient([...big, ...small], threads);
    const messages = await loadSourceMessages(client, 'C1', 50);
    const parents = messages.filter((m) => m.parentTs === undefined);
    expect(parents.filter((m) => m.text.startsWith('small')).map((m) => m.repliesShown)).toEqual(Array(13).fill(2));
    expect(parents.filter((m) => m.text.startsWith('big')).every((m) => (m.repliesShown ?? 0) >= 53)).toBe(true);
    expect(messages.filter((m) => m.parentTs !== undefined).length).toBeLessThanOrEqual(MAX_THREAD_REPLIES_TOTAL);
  });

  it('stops asking for threads once Slack rate-limits a read, and still returns the channel messages', async () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ ts: `${100 + i}.000000`, user: 'U1', text: `t${i}`, reply_count: 2 }));
    const limited = Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error' });
    const { client, replies } = makeClient(history, Object.fromEntries(history.map((parent) => [parent.ts, limited])));
    const messages = await loadSourceMessages(client, 'C1', 50);
    expect(replies).toHaveBeenCalledTimes(5);
    expect(messages).toHaveLength(12);
    expect(messages.every((m) => m.repliesShown === 0 && m.repliesOmitted === 2)).toBe(true);
  });

  it('reads threads through the dedicated thread client when one is supplied', async () => {
    const history = [{ ts: '100.000000', user: 'U1', text: 'parent', reply_count: 1 }];
    const main = makeClient(history);
    const side = makeClient(history, { '100.000000': [reply('100.000000', '110.000000', 'answer')] });
    const messages = await loadSourceMessages(main.client, 'C1', 50, undefined, side.client);
    expect(main.replies).not.toHaveBeenCalled();
    expect(messages.map((m) => m.text)).toEqual(['parent', 'answer']);
  });

  it('bounds thread replies to a frozen summary window', async () => {
    const window = { oldestTs: '100.000000', latestTs: '500.000000' };
    const { client, replies } = makeClient([{ ts: '100.000000', user: 'U1', text: 'parent', reply_count: 1 }]);
    await loadSourceMessages(client, 'C1', 50, window);
    expect(replies).toHaveBeenCalledWith({ channel: 'C1', ts: '100.000000', limit: 999, inclusive: true, latest: '500.000000' });
  });
});

describe('very long threads', () => {
  it('still reaches the real ending of a thread longer than 200 replies', async () => {
    const all = Array.from({ length: 300 }, (_, i) => reply('100.000000', `${1000 + i}.000000`, `reply ${i}`));
    const parent = { ts: '100.000000', user: 'U1', text: 'parent', reply_count: 300 };
    // Like Slack: one page holds at most `limit` messages, oldest first, parent included.
    const replies = jest.fn(async ({ limit }: { limit: number }) => ({ messages: [parent, ...all].slice(0, limit) }));
    const client = {
      conversations: { history: jest.fn().mockResolvedValue({ messages: [parent] }), replies },
      auth: { test: jest.fn().mockResolvedValue({ user_id: 'UBOT' }) },
    } as unknown as WebClient;
    const messages = await loadSourceMessages(client, 'C1', 50);
    expect(messages[messages.length - 1].text).toBe('reply 299');
    expect(messages[0]).toMatchObject({ repliesShown: 60, repliesOmitted: 240 });
  });

  it('follows has_more when Slack returns a short page', async () => {
    const all = Array.from({ length: 30 }, (_, i) => reply('100.000000', `${1000 + i}.000000`, `reply ${i}`));
    const parent = { ts: '100.000000', user: 'U1', text: 'parent', reply_count: 30 };
    const replies = jest.fn(async ({ cursor }: { cursor?: string }) => cursor
      ? { messages: all.slice(10), has_more: false }
      : { messages: [parent, ...all.slice(0, 10)], has_more: true, response_metadata: { next_cursor: 'next' } });
    const client = {
      conversations: { history: jest.fn().mockResolvedValue({ messages: [parent] }), replies },
      auth: { test: jest.fn().mockResolvedValue({ user_id: 'UBOT' }) },
    } as unknown as WebClient;
    const messages = await loadSourceMessages(client, 'C1', 50);
    expect(replies).toHaveBeenCalledTimes(2);
    expect(replies.mock.calls[1][0]).toMatchObject({ cursor: 'next' });
    expect(messages.slice(1).map((m) => m.text)).toEqual(all.map((m) => m.text));
    expect(messages[0]).toMatchObject({ repliesShown: 30, repliesOmitted: 0 });
  });

  it('reports the unread remainder when a thread outruns the page allowance', async () => {
    const parent = { ts: '100.000000', user: 'U1', text: 'parent', reply_count: 5000 };
    let next = 0;
    const replies = jest.fn(async () => ({
      messages: Array.from({ length: 10 }, () => reply('100.000000', `${1000 + next++}.000000`, 'r')),
      has_more: true, response_metadata: { next_cursor: 'more' },
    }));
    const client = {
      conversations: { history: jest.fn().mockResolvedValue({ messages: [parent] }), replies },
      auth: { test: jest.fn().mockResolvedValue({ user_id: 'UBOT' }) },
    } as unknown as WebClient;
    const messages = await loadSourceMessages(client, 'C1', 50);
    expect(replies).toHaveBeenCalledTimes(3);
    expect(messages[0]).toMatchObject({ repliesShown: 30, repliesOmitted: 4970 });
  });
});
