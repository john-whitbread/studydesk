//! The encrypted vault: one file holding the Canvas token and every setting.
//!
//! Inner format (all integers little-endian):
//!
//! ```text
//! magic "SDV1" | m_cost u32 | t_cost u32 | p_cost u32 | salt [16] | nonce [24] | ciphertext+tag
//! ```
//!
//! * Key = Argon2id(passphrase, salt, m_cost KiB, t_cost, p_cost) -> 32 bytes.
//! * Cipher = XChaCha20-Poly1305. The header is the associated data, so the
//!   KDF parameters cannot be altered without detection.
//! * On Windows the whole inner blob is then wrapped with DPAPI (see dpapi.rs).
//!
//! Nothing about the user (not even the Canvas address) is readable until
//! the vault is unlocked.

use crate::{dpapi, CoreError, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use zeroize::{Zeroize, Zeroizing};

const MAGIC: &[u8; 4] = b"SDV1";
const HEADER_LEN: usize = 4 + 12 + 16 + 24;
pub const MIN_PASSPHRASE_CHARS: usize = 8;
/// Used when you choose not to have a passphrase. It contains a NUL byte so it
/// can never be typed. The vault is then protected by your Windows account
/// (DPAPI) alone, and opens automatically when you're signed in to Windows.
pub const NO_PASSPHRASE: &str = "\u{0}studydesk:windows-account-only";
const MAX_PASSPHRASE_CHARS: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KdfParams {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl KdfParams {
    /// About 0.3 to 1 s on a typical laptop. Each wrong guess costs that much,
    /// on top of the lockout delay.
    pub const DEFAULT: KdfParams = KdfParams { m_cost_kib: 64 * 1024, t_cost: 3, p_cost: 1 };
    /// Fast parameters for unit tests only.
    pub const TEST: KdfParams = KdfParams { m_cost_kib: 64, t_cost: 1, p_cost: 1 };

    fn sane(&self) -> bool {
        (8..=2 * 1024 * 1024).contains(&self.m_cost_kib) && (1..=10).contains(&self.t_cost) && (1..=4).contains(&self.p_cost)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Prefs {
    /// 0 = never.
    pub auto_lock_minutes: u32,
    pub hidden_courses: BTreeSet<u64>,
    /// Whether a passphrase is required to open Studydesk.
    pub passphrase: bool,
    /// Windows notifications before deadlines.
    pub notify: bool,
    /// Closing the window keeps Studydesk running in the tray.
    pub close_to_tray: bool,
    /// Reminder keys already shown ("<course>:<assignment>:<due>:<lead>").
    pub notified: BTreeSet<String>,
    /// Dates you pinned from the course scanner (or added by hand).
    pub pinned: Vec<PinnedDate>,
    /// Scanner findings you dismissed, by id.
    pub dismissed: BTreeSet<String>,
    /// system | light | dark
    pub theme: String,
    /// One of appearance::ACCENTS.
    pub accent: String,
    /// Your colour for a course (`#rrggbb`), overriding Canvas's.
    pub course_colors: BTreeMap<u64, String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct PinnedDate {
    pub id: String,
    pub course_id: u64,
    /// YYYY-MM-DD, local.
    pub date: String,
    /// HH:MM, local.
    pub time: Option<String>,
    pub label: String,
    /// exam | quiz | deliverable | info
    pub kind: String,
    pub weight: Option<String>,
    pub source: String,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { auto_lock_minutes: 0, hidden_courses: BTreeSet::new(), passphrase: false, notify: true, close_to_tray: true, notified: BTreeSet::new(), pinned: Vec::new(),
            dismissed: BTreeSet::new(),
            theme: "system".into(),
            accent: "blue".into(),
            course_colors: BTreeMap::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub struct VaultData {
    pub base_url: String,
    pub token: String,
    pub user_id: u64,
    pub user_name: String,
    /// Canvas course id -> absolute folder path on this computer.
    #[serde(default)]
    pub folder_links: BTreeMap<u64, String>,
    #[serde(default)]
    pub prefs: Prefs,
    /// School Gmail connection, if set up.
    #[serde(default)]
    pub google: Option<GoogleAuth>,
    /// iCloud Calendar connection, if set up.
    #[serde(default)]
    pub apple: Option<AppleCal>,
    /// Read-only calendar links (Google secret address, Outlook, etc.).
    #[serde(default)]
    pub cal_links: Vec<CalLink>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Default)]
pub struct AppleCal {
    pub email: String,
    /// App-specific password (16 letters). Never the Apple ID password.
    pub password: String,
    /// Calendar home URL on iCloud.
    pub home: String,
    #[serde(default)]
    pub calendars: Vec<crate::calendar::caldav::CalInfo>,
    /// Calendar hrefs shown in Studydesk.
    #[serde(default)]
    pub shown: BTreeSet<String>,
    /// Keep a "Studydesk" calendar in iCloud with deadlines and key dates.
    #[serde(default)]
    pub push: bool,
    #[serde(default)]
    pub studydesk_href: Option<String>,
    /// uid -> what was last written, so only changes are sent.
    #[serde(default)]
    pub pushed: BTreeMap<String, Pushed>,
}

impl Drop for AppleCal {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct Pushed {
    pub href: String,
    pub etag: String,
    pub hash: String,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Default)]
pub struct CalLink {
    pub id: String,
    pub name: String,
    /// Secret: the link itself grants access to the calendar.
    pub url: String,
    #[serde(default)]
    pub color: String,
    #[serde(default = "yes")]
    pub shown: bool,
}

fn yes() -> bool {
    true
}

impl Drop for CalLink {
    fn drop(&mut self) {
        self.url.zeroize();
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Default)]
pub struct GoogleAuth {
    pub client_id: String,
    pub client_secret: String,
    pub refresh_token: String,
    pub email: String,
}

impl Drop for GoogleAuth {
    fn drop(&mut self) {
        self.client_secret.zeroize();
        self.refresh_token.zeroize();
    }
}

impl std::fmt::Debug for VaultData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultData").field("base_url", &self.base_url).field("token", &"<redacted>").finish_non_exhaustive()
    }
}

impl Drop for VaultData {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

/// The derived key, kept in memory only while unlocked so settings can be
/// re-saved without asking for the passphrase again.
pub struct UnlockedKey {
    key: Zeroizing<[u8; 32]>,
    salt: [u8; 16],
    params: KdfParams,
}

pub fn check_new_passphrase(p: &str) -> Result<()> {
    let n = p.chars().count();
    if n < MIN_PASSPHRASE_CHARS {
        return Err(CoreError::Invalid(format!("Use at least {MIN_PASSPHRASE_CHARS} characters. A short phrase is easier to remember than random symbols.")));
    }
    if n > MAX_PASSPHRASE_CHARS {
        return Err(CoreError::Invalid("That passphrase is too long.".into()));
    }
    if p.trim().is_empty() {
        return Err(CoreError::Invalid("The passphrase can't be only spaces.".into()));
    }
    Ok(())
}

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::getrandom(&mut b).map_err(|_| CoreError::Io("The system random number generator failed.".into()))?;
    Ok(b)
}

fn derive(pass: &str, salt: &[u8; 16], p: KdfParams) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(p.m_cost_kib, p.t_cost, p.p_cost, Some(32)).map_err(|_| CoreError::VaultCorrupt)?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(pass.as_bytes(), salt, out.as_mut())
        .map_err(|_| CoreError::VaultCorrupt)?;
    Ok(out)
}

fn header(p: KdfParams, salt: &[u8; 16], nonce: &[u8; 24]) -> Vec<u8> {
    let mut h = Vec::with_capacity(HEADER_LEN);
    h.extend_from_slice(MAGIC);
    h.extend_from_slice(&p.m_cost_kib.to_le_bytes());
    h.extend_from_slice(&p.t_cost.to_le_bytes());
    h.extend_from_slice(&p.p_cost.to_le_bytes());
    h.extend_from_slice(salt);
    h.extend_from_slice(nonce);
    h
}

fn seal_with(key: &UnlockedKey, data: &VaultData) -> Result<Vec<u8>> {
    let nonce: [u8; 24] = random()?;
    let hdr = header(key.params, &key.salt, &nonce);
    let plain = Zeroizing::new(serde_json::to_vec(data).map_err(|e| CoreError::Io(e.to_string()))?);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key.key.as_ref()));
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: &plain, aad: &hdr })
        .map_err(|_| CoreError::Io("Encryption failed.".into()))?;
    let mut inner = hdr;
    inner.extend_from_slice(&ct);
    dpapi::protect(&inner)
}

