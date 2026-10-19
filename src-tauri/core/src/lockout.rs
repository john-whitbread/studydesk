//! Wrong-passphrase backoff, persisted so restarting the app doesn't reset it.
//!
//! Attempts 1 to 5 are free (apart from the Argon2 cost). After that each
//! further attempt must wait 30 s, then 60 s, 120 s ... capped at 15 minutes.

use crate::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FREE_ATTEMPTS: u32 = 5;
const BASE_DELAY_SECS: u64 = 30;
const MAX_DELAY_SECS: u64 = 15 * 60;

#[derive(Serialize, Deserialize, Default, Debug, Clone, Copy, PartialEq)]
pub struct LockoutState {
    pub failures: u32,
    pub last_failure_unix: u64,
}

impl LockoutState {
    pub fn delay_secs(&self) -> u64 {
        if self.failures < FREE_ATTEMPTS {
            return 0;
        }
        let exp = (self.failures - FREE_ATTEMPTS).min(16);
        (BASE_DELAY_SECS << exp).min(MAX_DELAY_SECS)
    }

    /// Seconds the user must still wait before another attempt, or 0.
    pub fn wait_remaining(&self, now_unix: u64) -> u64 {
        let allowed_at = self.last_failure_unix.saturating_add(self.delay_secs());
        allowed_at.saturating_sub(now_unix)
    }
}

pub struct Lockout {
    path: PathBuf,
}

impl Lockout {
    pub fn in_dir(dir: &Path) -> Self {
        Lockout { path: dir.join("lockout.json") }
    }

    pub fn load(&self) -> LockoutState {
        std::fs::read(&self.path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn check(&self, now_unix: u64) -> Result<()> {
        match self.load().wait_remaining(now_unix) {
            0 => Ok(()),
            n => Err(CoreError::Throttled(n)),
        }
    }

    pub fn record_failure(&self, now_unix: u64) -> Result<LockoutState> {
        let mut s = self.load();
        s.failures = s.failures.saturating_add(1);
        s.last_failure_unix = now_unix;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&self.path, serde_json::to_vec(&s).unwrap())?;
        Ok(s)
    }

    pub fn reset(&self) -> Result<()> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

pub fn now_unix() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delays() {
        let d = |f| LockoutState { failures: f, last_failure_unix: 0 }.delay_secs();
        assert_eq!(d(0), 0);
        assert_eq!(d(4), 0);
        assert_eq!(d(5), 30);
        assert_eq!(d(6), 60);
        assert_eq!(d(7), 120);
        assert_eq!(d(10), 900);
        assert_eq!(d(1000), 900);
    }

    #[test]
    fn persisted_backoff() {
        let dir = tempfile::tempdir().unwrap();
        let l = Lockout::in_dir(dir.path());
        for _ in 0..4 {
            l.record_failure(1000).unwrap();
        }
        assert!(l.check(1000).is_ok());
        l.record_failure(1000).unwrap(); // 5th failure
        assert!(matches!(l.check(1010), Err(CoreError::Throttled(20))));
        assert!(l.check(1030).is_ok());
        // A new process sees the same state.
        assert_eq!(Lockout::in_dir(dir.path()).load().failures, 5);
        l.reset().unwrap();
        assert!(l.check(1000).is_ok());
    }
}
