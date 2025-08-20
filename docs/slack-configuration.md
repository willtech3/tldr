# Slack App Configuration

This guide covers the complete Slack app setup for TLDR, including app creation, permissions, and GitHub secrets configuration.

## Overview

TLDR uses:
- **Slash Command**: `/tldr` (use `--ui` flag to open modal)
- **Message Shortcut**: Three-dot menu → "Summarize Thread"
- **Modals**: Interactive UI for configuration
- **Canvas Integration**: Automatic summary storage in channel canvases

## Prerequisites

- Slack workspace with admin permissions
- Deployed AWS infrastructure (via CDK)
- API Gateway endpoints from deployment:
  - Slash command: `https://{api-gateway}/commands`
  - Interactivity: `https://{api-gateway}/slack/interactive`

## Step 1: Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From an app manifest**
3. Choose your workspace
4. Paste contents of `slack-app-manifest.yaml.template`
5. Review and create the app

## Step 2: Configure OAuth Scopes

Navigate to **OAuth & Permissions** and add these bot token scopes:

### Required Scopes
- `commands` - Enable slash commands and shortcuts
- `channels:history` - Read channel messages
- `channels:read` - View channel information
- `chat:write` - Send messages
- `im:write` - Send DMs
- `users:read` - View user information

### Canvas Integration (Optional but Recommended)
- `channels:manage` - Create and manage canvases
- `bookmarks:read` - Read channel bookmarks
- `bookmarks:write` - Create/update Canvas bookmarks

After adding scopes, click **Install to Workspace**.

## Step 3: Collect Credentials

From **Basic Information**:
- **App ID**: Format `A01XXXXXX`
- **Signing Secret**: For request verification

From **OAuth & Permissions**:
- **Bot User OAuth Token**: Starts with `xoxb-`

## Step 4: Configure GitHub Secrets

Add these secrets to your GitHub repository (Settings → Secrets and variables → Actions):

### AWS Secrets
- `AWS_ACCESS_KEY_ID` - IAM user access key
- `AWS_SECRET_ACCESS_KEY` - IAM user secret key

### Slack Secrets
- `SLACK_BOT_TOKEN` - Bot token from Step 3
- `SLACK_SIGNING_SECRET` - Signing secret from Step 3

### OpenAI Secrets
- `OPENAI_API_KEY` - OpenAI API key
- `OPENAI_ORG_ID` - Organization ID (optional)

## Step 5: Deploy Infrastructure

Push to main branch or manually trigger GitHub Actions:
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

## Step 7: Configure Slash Command

Navigate to **Slash Commands** → **Create New Command**:
- **Command**: `/tldr`
- **Request URL**: `https://{api-gateway}/commands`
- **Short Description**: Summarize unread or recent messages
- **Usage Hint**: `count=100 --visible custom="Use bullet points" --ui`

## Step 8: Enable Interactivity

Navigate to **Interactivity & Shortcuts**:
1. Toggle **Interactivity** ON
2. Set **Request URL**: `https://{api-gateway}/slack/interactive`

## Step 9: Create Shortcuts

### Message Shortcut (Three-Dot Menu)
1. Click **Create New Shortcut** → **On Messages**
2. Configure:
   - **Name**: Summarize Thread
   - **Short Description**: Summarize this message thread
   - **Callback ID**: `tldr_message_action`

## Step 10: Reinstall App

After all configuration:
1. Go to **OAuth & Permissions**
2. Click **Reinstall to Workspace**
3. Review and approve permissions

## Usage

### Slash Command
```
/tldr                    # Opens modal
/tldr count=50          # Direct summary of last 50 messages
/tldr --visible         # Post publicly to channel
/tldr --ui              # Force modal to open
```

### Message Shortcut
1. Hover over any message
2. Click ... (three-dot menu)
3. Select "Summarize Thread"

## Canvas Integration

Summaries can be automatically stored in channel canvases:
- Creates "📋 TLDR Summaries" canvas on first use
- New summaries prepended at top (newest first)
- Each summary includes timestamp, content, and attribution
- Access via 📋 icon in channel header

## Token Types Reference

| Token Type | Prefix | Purpose | Location |
|------------|--------|---------|----------|
| Bot Token | `xoxb-` | Runtime API calls | OAuth & Permissions |
| Signing Secret | (none) | Request verification | Basic Information |
| Config Token | `xoxe.xoxp-` | Manifest updates (not used) | N/A |
| App-Level Token | `xapp-` | Socket mode (not used) | N/A |

## Security Implementation

The app implements Slack's security requirements:
- **Request Verification**: HMAC-SHA256 using signing secret
- **Timestamp Validation**: Rejects requests > 5 minutes old
- **3-Second Response**: Acknowledges within Slack's timeout window
- **Raw Body Verification**: Uses unparsed body for signature verification

Reference: [Slack Request Verification](https://api.slack.com/authentication/verifying-requests-from-slack)

## Troubleshooting

### Modal Submit Button Missing
- Verify modal has at least one input block
- Check callback_id is set correctly
- Ensure app has required permissions

### Shortcuts Not Appearing
- Verify callback IDs match exactly
- Confirm Interactivity is enabled
- Reinstall app after changes

### Canvas Creation Fails
- Check bot has `channels:manage` and `bookmarks:write` scopes
- Verify bot is member of the channel
- Check CloudWatch logs for specific errors

### Signature Verification Fails
- Ensure `SLACK_SIGNING_SECRET` is correct
- Verify using raw request body (not parsed)
- Check timestamp is within 5-minute window

## Testing Checklist

- [ ] `/tldr` command opens modal
- [ ] Message shortcut appears in three-dot menu
- [ ] Modal submission processes successfully
- [ ] Canvas creation works (if enabled)
- [ ] DM delivery works
- [ ] Public posting works with `--visible` flag
- [ ] Error messages display correctly for invalid inputs

## Related Documentation

- [Slack API: Slash Commands](https://api.slack.com/interactivity/slash-commands)
- [Slack API: Shortcuts](https://api.slack.com/interactivity/shortcuts)
- [Slack API: Modals](https://api.slack.com/surfaces/modals)
- [Slack API: Canvas](https://api.slack.com/methods/conversations.canvases)