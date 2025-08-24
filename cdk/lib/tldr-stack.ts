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
  slackBotToken: string;
  slackSigningSecret: string;
  openaiApiKey: string;
  openaiOrgId: string;
}

export class TldrStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TldrStackProps) {
    super(scope, id, props);

    // Create a deployment IAM user for GitHub Actions
    const deploymentUser = new iam.User(this, 'TldrDeploymentUser', {
      userName: 'tldr-github-actions-deployment-user',
    });

    // Create access key for the deployment user
    const accessKey = new iam.CfnAccessKey(this, 'TldrDeploymentUserAccessKey', {
      userName: deploymentUser.userName,
    });

    // Add permissions to the deployment user
    deploymentUser.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCloudFormationFullAccess')
    );
    deploymentUser.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess')
    );
    deploymentUser.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonAPIGatewayAdministrator')
    );
    deploymentUser.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AWSLambda_FullAccess')
    );
    deploymentUser.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('IAMFullAccess')
    );
    deploymentUser.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSQSFullAccess')
    );
    deploymentUser.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMFullAccess')
    );
    // Add Secrets Manager permissions needed for CDK synthesis
    deploymentUser.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('SecretsManagerReadWrite')
    );

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
        dataTraceEnabled: true,
        metricsEnabled: true,
      },
    });

    // Common environment variables for both functions (excluding API URL to avoid cycles)
    const commonEnvironment = {
      SLACK_BOT_TOKEN: props.slackBotToken,
      SLACK_SIGNING_SECRET: props.slackSigningSecret,
      SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID || '',
      SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET || '',
      SLACK_REDIRECT_URL: process.env.SLACK_REDIRECT_URL || '',
      USER_TOKEN_PARAM_PREFIX: process.env.USER_TOKEN_PARAM_PREFIX || '/tldr/user_tokens/',
      USER_TOKEN_NOTIFY_PREFIX: process.env.USER_TOKEN_NOTIFY_PREFIX || '/tldr/user_token_notified/',
      OPENAI_API_KEY: props.openaiApiKey,
      OPENAI_ORG_ID: props.openaiOrgId,
      PROCESSING_QUEUE_URL: processingQueue.queueUrl,
    } as const;

    // Environment for the API Lambda (no API_BASE_URL reference)
    const apiEnvironment = {
      ...commonEnvironment,
    };

    // Environment for the Worker Lambda (safe to reference the API, worker is not integrated by API Gateway)
    const workerEnvironment = {
      ...commonEnvironment,
      // ensure no trailing slash to avoid double slashes when composing paths
      API_BASE_URL: api.url.replace(/\/$/, ''),
    };

    // Create the Lambda function for immediate responses to Slack commands
    const tldrApiFunction = new lambda.Function(this, 'TldrApiFunction', {
      runtime: lambda.Runtime.PROVIDED_AL2,
      handler: 'bootstrap', // Fixed handler name for Rust Lambdas
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/target/lambda/tldr-api/function.zip')),
      environment: apiEnvironment,
      functionName: 'tldr-api',
      timeout: cdk.Duration.seconds(10), // Short timeout for immediate responses
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_WEEK, // Add CloudWatch logs retention
    });

    // Create the worker Lambda function for background processing
    const tldrWorkerFunction = new lambda.Function(this, 'TldrWorkerFunction', {
      runtime: lambda.Runtime.PROVIDED_AL2,
      handler: 'bootstrap', // Fixed handler name for Rust Lambdas
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/target/lambda/tldr-worker/function.zip')),
      environment: workerEnvironment,
      functionName: 'tldr-worker',
      timeout: cdk.Duration.seconds(900), // Max timeout for long-running summaries
      memorySize: 1024, // More memory for processing
      logRetention: logs.RetentionDays.ONE_WEEK, // Add CloudWatch logs retention
    });

    // Add SQS as an event source for the worker Lambda
    tldrWorkerFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(processingQueue, {
        batchSize: 1, // Process one message at a time
      })
    );

    // Grant the API function permission to send messages to the queue
    processingQueue.grantSendMessages(tldrApiFunction);

    // SSM Parameter Store permissions for user token storage
    const userTokenParamArn = cdk.Arn.format(
      {
        service: 'ssm',
        resource: 'parameter',
        resourceName: 'tldr/user_tokens/*',
      },
      this,
    );

    // SSM Parameter Store permissions for notification tracking
    const userNotifyParamArn = cdk.Arn.format(
      {
        service: 'ssm',
        resource: 'parameter',
        resourceName: 'tldr/user_token_notified/*',
      },
      this,
    );

    // API Lambda needs to write user tokens
    tldrApiFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ssm:PutParameter'], resources: [userTokenParamArn] }),
    );

    // Worker Lambda needs to read user tokens and read/write notification flags
    tldrWorkerFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [userTokenParamArn] }),
    );
    tldrWorkerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:PutParameter'],
        resources: [userNotifyParamArn]
      }),
    );

    // Allow decrypting SecureString parameters that SSM serves (scoped via ViaService)
    tldrWorkerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
      }),
    );

    // Create a Lambda integration for the API Gateway
    const tldrIntegration = new apigateway.LambdaIntegration(tldrApiFunction);

    // Add a resource and method for Slack slash commands
    const commands = api.root.addResource('commands');
    commands.addMethod('POST', tldrIntegration);

    // Slack surface resources
    const slack = api.root.addResource('slack');

    // Add a resource and method for Slack interactive payloads (shortcuts, view_submission)
    const interactive = slack.addResource('interactive');
    interactive.addMethod('POST', tldrIntegration);

    // Add a resource and method for Slack Events API (url_verification, event_callback)
    const events = slack.addResource('events');
    events.addMethod('POST', tldrIntegration);

    // OAuth routes for user-token flow
    const auth = api.root.addResource('auth');
    const slackAuth = auth.addResource('slack');
    slackAuth.addResource('start').addMethod('GET', tldrIntegration);
    slackAuth.addResource('callback').addMethod('GET', tldrIntegration);

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

    // Output the deployment user ARN
    new cdk.CfnOutput(this, 'DeploymentUserArn', {
      value: deploymentUser.userArn,
      description: 'ARN of the deployment IAM user for GitHub Actions',
    });

    // Output the deployment user access key ID and secret (only for initial bootstrap)
    new cdk.CfnOutput(this, 'DeploymentUserAccessKeyId', {
      value: accessKey.ref,
      description: 'Access Key ID for the deployment IAM user',
    });

    new cdk.CfnOutput(this, 'DeploymentUserSecretAccessKey', {
      value: accessKey.attrSecretAccessKey,
      description: 'Secret Access Key for the deployment IAM user (only shown once during initial deployment)',
    });
  }
}
