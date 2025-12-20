## Option B: AI‑first rewrite with Bolt (TypeScript) for Slack AI App (split‑view)

This is a restart plan for TLDR that **prioritizes Slack's AI App (split‑view) experience** and rebuilds the Slack-facing layer using **Bolt for JavaScript, implemented in TypeScript**.

TypeScript is the practical "first class" choice here because:
- It's the dominant Bolt ecosystem language (types + maintainability).
- This repo already uses TypeScript for CDK, so we keep one frontend language for infra + Slack UX.

The goals here are simple:

- **AI-first UX**: the bot should feel native inside Slack's AI container (assistant threads).
- **Great "style" UX**: funny summaries are powered by **always-custom** style prompts (no presets).
- **Depth**: summaries should meaningfully incorporate **links and images/files**.
- **Small-workspace friendly**: this is for ~7 friends; optimize for simplicity and reliability over enterprise features.

---

## Hard reset: remove legacy surfaces (no backward compatibility)

You explicitly don't care about backwards compatibility and no one is using the bot today. So we will **delete legacy features first** and keep the product surface area extremely small:

- **Keep**: Slack AI App split-view only (assistant threads).
- **Delete**: **Canvas** support.
- **Delete**: **`/tldr` slash command** and all slash-command UX.
- **Delete** (recommended): message/global shortcuts, sharing modals, OAuth "unread" user-token flows, emoji/scheduled workflows.

This isn't "deprecate" — it's a **hard delete** to prevent drift, keep the codebase clean, and let agents ship V1 fast.

---

## What we're replacing vs keeping

### Replace
- The current Rust "API Lambda" request routing and Slack event handling (Events API, interactive payloads, AI app thread UX).

### Keep (optional, transitional)
- The existing "worker" concept (async jobs) and infrastructure pattern (SQS → worker) to guarantee Slack acks within 3 seconds.

### End state (recommended)
- **Slack-facing AI App surface in TypeScript (Bolt)** + **summarization worker stays in Rust** (fast runtime, simple infra, and you already like the UX impact of low-latency execution).

---

## Why Bolt JS (Option B) is the right move

Slack's AI App features (assistant thread events, suggested prompts, status indicator, streaming) have rapidly evolving payload shapes. Bolt provides:

- **Battle-tested request verification + routing**
- **Unified handling for Events API + interactivity**
- **Cleaner, more maintainable user interaction patterns** (especially important as Slack docs evolve)

---

## LLM strategy (do both: keep prompts + upgrade model to GPT‑5.2)

This is not an either/or decision:

- **Keep prompts**: the "funny summaries" custom prompt is the *personality* of the app and the #1 UX differentiator for your 7-person workspace.
- **Upgrade the model**: switch the worker's default model to **ChatGPT 5.2** (via the **Responses API**) to improve quality and handle mixed inputs (text + links + images) more reliably.

Implementation notes:
- The Rust worker already calls the **Responses API** at `POST /v1/responses` (so this upgrade is mostly a **model default + prompt discipline** change).
- Make the model fully configurable via `OPENAI_MODEL` (default to `gpt-5.2`, with an easy downgrade path if needed).
- Keep the prompt builder structure:
  - **Base rules** (short, stable).
  - **Style block** (custom only).
  - **Conversation content** (messages + receipts + links + image inputs).

---

## Product scope (to make this usable fast)

