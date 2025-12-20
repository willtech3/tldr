//! Server-Sent Events (SSE) parser for `OpenAI` streaming responses.
//!
//! This module provides a robust SSE parser that handles:
//! - Frames split across TCP chunks
//! - Multiple frames in one read
//! - Unknown event types (safely ignored)
//!
//! It emits strongly-typed events for `OpenAI`'s Responses API streaming format.

use serde::Deserialize;
use serde_json::Value;

/// Events emitted by the `OpenAI` Responses API streaming endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEvent {
    /// A text delta from `response.output_text.delta` events.
    TextDelta(String),
    /// The response completed successfully.
    Completed,
    /// The response failed with an error message.
    Failed(String),
    /// An error occurred during streaming.
    Error(String),
}

/// Result of parsing an SSE frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseResult {
    /// A complete event was parsed.
    Event(StreamEvent),
    /// The frame was parsed but contained an unknown/unhandled event type.
    UnknownEvent(String),
    /// No complete event available yet (need more data).
    Incomplete,
    /// End of stream signal (`[DONE]`).
    Done,
}

/// Stateful SSE parser that buffers incomplete frames across chunk boundaries.
#[derive(Debug, Default)]
pub struct SseParser {
    /// Buffer for accumulating incomplete frames.
    buffer: String,
}

impl SseParser {
    /// Creates a new SSE parser.
    #[must_use]
    pub fn new() -> Self {
        Self {
            buffer: String::new(),
        }
    }

    /// Feeds a chunk of data to the parser and returns all complete events.
    ///
    /// This method handles:
    /// - Partial frames (buffered for next chunk)
    /// - Multiple frames in one chunk
    /// - Empty lines between events
    pub fn feed(&mut self, chunk: &str) -> Vec<ParseResult> {
        self.buffer.push_str(chunk);
        let mut results = Vec::new();

        // SSE events are separated by double newlines
        while let Some(event_end) = self.find_event_boundary() {
            let event_text = self.buffer[..event_end].to_string();
            self.buffer = self.buffer[event_end..]
                .trim_start_matches('\n')
                .to_string();

            if let Some(result) = Self::parse_event(&event_text) {
                results.push(result);
            }
        }

        results
    }

    /// Finds the end of a complete SSE event (double newline boundary).
    fn find_event_boundary(&self) -> Option<usize> {
        // Look for \n\n (standard SSE boundary)
        if let Some(pos) = self.buffer.find("\n\n") {
            return Some(pos + 2);
        }
        // Also handle \r\n\r\n for Windows-style line endings
        if let Some(pos) = self.buffer.find("\r\n\r\n") {
            return Some(pos + 4);
        }
        None
    }

    /// Parses a single SSE event block.
    fn parse_event(event_text: &str) -> Option<ParseResult> {
        let mut data_lines: Vec<&str> = Vec::new();

        for line in event_text.lines() {
            let line = line.trim();

            // Skip empty lines and comments
            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            // Parse data lines
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if !data.is_empty() {
                    data_lines.push(data);
                }
            }
            // Note: We ignore `event:` lines as OpenAI includes `type` in the JSON payload
        }

        if data_lines.is_empty() {
            return None;
        }

        // Join all data lines (SSE spec allows multi-line data)
        let data = data_lines.join("\n");

        // Check for stream end signal
        if data == "[DONE]" {
            return Some(ParseResult::Done);
        }

        // Parse the JSON payload
        Self::parse_json_event(&data)
    }

    /// Parses the JSON payload from an SSE data field.
    fn parse_json_event(data: &str) -> Option<ParseResult> {
        let json: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return None,
        };

        let event_type = json.get("type").and_then(Value::as_str).unwrap_or("");

        match event_type {
            "response.output_text.delta" => {
                let delta = json.get("delta").and_then(Value::as_str).unwrap_or("");
                Some(ParseResult::Event(StreamEvent::TextDelta(
                    delta.to_string(),
                )))
            }
            "response.completed" => Some(ParseResult::Event(StreamEvent::Completed)),
            "response.failed" => {
                let error_msg = extract_error_message(&json);
                Some(ParseResult::Event(StreamEvent::Failed(error_msg)))
            }
            "error" => {
                let error_msg = extract_error_message(&json);
                Some(ParseResult::Event(StreamEvent::Error(error_msg)))
            }
            // Handle other events we might want to know about
            "response.created"
            | "response.in_progress"
            | "response.output_item.added"
            | "response.content_part.added"
            | "response.output_text.done"
            | "response.content_part.done"
            | "response.output_item.done" => {
                Some(ParseResult::UnknownEvent(event_type.to_string()))
            }
            // Truly unknown events
            _ if !event_type.is_empty() => Some(ParseResult::UnknownEvent(event_type.to_string())),
            _ => None,
        }
    }

    /// Returns any remaining buffered data (for debugging/testing).
    #[must_use]
    pub fn remaining_buffer(&self) -> &str {
        &self.buffer
    }

    /// Clears the internal buffer.
    pub fn clear(&mut self) {
        self.buffer.clear();
    }
}

