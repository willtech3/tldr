import { buildRateLimitMessage } from '../../src/handlers/run_summary';
import { RATE_LIMIT_MAX_PER_MINUTE } from '../../src/security';

describe('buildRateLimitMessage', () => {
  it('talks about requests (chat shares the budget), not just summaries', () => {
    const message = buildRateLimitMessage(2500);
    expect(message).toContain(`${RATE_LIMIT_MAX_PER_MINUTE} requests a minute`);
    expect(message).toContain('~3s');
  });

  it('never tells the user to wait zero seconds', () => {
    expect(buildRateLimitMessage(0)).toContain('~1s');
  });
});

import type { WebClient } from '@slack/web-api';
import type { AppConfig } from '../../src/config';
import { guardAndRunSummarization, type GuardedSummarizeArgs } from '../../src/handlers/run_summary';
import { MAX_SUMMARY_TO_SHORTEN_LENGTH } from '../../src/ai/prompt';
import { checkChannelMembership } from '../../src/security';
import { runSummarization } from '../../src/worker/summarize';
jest.mock('../../src/worker/summarize', () => ({ runSummarization: jest.fn().mockResolvedValue('empty') }));
jest.mock('../../src/security', () => ({
  ...jest.requireActual('../../src/security'),
  checkChannelMembership: jest.fn(),
}));

describe('source persistence guard', () => {
  let serial = 0;
  const fixture = () => {
    const client = {
      chat: { postMessage: jest.fn().mockResolvedValue({}) },
      assistant: { threads: { setStatus: jest.fn().mockResolvedValue({}) } },
    };
    return {
      client: client as unknown as WebClient,
      config: {} as AppConfig,
      userId: `source-guard-${++serial}`,
      sourceChannelId: 'C012345678',
      assistantChannelId: 'D012345678',
      assistantThreadTs: '1788888888.000001',
      messageCount: 5,
      customStyle: null,
      beforeRun: jest.fn().mockResolvedValue(undefined),
      logger: { error: jest.fn(), warn: jest.fn() },
    };
  };
  beforeEach(() => jest.clearAllMocks());
  it.each(['not_member', 'unknown'] as const)('never persists or reads history when membership is %s', async (membership) => {
    const args = fixture();
    jest.mocked(checkChannelMembership).mockResolvedValue(membership);
    await guardAndRunSummarization(args);
    expect(args.beforeRun).not.toHaveBeenCalled();
    expect(runSummarization).not.toHaveBeenCalled();
  });
  it('refuses to summarize if the chosen source could not be saved', async () => {
    const args = fixture();
    jest.mocked(checkChannelMembership).mockResolvedValue('member');
    args.beforeRun.mockRejectedValue(new Error('state write failed'));
    await guardAndRunSummarization(args);
    expect(runSummarization).not.toHaveBeenCalled();
    expect(args.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("couldn't save that source") }));
  });
  it('saves before reading source messages after membership passes', async () => {
    const args = fixture();
    jest.mocked(checkChannelMembership).mockResolvedValue('member');
    await guardAndRunSummarization(args);
    expect(args.beforeRun).toHaveBeenCalledTimes(1);
    expect(runSummarization).toHaveBeenCalledTimes(1);
    expect(args.beforeRun.mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(runSummarization).mock.invocationCallOrder[0]);
  });
});

describe('saved-window guard', () => {
  const window = { oldestTs: '1788825600.000001', latestTs: '1788827400.000002' };
  let serial = 0;
  const fixture = () => ({
    client: { chat: { postMessage: jest.fn() }, assistant: { threads: { setStatus: jest.fn() } } } as unknown as WebClient,
    config: {} as AppConfig, userId: `window-guard-${++serial}`, sourceChannelId: 'C012345678',
    assistantChannelId: 'D012345678', assistantThreadTs: '1788840000.000001', messageCount: 5,
    customStyle: null, window, shorter: true, logger: { error: jest.fn(), warn: jest.fn() },
  });
  beforeEach(() => jest.clearAllMocks());
  it.each(['not_member', 'unknown'] as const)('does not read source history after membership becomes %s', async (membership) => {
    jest.mocked(checkChannelMembership).mockResolvedValue(membership);
    await guardAndRunSummarization(fixture());
    expect(runSummarization).not.toHaveBeenCalled();
  });
  it('refuses malformed window and count before any model or membership call', async () => {
    const args = fixture();
    await guardAndRunSummarization({ ...args, window: { ...window, oldestTs: 'bad' } });
    await guardAndRunSummarization({ ...args, messageCount: 501 });
    expect(runSummarization).not.toHaveBeenCalled();
    expect(checkChannelMembership).not.toHaveBeenCalled();
  });
  it('passes original source, window, count and Shorter through the guarded run', async () => {
    jest.mocked(checkChannelMembership).mockResolvedValue('member');
    await guardAndRunSummarization(fixture());
    expect(runSummarization).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({
      channelId: 'C012345678', messageCount: 5, window, shorter: true,
    }) }));
  });
});


describe('visible-recap guard', () => {
  const window = { oldestTs: '1788825600.000001', latestTs: '1788827400.000002' };
  let serial = 0;
  const fixture = (): GuardedSummarizeArgs => ({
    client: { chat: { postMessage: jest.fn() }, assistant: { threads: { setStatus: jest.fn() } } } as unknown as WebClient,
    config: {} as AppConfig, userId: `recap-guard-${++serial}`, sourceChannelId: 'C012345678',
    assistantChannelId: 'D012345678', assistantThreadTs: '1788840000.000001', messageCount: 5,
    customStyle: null, window, shorter: true, summaryToShorten: 'The visible dry-witted recap.',
    logger: { error: jest.fn(), warn: jest.fn() },
  });
  beforeEach(() => jest.clearAllMocks());

  it.each([
    { summaryToShorten: '' }, { summaryToShorten: ' \n ' }, { summaryToShorten: null },
    { summaryToShorten: 7 }, { summaryToShorten: 'x'.repeat(MAX_SUMMARY_TO_SHORTEN_LENGTH + 1) },
    { window: undefined }, { window: null }, { shorter: false }, { shorter: undefined },
    { shorter: 'true' }, { customStyle: {} }, { customStyle: 'x'.repeat(4001) },
  ])('rejects malformed shortening fields before membership or worker calls: case %#', async (override) => {
    const args = { ...fixture(), ...override } as unknown as GuardedSummarizeArgs;
    await guardAndRunSummarization(args);
    expect(args.client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(args.client.assistant.threads.setStatus).not.toHaveBeenCalled();
    expect(checkChannelMembership).not.toHaveBeenCalled();
    expect(runSummarization).not.toHaveBeenCalled();
  });

  it.each(['not_member', 'unknown'] as const)('does not bypass membership when prior visible recap exists: %s', async (membership) => {
    jest.mocked(checkChannelMembership).mockResolvedValue(membership);
    await guardAndRunSummarization(fixture());
    expect(runSummarization).not.toHaveBeenCalled();
  });

  it('passes only the supplied visible recap, original window, and normal style args to the worker', async () => {
    jest.mocked(checkChannelMembership).mockResolvedValue('member');
    const args = fixture();
    await guardAndRunSummarization(args);
    expect(runSummarization).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({
      channelId: args.sourceChannelId, window, shorter: true, customStyle: null,
      summaryToShorten: args.summaryToShorten,
    }) }));
  });
});
