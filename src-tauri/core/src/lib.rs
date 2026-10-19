//! Studydesk core.
//!
//! Everything security-relevant lives here so it can be unit tested without a
//! window: the encrypted vault, the passphrase lockout, filesystem guards, URL
//! guards and the Canvas LMS client. The Tauri app crate is a thin shell.

pub mod appearance;
pub mod canvas;
pub mod dates;
pub mod dpapi;
pub mod error;
pub mod google;
pub mod idle;
pub mod lockout;
pub mod paths;
pub mod reminders;
pub mod submit;
pub mod textract;
pub mod url_guard;
pub mod vault;

pub use error::{CoreError, Result};
