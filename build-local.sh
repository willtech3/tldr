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

# Use docker save and tar extraction to get files from scratch image
echo "Extracting Lambda artifacts from image..."
TEMP_DIR=$(mktemp -d)
docker save tldr-lambda-builder:local -o $TEMP_DIR/image.tar
cd $TEMP_DIR
tar -xf image.tar
# Find the layer containing our artifacts
LAYER_ID=""
for MANIFEST in */manifest.json; do
  LAYER_ID=$(cat $MANIFEST | grep -o '"Layers":\["[^"]*' | grep -o '[a-f0-9]*/layer.tar' | head -1)
  if [ ! -z "$LAYER_ID" ]; then
    break
  fi
done

if [ -z "$LAYER_ID" ]; then
  echo "❌ Failed to find layer with Lambda artifacts"
  cd - > /dev/null
  rm -rf $TEMP_DIR
  exit 1
fi

# Extract the layer to access our Lambda artifacts
mkdir -p layer
tar -xf $LAYER_ID -C layer

# Copy artifacts to their destination
if [ -f "layer/tldr-api.zip" ]; then
  cp layer/tldr-api.zip "$(cd - > /dev/null && pwd)/lambda/target/lambda/tldr-api/bootstrap.zip"
else
  echo "❌ Could not find API Lambda artifact"
  cd - > /dev/null
  rm -rf $TEMP_DIR
  exit 1
fi

if [ -f "layer/tldr-worker.zip" ]; then
  cp layer/tldr-worker.zip "$(cd - > /dev/null && pwd)/lambda/target/lambda/tldr-worker/bootstrap.zip"
else
  echo "❌ Could not find Worker Lambda artifact"
  cd - > /dev/null
  rm -rf $TEMP_DIR
  exit 1
fi

# Clean up temp directory
cd - > /dev/null
rm -rf $TEMP_DIR

# Verify artifacts were created successfully
if [ -f "lambda/target/lambda/tldr-api/bootstrap.zip" ] && [ -f "lambda/target/lambda/tldr-worker/bootstrap.zip" ]; then
    echo "✅ Lambda artifacts built successfully!"
    echo "   - API Lambda: lambda/target/lambda/tldr-api/bootstrap.zip"
    echo "   - Worker Lambda: lambda/target/lambda/tldr-worker/bootstrap.zip"
    
    # Display file sizes
    echo "API Lambda size: $(du -h lambda/target/lambda/tldr-api/bootstrap.zip | cut -f1)"
    echo "Worker Lambda size: $(du -h lambda/target/lambda/tldr-worker/bootstrap.zip | cut -f1)"
else
    echo "❌ Lambda artifacts build failed"
    exit 1
fi

echo "✨ Build complete!"
echo "======================================================"
echo "🔍 To deploy with CDK, run: cd cdk && npm run cdk deploy"
