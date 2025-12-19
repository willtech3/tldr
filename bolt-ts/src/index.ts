/**
 * AWS Lambda entry point for the TLDR Slack AI App.
 *
 * This module sets up the Bolt app with the AWS Lambda receiver,
 * which handles HTTP events from API Gateway and routes them to Bolt.
 */

import { AwsLambdaReceiver } from '@slack/bolt';
import { AwsCallback, AwsEvent, AwsResponse } from '@slack/bolt/dist/receivers/AwsLambdaReceiver';
import { loadConfig, AppConfig } from './config';
import { createApp } from './app';

// Lazy-initialized app and receiver (reused across Lambda invocations)
let receiver: AwsLambdaReceiver | null = null;
let config: AppConfig | null = null;

/**
 * Initialize the app and receiver on first invocation.
 * This is done lazily to allow environment variables to be set.
 */
function initialize(): AwsLambdaReceiver {
  if (receiver) {
    return receiver;
  }

  config = loadConfig();

  // Create the AWS Lambda receiver
  receiver = new AwsLambdaReceiver({
    signingSecret: config.slackSigningSecret,
  });

  // Create and attach the app
  const app = createApp(config);

  // Start the app with the receiver
  // Note: We don't await this - it returns the receiver's handler
  app.start().catch((err) => {
    console.error('Failed to start app:', err);
  });

  return receiver;
}

/**
 * AWS Lambda handler function.
 *
 * This is the entry point called by AWS Lambda when the function is invoked.
 * It delegates to the Bolt AwsLambdaReceiver to handle Slack events.
 */
export const handler = async (
  event: AwsEvent,
  context: unknown,
  callback: AwsCallback
): Promise<AwsResponse> => {
  const awsReceiver = initialize();

  // Get the Lambda handler from the receiver
  const boltHandler = awsReceiver.toHandler();

  // Invoke the handler
  return boltHandler(event, context, callback);
};
