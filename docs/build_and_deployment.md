# TLDR Build and Deployment Pipeline

This document explains the build pipeline and deployment process for TLDR's
single-service Bolt.js Lambda (TypeScript).

## Overview

The pipeline builds the Bolt Lambda bundle via `esbuild` and deploys with
Terraform. There is no Rust toolchain, no Docker build step, and no SQS queue —
the previous two-Lambda architecture has been collapsed into a single TypeScript
service. Terraform configuration lives in `terraform/` (see
`terraform/README.md`).

## Primary Deployment Method: CI/CD

**Important**: Deployments are primarily handled through GitHub Actions
CI/CD. Manual/local builds should only be used for debugging or emergency
situations.

### GitHub Actions Workflow

The workflow in `.github/workflows/deploy.yml` runs:

#### Pull Requests
Runs the full code quality gate:
- ESLint + TypeScript build (`tsc`) + Jest unit tests for `bolt-ts/`
- `terraform fmt -check` and `terraform validate` for `terraform/`

#### Main Branch Push or Manual Dispatch on `main`
Executes the deployment:
1. Bundles the Bolt Lambda (`npm run bundle`)
2. Syncs Slack/Anthropic secrets into SSM SecureString parameters
3. `terraform init` against the S3 backend, then `terraform apply -auto-approve`
4. Prints the API Gateway URL (`terraform output -raw api_gateway_url`) for the Slack manifest

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
- Terraform: `terraform fmt -check`, `terraform validate` (offline, no AWS creds)

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

Terraform's `data.archive_file` zips `bolt-ts/bundle/` into the Lambda deployment
package at apply time.

### Terraform Deployment

Terraform (`terraform/`) handles:
- API Gateway configuration (`/slack/events`, `/slack/interactive`)
- The single Lambda function (`tldr-bolt`)
- IAM permissions (SSM read for the three configured parameters)
- CloudWatch log group with one-week retention
- Account-level API Gateway CloudWatch Logs role (for stage access logging)
- Runtime secret access via SSM SecureString parameter names

State is stored in S3 (configured at `terraform init` time). A one-time bucket
bootstrap is documented in `terraform/README.md`.

## Environment Variables

CI deployment variables / secrets:
- `TF_STATE_BUCKET` (repo variable) — S3 bucket holding Terraform state (required)
- `TF_STATE_KEY` (repo variable) — state object key (optional, default `tldr/terraform.tfstate`)
- `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` / `ANTHROPIC_API_KEY` (secrets) — synced into SSM
- `AWS_DEPLOY_ROLE_ARN` (secret, OIDC) or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (secrets)

These map to Terraform inputs (`TF_VAR_*`); see `terraform/variables.tf`:
- `SLACK_BOT_TOKEN_PARAMETER_NAME`
- `SLACK_SIGNING_SECRET_PARAMETER_NAME`
- `ANTHROPIC_API_KEY_PARAMETER_NAME`
- `AWS_ACCOUNT_ID` — optional; if set, Terraform refuses to apply against any other account

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

1. **Type errors**: run `just bolt-build` for fast feedback.
2. **Lint / format errors**: run `just bolt-lint`; run `just tf-fmt` (then `terraform -chdir=terraform fmt` to fix).
3. **Test failures**: run `just bolt-test` — the Jest suite is fast (~1 second).
4. **Terraform config errors**: run `just tf-validate` (offline; no AWS creds needed).

### Deployment Issues

1. **AWS credentials**: verify `AWS_DEPLOY_ROLE_ARN` (or access keys) are configured in GitHub Actions.
2. **Missing state bucket**: ensure the `TF_STATE_BUCKET` repo variable points at a real S3 bucket (see `terraform/README.md`).
3. **Stale routes**: if a new API Gateway route isn't live, confirm it's listed in the `aws_api_gateway_deployment` `triggers` hash so a redeploy fires.
4. **Lambda size**: the esbuild bundle is small (~6 MB); if it ever exceeds Lambda limits, audit recent dependency additions.

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
