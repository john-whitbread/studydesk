//! Studydesk core.
//!
//! Everything security-relevant lives here so it can be unit tested without a
//! window: the encrypted vault, the passphrase lockout, filesystem guards, URL
//! guards and the Canvas LMS client. The Tauri app crate is a thin shell.

pub mod announce;
pub mod appearance;
pub mod calendar;
pub mod canvas;
pub mod changes;
pub mod courses;
pub mod dates;
pub mod dpapi;
pub mod effort;
pub mod error;
pub mod google;
pub mod idle;
pub mod lockout;
pub mod office_hours;
pub mod paths;
pub mod reminders;
pub mod submit;
pub mod textract;
pub mod url_guard;
pub mod vault;
pub mod work;

pub use error::{CoreError, Result};
