# Slack App Configuration

This guide covers the complete Slack app setup for TLDR, including app creation, permissions, and GitHub secrets configuration.

## Overview

TLDR uses the **AI App split-view** interface as its primary (and only) user surface:
- **AI App split view**: Assistant thread with suggested prompts and in-thread summarization

## Prerequisites

- Slack workspace with admin permissions (paid plan required for AI Apps)
- Deployed AWS infrastructure (via CDK)
- API Gateway endpoints from deployment:
  - Events: `https://{api-gateway}/slack/events`
  - Interactivity: `https://{api-gateway}/slack/interactive`

> **Note:** Slack interactivity is handled at `/slack/interactive` and Events API at `/slack/events` (see `cdk/lib/tldr-stack.ts`). Both routes target the single Bolt Lambda; you may also point both subscriptions at `/slack/events` if you prefer.

## Step 1: Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From an app manifest**
3. Choose your workspace
4. Paste contents of `slack-app-manifest.yaml.template`
5. Review and create the app

## Step 2: Configure OAuth Scopes

Navigate to **OAuth & Permissions** and add these bot token scopes:

### Required Bot Scopes
- `assistant:write` - Required for AI App features
- `im:history`, `im:read`, `im:write` - Read/write DM conversations
- `channels:history`, `channels:read` - Read public channel messages
- `chat:write` - Post messages
- `groups:history`, `groups:read` - Read private channel messages
- `mpim:history`, `mpim:read` - Read group DM history
- `users:read` - Get user info
- `files:read` - Download images for summarization

After adding scopes, click **Install to Workspace**.

## Step 3: Collect Credentials

From **Basic Information**:
- **App ID**: Format `A01XXXXXX`
- **Signing Secret**: For request verification

From **OAuth & Permissions**:
- **Bot User OAuth Token**: Starts with `xoxb-`

## Step 4: Store Runtime Secrets in SSM

Store runtime secrets as SSM SecureString parameters. CDK passes parameter names to Lambda and grants each function read access; it does not put secret values in Lambda environment variables.

```bash
aws ssm put-parameter --name /tldr/slack/bot-token \
  --type SecureString --value "xoxb-your-bot-token" --overwrite
aws ssm put-parameter --name /tldr/slack/signing-secret \
  --type SecureString --value "your-signing-secret" --overwrite
aws ssm put-parameter --name /tldr/anthropic/api-key \
  --type SecureString --value "sk-ant-your-anthropic-api-key" --overwrite
```

Set these deployment variables in `cdk/.env` or your CI environment:

- `SLACK_BOT_TOKEN_PARAMETER_NAME`
- `SLACK_SIGNING_SECRET_PARAMETER_NAME`
- `ANTHROPIC_API_KEY_PARAMETER_NAME`
- `ANTHROPIC_MODEL` (optional, default `claude-sonnet-4-6`)

For CI/CD, configure the `AWS_DEPLOY_ROLE_ARN` GitHub secret for a GitHub OIDC role and set `AWS_ACCOUNT_ID` as a repository variable. The CDK stack no longer creates a broad IAM deployment user or outputs long-lived access keys.

## Step 5: Deploy Infrastructure

Push to the main branch or manually trigger GitHub Actions from the main ref:
```bash
git push origin main
# Or trigger manually in GitHub Actions UI
```

The deployment will output your API Gateway URL.

## Step 6: Update Slack App Manifest

After deployment, update your Slack app with the API Gateway URL:

1. Get the API Gateway URL from:
   ```bash
   aws cloudformation describe-stacks --stack-name TldrStack \
     --query "Stacks[0].Outputs[?OutputKey=='ApiGatewayUrl'].OutputValue" \
     --output text
   ```
   Or check GitHub Actions logs for "API Gateway URL"

2. Update `slack-app-manifest.yaml`:
   - Replace all `YOUR-API-ID` with your actual API Gateway ID
   - URL format: `https://{api-id}.execute-api.{region}.amazonaws.com/prod`

3. Apply to Slack:
   - Go to your app at [api.slack.com/apps](https://api.slack.com/apps)
   - Click **App Manifest** in sidebar
   - Paste updated manifest
   - Click **Save Changes**

## Step 7: Enable AI App Features

Navigate to **Agents & AI Apps**:
1. Enable **Agents & AI Apps** feature
2. This unlocks assistant thread events

## Step 8: Enable Interactivity & Events

Navigate to **Interactivity & Shortcuts**:
1. Toggle **Interactivity** ON
2. Set **Request URL**: `https://{api-gateway}/slack/interactive`

Navigate to **Event Subscriptions**:
1. Toggle **Enable Events** ON
2. Set **Request URL**: `https://{api-gateway}/slack/events`
3. Subscribe to Bot Events:
   - `assistant_thread_started`
   - `assistant_thread_context_changed`
   - `message.im`

## Step 9: Reinstall App

After all configuration:
1. Go to **OAuth & Permissions**
2. Click **Reinstall to Workspace**
3. Review and approve permissions

## Usage

### AI App Split View

Open the TLDR app from Slack's AI icon (top-right):

1. Click the AI Apps icon in the top-right corner of Slack
2. Select **TLDR** from the list
3. The assistant thread opens in split-view
4. Use suggested prompts or type commands:
   - `summarize` - Summarize last 50 messages from current channel
   - `summarize last 100` - Summarize last 100 messages
   - `style` - Change the summary style
   - `help` - Show available commands

### Changing Channels

When you switch channels in Slack while the AI App is open, TLDR automatically updates its context. The next summarize command will target the new channel.

### Custom Styles

Click "Change style" or type `style: your custom instructions` to customize how summaries are written. Styles persist for the current assistant thread.

## Token Types Reference

| Token Type | Prefix | Purpose | Location |
|------------|--------|---------|----------|
| Bot Token | `xoxb-` | Runtime API calls | OAuth & Permissions |
| Signing Secret | (none) | Request verification | Basic Information |

## Security Implementation

The app implements Slack's security requirements:
- **Request Verification**: HMAC-SHA256 using signing secret
- **Timestamp Validation**: Rejects requests > 5 minutes old
- **3-Second Response**: Acknowledges within Slack's timeout window
- **Raw Body Verification**: Uses unparsed body for signature verification

Reference: [Slack Request Verification](https://api.slack.com/authentication/verifying-requests-from-slack)

## Troubleshooting

### AI App Not Appearing
- Verify **Agents & AI Apps** is enabled in app settings
- Ensure workspace is on a paid plan (AI Apps require paid plans)
- Reinstall app after enabling features

### Events Not Received
- Verify Event Subscriptions URL responds with 200
- Check CloudWatch logs for incoming requests
- Ensure bot events are subscribed

### Signature Verification Fails
- Ensure `SLACK_SIGNING_SECRET` is correct
- Verify using raw request body (not parsed)
- Check timestamp is within 5-minute window

## Testing Checklist

- ☐ AI App appears in Slack's AI Apps menu
- ☐ Opening TLDR shows welcome message and suggested prompts
- ☐ Switching channels updates context
- ☐ "Summarize" produces a summary in the thread
- ☐ Custom styles are applied correctly
- ☐ Error messages display correctly for failures

## Related Documentation

- [Slack API: AI Apps](https://api.slack.com/docs/apps/ai)
- [Slack API: Events](https://api.slack.com/events)
- [Slack API: Interactivity](https://api.slack.com/interactivity)