/// Creates a new vault. Returns the file bytes and the in-memory key.
pub fn create(pass: &str, data: &VaultData, params: KdfParams) -> Result<(Vec<u8>, UnlockedKey)> {
    if pass != NO_PASSPHRASE {
        check_new_passphrase(pass)?;
    }
    let salt: [u8; 16] = random()?;
    let key = UnlockedKey { key: derive(pass, &salt, params)?, salt, params };
    let bytes = seal_with(&key, data)?;
    Ok((bytes, key))
}

/// Re-encrypts with the existing key and a fresh nonce.
pub fn reseal(key: &UnlockedKey, data: &VaultData) -> Result<Vec<u8>> {
    seal_with(key, data)
}

/// Opens a vault. A wrong passphrase and a tampered ciphertext are
/// indistinguishable by design; both return `BadPassphrase`.
pub fn open(file_bytes: &[u8], pass: &str) -> Result<(VaultData, UnlockedKey)> {
    let inner = dpapi::unprotect(file_bytes)?;
    if inner.len() < HEADER_LEN + 16 || &inner[..4] != MAGIC {
        return Err(CoreError::VaultCorrupt);
    }
    let u32_at = |i: usize| u32::from_le_bytes(inner[i..i + 4].try_into().unwrap());
    let params = KdfParams { m_cost_kib: u32_at(4), t_cost: u32_at(8), p_cost: u32_at(12) };
    if !params.sane() {
        return Err(CoreError::VaultCorrupt);
    }
    let salt: [u8; 16] = inner[16..32].try_into().unwrap();
    let nonce: [u8; 24] = inner[32..56].try_into().unwrap();
    let key = UnlockedKey { key: derive(pass, &salt, params)?, salt, params };
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key.key.as_ref()));
    let plain = Zeroizing::new(
        cipher
            .decrypt(XNonce::from_slice(&nonce), Payload { msg: &inner[HEADER_LEN..], aad: &inner[..HEADER_LEN] })
            .map_err(|_| CoreError::BadPassphrase)?,
    );
    let data: VaultData = serde_json::from_slice(&plain).map_err(|_| CoreError::VaultCorrupt)?;
    Ok((data, key))
}

