//! API feature orchestrator: Slack signature verification, routing, and enqueue.

use super::{oauth, parsing, signature, sqs, view_submission};
use crate::core::config::AppConfig;
use crate::core::models::{Destination, ProcessingTask};
use crate::slack::SlackBot;
use crate::slack::modal_builder::build_share_modal;
use crate::slack::modal_builder::{Prefill, build_tldr_modal};
use lambda_runtime::{Error, LambdaEvent};
use serde::Serialize;
use serde_json::{Value, json};
use tracing::{error, info};
use uuid::Uuid;

pub use self::function_handler as handler;

/// Lambda handler for the API entrypoint. Verifies Slack signature,
/// routes interactive vs slash-command, and enqueues a `ProcessingTask`.
///
/// # Errors
///
/// Returns an error response payload if the request is malformed or fails
/// Slack signature verification; otherwise returns a 200 with a JSON body.
#[allow(clippy::too_many_lines, clippy::manual_let_else)]
#[tracing::instrument(level = "info", skip(event))]
pub async fn function_handler(
    event: LambdaEvent<serde_json::Value>,
) -> Result<impl Serialize, Error> {
    let config = AppConfig::from_env().map_err(|e| {
        error!("Config error: {}", e);
        Error::from(e)
    })?;
    info!("API Lambda received request: {:?}", event);

    let Some(headers) = event.payload.get("headers") else {
        error!("Request missing headers");
        return Ok(json!({
            "statusCode": 400,
            "body": json!({ "error": "Missing headers" }).to_string()
        }));
    };
    // Lightweight path: public OAuth endpoints are not signed by Slack and may not include a body
    let path_opt = event
        .payload
        .get("rawPath")
        .and_then(|v| v.as_str())
        .or_else(|| event.payload.get("path").and_then(|v| v.as_str()));
    if let Some(path) = path_opt {
        info!(raw_path = %path, "Request path");
        if path.ends_with("/auth/slack/start") {
            // Require SLACK_REDIRECT_URL to be configured
            if config.slack_redirect_url.is_none() {
                error!("OAuth failed: SLACK_REDIRECT_URL environment variable is not configured");
                return Ok(json!({
                    "statusCode": 500,
                    "body": json!({
                        "error": "OAuth configuration error: SLACK_REDIRECT_URL is not set. Please contact your administrator."
                    }).to_string()
                }));
            }

            let state = Uuid::new_v4().to_string();
            let xray = parsing::get_header_value(headers, "X-Amzn-Trace-Id").unwrap_or("");
            // Safe to use as_ref() here since we checked is_none() above
            if let Some(redirect_url) = &config.slack_redirect_url {
                info!(redirect_url=%redirect_url, xray_trace_id=%xray, state=%state, "Building Slack authorize URL");
            }
            let url = oauth::build_authorize_url(&config, &state, None);
            return Ok(json!({
                "statusCode": 302,
                "headers": { "Location": url },
                "body": ""
            }));
        }
        if path.ends_with("/auth/slack/callback") {
            // Parse query string for `code`
            let code_opt = event
                .payload
                .get("rawQueryString")
                .and_then(|q| q.as_str())
                .and_then(|q| {
                    q.split('&')
                        .find(|kv| kv.starts_with("code="))
                        .map(|kv| kv.trim_start_matches("code=").to_string())
                })
                .or_else(|| {
                    event
                        .payload
                        .get("queryStringParameters")
                        .and_then(|m| m.get("code"))
                        .and_then(|v| v.as_str())
                        .map(std::string::ToString::to_string)
                });
            if let Some(code) = code_opt {
                // Require SLACK_REDIRECT_URL to be configured
                if config.slack_redirect_url.is_none() {
                    error!(
                        "OAuth callback failed: SLACK_REDIRECT_URL environment variable is not configured"
                    );
                    return Ok(json!({
                        "statusCode": 500,
                        "body": json!({
                            "error": "OAuth configuration error: SLACK_REDIRECT_URL is not set. Please contact your administrator."
                        }).to_string()
                    }));
                }

                let http = reqwest::Client::new();
                let xray = parsing::get_header_value(headers, "X-Amzn-Trace-Id").unwrap_or("");
                // Safe to use as_ref() here since we checked is_none() above
                if let Some(redirect_url) = &config.slack_redirect_url {
                    info!(redirect_url=%redirect_url, xray_trace_id=%xray, "Handling OAuth callback");
                }
                match oauth::handle_callback(&config, &http, &code, None).await {
                    Ok((user_id, _)) => {
                        return Ok(json!({
                            "statusCode": 200,
                            "body": json!({"ok": true, "user_id": user_id}).to_string()
                        }));
                    }
                    Err(e) => {
                        error!("OAuth callback failed: {}", e);
                        return Ok(json!({
                            "statusCode": 400,
                            "body": json!({"ok": false, "error": format!("{}", e)}).to_string()
                        }));
                    }
                }
            }
            return Ok(json!({
                "statusCode": 400,
                "body": json!({"ok": false, "error": "missing code"}).to_string()
            }));
        }
    }

    // For Slack-signed routes, a body is required
    let body = if let Some(body) = event.payload.get("body") {
        if let Some(body_str) = body.as_str() {
            body_str
        } else {
            error!("Request body is not a string");
            return Ok(json!({
                "statusCode": 400,
                "body": json!({ "error": "Invalid body format" }).to_string()
            }));
        }
    } else {
        error!("Request missing body");
        return Ok(json!({
            "statusCode": 400,
            "body": json!({ "error": "Missing body" }).to_string()
        }));
    };

    // Verify the Slack signature
    let Some(signature) = parsing::get_header_value(headers, "X-Slack-Signature") else {
        error!("Missing X-Slack-Signature header");
        return Ok(json!({
            "statusCode": 401,
            "body": json!({ "error": "Missing X-Slack-Signature header" }).to_string()
        }));
    };
    let Some(timestamp) = parsing::get_header_value(headers, "X-Slack-Request-Timestamp") else {
        error!("Missing X-Slack-Request-Timestamp header");
        return Ok(json!({
            "statusCode": 401,
            "body": json!({ "error": "Missing X-Slack-Request-Timestamp header" }).to_string()
        }));
    };
    if !signature::verify_slack_signature(body, timestamp, signature, &config) {
        error!("Slack signature verification failed");
        return Ok(json!({
            "statusCode": 401,
            "body": json!({ "error": "Invalid Slack signature" }).to_string()
        }));
    }

    info!("Slack signature verified successfully");

    // Slack Events API (JSON) — handle before interactive/slash parsing
    if let Ok(json_body) = serde_json::from_str::<Value>(body) {
        // URL verification handshake
        if json_body
            .get("type")
            .and_then(|t| t.as_str())
            .is_some_and(|t| t == "url_verification")
        {
            let challenge = json_body
                .get("challenge")
                .and_then(|c| c.as_str())
                .unwrap_or("");
            return Ok(json!({
                "statusCode": 200,
                "body": challenge
            }));
        }

        // Event callbacks
        if json_body
            .get("type")
            .and_then(|t| t.as_str())
            .is_some_and(|t| t == "event_callback")
        {
            let Some(event) = json_body.get("event") else {
                return Ok(json!({ "statusCode": 200, "body": "{}" }));
            };
            let e_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");

            match e_type {
                // AI App entry: user opened the assistant thread
                "assistant_thread_started" => {
                    // Extract from assistant_thread.{channel_id, thread_ts}
                    let channel_id = event
                        .get("assistant_thread")
                        .and_then(|t| t.get("channel_id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let thread_ts = event
                        .get("assistant_thread")
                        .and_then(|t| t.get("thread_ts"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    if !channel_id.is_empty() && !thread_ts.is_empty() {
                        // Fire-and-forget to keep Slack ack fast
                        let cfg = config.clone();
                        let ch = channel_id.to_string();
                        let ts = thread_ts.to_string();
                        tokio::spawn(async move {
                            if let Ok(bot) = SlackBot::new(&cfg) {
                                let suggestions =
                                    ["Summarize unread", "Summarize last 50", "Help", "Configure"];
                                let _ = bot
                                    .slack_client()
                                    .assistant_set_suggested_prompts(&ch, &ts, &suggestions)
                                    .await;

                                // Show a more welcoming initial message with clear guidance
                                let blocks = json!([
                                    {
                                        "type": "section",
                                        "text": {
                                            "type": "mrkdwn",
                                            "text": "👋 Hi! I'm TLDR Bot. I can summarize channel messages for you.\n\n*Quick start:*\n• Click a suggested prompt below\n• Or type `help` to see all commands\n• Just type `summarize` to get started"
                                        }
                                    }
                                ]);
                                let _ = bot
                                    .slack_client()
                                    .post_message_with_blocks(
                                        &ch,
                                        Some(&ts),
                                        "Welcome to TLDR Bot",
                                        &blocks,
                                    )
                                    .await;
                            }
                        });
                    }

                    return Ok(json!({ "statusCode": 200, "body": "{}" }));
                }
                // User sent a message in the assistant thread (e.g., chose a suggested prompt)
                "message.im" | "message" => {
                    // Ignore bot messages and edited/system messages to avoid loops
                    if event.get("bot_id").is_some() || event.get("subtype").is_some() {
                        return Ok(json!({ "statusCode": 200, "body": "{}" }));
                    }

                    let channel_id = event.get("channel").and_then(|c| c.as_str()).unwrap_or("");
                    // Prefer thread_ts if present, else fall back to ts
                    let thread_ts = event
                        .get("thread_ts")
                        .and_then(|t| t.as_str())
                        .or_else(|| event.get("ts").and_then(|t| t.as_str()))
                        .unwrap_or("");
                    let text_lc = event
                        .get("text")
                        .and_then(|t| t.as_str())
                        .map(str::to_lowercase)
                        .unwrap_or_default();

                    // If the user typed "help", show available commands
                    if text_lc.contains("help") || text_lc == "?" || text_lc.contains("what can") {
                        if let Ok(bot) = SlackBot::new(&config) {
                            let blocks = json!([
                                {
                                    "type": "header",
                                    "text": {"type": "plain_text", "text": "🤖 TLDR Bot Commands"}
                                },
                                {
                                    "type": "section",
                                    "text": {
                                        "type": "mrkdwn",
                                        "text": "*Basic Commands:*\n• `summarize` - Summarize recent messages from a channel\n• `summarize unread` - Only summarize unread messages (Slack-tracked)\n• `summarize last 50` - Summarize the last 50 messages\n• `help` - Show this help message"
                                    }
                                },
                                {
                                    "type": "section",
                                    "text": {
                                        "type": "mrkdwn",
                                        "text": "*Advanced Features:*\n• `customize` or `configure` - Set custom prompt styles for a channel\n• `share` - Share the last summary to a channel\n• Mention a channel (e.g., `summarize #general`) to target specific channels"
                                    }
                                },
                                {
                                    "type": "section",
                                    "text": {
                                        "type": "mrkdwn",
                                        "text": "*Tips:*\n• The bot will ask you to select a channel if you don't mention one\n• Summaries are sent as DMs by default\n• Use Canvas integration to save and edit summaries\n• Add custom style prompts for creative summaries (poems, haikus, etc.)"
                                    }
                                },
                                {
                                    "type": "context",
                                    "elements": [
                                        {"type": "mrkdwn", "text": "Try one of the suggested prompts below or type your own command!"}
                                    ]
                                }
                            ]);
                            let _ = bot
                                .slack_client()
                                .post_message_with_blocks(
                                    channel_id,
                                    Some(thread_ts),
                                    "TLDR Bot Help",
                                    &blocks,
                                )
                                .await;
                        }
                        return Ok(json!({ "statusCode": 200, "body": "{}" }));
                    }

                    // If the user typed "share", provide guidance on sharing summaries
                    if text_lc.contains("share") && !text_lc.contains("summarize") {
                        if let Ok(bot) = SlackBot::new(&config) {
                            let blocks = json!([
                                {
                                    "type": "section",
                                    "text": {
                                        "type": "mrkdwn",
                                        "text": "*To share a summary:*\n1. First generate a summary using `summarize`\n2. The Share button will appear in the summary message\n3. Click Share to send it to any channel with optional custom styling\n\n_No recent summary found. Generate one first!_"
                                    }
                                }
                            ]);
                            let _ = bot
                                .slack_client()
                                .post_message_with_blocks(
                                    channel_id,
                                    Some(thread_ts),
                                    "Share Summary",
                                    &blocks,
                                )
                                .await;
                        }
                        return Ok(json!({ "statusCode": 200, "body": "{}" }));
                    }

                    // If the user typed "customize", show a channel picker first
                    if text_lc.contains("customize") || text_lc.contains("configure") {
                        if let Ok(bot) = SlackBot::new(&config) {
                            let blocks = json!([
                                { "type": "section", "text": {"type": "mrkdwn", "text": "Pick a conversation to configure TLDR for:"}},
                                { "type": "actions", "block_id": "tldr_pick_config", "elements": [
                                    { "type": "conversations_select", "action_id": "tldr_pick_conv", "default_to_current_conversation": true, "response_url_enabled": true }
                                ]}
                            ]);
                            let _ = bot
                                .slack_client()
                                .post_message_with_blocks(
                                    channel_id,
                                    Some(thread_ts),
                                    "Pick conversation",
                                    &blocks,
                                )
                                .await;
                        }
                        return Ok(json!({ "statusCode": 200, "body": "{}" }));
                    }

                    // Parse simple intents: summarize unread / last N, style, destinations
                    let mut count_opt: Option<u32> = None;
                    if let Some(n) = text_lc
                        .split_whitespace()
                        .find_map(|w| w.strip_prefix("last "))
                        .and_then(|rest| rest.split_whitespace().next())
                        .and_then(|n| n.parse::<u32>().ok())
                    {
                        count_opt = Some(n);
                    }

                    let mode_unread = text_lc.contains("unread");
                    let post_here = text_lc.contains("post here") || text_lc.contains("public");

                    // Extract channel mention like <#C123|name>
                    let target_channel_id =
                        event.get("text").and_then(|t| t.as_str()).and_then(|t| {
                            t.split_whitespace().find_map(|tok| {
                                if tok.starts_with("<#") && tok.contains('|') && tok.ends_with('>')
                                {
                                    tok.trim_start_matches("<#")
                                        .split('|')
                                        .next()
                                        .map(std::string::ToString::to_string)
                                } else {
                                    None
                                }
                            })
                        });

                    // If no channel hint and user asked to run, offer channel selector
                    let asked_to_run =
                        mode_unread || text_lc.contains("summarize") || count_opt.is_some();
                    if asked_to_run && target_channel_id.is_none() {
                        // Encode intent in block_id so we can recover it in block_actions
                        let block_id = if let Some(n) = count_opt {
                            format!("tldr_pick_lastn_{n}")
                        } else {
                            "tldr_pick_recent".to_string()
                        };

                        // Always show standard conversations_select for channel selection
                        if let Ok(bot) = SlackBot::new(&config) {
                            let prompt_text = if let Some(n) = count_opt {
                                format!("Select a channel to summarize the last {n} messages:")
                            } else {
                                "Select a channel to summarize recent messages:".to_string()
                            };

                            let blocks = json!([
                                { "type": "section", "text": {"type": "mrkdwn", "text": prompt_text}},
                                { "type": "actions", "block_id": block_id, "elements": [
                                    { "type": "conversations_select", "action_id": "tldr_pick_conv", "default_to_current_conversation": true }
                                ]}
                            ]);
                            let fut = bot.slack_client().post_message_with_blocks(
                                channel_id,
                                Some(thread_ts),
                                "Choose channel",
                                &blocks,
                            );
                            let _ =
                                tokio::time::timeout(std::time::Duration::from_millis(1500), fut)
                                    .await;
                        }
                        return Ok(json!({ "statusCode": 200, "body": "{}" }));
                    }

                    // Build and enqueue ProcessingTask
                    if !channel_id.is_empty() && !thread_ts.is_empty() && asked_to_run {
                        let correlation_id = Uuid::new_v4().to_string();
                        let task = ProcessingTask {
                            correlation_id: correlation_id.clone(),
                            user_id: event
                                .get("user")
                                .and_then(|u| u.as_str())
                                .unwrap_or("")
                                .to_string(),
                            channel_id: target_channel_id
                                .clone()
                                .unwrap_or_else(|| channel_id.to_string()),
                            thread_ts: Some(thread_ts.to_string()),
                            origin_channel_id: Some(channel_id.to_string()),
                            response_url: None,
                            text: text_lc.clone(),
                            message_count: count_opt,
                            target_channel_id: None,
                            custom_prompt: None,
                            visible: post_here,
                            destination: Destination::Thread,
                            dest_canvas: false,
                            dest_dm: false,
                            dest_public_post: false,
                        };
                        let cfg = config.clone();
                        let ch = channel_id.to_string();
                        let ts = thread_ts.to_string();
                        if let Err(e) = sqs::send_to_sqs(&task, &config).await {
                            error!("enqueue failed: {}", e);
                        } else {
                            tokio::spawn(async move {
                                if let Ok(bot) = SlackBot::new(&cfg) {
                                    let _ = bot
                                        .slack_client()
                                        .assistant_set_suggested_prompts(
                                            &ch,
                                            &ts,
                                            &["Summarizing…"],
                                        )
                                        .await;
                                }
                            });
                        }
                        return Ok(json!({ "statusCode": 200, "body": "{}" }));
                    }

                    return Ok(json!({ "statusCode": 200, "body": "{}" }));
                }
                _ => {
                    // No-op for other events in Phase 1
                    return Ok(json!({ "statusCode": 200, "body": "{}" }));
                }
            }
        }
    }

    // Interactive vs slash
    if parsing::is_interactive_body(body) {
        let payload = match parsing::parse_interactive_payload(body) {
            Ok(v) => v,
            Err(e) => {
                error!("Interactive payload parse error: {}", e);
                return Ok(json!({
                    "statusCode": 400,
                    "body": json!({ "error": format!("Parse Error: {}", e) }).to_string()
                }));
            }
        };

        let p_type = payload.get("type").and_then(|s| s.as_str()).unwrap_or("");
        match p_type {
            "shortcut" | "message_action" => {
                let mut prefill = Prefill::default();
                if let Some(ch) = parsing::v_str(&payload, &["channel", "id"]) {
                    prefill.initial_conversation = Some(ch.to_string());
                }
                prefill.last_n = Some(100);

                let view = build_tldr_modal(&prefill);
                let trigger_id = parsing::v_str(&payload, &["trigger_id"])
                    .unwrap_or("")
                    .to_string();
                let view_clone = view.clone();
                let config_clone = config.clone();
                let modal_handle = tokio::spawn(async move {
                    match SlackBot::new(&config_clone) {
                        Ok(bot) => {
                            if let Err(e) = bot.open_modal(&trigger_id, &view_clone).await {
                                error!("Failed to open modal: {}", e);
                            }
                        }
                        Err(e) => error!("Failed to initialize SlackBot for views.open: {}", e),
                    }
                });
                let _ = tokio::time::timeout(std::time::Duration::from_millis(2000), modal_handle)
                    .await;
                return Ok(json!({ "statusCode": 200, "body": "{}" }));
            }
            // Open config button from actions block
            "block_actions" => {
                let actions = parsing::v_array(&payload, &["actions"])
                    .cloned()
                    .unwrap_or_default();
                let open_clicked = actions.iter().any(|a| {
                    a.get("action_id")
                        .and_then(|id| id.as_str())
                        .is_some_and(|id| id == "tldr_open_config")
                });
                // Share button handler: open Share modal
                if let Some(share_action) = actions.iter().find(|a| {
                    a.get("action_id")
                        .and_then(|id| id.as_str())
                        .is_some_and(|id| id == "tldr_share_open")
                }) {
                    let meta = share_action
                        .get("value")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let has_custom = serde_json::from_str::<serde_json::Value>(meta)
                        .ok()
                        .and_then(|v| {
                            v.get("has_custom_prompt")
                                .and_then(serde_json::Value::as_bool)
                        })
                        .unwrap_or(false);
                    let view = build_share_modal(has_custom, meta);
                    let trigger_id = parsing::v_str(&payload, &["trigger_id"])
                        .unwrap_or("")
                        .to_string();
                    let view_clone = view.clone();
                    let config_clone = config.clone();
                    tokio::spawn(async move {
                        match SlackBot::new(&config_clone) {
                            Ok(bot) => {
                                if let Err(e) = bot.open_modal(&trigger_id, &view_clone).await {
                                    error!("Failed to open share modal: {}", e);
                                }
                            }
                            Err(e) => error!("Failed to init SlackBot for share modal: {}", e),
                        }
                    });
                    return Ok(json!({ "statusCode": 200, "body": "{}" }));
                }

                if open_clicked {
                    let prefill = Prefill {
                        last_n: Some(100),
                        ..Default::default()
                    };

                    let view = build_tldr_modal(&prefill);
                    let trigger_id = parsing::v_str(&payload, &["trigger_id"])
                        .unwrap_or("")
                        .to_string();
                    let view_clone = view.clone();
                    let config_clone = config.clone();
                    tokio::spawn(async move {
                        match SlackBot::new(&config_clone) {
                            Ok(bot) => {
                                if let Err(e) = bot.open_modal(&trigger_id, &view_clone).await {
                                    error!("Failed to open modal from block_actions: {}", e);
                                }
                            }
                            Err(e) => error!("Failed to initialize SlackBot for views.open: {}", e),
                        }
                    });
                }

                // Handle conversation selection from quick-pick
                let conv_pick = actions.iter().find(|a| {
                    a.get("action_id")
                        .and_then(|id| id.as_str())
                        .is_some_and(|id| id == "tldr_pick_conv")
                });

                if let Some(a) = conv_pick {
                    // If this came from a config pick, open the config modal with that channel
                    let block_id_ctx = a.get("block_id").and_then(|v| v.as_str()).unwrap_or("");
                    if block_id_ctx == "tldr_pick_config" {
                        let selected_channel = a
                            .get("selected_conversation")
                            .and_then(|v| v.as_str())
                            .or_else(|| {
                                a.get("selected_option")
                                    .and_then(|o| o.get("value"))
                                    .and_then(|v| v.as_str())
                            })
                            .unwrap_or("");

                        if let Some(ch) = (!selected_channel.is_empty()).then_some(selected_channel)
                        {
                            let prefill = Prefill {
                                initial_conversation: Some(ch.to_string()),
                                last_n: Some(100),
                                ..Default::default()
                            };

                            let view = build_tldr_modal(&prefill);
                            let trigger_id = parsing::v_str(&payload, &["trigger_id"])
                                .unwrap_or("")
                                .to_string();
                            let view_clone = view.clone();
                            let config_clone = config.clone();
                            tokio::spawn(async move {
                                match SlackBot::new(&config_clone) {
                                    Ok(bot) => {
                                        if let Err(e) =
                                            bot.open_modal(&trigger_id, &view_clone).await
                                        {
                                            error!("Failed to open modal from pick_config: {}", e);
                                        }
                                    }
                                    Err(e) => error!(
                                        "Failed to initialize SlackBot for views.open: {}",
                                        e
                                    ),
                                }
                            });
                        }

                        return Ok(json!({ "statusCode": 200, "body": "{}" }));
                    }
                    // Support both conversations_select and static_select payload shapes
                    let selected_channel = a
                        .get("selected_conversation")
                        .and_then(|v| v.as_str())
                        .or_else(|| {
                            a.get("selected_option")
                                .and_then(|o| o.get("value"))
                                .and_then(|v| v.as_str())
                        })
                        .unwrap_or("");

                    // Recover intent from block_id: unread vs last-N
                    let block_id = a.get("block_id").and_then(|v| v.as_str()).unwrap_or("");
                    let message_count: Option<u32> =
                        if let Some(n_str) = block_id.strip_prefix("tldr_pick_lastn_") {
                            n_str.parse::<u32>().ok()
                        } else {
                            None
                        };

                    let channel_id = parsing::v_str(&payload, &["channel", "id"]) // fallback to container
                        .or_else(|| parsing::v_str(&payload, &["container", "channel_id"]))
                        .unwrap_or("");
                    // Prefer thread_ts from container, else message.thread_ts, else message_ts as root
                    let thread_ts = parsing::v_str(&payload, &["container", "thread_ts"]) // present when message in thread
                        .or_else(|| parsing::v_str(&payload, &["message", "thread_ts"]))
                        .or_else(|| parsing::v_str(&payload, &["container", "message_ts"]))
                        .unwrap_or("");
                    let user_id = parsing::v_str(&payload, &["user", "id"]).unwrap_or("");

                    if !selected_channel.is_empty()
                        && !channel_id.is_empty()
                        && !thread_ts.is_empty()
                        && !user_id.is_empty()
                    {
                        let correlation_id = Uuid::new_v4().to_string();
                        let text = if let Some(n) = message_count {
                            format!("summarize last {n}")
                        } else {
                            "summarize unread".to_string()
                        };
                        let task = ProcessingTask {
                            correlation_id: correlation_id.clone(),
                            user_id: user_id.to_string(),
                            channel_id: selected_channel.to_string(),
                            thread_ts: Some(thread_ts.to_string()),
                            origin_channel_id: Some(channel_id.to_string()),
                            response_url: None,
                            text,
                            message_count,
                            target_channel_id: None,
                            custom_prompt: None,
                            visible: false,
                            destination: Destination::Thread,
                            dest_canvas: false,
                            dest_dm: false,
                            dest_public_post: false,
                        };

                        let cfg = config.clone();
                        let ch = channel_id.to_string();
                        let ts = thread_ts.to_string();
                        if let Err(e) = sqs::send_to_sqs(&task, &config).await {
                            error!("enqueue failed from conv_pick: {}", e);
                        } else {
                            tokio::spawn(async move {
                                if let Ok(bot) = SlackBot::new(&cfg) {
                                    let _ = bot
                                        .slack_client()
                                        .assistant_set_suggested_prompts(
                                            &ch,
                                            &ts,
                                            &["Summarizing…"],
                                        )
                                        .await;
                                }
                            });
                        }
                    }

                    return Ok(json!({ "statusCode": 200, "body": "{}" }));
                }

                return Ok(json!({ "statusCode": 200, "body": "{}" }));
            }
            "view_submission" => {
                let correlation_id = Uuid::new_v4().to_string();
                info!(
                    "view_submission received, correlation_id={}",
                    correlation_id
                );
                if let Some(view) = payload.get("view") {
                    // Handle share modal submissions
                    if parsing::v_str(view, &["callback_id"])
                        .is_some_and(|s| s == "tldr_share_submit")
                    {
                        // Extract private_metadata
                        let meta_str = parsing::v_str(view, &["private_metadata"]).unwrap_or("");
                        let meta: Value = serde_json::from_str(meta_str).unwrap_or(json!({}));
                        let thread_ts =
                            meta.get("thread_ts").and_then(|v| v.as_str()).unwrap_or("");
                        let source_channel_id = meta
                            .get("source_channel_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let message_count = meta
                            .get("message_count")
                            .and_then(serde_json::Value::as_u64)
                            .and_then(|v| u32::try_from(v).ok())
                            .unwrap_or(0);
                        let custom_prompt = meta
                            .get("custom_prompt")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string);

                        // Determine destination channel from modal
                        let dest_channel = parsing::v_str(
                            view,
                            &[
                                "state",
                                "values",
                                "share_dest",
                                "share_conv",
                                "selected_conversation",
                            ],
                        )
                        .unwrap_or("");
                        // Determine selected options
                        let mut include_count = false;
                        let mut include_custom = false;
                        let mut include_user = false;
                        if let Some(opts) = view
                            .get("state")
                            .and_then(|s| s.get("values"))
                            .and_then(|v| v.get("share_opts"))
                            .and_then(|b| b.get("share_flags"))
                            .and_then(|a| a.get("selected_options"))
                            .and_then(|o| o.as_array())
                        {
                            for o in opts {
                                if let Some(val) = o.get("value").and_then(|v| v.as_str()) {
                                    match val {
                                        "include_count" => include_count = true,
                                        "include_custom" => include_custom = true,
                                        "include_user" => include_user = true,
                                        _ => {}
                                    }
                                }
                            }
                        }

                        // Get user ID from payload for attribution
                        let user_id = parsing::v_str(&payload, &["user", "id"]).unwrap_or("");

                        // Fetch the summary text from the thread
                        let summary_text = match SlackBot::new(&config) {
                            Ok(bot) => bot
                                .slack_client()
                                .get_summary_text_from_thread(source_channel_id, thread_ts)
                                .await
                                .unwrap_or_default(),
                            Err(_) => String::new(),
                        };

                        // Compose share message with enhanced formatting
                        let mut share_body = String::new();

                        // Add attribution header if requested
                        if include_user && !user_id.is_empty() {
                            use std::fmt::Write as _;
                            let _ = writeln!(share_body, "_Summary created by <@{user_id}>_");
                        }

                        // Add custom prompt prominently if included
                        if include_custom {
                            if let Some(cp) = custom_prompt.as_deref() {
                                if !cp.is_empty() {
                                    use std::fmt::Write as _;
                                    let _ = writeln!(share_body, "✨ *Style: \"{cp}\"*");
                                }
                            }
                        }

                        // Add message count if included
                        if include_count && message_count > 0 {
                            use std::fmt::Write as _;
                            let _ = writeln!(
                                share_body,
                                "📊 _Summary of {message_count} messages from <#{source_channel_id}>_"
                            );
                        }

                        // Add separator if we have metadata
                        if include_user || include_custom || include_count {
                            share_body.push_str("\n───────────\n\n");
                        }

                        // Add the actual summary
                        share_body.push_str(&summary_text);

                        // Add footer
                        share_body.push_str("\n\n_Generated with TLDR AI Assistant_");

                        if let Ok(bot) = SlackBot::new(&config) {
                            if !dest_channel.is_empty() {
                                let _ = bot
                                    .slack_client()
                                    .post_message(dest_channel, &share_body)
                                    .await;
                            }
                        }

                        return Ok(
                            json!({ "statusCode": 200, "body": json!({"response_action":"clear"}).to_string() }),
                        );
                    }
                    match crate::slack::modal_builder::validate_view_submission(view) {
                        Ok(()) => {
                            let user_id = parsing::v_str(&payload, &["user", "id"]).unwrap_or("");
                            let task = match view_submission::build_task_from_view(
                                user_id,
                                view,
                                correlation_id.clone(),
                            ) {
                                Ok(t) => t,
                                Err(e) => {
                                    error!(
                                        "Failed to build task (correlation_id={}): {}",
                                        correlation_id, e
                                    );
                                    return Ok(json!({
                                        "statusCode": 200,
                                        "body": json!({
                                            "response_action": "errors",
                                            "errors": { "conv": format!("Error processing request (ref: {}). Please try again.", &correlation_id[..8]) }
                                        }).to_string()
                                    }));
                                }
                            };
                            if let Err(e) = sqs::send_to_sqs(&task, &config).await {
                                error!("Enqueue failed (correlation_id={}): {}", correlation_id, e);
                                return Ok(json!({
                                    "statusCode": 200,
                                    "body": json!({
                                        "response_action": "errors",
                                        "errors": { "conv": format!("Unable to start job (ref: {}). Please try again.", &correlation_id[..8]) }
                                    }).to_string()
                                }));
                            }
                            return Ok(
                                json!({ "statusCode": 200, "body": json!({ "response_action": "clear" }).to_string() }),
                            );
                        }
                        Err(errors) => {
                            return Ok(json!({
                                "statusCode": 200,
                                "body": json!({ "response_action": "errors", "errors": Value::Object(errors) }).to_string()
                            }));
                        }
                    }
                }
                return Ok(
                    json!({ "statusCode": 400, "body": json!({ "error": "Missing view in payload" }).to_string() }),
                );
            }
            _ => {
                info!("Unhandled interactive type: {}", p_type);
                return Ok(json!({ "statusCode": 200, "body": "{}" }));
            }
        }
    }

    // Slash command
    let slack_event = match parsing::parse_slack_event(body) {
        Ok(event) => event,
        Err(e) => {
            error!("Failed to parse Slack event: {}", e);
            return Ok(json!({
                "statusCode": 400,
                "body": json!({ "error": format!("Parse Error: {}", e) }).to_string()
            }));
        }
    };

    let text_parts: Vec<&str> = slack_event.text.split_whitespace().collect();
    let visible = text_parts
        .iter()
        .any(|&p| p == "--visible" || p == "--public");
    let filtered_text: String = text_parts
        .iter()
        .filter(|&&p| p != "--visible" && p != "--public" && p != "--ui" && p != "--modal")
        .copied()
        .collect::<Vec<&str>>()
        .join(" ");

    let (message_count, target_channel_id, custom_prompt) =
        parsing::parse_kv_params(&filtered_text);

    if text_parts.iter().any(|&p| p == "--ui" || p == "--modal") {
        let prefill = Prefill {
            initial_conversation: Some(slack_event.channel_id.clone()),
            last_n: message_count,
            custom_prompt: custom_prompt.clone(),
        };
        let view = build_tldr_modal(&prefill);
        let trigger_id = slack_event.trigger_id.clone();
        let view_clone = view.clone();
        let config_clone = config.clone();
        let modal_handle = tokio::spawn(async move {
            match SlackBot::new(&config_clone) {
                Ok(bot) => {
                    let _ = bot.open_modal(&trigger_id, &view_clone).await;
                }
                Err(e) => error!("Failed to initialize SlackBot for views.open: {}", e),
            }
        });
        let _ = tokio::time::timeout(std::time::Duration::from_millis(2000), modal_handle).await;
        return Ok(json!({
            "statusCode": 200,
            "body": json!({ "response_type": "ephemeral", "text": "Opening TLDR configuration…" }).to_string()
        }));
    }

    let correlation_id = Uuid::new_v4().to_string();
    info!(
        "Slash command direct processing, correlation_id={}",
        correlation_id
    );

    let task = ProcessingTask {
        correlation_id: correlation_id.clone(),
        user_id: slack_event.user_id.clone(),
        channel_id: slack_event.channel_id.clone(),
        thread_ts: None,
        origin_channel_id: Some(slack_event.channel_id.clone()),
        response_url: Some(slack_event.response_url.clone()),
        text: slack_event.text.clone(),
        message_count,
        target_channel_id: target_channel_id.clone(),
        custom_prompt,
        visible,
        destination: if visible || target_channel_id.is_some() {
            Destination::Channel
        } else {
            Destination::DM
        },
        dest_canvas: false,
        dest_dm: false,
        dest_public_post: false,
    };

    if let Err(e) = sqs::send_to_sqs(&task, &config).await {
        error!(
            "Failed to enqueue task (correlation_id={}): {}",
            correlation_id, e
        );
        return Ok(json!({
            "statusCode": 200,
            "body": json!({
                "response_type": "ephemeral",
                "text": format!("Failed to start summarization. Please try again. (ref: {})", &correlation_id[..8])
            }).to_string()
        }));
    }

    Ok(json!({
        "statusCode": 200,
        "body": json!({ "response_type": "ephemeral", "text": "✨ Starting summarization... You'll receive the summary shortly." }).to_string()
    }))
}
