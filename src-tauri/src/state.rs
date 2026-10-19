//! Process-wide state. While locked, `session` is None: no token, no key and
//! no Canvas client exist in memory, and every data command fails with
//! `Locked`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use studydesk_core::canvas::Canvas;
use studydesk_core::google::gmail::Gmail;
use studydesk_core::lockout::Lockout;
use studydesk_core::vault::{self, UnlockedKey, VaultData, VaultFile};
use studydesk_core::{paths, CoreError, Result};
use tokio::sync::{Mutex, RwLock};

pub struct Session {
    pub key: UnlockedKey,
    pub data: VaultData,
    pub canvas: Arc<Canvas>,
    /// Files chosen with the file picker or dropped from File Explorer,
    /// referenced by random id so the page never sends raw paths.
    pub picked: HashMap<String, PathBuf>,
    /// Course id -> "CODE – Name", filled on sync, used in confirmations.
    pub course_labels: HashMap<u64, String>,
    pub watcher: Option<crate::watch::Watcher>,
    /// Present when school Gmail is connected.
    pub gmail: Option<Arc<Gmail>>,
    /// (course label, assignment) for reminder checks, refreshed on sync.
    pub upcoming: Vec<(String, studydesk_core::canvas::models::Assignment)>,
}

pub struct AppState {
    pub vault: VaultFile,
    pub lockout: Lockout,
    pub session: RwLock<Option<Session>>,
    /// Unix ms of the last in-app activity (fallback idle measure).
    pub last_activity: AtomicU64,
    /// Serialises unlock attempts so throttling can't be raced.
    pub unlock_gate: Mutex<()>,
    /// Only one submission at a time.
    pub submit_gate: Mutex<()>,
    /// Cancels a Google sign-in that is waiting for the browser.
    pub gmail_cancel: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// Mirror of prefs.close_to_tray, readable while locked and from window events.
    pub close_to_tray: std::sync::atomic::AtomicBool,
    /// Downloaded calendar data by source+window, with when it was fetched.
    /// Cleared on lock.
    pub cal_cache: Mutex<std::collections::HashMap<String, (std::time::Instant, String)>>,
    /// An Apple Calendar update is running.
    pub cal_pushing: std::sync::atomic::AtomicBool,
    /// Result of the last Apple Calendar update, for Settings.
    pub cal_report: std::sync::Mutex<Option<crate::cmd_calendar::PushReport>>,
}

impl AppState {
    pub fn new(dir: PathBuf) -> Self {
        AppState {
            vault: VaultFile::in_dir(&dir),
            lockout: Lockout::in_dir(&dir),
            session: RwLock::new(None),
            last_activity: AtomicU64::new(now_ms()),
            unlock_gate: Mutex::new(()),
            submit_gate: Mutex::new(()),
            gmail_cancel: std::sync::Mutex::new(None),
            close_to_tray: std::sync::atomic::AtomicBool::new(true),
            cal_cache: Mutex::new(std::collections::HashMap::new()),
            cal_pushing: std::sync::atomic::AtomicBool::new(false),
            cal_report: std::sync::Mutex::new(None),
        }
    }

    pub fn touch(&self) {
        self.last_activity.store(now_ms(), Ordering::Relaxed);
    }

    pub async fn canvas(&self) -> Result<Arc<Canvas>> {
        self.touch();
        self.session.read().await.as_ref().map(|s| s.canvas.clone()).ok_or(CoreError::Locked)
    }

    /// Re-encrypts and writes the vault after a settings change.
    pub fn persist(&self, s: &Session) -> Result<()> {
        let bytes = vault::reseal(&s.key, &s.data)?;
        self.vault.write(&bytes)
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn random_id() -> String {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).expect("system RNG");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// A file the page wants to act on.
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileRef {
    #[serde(rename_all = "camelCase")]
    Linked { course_id: u64, rel: String },
    Picked { id: String },
}

impl Session {
    pub fn root(&self, course_id: u64) -> Result<PathBuf> {
        let p = self
            .data
            .folder_links
            .get(&course_id)
            .ok_or_else(|| CoreError::Invalid("No folder is linked to this course yet.".into()))?;
        let p = PathBuf::from(p);
        if !p.is_dir() {
            return Err(CoreError::Invalid(format!("The linked folder is missing: {}. Link it again in Settings.", p.display())));
        }
        Ok(p)
    }

    pub fn resolve(&self, r: &FileRef) -> Result<PathBuf> {
        match r {
            FileRef::Linked { course_id, rel } => paths::resolve_within(&self.root(*course_id)?, rel),
            FileRef::Picked { id } => {
                let p = self.picked.get(id).ok_or_else(|| CoreError::Invalid("That file is no longer selected. Choose it again.".into()))?;
                paths::canonical(p)
            }
        }
    }

    pub fn add_picked(&mut self, p: PathBuf) -> String {
        if self.picked.len() > 500 {
            self.picked.clear();
        }
        let id = random_id();
        self.picked.insert(id.clone(), p);
        id
    }
}
