/**
 * AWS Lambda entry point for the single-service TLDR Slack AI App.
 *
 * Sets up the Bolt AWS Lambda receiver, wires the Bolt app, and delegates each
 * Lambda invocation to Bolt's handler. Bolt internally ACKs Slack events so
 * the Lambda HTTP response is sent promptly, while the rest of the handler
 * (including Anthropic streaming and Slack streaming-message posting) continues
 * to run inline within the Lambda invocation.
 */

import { AwsLambdaReceiver } from '@slack/bolt';
import type {
  AwsCallback,
  AwsEvent,
  AwsResponse,
} from '@slack/bolt/dist/receivers/AwsLambdaReceiver';
import { loadConfigCached } from './config';
import { createApp } from './app';

let receiver: AwsLambdaReceiver | null = null;
let receiverPromise: Promise<AwsLambdaReceiver> | null = null;

async function initialize(): Promise<AwsLambdaReceiver> {
  if (receiver) {
    return receiver;
  }
  if (receiverPromise) {
    return receiverPromise;
  }
  // If initialization fails (e.g. SSM not yet populated), clear the cached
  // promise so the next invocation on this warm container retries instead of
  // re-awaiting the same rejection.
  const attempt = (async (): Promise<AwsLambdaReceiver> => {
    const config = await loadConfigCached();
    const created = new AwsLambdaReceiver({ signingSecret: config.slackSigningSecret });
    createApp(config, created);
    receiver = created;
    return created;
  })();
  receiverPromise = attempt;
  attempt.catch(() => {
    if (receiverPromise === attempt) {
      receiverPromise = null;
    }
  });
  return attempt;
}

/**
 * True when this request is a Slack retry caused by us not responding within
 * Slack's 3-second event window. Summarization (and chat) run inline in the
 * Lambda, so the original invocation is still working when these retries
 * arrive — processing them again produces duplicate replies. Retries with any
 * other reason (e.g. a 5xx from a cold-start failure) are still processed, as
 * they are our only recovery path.
 */
export function isSlackTimeoutRetry(event: AwsEvent): boolean {
  const headers = (event as { headers?: Record<string, string | undefined> }).headers ?? {};
  let retryNum: string | undefined;
  let retryReason: string | undefined;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'x-slack-retry-num') {
      retryNum = value;
    } else if (lower === 'x-slack-retry-reason') {
      retryReason = value;
    }
  }
  return Boolean(retryNum) && retryReason === 'http_timeout';
}

export const handler = async (
  event: AwsEvent,
  context: unknown,
  callback: AwsCallback
): Promise<AwsResponse> => {
  if (isSlackTimeoutRetry(event)) {
    return { statusCode: 200, body: '' };
  }
  const awsReceiver = await initialize();
  const boltHandler = awsReceiver.toHandler();
  return boltHandler(event, context, callback);
};
