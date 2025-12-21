## Rich Image Summaries (Spec)

### Summary

TLDR currently includes Slack images in the OpenAI request by passing **image URLs**. In production, OpenAI sometimes returns **HTTP 400** (`invalid_request_error`, `param: url`, `code: invalid_value`) with messages like **“Error while downloading …”**, causing summaries to fall back to text-only (and reducing “Image highlights” quality).

This spec describes the root cause and proposes **one recommended solution** plus **two alternatives** that keep images in the “rich” summary without relying on a clunky fallback.

### Background / current behavior

- **Where images enter the prompt**: `lambda/src/slack/bot.rs` (`SlackBot::build_summarize_prompt_data`) collects Slack files and adds them as image inputs.
- **How images are provided to OpenAI today**:
  - The OpenAI “Images and vision” guide supports providing images as:
    - **Fully-qualified URL**
    - **Base64-encoded data URL**
    - **File ID** (via Files API)
  - TLDR currently uses the **URL** approach for images.
  - Reference: [OpenAI docs — Images and vision](https://platform.openai.com/docs/guides/images-vision)
- **Observed failure mode**:
  - OpenAI attempts to fetch a Slack-hosted URL and fails with a 400:
    - `invalid_request_error` + `param: url` + `invalid_value`
    - Message: “Error while downloading https://files.slack.com/files-pri/…”
  - This breaks streaming delivery and forces a text-only retry (or canonical failure).

### Root cause (why the 400 happens)

- **Slack file URLs are commonly authenticated**:
  - Slack file objects include private URLs like `url_private` / `url_private_download`.
  - These generally require an **Authorization bearer token** to fetch.
  - Slack’s own docs explicitly call out downloading `url_private_download` using a bot token in headers (not via a “public” unauthenticated fetch).
  - Reference: [Slack docs — `files.sharedPublicURL`](https://docs.slack.dev/reference/methods/files.sharedPublicURL/)
- **OpenAI cannot attach Slack auth headers** when it’s fetching an image by URL.
  - When a URL is not reliably reachable from OpenAI’s fetch environment (auth required, redirects, blocked downloads, workspace restrictions), OpenAI returns a 400 and rejects the request.
- **Public sharing is not guaranteed**:
  - Even if TLDR enables public sharing, Slack workspaces can restrict/disable public sharing.
  - Slack’s public share surface is represented by the file object’s `permalink_public` (example: `https://slack-files.com/T...-F...-<secret>`).
  - Reference: [Slack docs — File object](https://docs.slack.dev/reference/objects/file-object/)

### Goals / non-goals

- **Goals**
  - **Reliability**: summary generation should not fail because a single image URL is inaccessible to OpenAI.
  - **Quality**: “Image highlights” should be based on actual image content, not placeholders.
  - **Privacy**: avoid leaving Slack files publicly accessible, and avoid leaking public file URLs into the final Slack message.
  - **Streaming UX**: keep the thread streaming pipeline working even with images.
- **Non-goals**
  - Build a full image processing product (classification, OCR pipelines, etc.).
  - Store Slack attachments long-term outside Slack unless explicitly required.

### Constraints (from official docs)

- **OpenAI image input methods** (supported):
  - URL, Base64 data URL, or file ID.
  - Reference: [OpenAI docs — Images and vision](https://platform.openai.com/docs/guides/images-vision)
- **OpenAI image requirements**:
  - Supported types: PNG/JPEG/WEBP/non-animated GIF
  - Size limits: up to 50 MB total payload/request; up to 500 images/request
  - Reference: [OpenAI docs — Images and vision](https://platform.openai.com/docs/guides/images-vision)
- **Slack public sharing APIs**:
  - Enable public share: `files.sharedPublicURL` (returns `permalink_public`).
  - Revoke public share: `files.revokePublicURL` (supports bot token `files:write`).
  - References:
    - [Slack docs — `files.sharedPublicURL`](https://docs.slack.dev/reference/methods/files.sharedPublicURL/)
    - [Slack docs — `files.revokePublicURL`](https://docs.slack.dev/reference/methods/files.revokePublicURL/)

---

## Solution A (Recommended): Fetch from Slack → send Base64 data URLs to OpenAI

### Approach

Instead of giving OpenAI a Slack URL to download, TLDR should:

- **Download image bytes server-side** from Slack using the bot token.
- **Convert to Base64** and send to OpenAI as a `data:` URL via `input_image.image_url`.

This uses OpenAI’s supported **Base64-encoded data URL** input method and avoids any third-party fetch from Slack.

### Why this fixes the issue

- **No OpenAI-side download step** → no “Error while downloading …” failures.
- Slack authentication happens **inside TLDR**, where we control headers and retries.
- Works regardless of Slack workspace public-sharing policies.

### Implementation sketch (TLDR codebase)

- **Prompt builder changes** (`lambda/src/slack/bot.rs`)
  - **Download** the image bytes using `url_private_download` + bot token auth.
  - Prefer using Slack-provided thumbnails (when available) to reduce bytes.
  - Convert bytes to `data:<mime>;base64,<...>`.
  - Emit `input_image` parts that use the data URL.
- **OpenAI input shape** (`lambda/src/ai/client.rs`)
  - Keep current Responses input structure but set:
    - `{"type":"input_image","image_url":"data:image/png;base64,..."}`.
  - Optionally set `detail` to `low|high|auto` to control token spend (OpenAI supports `detail` for image inputs).
- **Guardrails**
  - Enforce a strict maximum inline size (e.g., default 512KB–2MB per image) and a max-image count.
  - If an image is too large, use a smaller thumb or downscale/encode (see “Optional hardening”).
  - Never fail the entire summary due to a single image download error.

### Optional hardening (recommended if images are large)

- **Downscale + recompress** (e.g., 1024px max dimension) before Base64 encoding.
  - This keeps payload sizes small and improves reliability.
  - (Would require adding an image processing crate; keep scope minimal.)

### Pros / cons

- **Pros**
  - **Most reliable**: avoids network reachability issues entirely.
  - **Best privacy posture**: no need to make Slack files publicly accessible.
  - **Streaming-friendly**: failures are localized to individual images.
- **Cons**
  - More bytes in the OpenAI request (Base64 overhead).
  - Requires careful caps + optional downscaling to avoid large payloads.

---

## Solution B: Use Slack `permalink_public` + revoke after summarization

### Approach

- Enable public sharing for each image via `files.sharedPublicURL`.
- Use the returned file object’s **`permalink_public`** (example: `https://slack-files.com/T...-F...-<secret>`) as the `input_image.image_url`.
- After summarization completes (success or failure), best-effort revoke sharing with `files.revokePublicURL`.

References:
- [Slack docs — `files.sharedPublicURL`](https://docs.slack.dev/reference/methods/files.sharedPublicURL/)
- [Slack docs — `files.revokePublicURL`](https://docs.slack.dev/reference/methods/files.revokePublicURL/)

### Suggested safety check (to avoid OpenAI failures)

- Perform an unauthenticated `HEAD`/`GET` from the worker to validate that `permalink_public` is reachable.
  - If not reachable, fall back to Solution A for that image.

### Pros / cons

- **Pros**
  - Minimal request bloat (still URL-based).
  - Works for larger images without Base64 size concerns.
- **Cons**
  - Depends on Slack workspace policies (public sharing can be disabled/restricted).
  - **Privacy risk**: even if revoked later, there is a window where the file is publicly accessible.
  - Still relies on OpenAI downloading URLs reliably.

---

## Solution C: Serve images from TLDR-controlled URLs (proxy or storage)

### Option C1: Ephemeral image proxy (API Gateway/Lambda)

- Worker generates a short-lived, signed URL (query-param signature) served by TLDR.
- The proxy fetches the Slack file with bot auth and streams it back to the caller (OpenAI).

**Pros**
- No public Slack sharing required.
- Supports large images without Base64 overhead.

**Cons**
- Requires new infra (route + auth scheme + logging + rate limiting).
- URL must be accessible to OpenAI without headers; signature must be in the URL.

### Option C2: Upload to OpenAI Files API, reference by file ID

OpenAI supports providing images as a **file ID** (“created with the Files API”) per the images/vision guide.

**Pros**
- Avoids OpenAI fetching Slack URLs.
- Avoids Base64 overhead.

**Cons**
- Requires extra API calls (upload + cleanup policy).
- Requires explicit decisions about retention, privacy, and quotas.

Reference:
- [OpenAI docs — Images and vision](https://platform.openai.com/docs/guides/images-vision)

---

## Recommendation

- **Default**: Implement **Solution A** (Slack download → Base64 data URL) with strict size caps and per-image failure isolation.
- **If large images are common**: add either:
  - Downscale/recompress (still Solution A), or
  - **C1 proxy** for large images while keeping Base64 for small images.
- Keep **Solution B** as an optional path only if public sharing is acceptable in your workspace security posture.

---

## Acceptance criteria

- ✅ Streaming summaries succeed even when one or more Slack images are not externally fetchable.
- ✅ “Image highlights” reflect actual image content for supported images.
- ✅ No Slack file URLs (private or public) are printed in the user-facing summary.
- ✅ The system never requires permanent public sharing of Slack files.

---

## Implementation checklist

- ☐ Add config/env vars for image handling (e.g., inline byte caps, max images, default detail level).
- ☐ Add Slack file download helper with retries and clear error reporting.
- ☐ Prefer thumbnails or downscale images to stay under caps.
- ☐ Encode images as Base64 data URLs and attach via `input_image`.
- ☐ Add unit tests for:
  - data URL construction
  - size cap enforcement
  - “one bad image doesn’t fail the run”
- ☐ Manual test in Slack:
  - images present → “Image highlights” populated
  - unreachable image → summary still completes and streams


