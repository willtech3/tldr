/**
 * SQS client for enqueueing processing tasks.
 *
 * The Bolt Lambda enqueues work to SQS for async processing by the Rust worker.
 * This ensures fast ACK (< 3 seconds) to Slack while heavy work runs in background.
 */

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { ProcessingTask } from './types';

// Lazy-initialized SQS client (reused across Lambda invocations)
let sqsClient: SQSClient | null = null;

function getClient(): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({});
  }
  return sqsClient;
}

/**
 * Send a processing task to SQS for async handling by the worker Lambda.
 *
 * @param task - The processing task to enqueue
 * @param queueUrl - The SQS queue URL
 * @throws Error if the message cannot be sent
 */
export async function sendToSqs(task: ProcessingTask, queueUrl: string): Promise<void> {
  const client = getClient();
  const messageBody = JSON.stringify(task);

  const command = new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: messageBody,
  });

  await client.send(command);
  console.log(`Enqueued task ${task.correlation_id} to SQS`);
}