/// Extracts an error message from a failed/error event JSON.
fn extract_error_message(json: &Value) -> String {
    // Try different paths where error info might be
    if let Some(error) = json.get("error") {
        if let Some(msg) = error.get("message").and_then(Value::as_str) {
            return msg.to_string();
        }
        if let Some(msg) = error.as_str() {
            return msg.to_string();
        }
    }

    if let Some(response) = json.get("response")
        && let Some(error) = response.get("error")
        && let Some(msg) = error.get("message").and_then(Value::as_str)
    {
        return msg.to_string();
    }

    "Unknown error".to_string()
}

/// Struct for deserializing text delta events (for reference/documentation).
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct TextDeltaEvent {
    #[serde(rename = "type")]
    event_type: String,
    delta: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_text_delta_event() {
        let mut parser = SseParser::new();
        let chunk = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello\"}\n\n";

        let results = parser.feed(chunk);

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0],
            ParseResult::Event(StreamEvent::TextDelta("Hello".to_string()))
        );
    }

    #[test]
    fn test_parse_completed_event() {
        let mut parser = SseParser::new();
        let chunk = "data: {\"type\":\"response.completed\"}\n\n";

        let results = parser.feed(chunk);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0], ParseResult::Event(StreamEvent::Completed));
    }

    #[test]
    fn test_parse_failed_event() {
        let mut parser = SseParser::new();
        let chunk = "data: {\"type\":\"response.failed\",\"error\":{\"message\":\"Rate limit exceeded\"}}\n\n";

        let results = parser.feed(chunk);

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0],
            ParseResult::Event(StreamEvent::Failed("Rate limit exceeded".to_string()))
        );
    }

    #[test]
    fn test_parse_error_event() {
        let mut parser = SseParser::new();
        let chunk = "data: {\"type\":\"error\",\"error\":{\"message\":\"Server error\"}}\n\n";

        let results = parser.feed(chunk);

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0],
            ParseResult::Event(StreamEvent::Error("Server error".to_string()))
        );
    }

    #[test]
    fn test_parse_done_signal() {
        let mut parser = SseParser::new();
        let chunk = "data: [DONE]\n\n";

        let results = parser.feed(chunk);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0], ParseResult::Done);
    }

    #[test]
    fn test_parse_unknown_event_type() {
        let mut parser = SseParser::new();
        let chunk = "data: {\"type\":\"response.created\"}\n\n";

        let results = parser.feed(chunk);

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0],
            ParseResult::UnknownEvent("response.created".to_string())
        );
    }

    #[test]
    fn test_multiple_events_in_single_chunk() {
        let mut parser = SseParser::new();
        let chunk = concat!(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello\"}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\" World\"}\n\n",
            "data: {\"type\":\"response.completed\"}\n\n"
        );

        let results = parser.feed(chunk);

        assert_eq!(results.len(), 3);
        assert_eq!(
            results[0],
            ParseResult::Event(StreamEvent::TextDelta("Hello".to_string()))
        );
        assert_eq!(
            results[1],
            ParseResult::Event(StreamEvent::TextDelta(" World".to_string()))
        );
        assert_eq!(results[2], ParseResult::Event(StreamEvent::Completed));
    }

    #[test]
    fn test_frames_split_across_chunks() {
        let mut parser = SseParser::new();

        // First chunk: partial event
        let chunk1 = "data: {\"type\":\"response.output_text.delta\",";
        let results1 = parser.feed(chunk1);
        assert!(results1.is_empty(), "Should not emit until complete");

        // Second chunk: rest of the event
        let chunk2 = "\"delta\":\"Hello\"}\n\n";
        let results2 = parser.feed(chunk2);

        assert_eq!(results2.len(), 1);
        assert_eq!(
            results2[0],
            ParseResult::Event(StreamEvent::TextDelta("Hello".to_string()))
        );
    }

    #[test]
    fn test_event_split_at_boundary() {
        let mut parser = SseParser::new();

        // First chunk: complete data line but no double newline
        let chunk1 = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Test\"}\n";
        let results1 = parser.feed(chunk1);
        assert!(
            results1.is_empty(),
            "Should wait for double newline boundary"
        );

        // Second chunk: just the second newline
        let chunk2 = "\n";
        let results2 = parser.feed(chunk2);

        assert_eq!(results2.len(), 1);
        assert_eq!(
            results2[0],
            ParseResult::Event(StreamEvent::TextDelta("Test".to_string()))
        );
    }

    #[test]
    fn test_ignores_event_line() {
        let mut parser = SseParser::new();
        // OpenAI sometimes sends event: lines but we parse type from JSON
        let chunk = "event: text_delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n";

        let results = parser.feed(chunk);

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0],
            ParseResult::Event(StreamEvent::TextDelta("Hi".to_string()))
        );
    }

    #[test]
    fn test_ignores_comments() {
        let mut parser = SseParser::new();
        let chunk = ": this is a comment\ndata: {\"type\":\"response.completed\"}\n\n";

        let results = parser.feed(chunk);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0], ParseResult::Event(StreamEvent::Completed));
    }

    #[test]
    fn test_handles_empty_chunks() {
        let mut parser = SseParser::new();

        let results = parser.feed("");
        assert!(results.is_empty());

        let results = parser.feed("\n\n");
        assert!(results.is_empty());
    }

    #[test]
    fn test_handles_windows_line_endings() {
        let mut parser = SseParser::new();
        let chunk = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Win\"}\r\n\r\n";

        let results = parser.feed(chunk);

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0],
            ParseResult::Event(StreamEvent::TextDelta("Win".to_string()))
        );
    }

    #[test]
    fn test_unicode_in_delta() {
        let mut parser = SseParser::new();
        let chunk =
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello 世界 🌍\"}\n\n";

        let results = parser.feed(chunk);

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0],
            ParseResult::Event(StreamEvent::TextDelta("Hello 世界 🌍".to_string()))
        );
    }

    #[test]
    fn test_escaped_characters_in_delta() {
        let mut parser = SseParser::new();
        let chunk = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Line1\\nLine2\\t\\\"quoted\\\"\"}\n\n";

        let results = parser.feed(chunk);

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0],
            ParseResult::Event(StreamEvent::TextDelta(
                "Line1\nLine2\t\"quoted\"".to_string()
            ))
        );
    }

    #[test]
    fn test_remaining_buffer() {
        let mut parser = SseParser::new();

        // Feed partial data
        parser.feed("data: {\"type\":\"partial");

        assert!(!parser.remaining_buffer().is_empty());
        assert!(parser.remaining_buffer().contains("partial"));
    }

    #[test]
    fn test_clear_buffer() {
        let mut parser = SseParser::new();

        parser.feed("data: {\"type\":\"partial");
        assert!(!parser.remaining_buffer().is_empty());

        parser.clear();
        assert!(parser.remaining_buffer().is_empty());
    }

    #[test]
    fn test_realistic_openai_stream() {
        let mut parser = SseParser::new();

        // Simulate a realistic OpenAI stream with multiple event types
        let chunks = vec![
            "data: {\"type\":\"response.created\"}\n\n",
            "data: {\"type\":\"response.in_progress\"}\n\n",
            "data: {\"type\":\"response.output_item.added\"}\n\n",
            "data: {\"type\":\"response.content_part.added\"}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"The \"}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"summary \"}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"is...\"}\n\n",
            "data: {\"type\":\"response.output_text.done\"}\n\n",
            "data: {\"type\":\"response.content_part.done\"}\n\n",
            "data: {\"type\":\"response.output_item.done\"}\n\n",
            "data: {\"type\":\"response.completed\"}\n\n",
            "data: [DONE]\n\n",
        ];

        let mut all_results = Vec::new();
        for chunk in chunks {
            all_results.extend(parser.feed(chunk));
        }

        // Extract just the text deltas
        let deltas: Vec<&str> = all_results
            .iter()
            .filter_map(|r| {
                if let ParseResult::Event(StreamEvent::TextDelta(s)) = r {
                    Some(s.as_str())
                } else {
                    None
                }
            })
            .collect();

        assert_eq!(deltas, vec!["The ", "summary ", "is..."]);

        // Check completed event exists
        assert!(
            all_results
                .iter()
                .any(|r| matches!(r, ParseResult::Event(StreamEvent::Completed)))
        );

        // Check done signal exists
        assert!(all_results.iter().any(|r| matches!(r, ParseResult::Done)));
    }

    #[test]
    fn test_fragmented_json_across_many_chunks() {
        let mut parser = SseParser::new();

        // Simulate a JSON event split across many small chunks
        let full_event = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Complete message here!\"}\n\n";

        let mut emitted: Vec<ParseResult> = Vec::new();

        // Split into very small chunks (like TCP might)
        for chunk in full_event.as_bytes().chunks(5) {
            let chunk_str = std::str::from_utf8(chunk).unwrap();
            let results = parser.feed(chunk_str);

            emitted.extend(results);
        }

        assert_eq!(
            emitted,
            vec![ParseResult::Event(StreamEvent::TextDelta(
                "Complete message here!".to_string()
            ))]
        );
        assert!(parser.remaining_buffer().is_empty());
    }

    #[test]
    fn test_empty_delta() {
        let mut parser = SseParser::new();
        let chunk = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"\"}\n\n";

        let results = parser.feed(chunk);

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0],
            ParseResult::Event(StreamEvent::TextDelta(String::new()))
        );
    }
}
