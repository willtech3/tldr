# User Workflows (AI Split View)

This document describes the primary user interactions for TLDR in the Slack AI Split View.

## 1. Summarize Current Channel

**Goal**: Quickly catch up on the channel currently being viewed.

1. **User Action**: clicks the "TLDR" app icon in the Slack sidebar (opening the split view).
2. **System**: 
   - Detects the channel the user is currently viewing in the main window.
   - Displays a welcome message in the assistant thread:
     > 👋 Hi! I'm TLDR.
     > 📍 *Viewing:* <#C12345|general>
   - Shows suggested prompts (e.g., "📋 Just the Facts", "🔥 Choose Violence").
3. **User Action**: Clicks "📋 Just the Facts" (or types `summarize`).
4. **System**:
   - Updates status to "Summarizing...".
   - Fetches the last 50 messages from the viewed channel.
   - Posts a concise summary to the thread.
   - Appends interactive action buttons: `[📤 Share to #general]` `[🔥 Roast This]` `[📜 Pull Receipts]`.

## 2. Custom Style (Roast Mode)

**Goal**: Entertain the group with a sarcastic or critical summary.

1. **User Action**: Opens TLDR and clicks the "🔥 Choose Violence" suggested prompt.
   - *Command sent*: `summarize with style: maximum chaos mode — be theatrically funny, dramatic, and roast everyone with surgical precision... start every bullet with a verdict emoji (🔥 💀 🤡 📉 🎯 🚨 🍿 🧠 ⚰️)... end the Summary with 🏆 MVP and 🪦 casualty awards...`
2. **System**:
   - Generates a summary using the "Roast" persona.
   - Posts the result.
   - Appends action buttons.

## 3. Engagement Actions (Pivot)

**Goal**: Switch modes instantly after seeing a "boring" summary.

1. **Context**: User has just received a standard summary.
2. **User Action**: Clicks the `[🔥 Roast This]` button at the bottom of the summary.
3. **System**:
   - Immediately runs a new summary generation for the same message range.
   - Applies the "Roast" style.
   - Posts the new summary to the thread.

## 4. Share to Channel

**Goal**: Share a funny or useful summary with the group.

1. **Context**: User has received a summary they like.
2. **User Action**: Clicks `[📤 Share to #channel]`.
3. **System**:
   - Posts the summary to the *source channel* (the one being summarized).
   - Uses story-format attribution:
     > <@Alice> chose violence and asked TLDR to roast the last 50 messages. Here's what came back:
     > ...
   - Posts a confirmation in the private assistant thread: `✅ Shared to #general`.

## 5. Changing Context

**Goal**: Summarize a different channel without closing TLDR.

1. **User Action**: Clicks a different channel (e.g., `#random`) in the Slack sidebar.
2. **System**:
   - Detects the context change event.
   - Updates the existing welcome message in the open assistant thread to show:
     > 📍 *Viewing:* <#C67890|random>
   - (Optional) User can now click "Summarize" to summarize the new channel.

## 6. Manual Override

**Goal**: Summarize a specific channel regardless of view.

1. **User Action**: Types `summarize #general last 100`.
2. **System**:
   - Ignores the current viewing context.
   - Summarizes the explicitly requested channel.