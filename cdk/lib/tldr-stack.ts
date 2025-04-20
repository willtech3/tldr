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

    // Create SQS queue for processing tasks
    const processingQueue = new sqs.Queue(this, 'TldrProcessingQueue', {
      visibilityTimeout: cdk.Duration.seconds(300), // 5 minutes
      retentionPeriod: cdk.Duration.days(1),
    });

    // Common environment variables for both functions
    const commonEnvironment = {
      SLACK_BOT_TOKEN: props.slackBotToken,
      SLACK_SIGNING_SECRET: props.slackSigningSecret,
      OPENAI_API_KEY: props.openaiApiKey,
      PROCESSING_QUEUE_URL: processingQueue.queueUrl,
    };

    // Create the Lambda function for immediate responses to Slack commands
    const tldrApiFunction = new lambda.Function(this, 'TldrApiFunction', {
      runtime: lambda.Runtime.PROVIDED_AL2,
      handler: 'bootstrap', // Fixed handler name for Rust Lambdas
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/target/lambda/api')),
      environment: commonEnvironment,
      timeout: cdk.Duration.seconds(10), // Short timeout for immediate responses
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_WEEK, // Add CloudWatch logs retention
    });

    // Create CloudWatch log group with custom settings for API function
    new logs.LogGroup(this, 'TldrApiFunctionLogGroup', {
      logGroupName: `/aws/lambda/${tldrApiFunction.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Create the worker Lambda function for background processing
    const tldrWorkerFunction = new lambda.Function(this, 'TldrWorkerFunction', {
      runtime: lambda.Runtime.PROVIDED_AL2,
      handler: 'bootstrap', // Fixed handler name for Rust Lambdas
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/target/lambda/worker')),
      environment: commonEnvironment,
      timeout: cdk.Duration.seconds(300), // Longer timeout for processing
      memorySize: 1024, // More memory for processing
      logRetention: logs.RetentionDays.ONE_WEEK, // Add CloudWatch logs retention
    });

    // Create CloudWatch log group with custom settings for Worker function
    new logs.LogGroup(this, 'TldrWorkerFunctionLogGroup', {
      logGroupName: `/aws/lambda/${tldrWorkerFunction.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Add SQS as an event source for the worker Lambda
    tldrWorkerFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(processingQueue, {
        batchSize: 1, // Process one message at a time
      })
    );

    // Grant the API function permission to send messages to the queue
    processingQueue.grantSendMessages(tldrApiFunction);

    // Create an API Gateway to expose the Lambda function
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

    // Create a Lambda integration for the API Gateway
    const tldrIntegration = new apigateway.LambdaIntegration(tldrApiFunction);

    // Add a resource and method for Slack events
    const events = api.root.addResource('events');
    events.addMethod('POST', tldrIntegration);

    // Add a resource and method for Slack slash commands
    const commands = api.root.addResource('commands');
    commands.addMethod('POST', tldrIntegration);

    // Output the API endpoint URL
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'URL of the API Gateway endpoint',
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
