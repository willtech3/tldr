#!/bin/bash
set -e

# Default to not using debug logs
DEBUG_LOGS=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  key="$1"
  case $key in
    --debug-logs)
      DEBUG_LOGS=true
      shift
      ;;
    *)
      # Unknown option
      shift
      ;;
  esac
done

echo "🚀 Building TLDR Lambda functions locally"
echo "======================================================"

if [ "$DEBUG_LOGS" = true ]; then
  echo "🐛 Debug logs enabled - full prompts will be visible in logs"
  # Pass the feature flag as a build arg to Docker
  BUILD_ARGS="--build-arg ENABLE_DEBUG_LOGS=true"
else
  echo "🔒 Debug logs disabled - prompts will be masked in logs"
  BUILD_ARGS=""
fi

# Build the Docker image with verbosity for debugging
echo "📦 Building Docker image (this may take several minutes)..."
docker build --platform linux/amd64 -t tldr-lambda-builder:local . --progress=plain $BUILD_ARGS
docker tag tldr-lambda-builder:local tldr-lambda-builder:latest # Add the :latest tag for CI

# Create directories for the Lambda artifacts
echo "📋 Extracting Lambda artifacts..."
mkdir -p lambda/target/lambda/tldr-api
mkdir -p lambda/target/lambda/tldr-worker

# Remove existing container if it exists
docker rm -f lambda-artifact-extractor 2>/dev/null || true

# Create a container from the image (won't fail now since we have a valid CMD)
echo "Creating container from image..."
if ! docker create --name lambda-artifact-extractor tldr-lambda-builder:local; then
    echo "❌ Failed to create container from the built image"
    exit 1
fi

# Extract the Lambda artifacts
echo "Copying API Lambda artifact..."
if ! docker cp lambda-artifact-extractor:/dist/tldr-api/bootstrap lambda/target/lambda/tldr-api/bootstrap; then
    echo "❌ Failed to copy API Lambda artifact from container"
    docker rm lambda-artifact-extractor
    exit 1
fi

echo "Copying Worker Lambda artifact..."
if ! docker cp lambda-artifact-extractor:/dist/tldr-worker/bootstrap lambda/target/lambda/tldr-worker/bootstrap; then
    echo "❌ Failed to copy Worker Lambda artifact from container"
    docker rm lambda-artifact-extractor
    exit 1
fi

# Extract ZIP files directly from the container
echo "Copying ZIP files from container..."
if ! docker cp lambda-artifact-extractor:/tldr-api.zip lambda/target/lambda/tldr-api/function.zip; then
    echo "❌ Failed to copy API Lambda ZIP from container"
    docker rm lambda-artifact-extractor
    exit 1
fi

if ! docker cp lambda-artifact-extractor:/tldr-worker.zip lambda/target/lambda/tldr-worker/function.zip; then
    echo "❌ Failed to copy Worker Lambda ZIP from container"
    docker rm lambda-artifact-extractor
    exit 1
fi

# Clean up container
docker rm lambda-artifact-extractor

# Verify artifacts were created successfully
if [ -f "lambda/target/lambda/tldr-api/bootstrap" ] && [ -f "lambda/target/lambda/tldr-worker/bootstrap" ] && \
   [ -f "lambda/target/lambda/tldr-api/function.zip" ] && [ -f "lambda/target/lambda/tldr-worker/function.zip" ]; then
    echo "✅ Lambda artifacts built successfully!"

    # Verify linkage type
    echo "🔍 Verifying binary linkage..."
    echo "API Bootstrap Type:" 
    file lambda/target/lambda/tldr-api/bootstrap
    echo "Worker Bootstrap Type:"
    file lambda/target/lambda/tldr-worker/bootstrap

    echo "   - API Lambda: lambda/target/lambda/tldr-api/bootstrap"
    echo "   - Worker Lambda: lambda/target/lambda/tldr-worker/bootstrap"
    echo "   - API Lambda ZIP: lambda/target/lambda/tldr-api/function.zip"
    echo "   - Worker Lambda ZIP: lambda/target/lambda/tldr-worker/function.zip"
    
    # Display file sizes
    echo "API Lambda size: $(du -h lambda/target/lambda/tldr-api/bootstrap | cut -f1)"
    echo "Worker Lambda size: $(du -h lambda/target/lambda/tldr-worker/bootstrap | cut -f1)"
    echo "API Lambda ZIP size: $(du -h lambda/target/lambda/tldr-api/function.zip | cut -f1)"
    echo "Worker Lambda ZIP size: $(du -h lambda/target/lambda/tldr-worker/function.zip | cut -f1)"
else
    echo "❌ Lambda artifacts build failed"
    exit 1
fi

echo "✨ Build complete!"
echo "======================================================"
echo "🔍 To deploy with CDK, run: cd cdk && npm run deploy"
