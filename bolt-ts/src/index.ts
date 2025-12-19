/**
 * AWS Lambda entry point for the TLDR Slack AI App.
 *
 * This module sets up the Bolt app with the AWS Lambda receiver,
 * which handles HTTP events from API Gateway and routes them to Bolt.
 */

import { AwsLambdaReceiver } from '@slack/bolt';
// Note: These types are imported from Bolt's internal path. While not ideal,
// Bolt doesn't export these types from the main package. The types are stable
// and match AWS API Gateway event/response shapes.
import type {
  AwsCallback,
  AwsEvent,
  AwsResponse,
} from '@slack/bolt/dist/receivers/AwsLambdaReceiver';
import { loadConfig } from './config';
import type { AppConfig } from './config';
import { createApp } from './app';

// Lazy-initialized receiver (reused across Lambda invocations)
let receiver: AwsLambdaReceiver | null = null;
let config: AppConfig | null = null;

/**
 * Initialize the app and receiver on first invocation.
 * This is done lazily to allow environment variables to be set.
 *
 * IMPORTANT: The receiver must be passed to the App constructor so that
 * events are properly routed to registered handlers. Do NOT call app.start()
 * in Lambda mode - the receiver's toHandler() method handles everything.
 */
function initialize(): AwsLambdaReceiver {
  if (receiver) {
    return receiver;
  }

  config = loadConfig();

  // Create the AWS Lambda receiver first
  receiver = new AwsLambdaReceiver({
    signingSecret: config.slackSigningSecret,
  });

  // Create the app with the receiver - this wires up event routing
  // Note: We don't call app.start() in Lambda mode
  createApp(config, receiver);

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

  // Get the Lambda handler from the receiver and invoke it
  const boltHandler = awsReceiver.toHandler();

  return boltHandler(event, context, callback);
};
