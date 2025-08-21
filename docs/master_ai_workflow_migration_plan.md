### Master AI Workflow Migration Plan — TLDR Slack App (Manual Trigger Only)

## Executive overview

This epic migrates TLDR to Slack’s AI App split‑view experience with a single, manual entry point: users click the TLDR icon in the top‑right of Slack to open an assistant thread and request a summary. Emoji‑reaction and scheduled workflows are explicitly removed. We preserve:
- **Custom model control**: continue using our own LLM (default: GPT‑5), via OpenAI Responses API
- **User preferences**: “Unread since last” and “Last N messages”, plus custom style prompts (per‑user default + per‑thread override)
- **Two‑Lambda architecture**: API Lambda → SQS → Worker Lambda; Slack remains the UI
- **Threaded UX**: results posted back in the AI app thread; optional channel/Canvas paths remain

Paid plan requirement and entry point verification:
- **Top‑right AI app entry point**: Slack confirms users can open an AI app from the upper‑right icon, which opens split view [Understand AI apps in Slack](https://slack.com/help/articles/33076000248851-Understand-AI-apps-in-Slack#chat-in-a-split-view). Also see [Developing AI Apps](https://api.slack.com/docs/apps/ai) (feature overview, split view, suggested prompts, status).
- **Events**: When the app is opened, Slack sends `assistant_thread_started`; user input arrives as `message.im`. See [assistant_thread_started](https://api.slack.com/events/assistant_thread_started), [message.im](https://api.slack.com/events/message.im), and the Events API index [Events API types](https://api.slack.com/events).

Scopes and events to enable:
- Scopes: `assistant:write`, `im:history`, `chat:write`
- Events: `assistant_thread_started`, `assistant_thread_context_changed`, `message.im`
(Per Slack: [Developing AI Apps → Event subscriptions](https://api.slack.com/docs/apps/ai))

## Where the prior plans converge
- **Keep the backend**: All plans favor keeping our API Lambda → SQS → Worker Lambda flow; no move to Slack’s Deno runtime.
- **Adopt AI App split view**: Use assistant threads for discoverability, suggested prompts, and status.
- **Preserve summarization modes**: “Unread since last” and “Last N messages” stay intact; TLDR already implements both.
- **Preserve custom prompts**: TLDR accepts a user style block; keep sanitization and pass through to the model.
- **Post in-context**: Reply to the same AI app thread (`thread_ts`), optionally also post to channel and Canvas.
- **Security and reliability**: Verify Slack signatures, enqueue fast, back off on rate limits, and log/measure.

What we intentionally remove in this epic
- Emoji‑reaction workflow (📋) — removed
- Scheduled workflow — removed
- Link/webhook triggers — out of scope for this migration

## Architecture (manual trigger only)
```
User (Slack, top‑right TLDR icon)
  → assistant_thread_started (context) → API Lambda (/slack/events)
  → API: set suggested prompts; show status when running
User types "Summarize unread" or "Summarize last 50"
  → message.im → API Lambda parses → enqueue ProcessingTask → SQS
SQS → Worker Lambda → Slack Web API (history) → OpenAI Responses (GPT‑5) → format
  → chat.postMessage(thread_ts) (+ optional channel/Canvas)
```

Internal task schema additions (modeled after earlier docs):
- `thread_ts: String`
- `mode: enum { Unread, LastN }`
- `message_count: Option<u32>`
- `style: Option<String>`
- `destination: enum { Thread, DM, Channel }` (default: Thread)

## User preferences (UI‑native, no DB by default)
- Provide a thread‑local configuration modal launched from a suggested prompt (e.g., “Open configuration”). Users choose: mode (Unread vs Last N), count, and custom style. Choices are sent with the job payload.
- For prefill without external storage, save the last‑used selections as message metadata on the assistant thread and read them to pre‑populate the next modal in that thread. This avoids any external DB while remaining native to Slack’s UI surfaces (see “Block Kit interactions in the app thread” and “message metadata” in Slack docs).
- Default selection continues to favor “last N unread” semantics as preferred [[memory:6609182]].

## Model selection
- Default model is **GPT‑5** (not `o3-mini`). Keep OPENAI_MODEL override via env/config. Continue using the OpenAI Responses API (not Chat Completions) [[memory:5718830]].

## Detailed plan (phased)

Phase 1 — App surface and events
- Enable Agents & AI Apps in the Slack app. Add scopes (`assistant:write`, `im:history`, `chat:write`) and subscribe to `assistant_thread_started`, `assistant_thread_context_changed`, `message.im`. Reinstall app.
- Add `/slack/events` route in API Lambda; verify Slack signatures; return 200 quickly.
- On `assistant_thread_started`, call `assistant.threads.setSuggestedPrompts` with “Summarize unread”, “Summarize last N”, and “Open configuration”.

Phase 2 — Manual flow (no emoji/scheduled)
- Parse `message.im` like: “summarize unread”, “summarize last 50”, “style: executive bullets”, etc.
- Map to `ProcessingTask` with `thread_ts`, `mode`, `message_count`, `style`.
- Enqueue; set `assistant.threads.setStatus("Summarizing…")`; clear after posting results.

Phase 3 — Worker updates + output
- Worker resolves mode (Unread vs LastN) using existing collectors.
- Use GPT‑5 Responses integration for summary generation; preserve custom style block behavior and formatting.
- Post results to the `thread_ts` with `chat.postMessage`; optionally also post to channel and/or Canvas (feature flag).

Phase 4 — Preferences UX (stateless by default)
- Implement the configuration modal in the AI app split view. On submit, embed selections in the ProcessingTask and attach them as message metadata to the assistant thread for prefill, avoiding external persistence.
- Later (optional), add durable per‑user defaults behind a feature flag if demanded, but the default implementation remains stateless (thread‑scoped) and UI‑native.

Phase 5 — Remove non‑manual triggers
- Remove/deactivate emoji‑reaction and scheduled workflow paths and docs.

Phase 6 — QA and rollout
- Validate in a paid dev workspace/sandbox. Test matrix: unread vs last‑N; style prompts; thread posting; large channels; error handling.
- Deploy and announce new entry point. Acceptable to have short outages during deployment.

## Acceptance criteria
- Users can open TLDR from the top‑right AI app icon and request summaries via chat in split view.
- Only manual triggers exist. Emoji and scheduled flows are removed.
- GPT‑5 is used by default (configurable).
- Unread and Last‑N modes work; custom style prompts applied.
- Results posted in the same assistant thread.
- Logging/metrics present; signatures verified; backoff on rate limits.

## Risks and mitigations
- Paid plan requirement: use Slack Developer Program sandbox to test if needed.
- Event delivery retries and status accuracy: always 200 fast; queue work.
- Rate limits: avoid frequent updates; post once per job.
- Preferences storage: default to stateless thread‑scoped metadata; only add durable storage later if user demand warrants it.

## References
- AI apps overview and split view entry point: [Developing AI Apps](https://api.slack.com/docs/apps/ai)
- User‑facing entry point (top‑right icon): [Understand AI apps in Slack](https://slack.com/help/articles/33076000248851-Understand-AI-apps-in-Slack#chat-in-a-split-view)
- Events: [assistant_thread_started](https://api.slack.com/events/assistant_thread_started), [message.im](https://api.slack.com/events/message.im), [Events API types](https://api.slack.com/events)
- Best practices & suggested prompts/status: [AI Apps best practices](https://api.slack.com/docs/apps/ai-best-practices)
- Block Kit interactions and thread context: see “Block Kit interactions in the app thread” and “Using modals in split view” in [Bolt AI apps concepts](https://docs.slack.dev/tools/bolt-python/concepts/ai-apps)
- Message metadata (for stateless prefill): [Message metadata](https://docs.slack.dev/messaging/message-metadata)
