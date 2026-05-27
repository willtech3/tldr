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
  receiverPromise = (async (): Promise<AwsLambdaReceiver> => {
    const config = await loadConfigCached();
    const created = new AwsLambdaReceiver({ signingSecret: config.slackSigningSecret });
    createApp(config, created);
    receiver = created;
    return created;
  })();
  return receiverPromise;
}

export const handler = async (
  event: AwsEvent,
  context: unknown,
  callback: AwsCallback
): Promise<AwsResponse> => {
  const awsReceiver = await initialize();
  const boltHandler = awsReceiver.toHandler();
  return boltHandler(event, context, callback);
};
