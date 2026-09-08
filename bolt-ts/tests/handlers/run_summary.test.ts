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
import { guardAndRunSummarization } from '../../src/handlers/run_summary';
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
