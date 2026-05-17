import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';

interface TldrStackProps extends cdk.StackProps {
  slackBotTokenParameterName: string;
  slackSigningSecretParameterName: string;
  openaiApiKeyParameterName: string;
  openaiOrgIdParameterName?: string;
  openaiModel?: string;
  enableStreaming: string;
  streamMinAppendIntervalMs?: string;
  streamMaxChunkChars?: string;
}

export class TldrStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TldrStackProps) {
    super(scope, id, props);

    // Create SQS queue for processing tasks
    const processingQueue = new sqs.Queue(this, 'TldrProcessingQueue', {
      // Visibility timeout should exceed the Lambda processing timeout to avoid duplicate delivery
      visibilityTimeout: cdk.Duration.seconds(930), // 15m 30s (~30s buffer over 900s Lambda timeout)
      retentionPeriod: cdk.Duration.days(1),
    });

    // Create the API Gateway first to get its URL
    const api = new apigateway.RestApi(this, 'TldrApi', {
      restApiName: 'Tldr API',
      description: 'API for Tldr Slack bot integration',
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        // Do not log request/response bodies; Slack payloads can contain private
        // workspace data and signature material.
        dataTraceEnabled: false,
        metricsEnabled: true,
      },
    });

    // Environment for the Bolt API Lambda
    const boltApiEnvironment = {
      SLACK_BOT_TOKEN_PARAMETER_NAME: props.slackBotTokenParameterName,
      SLACK_SIGNING_SECRET_PARAMETER_NAME: props.slackSigningSecretParameterName,
      PROCESSING_QUEUE_URL: processingQueue.queueUrl,
      NODE_OPTIONS: '--enable-source-maps',
    } as const;

    // Environment for the Worker Lambda
    const workerEnvironment = {
      SLACK_BOT_TOKEN_PARAMETER_NAME: props.slackBotTokenParameterName,
      SLACK_SIGNING_SECRET_PARAMETER_NAME: props.slackSigningSecretParameterName,
      OPENAI_API_KEY_PARAMETER_NAME: props.openaiApiKeyParameterName,
      ...(props.openaiOrgIdParameterName
        ? { OPENAI_ORG_ID_PARAMETER_NAME: props.openaiOrgIdParameterName }
        : {}),
      ...(props.openaiModel ? { OPENAI_MODEL: props.openaiModel } : {}),
      PROCESSING_QUEUE_URL: processingQueue.queueUrl,
      ENABLE_STREAMING: props.enableStreaming,
      ...(props.streamMinAppendIntervalMs
        ? { STREAM_MIN_APPEND_INTERVAL_MS: props.streamMinAppendIntervalMs }
        : {}),
      ...(props.streamMaxChunkChars ? { STREAM_MAX_CHUNK_CHARS: props.streamMaxChunkChars } : {}),
      // ensure no trailing slash to avoid double slashes when composing paths
      API_BASE_URL: api.url.replace(/\/$/, ''),
      RUST_LOG: process.env.LOG_LEVEL || 'info',
    };

    // Create the Bolt TypeScript Lambda for Slack API handling
    // This replaces the Rust API Lambda with a TypeScript implementation using Bolt
    // The bundle directory contains esbuild-bundled code with all dependencies
    const tldrBoltApiFunction = new lambda.Function(this, 'TldrBoltApiFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../bolt-ts/bundle')),
      environment: boltApiEnvironment,
      functionName: 'tldr-bolt-api',
      timeout: cdk.Duration.seconds(10), // Short timeout for fast ACK (Slack requires < 3s)
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // Create the worker Lambda function for background processing (Rust)
    const tldrWorkerFunction = new lambda.Function(this, 'TldrWorkerFunction', {
      runtime: lambda.Runtime.PROVIDED_AL2,
      handler: 'bootstrap', // Fixed handler name for Rust Lambdas
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/target/lambda/tldr-worker/function.zip')),
      environment: workerEnvironment,
      functionName: 'tldr-worker',
      timeout: cdk.Duration.seconds(900), // Max timeout for long-running summaries
      memorySize: 1024, // More memory for processing
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // Add SQS as an event source for the worker Lambda
    tldrWorkerFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(processingQueue, {
        batchSize: 1, // Process one message at a time
      })
    );

    // Grant the Bolt API function permission to send messages to the queue
    processingQueue.grantSendMessages(tldrBoltApiFunction);

    this.grantSsmParameterRead(tldrBoltApiFunction, props.slackBotTokenParameterName);
    this.grantSsmParameterRead(tldrBoltApiFunction, props.slackSigningSecretParameterName);
    this.grantSsmParameterRead(tldrWorkerFunction, props.slackBotTokenParameterName);
    this.grantSsmParameterRead(tldrWorkerFunction, props.slackSigningSecretParameterName);
    this.grantSsmParameterRead(tldrWorkerFunction, props.openaiApiKeyParameterName);
    if (props.openaiOrgIdParameterName) {
      this.grantSsmParameterRead(tldrWorkerFunction, props.openaiOrgIdParameterName);
    }

    // Create a Lambda integration for the API Gateway
    const boltIntegration = new apigateway.LambdaIntegration(tldrBoltApiFunction);

    // Slack surface resources - all routes go to the Bolt TypeScript Lambda
    const slack = api.root.addResource('slack');

    // Add a resource and method for Slack interactive payloads (shortcuts, view_submission)
    const interactive = slack.addResource('interactive');
    interactive.addMethod('POST', boltIntegration);

    // Add a resource and method for Slack Events API (url_verification, event_callback)
    const events = slack.addResource('events');
    events.addMethod('POST', boltIntegration);

    // Output the API endpoint URL
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'URL of the API Gateway endpoint',
    });

    // Output the API Gateway URL for Slack manifest deployment
    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: api.url.replace(/\/$/, ''), // Remove trailing slash
      description: 'API Gateway URL for Slack app manifest',
      exportName: 'TldrApiGatewayUrl',
    });

    // Output the processing queue URL
    new cdk.CfnOutput(this, 'ProcessingQueueUrl', {
      value: processingQueue.queueUrl,
      description: 'URL of the SQS processing queue',
    });

  }

  private grantSsmParameterRead(fn: lambda.Function, parameterName: string): void {
    const normalizedName = parameterName.replace(/^\//, '');
    const parameterArn = cdk.Stack.of(this).formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: normalizedName,
    });

    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [parameterArn],
      })
    );
  }
}