### V1 scope (AI App split-view only)
- **Assistant thread start**: greet user, set thread title, set suggested prompts.
- **Context tracking**: track what channel the user is looking at via `assistant_thread_context_changed`.
- **Summarize current context**: default to "last 50" in the currently viewed channel.
- **Style/prompt UX**:
  - Custom prompt only (always custom).
  - A quick way to set/replace style for the current thread (stored in Slack thread metadata).
  - A per-run override (doesn't persist).
- **Image + link handling**:
  - Extract and list links shared.
  - Include image/file references with short AI-generated descriptions (vision-capable model).
- **Result in the same assistant thread**: always reply in-thread and include "receipts" (permalinks).

### Explicitly NOT in scope (deleted)
- Canvas storage
- `/tldr` slash command
- Message/global shortcuts
- OAuth "unread" user-token flow
- Scheduled / emoji workflows
- "Share" UI

If we ever want one of these again, we re-introduce it intentionally behind a new issue and acceptance criteria.

---

## Non-negotiables (fast ACK, trigger expiry, and no database)

This rewrite must be grounded in Slack's delivery contracts. If we violate these, users will see errors and Slack will retry payloads.

### Fast ACK (3 seconds)

- **Events API**: Your app **must** respond to event delivery with HTTP 2xx **within 3 seconds** or Slack considers delivery failed and will retry (3 times with exponential backoff). Docs: [Events API](https://docs.slack.dev/apis/events-api/).
- **Interactivity** (block actions, modal submits): Your app **must** return **HTTP 200 OK within 3 seconds** or Slack will show the user an error. Docs: [Handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction/).

### Trigger IDs expire fast (3 seconds)

- Any flow that requires a Slack `trigger_id` (opening modals) must call `views.open` fast — **trigger IDs expire in ~3 seconds**. Docs: [Handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction/) and [`views.open`](https://docs.slack.dev/reference/methods/views.open/).

### Architectural consequence

- **The Bolt TypeScript Lambda may not do heavyweight work** in the request/response window:
  - No OpenAI calls.
  - No fetching large Slack histories.
  - No downloading files/images.
- Instead, the Bolt Lambda should do only:
  - Minimal parsing + validation
  - One or two lightweight Slack Web API calls *only when required for UX contracts* (e.g., `views.open` with a `trigger_id`)
  - Enqueue work to SQS and return.

### No database (state lives inside Slack)

- Persist per-thread state using **Slack message metadata** (`metadata.event_type` + `metadata.event_payload`). Docs: [Using message metadata](https://docs.slack.dev/messaging/message-metadata/).

### Failure mode (copy exact string)

On any failure where we cannot complete a run, the bot must send exactly:

`Sorry, I couldn't generate a summary at this time. Please try again later.`

---

## Implementation plan (agents: do these tasks in order)

This section is intentionally written as a **checklist** so coding agents can execute it as a set of PRs.

### PR 0 — Repo hygiene + issue hygiene (no functionality yet)

- ✅ Update `docs/ai_app_first_rewrite_bolt_js.md` (this doc) to match the final plan (AI App only; Canvas + `/tldr` deleted).
- ✅ Update `docs/user_workflows.md` to remove Canvas + slash workflows and declare AI App split-view the only supported UX.
- ✅ Update `README.md` to remove `/tldr` usage and add "AI App only" quickstart.
- ✅ Ensure `.gitignore` covers all local artifacts (already mostly done).

### PR 1 — Delete legacy code (Canvas + slash command) BEFORE writing new Bolt logic

- ✅ Delete Canvas code (see "Canvas (delete completely)" checklist below).
- ✅ Delete slash command code (see "Slash command `/tldr` (delete completely)" checklist below).
- ✅ Delete OAuth unread code (recommended) or explicitly defer it to a future branch (but don't keep partially-used code).
- ✅ Remove dead dependencies from `lambda/Cargo.toml` (only after code deletion proves they're unused).
- ✅ Run `just qa` locally and ensure CI passes.

### PR 2 — Add Bolt TypeScript "AI App API Lambda" scaffold (minimal viable)

- ✅ Add a new directory (recommend `bolt-ts/`) containing:
  - ✅ Bolt app (`@slack/bolt`) in TypeScript
  - ✅ AWS Lambda receiver wiring (Bolt AWS Lambda receiver)
  - ✅ `tsconfig.json`, linting, minimal tests
- ✅ Add a new Lambda function in `cdk/lib/tldr-stack.ts` for the Bolt handler
- ✅ Keep the Rust worker Lambda as-is (for now).
- ✅ **Delete the Rust API Lambda binary** now that CDK routes Slack traffic to Bolt TS

### PR 3 — Implement AI App UX (context + prompts + status) end-to-end

- ✅ Handle Events:
  - ✅ `assistant_thread_started` → welcome message + `assistant.threads.setSuggestedPrompts`
  - ✅ `assistant_thread_context_changed` → persist context **in Slack thread state message metadata**
  - ✅ `message.im` → parse intent (summarize / style / help)
- ✅ Call `assistant.threads.setStatus` immediately on summarize.
- ✅ Enqueue SQS job and post summary into the assistant thread.

### PR 4 — Style UX (the "funny summaries" feature)

- ✅ Add a "Set style" modal (custom prompt only)
- ✅ Persist style state **only inside Slack** (thread state message metadata). No per-user defaults.
- ✅ Make the assistant thread clearly show the active style.

### PR 5 — Images + links depth (V1 quality bar)

- ☐ Extract links (URLs + unfurls) and include "Links shared".
- ✅ Handle Slack files (images) using authenticated download (bot token) and feed to Responses API as images.
- ☐ Add "Image highlights" section.
- ☐ Add receipts (permalinks) for trust.

---

## Pre-rewrite cleanup (makes the V1 rewrite faster + safer)

### Delete legacy features (behavior-changing; desired)

#### Canvas (delete completely)
- ✅ Delete `lambda/src/slack/canvas_helper.rs`
- ✅ Remove all Canvas API code from `lambda/src/slack/client.rs` (Canvas endpoints + helpers).
- ✅ Remove Canvas delivery path from `lambda/src/worker/deliver.rs`
- ✅ Remove any "dest_canvas" flags and related branching in `lambda/src/core/models.rs`
- ✅ Remove docs that describe Canvas as a feature

#### Slash command `/tldr` (delete completely)
- ✅ Delete slash parsing + handler code in the Rust API surface:
  - ✅ `lambda/src/api/slash_handler.rs`
  - ✅ `lambda/src/slack/command_parser.rs` (if only used by slash commands)
  - ✅ Remove slash routing from `lambda/src/api/handler.rs`
- ✅ Remove `/tldr` from `slack-app-manifest.yaml.template`.

#### Recommended extra deletions (to keep the repo tiny)
- ✅ Delete OAuth "unread" user-token flow:
  - ✅ `lambda/src/api/oauth.rs`
  - ✅ `lambda/src/core/user_tokens.rs`
- ✅ Delete "Share" UX:
  - ✅ Remove share button posting in `lambda/src/worker/deliver.rs`
  - ✅ Delete share modal builder/interactive handling if it becomes unused

---

## Acceptance criteria (what "usable" means)

### AI app UX
- Opening the app shows correct prompts, a welcome message, and a default channel context
- Changing channels updates the context without any channel picker
- Clicking "Summarize" produces a summary in the same thread, every time
- No Slack "Something went wrong" errors due to slow acknowledgements

### Style UX
- Users can change style in < 10 seconds.
- Style persists **only for the current assistant thread** (stored in Slack thread state metadata).
- The summary clearly indicates which style was used.

### Depth (images + links)
- Links are surfaced cleanly (deduped, readable).
- Images/files are acknowledged and described meaningfully.

### Failure mode
- On any failure, send exactly:
  - `Sorry, I couldn't generate a summary at this time. Please try again later.`

---

## Key Slack docs (bookmark these)

- AI app flow overview: [Developing apps with AI features](https://docs.slack.dev/ai/developing-ai-apps/)
- Fast ACK + retries: [Events API](https://docs.slack.dev/apis/events-api/) and [Handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction/)
- State persistence inside Slack: [Using message metadata](https://docs.slack.dev/messaging/message-metadata/)
- Events:
  - [`assistant_thread_started`](https://docs.slack.dev/reference/events/assistant_thread_started/)
  - [`assistant_thread_context_changed`](https://docs.slack.dev/reference/events/assistant_thread_context_changed/)
- Methods:
  - [`assistant.threads.setTitle`](https://docs.slack.dev/reference/methods/assistant.threads.setTitle/)
  - [`assistant.threads.setSuggestedPrompts`](https://docs.slack.dev/reference/methods/assistant.threads.setSuggestedPrompts/)
  - [`assistant.threads.setStatus`](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/)
  - [`conversations.history`](https://docs.slack.dev/reference/methods/conversations.history/)
  - [`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies/)
  - [`chat.getPermalink`](https://docs.slack.dev/reference/methods/chat.getPermalink/)
  - [`views.open`](https://docs.slack.dev/reference/methods/views.open/)