/// Location of the vault on disk, with crash-safe writes.
#[derive(Clone)]
pub struct VaultFile {
    path: PathBuf,
}

impl VaultFile {
    pub fn in_dir(dir: &Path) -> Self {
        VaultFile { path: dir.join("vault.bin") }
    }
    pub fn exists(&self) -> bool {
        self.path.is_file()
    }
    pub fn read(&self) -> Result<Vec<u8>> {
        Ok(std::fs::read(&self.path)?)
    }
    /// Write to a temp file, flush to disk, then rename over the old vault, so
    /// a crash mid-write can never leave a half-written vault.
    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("bin.tmp");
        {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(bytes)?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
    pub fn delete(&self) -> Result<()> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> VaultData {
        let mut links = BTreeMap::new();
        links.insert(42, "C:\\School\\MECE 2420".to_string());
        VaultData {
            base_url: "https://school.instructure.com/".into(),
            token: "7~SECRET-TOKEN-VALUE".into(),
            user_id: 7,
            user_name: "John".into(),
            folder_links: links,
            prefs: Prefs::default(),
            google: None,
            apple: None,
            cal_links: Vec::new(),
        }
    }

    #[test]
    fn roundtrip() {
        let (bytes, _) = create("correct horse battery", &sample(), KdfParams::TEST).unwrap();
        let (data, _) = open(&bytes, "correct horse battery").unwrap();
        assert!(data == sample());
    }

    #[test]
    fn token_not_in_file_bytes() {
        let (bytes, _) = create("correct horse battery", &sample(), KdfParams::TEST).unwrap();
        let hay = String::from_utf8_lossy(&bytes);
        assert!(!hay.contains("SECRET-TOKEN"));
        assert!(!hay.contains("instructure"));
        assert!(!hay.contains("School"));
    }

    #[test]
    fn wrong_passphrase_rejected() {
        let (bytes, _) = create("correct horse battery", &sample(), KdfParams::TEST).unwrap();
        assert!(matches!(open(&bytes, "correct horse batterY"), Err(CoreError::BadPassphrase)));
    }

    #[test]
    fn tampering_detected() {
        let (bytes, _) = create("correct horse battery", &sample(), KdfParams::TEST).unwrap();
        // Flip a ciphertext byte.
        let mut b = bytes.clone();
        let last = b.len() - 1;
        b[last] ^= 1;
        assert!(matches!(open(&b, "correct horse battery"), Err(CoreError::BadPassphrase)));
        // Alter the KDF params in the header (authenticated as AAD).
        let mut b = bytes.clone();
        b[4] ^= 0x10; // m_cost 64 -> 80 KiB: still sane, but AAD no longer matches
        assert!(matches!(open(&b, "correct horse battery"), Err(CoreError::BadPassphrase)));
        // Garbage.
        assert!(matches!(open(b"nope", "x"), Err(CoreError::VaultCorrupt)));
    }

    #[test]
    fn reseal_keeps_passphrase_and_changes_nonce() {
        let (b1, key) = create("correct horse battery", &sample(), KdfParams::TEST).unwrap();
        let mut d = sample();
        d.prefs.auto_lock_minutes = 30;
        let b2 = reseal(&key, &d).unwrap();
        assert_ne!(b1[32..56], b2[32..56], "nonce must change");
        let (back, _) = open(&b2, "correct horse battery").unwrap();
        assert_eq!(back.prefs.auto_lock_minutes, 30);
    }

    #[test]
    fn no_passphrase_mode_roundtrips_and_is_untypeable() {
        let (bytes, _) = create(NO_PASSPHRASE, &sample(), KdfParams::TEST).unwrap();
        assert!(open(&bytes, NO_PASSPHRASE).is_ok());
        assert!(matches!(open(&bytes, ""), Err(CoreError::BadPassphrase)));
        assert!(NO_PASSPHRASE.contains('\0'));
        assert!(!String::from_utf8_lossy(&bytes).contains("SECRET-TOKEN"));
    }

    #[test]
    fn passphrase_rules() {
        assert!(check_new_passphrase("short").is_err());
        assert!(check_new_passphrase("        ").is_err());
        assert!(check_new_passphrase("long enough phrase").is_ok());
    }

    #[test]
    fn debug_redacts_token() {
        assert!(!format!("{:?}", sample()).contains("SECRET"));
    }

    #[test]
    fn atomic_file_write() {
        let dir = tempfile::tempdir().unwrap();
        let f = VaultFile::in_dir(dir.path());
        assert!(!f.exists());
        f.write(b"one").unwrap();
        f.write(b"two").unwrap();
        assert_eq!(f.read().unwrap(), b"two");
        assert!(!dir.path().join("vault.bin.tmp").exists());
        f.delete().unwrap();
        assert!(!f.exists());
    }
}
