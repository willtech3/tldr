## Enhanced AI Split View & Engagement Actions (Implementation Spec)

This document is a **fully-specified, agent-implementable plan** to optimize TLDR's Slack AI assistant threads for maximum engagement in a friend group setting.

It replaces previous plans for "App Home" with a focus on **keeping users in the AI Split View** and providing rich, interactive actions directly in the thread.

---

## Goals

- **Goal**: Optimize the 4 suggested prompts for a friend group's use case (roasting, receipts, fun styles).
- **Goal**: Keep users engaged *within the thread* via interactive buttons ("Roast This", "Dig Deeper").
- **Goal**: Enable seamless sharing of funny summaries back to the source channel.
- **Goal**: Maintain the "entertainment weapon" persona of the bot.

- **Non-goal**: App Home customization (we want users in the split view).

---

## Context: The Friend Group Use Case

TLDR is used by a group of 8 friends in a non-work Slack workspace (a "fancy groupchat"). Key dynamics:

- **Roasting is central**: Custom styles like "be hyper-critical and sarcastic about everything Stephen wrote"
- **Inside jokes matter**: The app should feel personal and fun, not corporate
- **Receipts are currency**: Calling out contradictions and broken promises is highly valued.

---

## Design: Optimized Suggested Prompts

We will update the default suggested prompts shown when opening the assistant thread.

### Recommended Prompts

| # | Title | Message | Rationale |
|---|-------|---------|-----------|
| 1 | 🔥 Choose Violence | `summarize with style: be hyper-critical, sarcastic, and roast everyone mercilessly. call out bad takes and dumb ideas.` | The killer feature. "Choose Violence" is more evocative than "Roast Mode". |
| 2 | 📋 Just the Facts | `summarize` | Basic utility for quick catch-up. Simple but not boring. |
| 3 | 🕵️ Run the Investigation | `summarize with style: break down by person. what did each person contribute? be specific about who said what.` | Frames the breakdown as detective work. |
| 4 | 📜 Pull the Receipts | `summarize with style: find contradictions, broken promises, and things people said they would do but didn't. bring the receipts.` | Specific call-outs of hypocrisy drive engagement. |

---

## Design: Channel Context Visibility

**Problem:** Users don't know which channel TLDR will summarize.
**Solution:** Display the current viewing channel in the welcome message, and update it when context changes.

### Implementation

Update `buildWelcomeBlocks()` to accept and display `viewingChannelId`:

```typescript
export function buildWelcomeBlocks(
  viewingChannelId?: string | null,
  activeStyle?: string | null
): KnownBlock[] {
  const blocks: KnownBlock[] = [
    // ... intro section ...
  ];

  // Show current channel context
  if (viewingChannelId) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `📍 *Viewing:* <#${viewingChannelId}>`,
        },
      ],
    });
  }
  // ... rest of blocks ...
}
```

---

## Design: Interactive Thread Actions

To keep engagement going, we will append interactive buttons to **every summary**.

### 1. "Share to Channel"
Allows users to post the funny summary back to the source channel with story-format attribution.

### 2. "Pivot" Buttons (Engagement Actions)
If a user runs a "boring" summary, give them one-click access to the "fun" modes.

**Logic:**
- If current style is NOT "Roast", show `[🔥 Roast This]` button.
- If current style is NOT "Receipts", show `[📜 Pull Receipts]` button.

**User Flow:**
1. Alice runs `summarize` (Just the Facts).
2. Bot returns summary.
3. Bottom of summary has buttons: `[📤 Share to #general] [🔥 Roast This] [📜 Pull Receipts]`
4. Alice clicks `[🔥 Roast This]`.
5. Bot immediately runs `summarize with style: roast...` for the same message range.

---

## Implementation Plan

### PR 1 — Suggested Prompts + Channel Context

**Files to modify**:
- `bolt-ts/src/handlers/assistant.ts` — Update `DEFAULT_PROMPTS` and pass `viewingChannelId`.
- `bolt-ts/src/blocks.ts` — Update `buildWelcomeBlocks`.

**Checklist**:
- ☐ Update `DEFAULT_PROMPTS` with the 4 new personas.
- ☐ Update `buildWelcomeBlocks` to show `📍 Viewing: <#channel>`.
- ☐ Update `assistant_thread_started` and `context_changed` to pass `viewingChannelId`.

### PR 2 — Interactive Thread Actions (Share & Pivot)

**Files to modify**:
- `lambda/src/worker/deliver.rs` — Append Share AND Pivot buttons to summary blocks.
- `bolt-ts/src/handlers/actions.ts` — Handle `share_summary`, `roast_this`, `pull_receipts`.

#### Rust Worker: Appending Buttons

In `lambda/src/worker/deliver.rs`, we append a block of actions:

```json
{
  "type": "actions",
  "elements": [
    {
      "type": "button",
      "text": { "type": "plain_text", "text": "📤 Share to #channel" },
      "action_id": "share_summary",
      "value": "..." // Metadata
    },
    {
      "type": "button",
      "text": { "type": "plain_text", "text": "🔥 Roast This" },
      "action_id": "rerun_roast",
      "value": "..." // Metadata (count, channel)
    },
    {
      "type": "button",
      "text": { "type": "plain_text", "text": "📜 Pull Receipts" },
      "action_id": "rerun_receipts",
      "value": "..." // Metadata (count, channel)
    }
  ]
}
```

#### TypeScript Handler: `rerun_roast` / `rerun_receipts`

When clicked:
1. Extract `channelId` and `count` from button value.
2. Send a user-visible message to the thread: "🔥 Roast this!" (to confirm action).
3. Trigger the summarization logic (simulate a message event or enqueue directly).

*Note: Since the Bolt app handles messages, the cleanest way to "rerun" is to have the bot simply post the command as the user, or strictly call the internal logic. For simplicity, we can have the bot act as a proxy.*

**Simpler Approach for V1:**
The button simply posts a message to the thread *as the user* (if possible) or just posts a message saying "Running roast mode..." and enqueues the job.

---

## Design: Share to Channel (Detailed)

### Attribution Logic
- **Roast Style**: `<@User> chose violence and asked TLDR to roast the last 50 messages:`
- **Receipts Style**: `<@User> asked TLDR to pull receipts from the last 50 messages:`
- **Default**: `<@User> asked TLDR to summarize the last 50 messages:`

### Button Metadata
The `value` field of the Share button must contain:
- `sourceChannelId`
- `summaryText` (or fetch if too long)
- `style` (to determine attribution)

---

## Testing Checklist

- ☐ Suggested prompts appear correctly.
- ☐ Channel context updates in real-time.
- ☐ Summaries include Share/Roast/Receipts buttons.
- ☐ Share button posts to channel with correct attribution.
- ☐ Roast/Receipts buttons trigger a new summary generation.