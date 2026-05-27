import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';

interface TldrStackProps extends cdk.StackProps {
  slackBotTokenParameterName: string;
  slackSigningSecretParameterName: string;
  anthropicApiKeyParameterName: string;
  anthropicModel?: string;
  anthropicMaxOutputTokens?: string;
  enableStreaming: string;
  streamMinAppendIntervalMs?: string;
  streamMaxChunkChars?: string;
}

/**
 * TLDR single-service stack.
 *
 * One Node.js Lambda hosts Bolt + the inline summarisation worker. The Lambda
 * streams Anthropic Claude responses straight into the Slack assistant thread
 * via `chat.startStream` / `chat.appendStream` / `chat.stopStream`.
 */
export class TldrStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TldrStackProps) {
    super(scope, id, props);

    const api = new apigateway.RestApi(this, 'TldrApi', {
      restApiName: 'Tldr API',
      description: 'API for Tldr Slack bot integration',
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        // Never log payload bodies — they contain workspace data and Slack
        // signature material.
        dataTraceEnabled: false,
        metricsEnabled: true,
      },
    });

    const environment = {
      SLACK_BOT_TOKEN_PARAMETER_NAME: props.slackBotTokenParameterName,
      SLACK_SIGNING_SECRET_PARAMETER_NAME: props.slackSigningSecretParameterName,
      ANTHROPIC_API_KEY_PARAMETER_NAME: props.anthropicApiKeyParameterName,
      ...(props.anthropicModel ? { ANTHROPIC_MODEL: props.anthropicModel } : {}),
      ...(props.anthropicMaxOutputTokens
        ? { ANTHROPIC_MAX_OUTPUT_TOKENS: props.anthropicMaxOutputTokens }
        : {}),
      ENABLE_STREAMING: props.enableStreaming,
      ...(props.streamMinAppendIntervalMs
        ? { STREAM_MIN_APPEND_INTERVAL_MS: props.streamMinAppendIntervalMs }
        : {}),
      ...(props.streamMaxChunkChars
        ? { STREAM_MAX_CHUNK_CHARS: props.streamMaxChunkChars }
        : {}),
      API_BASE_URL: api.url.replace(/\/$/, ''),
      NODE_OPTIONS: '--enable-source-maps',
    } as const;

    // Single Lambda hosts both the Slack signal-handling layer and the inline
    // summarisation worker. 15 min timeout matches the maximum Slack streaming
    // session length; 1 GB memory leaves headroom for inline images.
    const tldrFunction = new lambda.Function(this, 'TldrBoltFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../bolt-ts/bundle')),
      environment,
      functionName: 'tldr-bolt',
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    this.grantSsmParameterRead(tldrFunction, props.slackBotTokenParameterName);
    this.grantSsmParameterRead(tldrFunction, props.slackSigningSecretParameterName);
    this.grantSsmParameterRead(tldrFunction, props.anthropicApiKeyParameterName);

    const boltIntegration = new apigateway.LambdaIntegration(tldrFunction);

    const slack = api.root.addResource('slack');
    slack.addResource('interactive').addMethod('POST', boltIntegration);
    slack.addResource('events').addMethod('POST', boltIntegration);

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'URL of the API Gateway endpoint',
    });
    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: api.url.replace(/\/$/, ''),
      description: 'API Gateway URL for Slack app manifest',
      exportName: 'TldrApiGatewayUrl',
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
