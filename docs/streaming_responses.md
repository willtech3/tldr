## Streaming Responses to Slack (Implementation Spec)

This document is a **fully-specified, agent-implementable plan** to add **real-time text streaming** for TLDR’s AI summaries in Slack **AI App assistant threads**.

It is written to be “no guessing required”: explicit architecture choice, exact Slack/OpenAI behaviors (verified), concrete code touchpoints, and ✅/☐ checklists per task group.

---

## Goals / non-goals

- **Goal**: Stream summaries into the assistant thread so users see text appear progressively (ChatGPT-style), instead of waiting for a full response.
- **Goal**: Keep Slack's HTTP/event ACK requirements intact by preserving the current **Bolt TS → SQS → Rust Worker** architecture.

- **Non-goal**: Replace the current prompt builder, image handling, or receipts/links logic (we will reuse existing Rust logic).
- **Non-goal**: Switch to a different OpenAI API surface (TLDR already uses the **Responses API**).

---

## Glossary (Slack terms used throughout)

- **Assistant channel ID**: The DM channel hosting the AI App assistant thread (e.g. `D...`). In TLDR tasks this is `ProcessingTask.origin_channel_id`.
- **Assistant thread ts**: The root thread timestamp Slack assigns to the assistant thread (from `assistant_thread_started.assistant_thread.thread_ts`). In TLDR tasks this is `ProcessingTask.thread_ts`.
- **Stream message ts**: The message timestamp returned by `chat.startStream`. This identifies the streaming message; it is passed to `chat.appendStream` and `chat.stopStream`.

---

## Current repo architecture (ground truth)

### Bolt TypeScript (API Lambda)

- **Summarize entrypoint**: `bolt-ts/src/handlers/message.ts`
  - Receives Slack events (`message` with `channel_type: 'im'`, corresponding to `message.im` subscriptions).
  - Validates intent and enqueues a `ProcessingTask` to SQS.
  - Calls `assistant.threads.setStatus({ status: 'Summarizing...' })` (currently without `loading_messages`).

### Rust worker (SQS Lambda)

- **Worker handler**: `lambda/src/worker/handler.rs`
  - Reads `ProcessingTask` from SQS.
  - Runs `summarize_task` (`lambda/src/worker/summarize.rs`) which fetches Slack messages and calls OpenAI (non-streaming).
  - Delivers final message via `deliver_summary` (`lambda/src/worker/deliver.rs`) using `chat.postMessage` to reply in thread.

### OpenAI integration

- **Responses API (non-streaming)**: `lambda/src/ai/client.rs::LlmClient::generate_summary`
  - Uses `POST https://api.openai.com/v1/responses`
  - Parses `output_text` from the response.

---

## External constraints & APIs (verified against official docs)

### Slack Events API ACK window (why we keep async + SQS)

Slack requires your event request URL to respond with an HTTP 2xx **within three seconds**, otherwise Slack considers delivery failed and retries with exponential backoff. Best practices include queueing work and avoiding processing in the same request handler.

