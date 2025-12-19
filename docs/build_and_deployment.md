# TLDR Build and Deployment Pipeline

This document explains the Docker-based build pipeline and deployment process for the TLDR Rust Lambda functions.

## Overview

The pipeline uses Docker to create a consistent build environment that accurately replicates the AWS Lambda runtime, ensuring there are no GLIBC compatibility issues or other runtime problems when deployed.

## Primary Deployment Method: CI/CD

**Important**: Deployments are primarily handled through GitHub Actions CI/CD. Manual/local builds should only be used for debugging or emergency situations.

### GitHub Actions Workflow

The workflow in `.github/workflows/deploy.yml` handles different scenarios:

#### Pull Requests
Runs code quality checks only:
- Code formatting with `rustfmt`
- Linting with Clippy (`-D warnings`)
- Test suite execution

#### Main Branch Push or Manual Dispatch
Executes full deployment:
1. Docker-based Lambda build
2. CDK TypeScript compilation
3. AWS deployment with CDK
4. Outputs API Gateway URL for Slack manifest updates

## Local Development

### Quality Checks

Before committing any changes, run the consolidated quality suite:

```bash
just qa
```

This executes:
- `cargo fmt --check`
- `cargo clippy` with strict warnings
- `cargo test`
- CDK TypeScript build

### Local Build (Debugging Only)

To build Lambda functions locally for debugging:

```bash
./build-local.sh
# With debug logging enabled (shows full prompts):
./build-local.sh --debug-logs
```

This script:
1. Builds a Docker image with necessary tools and dependencies
2. Compiles both Lambda functions (API and Worker)
3. Extracts artifacts (bootstrap binaries and function.zip files)
4. Places them in expected locations for CDK deployment

## Technical Details

### Rust Configuration

The build process:
- Uses stable Rust toolchain
- Cross-compiles for AWS Lambda runtime using Zig
- Ensures compatibility with Amazon Linux 2 environment

### Docker Build Process

The Dockerfile:
- Base: Amazon Linux 2 (matches Lambda runtime exactly)
- Installs Zig for cross-compilation
- Multi-stage build for optimized artifacts
- Outputs both bootstrap binaries and zip archives

### Build Artifacts

After building, artifacts are placed in:
- `lambda/target/lambda/tldr-api/bootstrap` - API Lambda binary
- `lambda/target/lambda/tldr-api/function.zip` - API Lambda package
- `lambda/target/lambda/tldr-worker/bootstrap` - Worker Lambda binary
- `lambda/target/lambda/tldr-worker/function.zip` - Worker Lambda package

### CDK Deployment

AWS CDK handles:
- API Gateway configuration
- Lambda function deployment
- SQS queue setup
- IAM permissions
- Environment variable injection from secrets

## Environment Variables

Required secrets in GitHub Actions:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `OPENAI_API_KEY`
- `OPENAI_ORG_ID` (optional)

## Troubleshooting

### Build Issues

1. **Docker not running**: Ensure Docker Desktop is started
2. **Compilation errors**: Run `just qa` locally first
3. **Missing dependencies**: Check Cargo.toml for version conflicts

### Deployment Issues

1. **AWS credentials**: Verify GitHub secrets are properly configured
2. **CDK errors**: Ensure `cdk/` dependencies are up to date with `npm ci`
3. **Lambda size**: Check artifact sizes don't exceed Lambda limits

### Local Testing

For local Lambda testing without deployment:

```bash
cd lambda
cargo lambda build --release
cargo lambda watch  # Starts local server on :9000
# In another terminal:
cargo lambda invoke --data-file test/fixtures/slash_command.json
```

## Related Documentation

- `slack_configuration.md` - Slack application configuration
- `README.md` - Project overview and setup
- `.github/workflows/deploy.yml` - CI/CD pipeline source


