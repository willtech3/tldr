/// List of disallowed patterns in custom prompts (prompt injection protection)
pub const DISALLOWED_PATTERNS: [&str; 4] = ["system:", "assistant:", "user:", "{{"];

/// Maximum length allowed for custom prompts for command parameters
pub const MAX_CUSTOM_PROMPT_LENGTH: usize = 800;

/// Max length for the custom field (after which we truncate in OpenAI prompt)
pub const MAX_CUSTOM_LEN: usize = 800;

/// Sanitizes a custom prompt to prevent prompt injection attacks
/// Returns a Result with either the sanitized prompt or an error message
pub fn sanitize_custom_prompt(prompt: &str) -> Result<String, String> {
    // Check length
    if prompt.len() > MAX_CUSTOM_PROMPT_LENGTH {
        return Err(format!(
            "Custom prompt exceeds maximum length of {} characters",
            MAX_CUSTOM_PROMPT_LENGTH
        ));
    }

    // Check for disallowed patterns
    for pattern in DISALLOWED_PATTERNS.iter() {
        if prompt.to_lowercase().contains(&pattern.to_lowercase()) {
            return Err(format!(
                "Custom prompt contains disallowed pattern: {}",
                pattern
            ));
        }
    }

    // Remove any control characters
    let sanitized = prompt
        .chars()
        .filter(|&c| !c.is_control())
        .collect::<String>();

    Ok(sanitized)
}

/// Remove control characters and hard-truncate for internal use
/// This is used when we need to sanitize but hard truncation is acceptable
/// and we don't need error handling
pub fn sanitize_custom_internal(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control())
        .take(MAX_CUSTOM_LEN)
        .collect()
}
