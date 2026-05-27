# TLDR Build and Deployment Pipeline

This document explains the build pipeline and deployment process for TLDR's
single-service Bolt.js Lambda (TypeScript).

## Overview

The pipeline builds the Bolt Lambda bundle via `esbuild` and deploys with AWS
CDK. There is no Rust toolchain, no Docker build step, and no SQS queue — the
previous two-Lambda architecture has been collapsed into a single TypeScript
service.

## Primary Deployment Method: CI/CD

**Important**: Deployments are primarily handled through GitHub Actions
CI/CD. Manual/local builds should only be used for debugging or emergency
situations.

### GitHub Actions Workflow

The workflow in `.github/workflows/deploy.yml` runs:

#### Pull Requests
Runs the full code quality gate:
- ESLint for `bolt-ts/` and `cdk/`
- TypeScript builds (`tsc`)
- Jest unit tests

#### Main Branch Push or Manual Dispatch on `main`
Executes the deployment:
1. Bundles the Bolt Lambda (`npm run bundle`)
2. Builds the CDK app
3. Deploys with `cdk deploy --require-approval never`
4. Outputs the API Gateway URL for the Slack manifest

Manual dispatches are gated to the `main` ref so branch code cannot obtain
deployment credentials.

## Local Development

### Quality Checks

Before committing any changes, run the consolidated quality suite:

```bash
just qa
```

This executes:
- Bolt: `npm run build`, `npm run bundle`, `npm run lint`, `npm test`
- CDK: `npm run build`, `npm run lint`

### Building the Bundle

```bash
cd bolt-ts
npm run bundle  # produces bolt-ts/bundle/index.js
```

`npm run package` additionally zips the bundle for ad-hoc uploads.

## Technical Details

### Runtime

The Lambda uses the `nodejs20.x` runtime, 1 GB memory, and a 15-minute timeout.
The 15-minute timeout is the ceiling for Anthropic streaming work. Bolt's
`AwsLambdaReceiver` ACKs the Slack event quickly, then the handler streams the
Anthropic response straight into the assistant thread.

### Build Artifacts

After building, artifacts are placed in:

- `bolt-ts/bundle/index.js` — esbuild output (bundled CJS for Node 20)
- `bolt-ts/function.zip` — produced by `npm run package` (optional, for manual uploads)

CDK reads from `bolt-ts/bundle/` when synthesising the stack.

### CDK Deployment

AWS CDK handles:
- API Gateway configuration (`/slack/events`, `/slack/interactive`)
- The single Lambda function (`tldr-bolt`)
- IAM permissions (SSM read for the four configured parameters)
- CloudWatch log group with one-week retention
- Runtime secret access via SSM SecureString parameter names

## Environment Variables

Required deployment variables:
- `SLACK_BOT_TOKEN_PARAMETER_NAME`
- `SLACK_SIGNING_SECRET_PARAMETER_NAME`
- `ANTHROPIC_API_KEY_PARAMETER_NAME`
- `AWS_ACCOUNT_ID`

Optional tuning:
- `ANTHROPIC_MODEL` — overrides the default model (defaults to `claude-sonnet-4-6`)
- `ANTHROPIC_MAX_OUTPUT_TOKENS` — overrides the default 16 000 (cap 64 000)
- `ENABLE_STREAMING` — `true` (default) to stream summaries into the thread
- `STREAM_MAX_CHUNK_CHARS` — per-append chunk size (max 12 000, default 8 000)
- `STREAM_MIN_APPEND_INTERVAL_MS` — floor between `chat.appendStream` calls (default 500)

Store Slack and Anthropic secrets as SSM SecureString parameters before
deployment. CI/CD uses a GitHub OIDC role via the `AWS_DEPLOY_ROLE_ARN` secret
where available, falling back to long-lived access keys otherwise.

## Troubleshooting

### Build Issues

1. **Type errors**: run `just bolt-build` and `just cdk-build` for fast feedback.
2. **Lint errors**: run `just bolt-lint` / `just cdk-lint`.
3. **Test failures**: run `just bolt-test` — the Jest suite is fast (~1 second).

### Deployment Issues

1. **AWS credentials**: verify `AWS_DEPLOY_ROLE_ARN` and `AWS_ACCOUNT_ID` are configured in GitHub Actions.
2. **CDK errors**: ensure `cdk/` dependencies are up to date with `npm ci`.
3. **Lambda size**: the esbuild bundle is small (~6 MB); if it ever exceeds Lambda limits, audit recent dependency additions.

### Local Testing

For local Lambda testing without deployment, use `aws-lambda-ric` or AWS SAM
with the bundled `bolt-ts/bundle/index.js`:

```bash
cd bolt-ts && npm run bundle
# Invoke with a Slack-shaped API Gateway event payload using SAM or
# aws-lambda-ric — the Bolt receiver validates Slack signatures via
# SLACK_SIGNING_SECRET.
```

## Related Documentation

- `slack_configuration.md` — Slack application configuration
- `README.md` — Project overview and setup
- `.github/workflows/deploy.yml` — CI/CD pipeline source
