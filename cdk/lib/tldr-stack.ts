import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
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

    // Create the Lambda function for the Slack bot using a simpler approach
    const tldrFunction = new lambda.Function(this, 'TldrFunction', {
      runtime: lambda.Runtime.PROVIDED_AL2,
      handler: 'bootstrap', // Fixed handler name for Rust Lambdas
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/target/lambda/tldr')),
      environment: {
        SLACK_BOT_TOKEN: props.slackBotToken,
        SLACK_SIGNING_SECRET: props.slackSigningSecret,
        OPENAI_API_KEY: props.openaiApiKey,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });

    // Create an API Gateway to expose the Lambda function
    const api = new apigateway.RestApi(this, 'TldrApi', {
      restApiName: 'Tldr API',
      description: 'API for Tldr Slack bot integration',
      deployOptions: {
        stageName: 'prod',
      },
    });

    // Create a Lambda integration for the API Gateway
    const tldrIntegration = new apigateway.LambdaIntegration(tldrFunction);

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
