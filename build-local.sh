#!/bin/bash
set -e

echo "🚀 Building SlackSummarizer Lambda functions locally"
echo "======================================================"

# Build the Docker image with verbosity for debugging
echo "📦 Building Docker image (this may take several minutes)..."
docker build -t tldr-lambda-builder:local . --progress=plain

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

# Create zip files for CDK deployment if needed
echo "Creating ZIP files for CDK deployment..."
(cd lambda/target/lambda/tldr-api && zip -j function.zip bootstrap)
(cd lambda/target/lambda/tldr-worker && zip -j function.zip bootstrap)

# Clean up container
docker rm lambda-artifact-extractor

# Verify artifacts were created successfully
if [ -f "lambda/target/lambda/tldr-api/bootstrap" ] && [ -f "lambda/target/lambda/tldr-worker/bootstrap" ]; then
    echo "✅ Lambda artifacts built successfully!"
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
echo "🔍 To deploy with CDK, run: cd cdk && npm run cdk deploy"
