# Slack App Configuration

This guide covers the complete Slack app setup for TLDR, including app creation, permissions, and GitHub secrets configuration.

## Overview

TLDR uses the **AI App split-view** interface as its primary (and only) user surface:
- **AI App split view**: Assistant thread with suggested prompts and in-thread summarization

## Prerequisites

- Slack workspace with admin permissions (paid plan required for AI Apps)
- Deployed AWS infrastructure (via Terraform)
- API Gateway endpoints from deployment:
  - Events: `https://{api-gateway}/slack/events`
  - Interactivity: `https://{api-gateway}/slack/interactive`

> **Note:** Slack interactivity is handled at `/slack/interactive` and Events API at `/slack/events` (see `terraform/apigateway.tf`). Both routes target the single Bolt Lambda; you may also point both subscriptions at `/slack/events` if you prefer.

## Step 1: Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From an app manifest**
3. Choose your workspace
4. Paste contents of `slack-app-manifest.yaml.template`
5. Review and create the app

## Step 2: Configure OAuth Scopes

Navigate to **OAuth & Permissions** and add these bot token scopes:

### Required Bot Scopes
- `app_mentions:read` - Receive @TLDR mentions in channels (chat replies)
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

Store runtime secrets as SSM SecureString parameters. Terraform passes the parameter *names* to the Lambda and grants it read access; secret values are never placed in Lambda environment variables. (In CI, the deploy workflow also syncs these values into SSM from GitHub Actions secrets on every deploy.)

```bash
aws ssm put-parameter --name /tldr/slack/bot-token \
  --type SecureString --value "xoxb-your-bot-token" --overwrite
aws ssm put-parameter --name /tldr/slack/signing-secret \
  --type SecureString --value "your-signing-secret" --overwrite
aws ssm put-parameter --name /tldr/anthropic/api-key \
  --type SecureString --value "sk-ant-your-anthropic-api-key" --overwrite
```

Set these deployment variables via `terraform/terraform.tfvars` (or `TF_VAR_*` env vars / CI repository variables):

- `SLACK_BOT_TOKEN_PARAMETER_NAME`
- `SLACK_SIGNING_SECRET_PARAMETER_NAME`
- `ANTHROPIC_API_KEY_PARAMETER_NAME`
- `ANTHROPIC_MODEL` (optional, default `claude-opus-4-8`)

For CI/CD, configure the `AWS_DEPLOY_ROLE_ARN` GitHub secret for a GitHub OIDC role and set the `TF_STATE_BUCKET` repository variable (the S3 bucket holding Terraform state; see `terraform/README.md`). `AWS_ACCOUNT_ID` is optional — if set, Terraform refuses to apply against any other account.

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
   terraform -chdir=terraform output -raw api_gateway_url
   ```
   (requires `terraform init` against the state bucket; see terraform/README.md)
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
   - `app_mention`
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
   - `summarize` - Summarize up to 50 messages from the source selected for this thread
   - `summarize last 100` - Summarize last 100 messages
   - `style` - Change the summary style
   - `help` - Show available commands

### Changing Channels

Use the **Source** picker in TLDR to choose a channel. The source stays set for this thread when you navigate elsewhere in Slack. An explicit `summarize #channel` request also updates this source after membership is verified.

### Custom Styles

Click "Set style" or type `style: your custom instructions` to customize how summaries are written. Styles persist for the current assistant thread.

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
- ☐ Source picker updates the source; Slack navigation leaves it unchanged
- ☐ "Summarize" produces a summary in the thread
- ☐ Custom styles are applied correctly
- ☐ Error messages display correctly for failures

## Explicit Source Selection

Slack's legacy `assistant_view` surface may omit channel-navigation events.
TLDR therefore labels its source explicitly and pins it to the assistant
thread. The native Source picker works without navigation events. When Slack
supplies context, it initializes an empty source; it never replaces a saved
choice. Typed `summarize #channel` requests update the source only after the
requester's membership is verified and the state write succeeds.

## Optional Migration to the New Agent Experience

Slack's July 2026 "[Agent context](https://docs.slack.dev/changelog/2026/07/02/app-context/)"
change replaces thread-scoped context events with app-scoped ones:

1. Manifest: swap `assistant_view` for `agent_view` (`assistant_description`
   → `agent_description`). **This cannot be reversed** — see caution below.
2. Event Subscriptions: add `app_context_changed` (scope `assistant:write`,
   already granted).
3. Once subscribed, `message.im` events carry an `app_context` field with the
   entities the user is viewing. The code reads this field
   (`appContextChannelId` in `bolt-ts/src/handlers/assistant.ts`) only when
   there is no saved source. A migration must preserve explicit source
   selection and must rework thread initialization first.

**Caution before migrating:**
- `agent_view` is irreversible once saved.
- `assistant_thread_started` stops firing under `agent_view`; the welcome
  card + suggested-prompts flow must be reworked onto `app_home_opened`
  (`tab === 'messages'`) first. Conversations move from the app's Chat tab
  into the Messages tab timeline.
- `assistant.threads.setStatus` / `setTitle` / `setSuggestedPrompts` keep
  working (prompts render at the top of the Messages tab instead).

## Related Documentation

- [Slack API: AI Apps](https://api.slack.com/docs/apps/ai)
- [Slack API: Events](https://api.slack.com/events)
- [Slack API: Interactivity](https://api.slack.com/interactivity)
- [Slack changelog: Agent context](https://docs.slack.dev/changelog/2026/07/02/app-context/)
