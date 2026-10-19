use serde::ser::SerializeStruct;

pub type Result<T> = std::result::Result<T, CoreError>;

/// Every error that can reach the UI. Messages are written for the user and
/// never include secrets (the token only ever travels in a request header).
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("{0}")]
    Invalid(String),
    #[error("Studydesk is locked.")]
    Locked,
    #[error("Wrong passphrase.")]
    BadPassphrase,
    #[error("Too many wrong passphrases. Try again in {0} seconds.")]
    Throttled(u64),
    #[error("Canvas rejected the access token. It may have expired or been deleted. Replace it in Settings.")]
    Unauthorized,
    #[error("Canvas refused this action: {0}")]
    Forbidden(String),
    #[error("Canvas could not find that item. It may have been deleted or unpublished.")]
    NotFound,
    #[error("Canvas is rate limiting requests. Wait a minute, then retry.")]
    RateLimited,
    #[error("Canvas returned an error ({status}): {message}")]
    Api { status: u16, message: String },
    #[error("Could not reach Canvas: {0}")]
    Network(String),
    #[error("The saved vault could not be read. It is damaged, or it was created under a different Windows account.")]
    VaultCorrupt,
    #[error("{0}")]
    Io(String),
    #[error("Cancelled.")]
    Cancelled,
    /// A rate limit from a service other than Canvas; the message names it.
    #[error("{0}")]
    Busy(String),
    /// A refusal from a service other than Canvas; the message names it.
    #[error("{0}")]
    Refused(String),
}

impl CoreError {
    pub fn kind(&self) -> &'static str {
        match self {
            CoreError::Invalid(_) => "invalid",
            CoreError::Locked => "locked",
            CoreError::BadPassphrase => "bad_passphrase",
            CoreError::Throttled(_) => "throttled",
            CoreError::Unauthorized => "unauthorized",
            CoreError::Forbidden(_) => "forbidden",
            CoreError::NotFound => "not_found",
            CoreError::RateLimited => "rate_limited",
            CoreError::Api { .. } => "api",
            CoreError::Network(_) => "network",
            CoreError::VaultCorrupt => "vault_corrupt",
            CoreError::Io(_) => "io",
            CoreError::Cancelled => "cancelled",
            CoreError::Busy(_) => "rate_limited",
            CoreError::Refused(_) => "forbidden",
        }
    }
}

impl serde::Serialize for CoreError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("CoreError", 3)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        let retry = if let CoreError::Throttled(n) = self { Some(*n) } else { None };
        st.serialize_field("retryAfter", &retry)?;
        st.end()
    }
}

impl From<std::io::Error> for CoreError {
    fn from(e: std::io::Error) -> Self {
        CoreError::Io(match e.kind() {
            std::io::ErrorKind::NotFound => "File or folder not found.".into(),
            std::io::ErrorKind::PermissionDenied => "Windows denied access to that file or folder.".into(),
            _ => format!("File error: {e}"),
        })
    }
}

impl From<reqwest::Error> for CoreError {
    fn from(e: reqwest::Error) -> Self {
        // reqwest's Display includes the URL but never headers, so no token.
        // Walk the error chain to tell certificate problems apart from "offline".
        let mut chain = String::new();
        let mut src: Option<&dyn std::error::Error> = Some(&e);
        while let Some(s) = src {
            chain.push_str(&s.to_string().to_lowercase());
            chain.push(' ');
            src = s.source();
        }
        if chain.contains("certificate") || chain.contains("unknownissuer") || chain.contains("invalid peer") {
            CoreError::Network(
                "the site's security certificate isn't trusted, so the connection was refused. On a school or work network that inspects traffic, try another network.".into(),
            )
        } else if chain.contains("dns error") || chain.contains("failed to lookup") || chain.contains("name or service not known") || chain.contains("no such host") {
            CoreError::Network("that address couldn't be found. Check the spelling, or your internet connection.".into())
        } else if e.is_timeout() {
            CoreError::Network("the request timed out".into())
        } else if e.is_connect() {
            CoreError::Network("could not connect. Check your internet connection.".into())
        } else if e.is_decode() {
            CoreError::Api { status: 0, message: "Canvas sent a response Studydesk could not read.".into() }
        } else {
            CoreError::Network(e.without_url().to_string())
        }
    }
}
