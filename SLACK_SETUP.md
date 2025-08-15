# Slack App Setup for TLDR (Slash Command + Shortcuts + Modals)

This guide explains how to configure your Slack app at `api.slack.com/apps` for the new UI-based workflow implemented in this repository. All steps are grounded in Slack’s official docs (linked inline) and match how this code handles requests and responses.

## What this app uses

- Slash Command: `/tldr`
- Interactivity & Shortcuts: global/message shortcuts; modal submission handling
- Modals: `views.open` and `view_submission`
- Request signing: `X-Slack-Signature` HMAC-SHA256 verification

Relevant Slack docs:
- Verifying requests: https://api.slack.com/authentication/verifying-requests-from-slack
- Slash commands: https://api.slack.com/interactivity/slash-commands
- Interactivity handling (shortcuts, payloads, view_submission): https://api.slack.com/interactivity/handling
- Shortcuts (global + message): https://api.slack.com/interactivity/shortcuts
- Shortcuts payload reference: https://api.slack.com/reference/interaction-payloads/shortcuts
- `views.open`: https://api.slack.com/methods/views.open

## Prerequisites

- A Slack workspace where you can install a custom app
- Your deployed API URL(s) from AWS API Gateway (CDK creates routes):
  - Slash command endpoint (POST): `.../commands`
  - Interactivity endpoint (POST): `.../slack/interactive`

From this repo’s CDK stack, both endpoints map to the API Lambda and are signature-verified in the code.

## 1) Create or open your app

- Go to `api.slack.com/apps` → Create New App (from scratch).
- App Name: TLDR (or your preferred name)
- Development Workspace: select the target workspace

## 2) Basic Information → App Credentials

- Note the Signing Secret. Set it as the environment variable `SLACK_SIGNING_SECRET` in your deployed Lambda (CDK already wires env; you just populate values).
- Our code validates requests exactly as per Slack docs using:
  - Header `X-Slack-Signature`
  - Header `X-Slack-Request-Timestamp`
  - Base string `v0:{timestamp}:{raw_body}` (raw body, not parsed)
  - HMAC-SHA256 using signing secret
  - Time window ≤ 5 minutes
  Reference: Verifying requests (Slack): https://api.slack.com/authentication/verifying-requests-from-slack

## 3) OAuth & Permissions → Scopes

Add bot scopes our features require:
- `commands` (required for slash commands and to enable shortcuts) – Shortcuts docs: https://api.slack.com/interactivity/shortcuts
- If your bot sends messages or DMs as part of summaries, also include the scopes you already use (e.g., `chat:write`, etc.). This repo’s `SlackBot` uses token-based Web API calls like `views.open` and posting. Ensure your existing scopes in this project remain present.

After adding scopes, click Save Changes and Reinstall App to Workspace.

## 4) Slash Commands

- Features → Slash Commands → Create New Command
  - Command: `/tldr`
  - Request URL: `https://{api-gateway}/commands`
  - Short Description: "Summarize unread or recent messages"
  - Usage Hint: e.g., `count=100 --visible custom="Use bullet points"`
  - Enable "Escape channels, users, and links" (optional but recommended per Slack docs)

Slack will POST `application/x-www-form-urlencoded` to your Request URL. Our API Lambda parses this, opens a modal via `views.open` within 3s using `trigger_id` (Slack requirement), then replies with a 200 OK ephemeral acknowledgement.

References:
- Slash commands setup/flow: https://api.slack.com/interactivity/slash-commands
- 3-second ACK requirement: see same page (“Confirming receipt”)

## 5) Interactivity & Shortcuts

- Features → Interactivity & Shortcuts → Toggle Interactivity ON
- Request URL: `https://{api-gateway}/slack/interactive`
  - Slack sends all interactive payloads (shortcuts, block_actions, view_submission) to this single URL as `application/x-www-form-urlencoded` with a `payload` JSON field.
  - Our API Lambda detects `payload=` and parses JSON. It handles `type` as follows:
    - `shortcut` / `message_action`: opens the TLDR modal (`views.open`) using the short-lived `trigger_id` (must be used within 3s; Slack enforces this).
    - `view_submission`: validates inputs and returns either
      - `{ "response_action": "clear" }` to close modal on success, or
      - `{ "response_action": "errors", "errors": { block_id: "msg" } }` for inline errors.

References:
- Interactivity handling + Request URL: https://api.slack.com/interactivity/handling
- Shortcut types/payloads (global vs message_action, response_url availability):
  https://api.slack.com/reference/interaction-payloads/shortcuts
- Modal submissions (`view_submission`) and response actions: see Interactivity docs and Bolt’s `ack(response_action=...)` docs; Slack behavior is identical.

## 6) Create Shortcuts

- Interactivity & Shortcuts → Create New Shortcut
  - Type: Global or On messages
  - Name: e.g., "Summarize channel"
  - Callback ID: e.g., `tldr_open`
  - Save

Notes from Slack docs:
- Global shortcuts do not include a `response_url`. Use the `trigger_id` to open a modal within 3s, per https://api.slack.com/interactivity/shortcuts
- Message shortcuts include channel/message context and usually include `response_url`.

Our app opens a Block Kit modal in both cases via `views.open` (implemented in `lambda/src/bot.rs`). The modal includes a `conversations_select`, range options, `last_n` number input, datepickers, and destination checkboxes.

## 7) Modals specifics (views.open and view_submission)

- Your app will call `views.open` with:
  - `trigger_id` from payload (valid for ~3s, single-use)
  - `view` JSON (Block Kit)
- When the user submits the modal, Slack sends a `view_submission` payload to your Interactivity Request URL. Your app must:
  - Acknowledge within 3s
  - Return `response_action` and (optionally) `errors` map for inline validation

References:
- Interactivity handling (incl. modal responses): https://api.slack.com/interactivity/handling
- Web API `views.open`: https://api.slack.com/methods/views.open

## 8) Environment variables

Populate these in Lambda (CDK wires keys; you supply values):
- `SLACK_BOT_TOKEN` (xoxb-...)
- `SLACK_SIGNING_SECRET`
- `OPENAI_API_KEY`
- `PROCESSING_QUEUE_URL`

## 9) Security notes (per Slack docs)

- Always verify `X-Slack-Signature` and `X-Slack-Request-Timestamp` using the raw HTTP body (not parsed). This app implements the exact algorithm documented at:
  https://api.slack.com/authentication/verifying-requests-from-slack
- Acknowledge within 3 seconds for slash commands and interactivity payloads, otherwise Slack shows a timeout to the user.

## 10) Testing checklist

- Slash command `/tldr` → modal opens quickly (we wait up to ~2.5s for views.open, within Slack’s 3s window)
- Global shortcut → opens modal; no `response_url` in payload, which is expected
- Message shortcut → opens modal with message context; may include `response_url`
- Submitting modal → receives `view_submission`, inline errors when invalid, clears modal on success

## Appendix: Example values to enter in app config

- Slash Commands → `/tldr`
  - Request URL: `https://{api-gateway-url}/commands`
- Interactivity & Shortcuts → Interactivity
  - Request URL: `https://{api-gateway-url}/slack/interactive`
- Shortcuts → Create New Shortcut
  - Type: Global or On messages
  - Name: "Summarize channel"
  - Callback ID: `tldr_open`
- OAuth & Permissions → Scopes
  - `commands` (required for commands/shortcuts)
  - plus existing messaging scopes used by the app

All behaviors above match Slack’s documented contracts for request signing, 3s acknowledgement, modal `views.open`, and `view_submission` response actions.