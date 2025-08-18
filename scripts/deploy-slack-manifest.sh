#!/bin/bash
set -euo pipefail

# Deploy Slack app manifest using Slack API
# Required environment variables:
# - SLACK_APP_ID: The Slack app ID
# - SLACK_APP_CONFIG_TOKEN: Token with apps:write scope for updating manifests
# - API_GATEWAY_URL: The API Gateway base URL

echo "🚀 Deploying Slack app manifest..."

# Check required environment variables
if [ -z "${SLACK_APP_ID:-}" ]; then
    echo "❌ Error: SLACK_APP_ID is not set"
    exit 1
fi

if [ -z "${SLACK_APP_CONFIG_TOKEN:-}" ]; then
    echo "❌ Error: SLACK_APP_CONFIG_TOKEN is not set"
    exit 1
fi

if [ -z "${API_GATEWAY_URL:-}" ]; then
    echo "❌ Error: API_GATEWAY_URL is not set"
    exit 1
fi

# Create temporary manifest with substituted values
TEMP_MANIFEST=$(mktemp)
trap "rm -f $TEMP_MANIFEST" EXIT

# Read the manifest template and substitute the API Gateway URL
sed "s|{{API_GATEWAY_URL}}|${API_GATEWAY_URL}|g" slack-app-manifest.yaml > "$TEMP_MANIFEST"

echo "📝 Updating manifest for app ID: ${SLACK_APP_ID}"

# Convert YAML to JSON (required for Slack API)
# Using Python since it's available in GitHub Actions
MANIFEST_JSON=$(python3 -c "
import yaml
import json
import sys

with open('$TEMP_MANIFEST', 'r') as f:
    manifest = yaml.safe_load(f)
print(json.dumps(manifest))
")

# Update the app manifest via Slack API
RESPONSE=$(curl -s -X POST https://slack.com/api/apps.manifest.update \
    -H "Authorization: Bearer ${SLACK_APP_CONFIG_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
        \"app_id\": \"${SLACK_APP_ID}\",
        \"manifest\": ${MANIFEST_JSON}
    }")

# Check if the update was successful
if echo "$RESPONSE" | grep -q '"ok":true'; then
    echo "✅ Slack app manifest deployed successfully!"
    
    # Extract and display any warnings
    if echo "$RESPONSE" | grep -q '"warnings"'; then
        echo "⚠️  Warnings from Slack API:"
        echo "$RESPONSE" | python3 -c "import sys, json; data = json.load(sys.stdin); [print(f'  - {w}') for w in data.get('warnings', [])]"
    fi
else
    echo "❌ Failed to deploy Slack app manifest"
    echo "Response from Slack API:"
    echo "$RESPONSE" | python3 -m json.tool
    exit 1
fi

echo "🎉 Manifest deployment complete!"