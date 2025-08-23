//! MIME utilities shared across modules

/// Returns whether a given MIME type is supported for image uploads.
pub fn is_supported_image_mime(mime: &str) -> bool {
    let canon = crate::ai::client::canonicalize_mime(mime);
    ["image/jpeg", "image/png", "image/gif", "image/webp"].contains(&canon.as_str())
}
