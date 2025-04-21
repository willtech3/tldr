# SlackSummarizer Build Pipeline

This document explains the Docker-based build pipeline for the SlackSummarizer Rust Lambda functions.

## Overview

The pipeline uses Docker to create a consistent build environment that accurately replicates the AWS Lambda runtime, ensuring there are no GLIBC compatibility issues or other runtime problems when deployed.

## Local Development Build

To build the Lambda functions locally:

```bash
./build-local.sh
```

This script will:
1. Build a Docker image with all the necessary tools and dependencies
2. Compile both Lambda functions (API and Worker)
3. Extract the artifacts from the Docker container
4. Place them in the expected locations for CDK deployment

## CI/CD with GitHub Actions

The GitHub Actions workflow in `.github/workflows/deploy.yml` handles:

1. **Code Quality Checks** (on PR only):
   - Code formatting with `rustfmt`
   - Linting with Clippy
   - Running tests

2. **Build Process**:
   - Docker-based build of Lambda functions
   - Proper caching for faster builds

3. **Deployment** (on push to main or manual dispatch):
   - AWS CDK deployment with proper environment variables

## Technical Details

### Rust Configuration

The build process:
- Uses stable Rust toolchain
- Properly handles the custom linker configuration in `.cargo/config.toml`
- Ensures compatibility with the Lambda runtime environment

### Docker Image

The Dockerfile:
- Uses Amazon Linux 2 as the base image (identical to Lambda runtime)
- Installs Zig for cross-compilation
- Configures proper build dependencies
- Uses multi-stage build for smaller artifacts

### CDK Deployment

After building the Lambda functions, they are deployed using AWS CDK:
- API Gateway setup
- Lambda function configuration
- Proper IAM permissions

## Troubleshooting

If you encounter build issues:

1. Check Docker is installed and running
2. Ensure AWS credentials are properly configured for deployment
3. Verify Lambda function source code compiles locally without errors

For more detailed logs, run the build-local.sh script which includes verbose output.
