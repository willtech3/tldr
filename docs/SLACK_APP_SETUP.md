# Slack App Setup for Button Triggers

## Overview
The TLDR bot now supports multiple ways to trigger summaries, not just the `/tldr` slash command.

## 1. Configure Shortcuts in Slack App Settings

### A. Global Shortcut (Lightning Bolt Menu)
1. Go to your Slack app settings at https://api.slack.com/apps
2. Navigate to **Interactivity & Shortcuts** → **Shortcuts**
3. Click **Create New Shortcut** → **Global**
4. Configure:
   - **Name**: Summarize Channel
   - **Short Description**: Generate a summary of the current channel
   - **Callback ID**: `tldr_global_shortcut`

### B. Message Shortcut (Three-Dot Menu)
1. In the same Shortcuts section
2. Click **Create New Shortcut** → **On Messages**
3. Configure:
   - **Name**: Summarize Thread
   - **Short Description**: Summarize this message thread
   - **Callback ID**: `tldr_message_action`

## 2. Update App Manifest

Use the provided `slack-app-manifest.yaml` to configure your app with all necessary permissions and features:

```bash
# In your Slack app settings:
1. Go to "App Manifest" 
2. Switch to YAML mode
3. Paste the contents of slack-app-manifest.yaml
4. Save changes
```

## 3. Required OAuth Scopes

Ensure your bot has these scopes for Canvas functionality:
- `channels:manage` - Create and manage canvases
- `channels:write.topic` - Update channel topics
- `bookmarks:read` - Read channel bookmarks
- `bookmarks:write` - Create/update bookmarks (canvases)

## 4. How Users Access the Features

### Slash Command (Original)
```
/tldr
```

### Global Shortcut (New)
1. Click the **Lightning Bolt** (⚡) icon in the message composer
2. Search for "Summarize Channel"
3. Click to open the TLDR modal

### Message Shortcut (New)  
1. Hover over any message
2. Click the **three-dot menu** (...)
3. Select "Summarize Thread"
4. Opens TLDR modal with that channel pre-selected

## 5. Canvas Behavior

### Summary Storage
- Each channel gets its own "TLDR Summaries" canvas
- New summaries are **prepended at the top** (latest first)
- Each summary includes:
  - Timestamp heading (e.g., "TL;DR - 2025-08-16 23:30 UTC")
  - Summary content
  - Attribution (who requested the summary)
  - Separator line

### Canvas Access
- Click the 📋 icon in the channel header
- Select "TLDR Summaries" from the list
- Canvas updates automatically when summaries are generated

## 6. Troubleshooting

### Submit Button Not Appearing in Modal
The submit button is defined in the code but may not appear if:
1. The modal JSON structure is invalid
2. Required blocks are missing
3. The app doesn't have proper permissions

Verify the modal structure matches Slack's requirements:
- Must have at least one input block
- Callback ID must be set
- Submit and close buttons properly defined

### Shortcuts Not Working
1. Verify the callback IDs match exactly:
   - Global: `tldr_global_shortcut`
   - Message: `tldr_message_action`
2. Ensure Interactivity is enabled with correct Request URL
3. Reinstall the app to your workspace after changes

## 7. Testing

1. **Test Global Shortcut**: 
   - Open any channel
   - Click Lightning Bolt → "Summarize Channel"
   - Modal should open with that channel selected

2. **Test Message Shortcut**:
   - Find any message
   - Click three-dots → "Summarize Thread"
   - Modal should open

3. **Test Canvas**:
   - Generate a summary with Canvas destination selected
   - Check the channel's Canvas for "TLDR Summaries"
   - Generate another summary
   - Verify new summary appears at the top