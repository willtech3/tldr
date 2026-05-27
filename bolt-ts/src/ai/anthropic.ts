/**
 * Anthropic Messages API client.
 *
 * Thin wrapper around `@anthropic-ai/sdk`. We stream the response via the SDK
 * helper so we can emit text deltas straight into Slack via chat.appendStream.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';
import type { ContentBlock, PromptPayload } from './prompt';

/** Default Anthropic model. */
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Max output tokens per request. Sonnet 4.6 supports up to 64k synchronous
 * output; we cap below that to keep streaming latency reasonable for Slack
 * (Slack's per-call markdown_text limit dominates anyway).
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

export type StreamEvent =
  | { kind: 'text_delta'; delta: string }
  | { kind: 'completed' }
  | { kind: 'failed'; message: string };

export interface LlmClientOptions {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
  /** Optional fetch override for tests. Passed through to the SDK. */
  fetchImpl?: typeof fetch;
}

export type StreamingResponse =
  | { kind: 'too_large' }
  | { kind: 'active'; iterator: AsyncIterator<StreamEvent>; cancel(): Promise<void> };

/** Friendly message shown when the model rejects the request as too long. */
export const TOO_LARGE_MESSAGE =
  'The conversation is too long to summarize in full. Try `summarize last N` in this thread to limit the window.';

/**
 * Detect Anthropic's "prompt is too long" / overloaded responses so the
 * worker can show a friendly fallback. Anthropic uses `invalid_request_error`
 * with a "prompt is too long" or "max_tokens" message when input exceeds the
 * context window.
 */
export function isPromptTooLargeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const message = (err as { message?: string }).message ?? '';
  const lower = message.toLowerCase();
  return (
    lower.includes('prompt is too long') ||
    lower.includes('input is too long') ||
    lower.includes('context window') ||
    lower.includes('too many tokens')
  );
}

export class LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxOutputTokens: number;

  constructor(opts: LlmClientOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  }

  /** Non-streaming summary. Mostly used by tests / non-streaming destinations. */
  async generateSummary(prompt: PromptPayload): Promise<string> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxOutputTokens,
        system: prompt.system,
        messages: [
          {
            role: 'user',
            content: prompt.userContent.map(toMessageParamBlock),
          },
        ],
      });
      return extractText(response.content);
    } catch (err) {
      if (isPromptTooLargeError(err)) {
        return TOO_LARGE_MESSAGE;
      }
      throw err;
    }
  }

  /**
   * Stream a summary. Returns an async iterator over {@link StreamEvent}
   * compatible with the worker's existing streaming pipeline.
   */
  async generateSummaryStream(prompt: PromptPayload): Promise<StreamingResponse> {
    let stream;
    try {
      stream = this.client.messages.stream({
        model: this.model,
        max_tokens: this.maxOutputTokens,
        system: prompt.system,
        messages: [
          {
            role: 'user',
            content: prompt.userContent.map(toMessageParamBlock),
          },
        ],
      });
    } catch (err) {
      if (isPromptTooLargeError(err)) {
        return { kind: 'too_large' };
      }
      throw err;
    }

    const iterator = consumeStream(stream);
    return {
      kind: 'active',
      iterator,
      async cancel(): Promise<void> {
        try {
          stream.abort();
        } catch {
          // best-effort
        }
      },
    };
  }
}

/** Translate our prompt blocks into Anthropic SDK message-param blocks. */
function toMessageParamBlock(block: ContentBlock): Anthropic.ContentBlockParam {
  if (block.type === 'image') {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: block.source.media_type,
        data: block.source.data,
      },
    };
  }
  return { type: 'text', text: block.text };
}

/** Pull plain text from a Message's content array. */
function extractText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Adapt the Anthropic SDK MessageStream into our internal `StreamEvent` shape.
 * We only surface text deltas, a single `completed` event when streaming ends,
 * and `failed` for errors — the worker pipeline doesn't care about tool use or
 * thinking blocks for summarisation.
 */
async function* consumeStream(
  stream: AsyncIterable<MessageStreamEvent> & {
    finalMessage(): Promise<unknown>;
  }
): AsyncGenerator<StreamEvent, void, void> {
  try {
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { kind: 'text_delta', delta: event.delta.text };
      }
      // We intentionally ignore other deltas (input_json_delta, thinking_delta,
      // citations_delta) — they don't apply to summarisation.
    }
    // Surfacing finalMessage() so that any deferred error on the stream is
    // raised here as a thrown exception (handled in the outer catch).
    await stream.finalMessage();
    yield { kind: 'completed' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { kind: 'failed', message };
  }
}
