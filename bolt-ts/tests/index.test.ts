import { isSlackTimeoutRetry } from '../src/index';
import type { AwsEvent } from '@slack/bolt/dist/receivers/AwsLambdaReceiver';

function makeEvent(headers: Record<string, string | undefined>): AwsEvent {
  return { headers, body: '{}' } as unknown as AwsEvent;
}

describe('isSlackTimeoutRetry', () => {
  it('drops retries caused by our slow (inline) processing', () => {
    expect(
      isSlackTimeoutRetry(
        makeEvent({ 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' })
      )
    ).toBe(true);
  });

  it('matches headers case-insensitively (API Gateway preserves sender casing)', () => {
    expect(
      isSlackTimeoutRetry(
        makeEvent({ 'X-Slack-Retry-Num': '2', 'X-Slack-Retry-Reason': 'http_timeout' })
      )
    ).toBe(true);
  });

  it('keeps retries with other reasons — they are the cold-start recovery path', () => {
    expect(
      isSlackTimeoutRetry(
        makeEvent({ 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_error' })
      )
    ).toBe(false);
  });

  it('keeps first deliveries', () => {
    expect(isSlackTimeoutRetry(makeEvent({}))).toBe(false);
    expect(isSlackTimeoutRetry({ body: '{}' } as unknown as AwsEvent)).toBe(false);
  });
});
