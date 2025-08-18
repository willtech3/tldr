# Slack App Setup & GitHub Secrets Configuration

## Required GitHub Secrets

The following secrets must be configured in your GitHub repository for automated deployment:

### AWS Deployment Secrets (Already Configured)
- `AWS_ACCESS_KEY_ID` - AWS IAM user access key for CDK deployment
- `AWS_SECRET_ACCESS_KEY` - AWS IAM user secret key for CDK deployment

### Slack Integration Secrets (Already Configured)
- `SLACK_BOT_TOKEN` - Bot User OAuth Token (starts with `xoxb-`)
  - Used for: Bot operations (sending messages, reading channels, Canvas operations)
  - Found at: OAuth & Permissions → Bot User OAuth Token
- `SLACK_SIGNING_SECRET` - For request signature verification
  - Used for: Verifying requests come from Slack
  - Found at: Basic Information → App Credentials

### OpenAI API Secrets (Already Configured)
- `OPENAI_API_KEY` - OpenAI API key for ChatGPT
- `OPENAI_ORG_ID` - OpenAI organization ID

### Slack App Manifest Deployment (Need to Add)
To enable automatic Slack app manifest deployment, you need to add these secrets:

1. **`SLACK_APP_ID`** - Your Slack app's ID
   - Find at: api.slack.com → Your App → Basic Information → App ID
   - Format: `A01XXXXXX`
   - Example: `A01ABC2D3EF`

2. **`SLACK_APP_CONFIG_TOKEN`** - App configuration token for manifest updates
   - **IMPORTANT**: This is NOT the same as your bot token (`SLACK_BOT_TOKEN`)
   - Generate at: api.slack.com → Your App → Basic Information → App-Level Tokens
   - Click "Generate Token and Scopes"
   - Token Name: "Manifest Deployment" (or any descriptive name)
   - Add scope: `app_configurations:write` (NOT `connections:write`)
   - Copy the token (starts with `xapp-`)
   - Format: `xapp-1-...`
   - Note: These tokens don't expire but are only needed during deployment

## Understanding Token Types

| Token Type | Prefix | Purpose | Where to Find |
|------------|--------|---------|---------------|
| Bot Token | `xoxb-` | Runtime API calls (messages, Canvas) | OAuth & Permissions |
| App Config Token | `xapp-` | Manifest updates only | App-Level Tokens |
| Signing Secret | (no prefix) | Request verification | Basic Information |

## How to Add GitHub Secrets

1. Go to your GitHub repository
2. Navigate to Settings → Secrets and variables → Actions
3. Click "New repository secret"
4. Add each secret with the exact name shown above

## Step-by-Step: Generating App Configuration Token

1. **Navigate to Your App**:
   - Go to [api.slack.com/apps](https://api.slack.com/apps)
   - Click on your TLDR app

2. **Go to App-Level Tokens Section**:
   - Click "Basic Information" in the left sidebar
   - Scroll down to "App-Level Tokens" section

3. **Generate New Token**:
   - Click "Generate Token and Scopes"
   - Token Name: Enter "Manifest Deployment" (or any name you prefer)
   - Scopes: Click "Add Scope" and select `app_configurations:write`
     - **IMPORTANT**: Make sure you select `app_configurations:write`, NOT `connections:write`
   - Click "Generate"

4. **Copy the Token**:
   - A token starting with `xapp-1-` will appear
   - Click "Copy" to copy it to your clipboard
   - **Save this immediately** - you won't be able to see it again

5. **Add to GitHub Secrets**:
   - Go to your GitHub repository
   - Settings → Secrets and variables → Actions
   - Click "New repository secret"
   - Name: `SLACK_APP_CONFIG_TOKEN`
   - Value: Paste the `xapp-1-...` token
   - Click "Add secret"

## Initial Slack App Setup

### First-Time Setup Only

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click "Create New App" → "From an app manifest"
3. Choose your workspace
4. Paste the contents of `slack-app-manifest.yaml`
5. Review and create the app
6. Install the app to your workspace

### After App Creation

1. Copy the App ID from Basic Information (format: `A01XXXXXX`)
2. Generate an app configuration token (see detailed steps above)
3. Add both as GitHub secrets
4. The deployment pipeline will now automatically update your Slack app manifest

## Deployment Flow

When you push to the `main` branch:

1. **CDK Deployment**: Creates/updates AWS infrastructure (Lambdas, API Gateway, SQS)
2. **API Gateway URL**: Automatically extracted from CDK outputs
3. **Manifest Update**: Uses `SLACK_APP_CONFIG_TOKEN` to update Slack app with new endpoints
4. **No Manual Steps**: Everything is automated after initial setup
5. **Failure Protection**: Pipeline will fail if Slack secrets are missing (no partial deployments)

## Verifying the Setup

After deployment, verify all three trigger methods work:

1. **Slash Command**: Type `/tldr` in any channel
2. **Global Shortcut**: Lightning bolt → "Summarize Channel"
3. **Message Shortcut**: Three-dot menu → "Summarize Thread"

## Canvas Integration

The bot will automatically:
- Create a "📋 TLDR Summaries" canvas in each channel on first use
- Prepend new summaries at the top with timestamps
- Maintain a history of all summaries in the canvas

## Troubleshooting

If manifest deployment fails:

- Check that `SLACK_APP_ID` and `SLACK_APP_CONFIG_TOKEN` are set correctly
- Ensure the app configuration token has `app_configurations:write` scope  
- Token format should be `xapp-1-...` (NOT `xoxb-...` which is the bot token)
- Review GitHub Actions logs for specific error messages
- Note: App config tokens expire after 12 hours but are regenerated each deployment
- As a last resort, manually update the manifest at api.slack.com

## Common Mistakes to Avoid

1. **Using Bot Token Instead of App Config Token**: The `SLACK_BOT_TOKEN` (xoxb-) cannot update manifests
2. **Missing Scope**: App config token must have `app_configurations:write` scope
3. **Wrong Token Format**: App config tokens start with `xapp-`, not `xoxb-`
4. **Not Adding Both Secrets**: Both `SLACK_APP_ID` and `SLACK_APP_CONFIG_TOKEN` are required