- Docs: [The Events API — Responding to events](https://docs.slack.dev/apis/events-api/#responding)

### Slack streaming methods (`chat.*Stream`)

Slack provides 3 Web API methods for message streaming:

| Method | Purpose | Rate limit (per docs) |
|--------|---------|------------------------|
| `chat.startStream` | Create a new streaming message | Tier 2: 20+ / minute |
| `chat.appendStream` | Append markdown to the streaming message | Tier 4: 100+ / minute |
| `chat.stopStream` | Finalize the streaming message (optionally attach blocks + metadata) | Tier 2: 20+ / minute |

Method references:
- [`chat.startStream`](https://docs.slack.dev/reference/methods/chat.startStream/)
- [`chat.appendStream`](https://docs.slack.dev/reference/methods/chat.appendStream/)
- [`chat.stopStream`](https://docs.slack.dev/reference/methods/chat.stopStream/)

**Verified constraints (important for implementation)**:
- `chat.startStream.markdown_text` is **optional** and is limited to **12,000 chars**.
- `chat.appendStream.markdown_text` is **required** and is limited to **12,000 chars** **per call**.
- `chat.stopStream.markdown_text` is **optional** and is limited to **12,000 chars**.
- `chat.startStream.thread_ts` is **required**. The streamed message is always a reply.
- When streaming to channels (not DMs), `recipient_user_id` and `recipient_team_id` are required.

### Slack assistant thread status (`assistant.threads.setStatus`)

Slack provides thread-level status / loading indicators:

- Docs: [`assistant.threads.setStatus`](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/)

**Verified constraints (important for implementation)**:
- `loading_messages` is optional and supports a **maximum of 10** messages.
- A **two minute timeout** applies; status is removed if no message is sent.
- Status clears automatically when the app sends a reply.
- Sending an empty string in `status` clears the status indicator.

### OpenAI Responses streaming (SSE)

OpenAI Responses supports streaming via server-sent events (SSE):

- Guide: [Streaming API responses](https://platform.openai.com/docs/guides/streaming-responses)

**Common event types to handle (not exhaustive)**:
- `response.created`
- `response.output_text.delta`
- `response.completed`
- `response.failed`
- `error`

**Verified event field**: `response.output_text.delta` events contain a `delta` string.
- OpenAI Python SDK (generated from OpenAPI): [`ResponseTextDeltaEvent` type](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_text_delta_event.py)
- OpenAI Python SDK: [`ResponseCompletedEvent` type](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_completed_event.py)
- OpenAI Python SDK: [`ResponseFailedEvent` type](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_failed_event.py)
- OpenAI Python SDK: [`ResponseErrorEvent` type](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_error_event.py)

---

## Architecture decision (what we will implement)

### Recommended: Stream from the Rust worker (keep OpenAI call in Rust)

This repo already uses SQS to protect Slack’s 3-second ACK window. The Rust worker is where the OpenAI call happens today, and it already owns the “deep” summarization logic (images, links, receipts).

Therefore, the recommended implementation is:
- Bolt TS continues to ACK quickly, set status, enqueue tasks.
- Rust worker switches from **non-streaming OpenAI** → **streaming OpenAI**, and wires OpenAI text deltas to Slack `chat.appendStream`.

### Not recommended (for this repo): Stream from Bolt TS

Streaming directly from Bolt TS would require moving the entire OpenAI + prompt-building + image-handling pipeline out of Rust (or introducing a new sync back-channel from worker → Bolt). That is a separate architecture project and is not required for streaming.

---

## End-to-end behavior spec

### Trigger

User sends `summarize …` inside an AI App assistant thread (Slack `message.im`, received by Bolt as an event of type `message` with `channel_type: 'im'`).

### Bolt TS responsibilities (must remain fast)

In `bolt-ts/src/handlers/message.ts`, for the `summarize` intent:

- **Must** enqueue `ProcessingTask` to SQS (existing behavior).
- **Must** call `assistant.threads.setStatus` with:
  - `status: 'Summarizing...'`
  - `loading_messages: [...]` (≤10 strings)
- **Must** avoid introducing new awaited Slack Web API calls in the hot path (preserve fast ACK).

### Worker responsibilities (streaming path)

In the Rust worker:

- **Must** stream only when the primary destination is `Destination::Thread` and `thread_ts` is present.
- **Must** post the summary incrementally into the assistant thread using Slack `chat.*Stream`.
- **Must** preserve the existing exact failure message string (see "Error handling" below).
- **Must** stream into the assistant thread identifiers from the task:
  - Slack `channel` for `chat.*Stream`: `ProcessingTask.origin_channel_id` (fallback to `ProcessingTask.channel_id` only if missing).
  - Slack `thread_ts` for `chat.startStream`: `ProcessingTask.thread_ts`.

### Output format parity (must match current non-streaming thread replies)

Today, thread replies are formatted by two places in Rust:

- `lambda/src/worker/deliver.rs`: optionally prefixes the message with a style header:
  - `_Style: <truncated_style>_\n\n`
- `lambda/src/slack/bot.rs::summarize_messages_with_chatgpt`: prefixes the model output with:
  - `*Summary from <#<channel_id>>*\n\n`

The streaming implementation **must preserve these prefixes** so streamed and non-streamed outputs look the same to users.

Implementation constraint (important): because `chat.startStream` does not support `metadata` and streaming output arrives incrementally, the worker should:

- Start the Slack stream with the full prefix string (style header + “Summary from …” header).
- Append OpenAI `delta` text after the prefix.
- Accumulate the full model output in memory and run the same “safety net” post-processing currently applied after `generate_summary` in `lambda/src/slack/bot.rs` (ensuring “Links shared”, “Image highlights”, “Receipts” sections exist). Any missing sections can be appended at the end before stopping the stream.

---

## Slack streaming implementation details (Rust)

### API wrapper requirements

Implement a small Rust wrapper around Slack streaming APIs (either within `lambda/src/slack/client.rs` or a new module under `lambda/src/slack/`):

- **`start_stream`** (wraps `chat.startStream`)
  - Inputs: `channel`, `thread_ts`, optional `markdown_text`
  - Output: streaming message `ts` (stream message ts)
- **`append_stream`** (wraps `chat.appendStream`)
  - Inputs: `channel`, `ts`, `markdown_text`
- **`stop_stream`** (wraps `chat.stopStream`)
  - Inputs: `channel`, `ts`, optional `markdown_text`, optional `blocks`, optional `metadata`

**Important**:
- When sending JSON POST bodies to Slack Web API, you must transmit your `token` as a bearer token in the `Authorization` header and you cannot include it as an attribute in posted JSON. TLDR’s Rust Slack client already uses bearer auth; follow the same pattern for the streaming methods.
  - Docs: [Slack Web API — JSON POST bodies (token rules)](https://docs.slack.dev/apis/web-api/)
- Use `Content-type: application/json` for these calls and do not mix query parameters + JSON body attributes in the same request (Slack treats that as invalid).

### Metadata & privacy note (Slack)

Slack notes that message metadata is accessible to any app/user in the workspace. If we include metadata, keep it minimal and non-sensitive (e.g., correlation ids and booleans).

### Suggested message metadata schema (for dedupe + debugging)

Use Slack message metadata on the finalized streamed summary message to support best-effort idempotency and easier debugging.

- **`metadata.event_type`**: `tldr_summary`
- **`metadata.event_payload`** (keep small):
  - `v`: `1`
  - `correlation_id`: `<ProcessingTask.correlation_id>`
  - `source_channel_id`: `<ProcessingTask.channel_id>`
  - `message_count`: `<ProcessingTask.message_count>` (or default used)
  - `streamed`: `true`

---

## OpenAI streaming implementation details (Rust)

### Request

Add a streaming-capable OpenAI call in `lambda/src/ai/client.rs`:

- Endpoint: `POST https://api.openai.com/v1/responses`
- Must include:
  - `model`
  - `input` (already built via `build_responses_input_from_prompt`)
  - `max_output_tokens`
  - `stream: true`

### Event handling

OpenAI returns SSE events. The implementation must:

- Parse SSE frames and extract a JSON event object.
- Route by `event["type"]`:
  - `response.output_text.delta` → extract `event["delta"]` (string) and append to the Slack stream buffer.
  - `response.completed` → finalize Slack stream.
  - `error` or `response.failed` → treat as failure (see “Error handling”).
- Ignore unknown event types safely.

**Parsing note**: SSE frames may contain `event:` and `data:` lines. Treat the `data:` payload as the authoritative JSON event (it includes a `type` field), and ignore the `event:` line if present.

---

## Chunking + rate limiting (Slack-safe, must follow)

### Hard constraints (verified)

- Each `markdown_text` sent to Slack streaming methods must be **≤ 12,000 characters**.
- `chat.appendStream` rate limit is **Tier 4: 100+ per minute**.

### TLDR chunking policy

To keep implementation safe and simple (and avoid hitting rate limits when multiple streams run):

- **STREAM_MAX_CHUNK_CHARS**: 4,000 characters (configurable, must remain ≤ 12,000).
- **STREAM_MIN_APPEND_INTERVAL_MS**: 1000ms (configurable). This keeps a single stream at ≤60 appends/minute, comfortably below Tier 4.
- Prefer splitting on `\n\n` (paragraph) or `\n` (line) boundaries; fallback to whitespace; fallback to hard split.

### Retry behavior

- On Slack HTTP 429, **must** respect `Retry-After` and continue buffering text until retry is allowed.
- On Slack errors `message_not_in_streaming_state`, treat as “already stopped” and stop appending.

---

## Error handling (strict UX requirements)

### Canonical failure message (must be exact)

```
Sorry, I couldn't generate a summary at this time. Please try again later.
```

### Failure rules

- If streaming **never started** (no `start_stream` succeeded): fall back to posting the canonical failure message in the assistant thread using `chat.postMessage`.
- If streaming **did start**:
  - Best effort: call `stop_stream` (so message is not left in streaming state).
  - Then ensure the final visible message text is **only** the canonical failure message (no partial summary text):
    - Preferred: `chat.update` the streamed message to replace the text with the canonical failure string and remove blocks.
    - Fallback (if update fails): attempt `chat.delete` for the streamed message, then post a fresh message with only the canonical failure string.

---

## Configuration (env vars)

All configuration is via env vars (consistent with existing `AppConfig` patterns).

### Worker (Rust)

- **`ENABLE_STREAMING`**:
  - **Default**: `false` (keep existing behavior unless explicitly enabled)
  - When “truthy” (e.g., `1`, `true`), enable streaming for `Destination::Thread` tasks.
- **`STREAM_MIN_APPEND_INTERVAL_MS`** (optional):
  - **Default**: `1000`
  - Minimum delay between Slack `chat.appendStream` calls.
- **`STREAM_MAX_CHUNK_CHARS`** (optional):
  - **Default**: `4000`
  - Maximum chars per Slack append (must be ≤12,000).

### Bolt (TypeScript)

- No new required env vars. (The Bolt side only adds richer `loading_messages`.)

## Implementation plan (agents: do these tasks in order)

Each section below is written as an **execution checklist**. Each PR should keep scope tight and land with tests where feasible.

### PR 1 — Bolt: enhanced loading states (`loading_messages`)

- ✅ Update `bolt-ts/src/handlers/message.ts` summarize path to pass `loading_messages` to `client.assistant.threads.setStatus`.
- ✅ Add a helper (either in the same file or `bolt-ts/src/loading_messages.ts`) that returns ≤10 messages.
- ✅ Ensure `setStatus` remains fire-and-forget (do not block the hot path).
- ☐ Manual test: confirm loading messages rotate and status clears when the first streamed message appears.

### PR 2 — Rust: Slack streaming API wrapper (`chat.*Stream`)

- ✅ Add `SlackClient::start_stream`, `SlackClient::append_stream`, and `SlackClient::stop_stream` (recommended location: `lambda/src/slack/client.rs`).
- ✅ Implement strict response parsing: treat `ok: false` as error, surface `error` string.
- ✅ Handle HTTP 429 by respecting `Retry-After` (sleep + retry) while buffering pending text.
- ✅ Add unit tests for request payload construction and response parsing (no network).

### PR 3 — Rust: OpenAI Responses streaming (SSE)

- ✅ Add a streaming method in `lambda/src/ai/client.rs` that calls `/v1/responses` with `stream: true`.
- ✅ Implement an SSE parser that can handle:
  - frames split across TCP chunks
  - multiple frames in one read
  - unknown event types
- ✅ Emit deltas for `response.output_text.delta` by extracting the `delta` string.
- ✅ Add unit tests for the parser using recorded SSE fixtures.

### PR 4 — Rust worker: end-to-end streaming delivery (thread destination only)

- ✅ Add a config flag (e.g., `ENABLE_STREAMING`) in `lambda/src/core/config.rs` to gate streaming.
- ✅ Wire the flag into deployment:
  - ✅ `cdk/lib/tldr-stack.ts`: add `ENABLE_STREAMING` (and optionally `STREAM_MIN_APPEND_INTERVAL_MS` / `STREAM_MAX_CHUNK_CHARS`) to `workerEnvironment`.
  - ✅ `cdk/env.example`: document the new env var(s).
- ✅ In `lambda/src/worker/handler.rs`, when destination is `Thread` and streaming is enabled:
  - ✅ Run the "fetch messages → build prompt" path (reuse existing logic).
    - ✅ Recommended refactor (to avoid duplicating summarization logic): extract the pre-OpenAI prompt construction out of `SlackBot::summarize_messages_with_chatgpt` into a helper that returns:
      - the OpenAI prompt (`Vec<ChatCompletionMessage>`)
      - `links_shared`, `receipts`, and `has_any_images` (for the existing "safety net" section injection)
    - ✅ Keep `SlackBot::summarize_messages_with_chatgpt` behavior unchanged for the non-streaming path by calling the helper + `LlmClient::generate_summary` (existing code).
  - ✅ Start an OpenAI stream; only call `chat.startStream` once the first `response.output_text.delta` arrives (so failures before first output don't create orphan streaming messages).
  - ✅ Compute the streamed-message prefix for parity with current output:
    - Optional: `_Style: <truncated_style>_\n\n` (use the same truncation behavior as `lambda/src/worker/deliver.rs`)
    - Required: `*Summary from <#<task.channel_id>>*\n\n`
  - ✅ Call `chat.startStream` with `channel = task.origin_channel_id` and `thread_ts = task.thread_ts`, initializing `markdown_text` with the prefix plus the first delta.
  - ✅ Append text chunks with the chunking policy above.
  - ✅ After OpenAI completes, apply the same "safety net" rules currently in `lambda/src/slack/bot.rs` (ensure "Links shared", "Image highlights", "Receipts" exist) and append any missing sections before stopping the stream.
  - ✅ Stop the stream.
- ✅ Preserve the existing non-streaming path for non-thread destinations.
- ✅ Ensure canonical error message behavior on any failure.

### PR 5 — Hardening: rate limits, timeouts, and idempotency

- ☐ Add a streaming-loop timeout (abort OpenAI request and finalize Slack message deterministically).
- ✅ Add structured logging around `startStream`/`appendStream`/`stopStream` with correlation ids.
- ☐ Add best-effort idempotency for SQS retries:
  - ☐ Include correlation_id in Slack message metadata (recommended `event_type: "tldr_summary"`) on the finalized message.
  - ☐ On worker start, check for an existing finalized summary with the same correlation id by calling `conversations.replies` with `include_all_metadata=true` and scanning for `metadata.event_type == "tldr_summary"` and matching `event_payload.correlation_id`.
  - ☐ If found, skip streaming/delivery and return success.
  - Docs: [Using message metadata — Sending/receiving metadata](https://docs.slack.dev/messaging/message-metadata/)
- ☐ Manual test: trigger Slack retry / SQS retry (or simulate) and ensure duplicate streamed summaries are not posted.

---

## Testing checklist (definition of done)

### Unit tests

- ✅ OpenAI SSE parser: extracts `delta` correctly and terminates on `response.completed`.
- ✅ Slack chunker: never exceeds 12,000 chars per append and respects append interval.
- ✅ Slack streaming wrapper: parses `ok: false` into error and handles 429 retry/backoff.

### Integration / manual tests (Slack)

- ☐ In an assistant thread, `summarize` produces a streaming reply (not a single final post).
- ☐ Loading state is visible before first chunk and clears once streaming begins.
- ☐ Error path shows **only** the canonical failure message.

---

## Acceptance criteria

- **Streaming UX**: Summary text appears incrementally in the assistant thread and feels smooth.
- **Slack compliance**: Bolt TS continues to ACK event requests within 3 seconds (no new slow calls in the hot path).
- **Rate limit safety**: Append cadence respects Slack Tier 4 limits under normal usage, and 429 handling is correct.
- **Reliability**: Any failure results in the canonical failure message, with no orphaned "stuck streaming" messages.

