//! Error types for the RelayCast SDK.

use thiserror::Error;

/// Errors that can occur when using the RelayCast SDK.
#[derive(Error, Debug)]
pub enum RelayError {
    /// An error returned by the RelayCast API.
    #[error("API error ({code}): {message}")]
    Api {
        /// The error code from the API.
        code: String,
        /// The error message from the API.
        message: String,
        /// The HTTP status code.
        status: u16,
    },

    /// An HTTP request error.
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// A JSON serialization/deserialization error.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// A URL parsing error.
    #[error("URL error: {0}")]
    Url(#[from] url::ParseError),

    /// A WebSocket error.
    #[error("WebSocket error: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),

    /// The response was invalid or malformed.
    #[error("Invalid response: {0}")]
    InvalidResponse(String),

    /// The WebSocket is not connected.
    #[error("WebSocket not connected. Call connect() first.")]
    NotConnected,
}

impl RelayError {
    /// Create a new API error.
    pub fn api(code: impl Into<String>, message: impl Into<String>, status: u16) -> Self {
        Self::Api {
            code: code.into(),
            message: message.into(),
            status,
        }
    }

    /// Check if this is a retryable error.
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Api { status, .. } => *status >= 500 && *status <= 599,
            Self::Http(e) => e.is_connect() || e.is_timeout(),
            _ => false,
        }
    }
}

/// Result type alias for RelayCast operations.
pub type Result<T> = std::result::Result<T, RelayError>;
