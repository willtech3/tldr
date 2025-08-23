use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::error;

use crate::core::config::AppConfig;

pub fn verify_slack_signature(
    request_body: &str,
    timestamp: &str,
    signature: &str,
    config: &AppConfig,
) -> bool {
    let signing_secret = &config.slack_signing_secret;

    if let (Ok(ts), Ok(now)) = (
        timestamp.parse::<u64>(),
        SystemTime::now().duration_since(UNIX_EPOCH),
    ) {
        let now_secs = now.as_secs();
        if now_secs - ts > 300 || ts > now_secs + 60 {
            error!("Timestamp out of range, potential replay attack");
            return false;
        }
    }

    let base_string = format!("v0:{timestamp}:{request_body}");

    let mut mac = match Hmac::<Sha256>::new_from_slice(signing_secret.as_bytes()) {
        Ok(mac) => mac,
        Err(e) => {
            error!("Failed to create HMAC: {}", e);
            return false;
        }
    };
    mac.update(base_string.as_bytes());
    let computed_signature = format!("v0={}", hex::encode(mac.finalize().into_bytes()));

    if computed_signature == signature {
        true
    } else {
        error!(
            "Signature verification failed. Computed: '{}', Received: '{}'",
            computed_signature, signature
        );
        false
    }
}

pub fn compute_signature(timestamp: &str, request_body: &str, signing_secret: &str) -> String {
    let base_string = format!("v0:{timestamp}:{request_body}");
    let mut mac = match Hmac::<Sha256>::new_from_slice(signing_secret.as_bytes()) {
        Ok(mac) => mac,
        Err(e) => {
            error!("Failed to create HMAC: {}", e);
            return String::new();
        }
    };
    mac.update(base_string.as_bytes());
    format!("v0={}", hex::encode(mac.finalize().into_bytes()))
}
