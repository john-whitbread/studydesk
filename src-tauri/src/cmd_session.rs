//! Setup, lock/unlock, passphrase and settings commands.

use crate::state::{AppState, Session};
use crate::{ui, watch};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use studydesk_core::canvas::Canvas;
use studydesk_core::lockout::now_unix;
use studydesk_core::vault::{self, KdfParams, Prefs, VaultData};
use studydesk_core::{paths, CoreError, Result};
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroizing;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    vault_exists: bool,
    unlocked: bool,
    retry_after: u64,
    passphrase: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub user_id: u64,
    pub user_name: String,
    pub base_url: String,
}

fn profile(d: &VaultData) -> Profile {
    Profile { user_id: d.user_id, user_name: d.user_name.clone(), base_url: d.base_url.clone() }
}

pub fn restart_watcher(app: &AppHandle, s: &mut Session) {
    s.watcher = None; // stop the old one first
    let roots = s.data.folder_links.iter().map(|(id, p)| (*id, std::path::PathBuf::from(p))).collect();
    s.watcher = watch::start(app.clone(), roots);
}

fn new_session(app: &AppHandle, key: vault::UnlockedKey, data: VaultData) -> Result<Session> {
    let canvas = Arc::new(Canvas::new(&data.base_url, &data.token, false)?);
    let gmail = data.google.as_ref().and_then(|g| crate::cmd_gmail::client_from(g).ok()).map(Arc::new);
    use tauri::Manager;
    app.state::<AppState>().close_to_tray.store(data.prefs.close_to_tray, std::sync::atomic::Ordering::Relaxed);
    let mut s = Session { key, data, canvas, picked: HashMap::new(), course_labels: HashMap::new(), watcher: None, gmail, upcoming: Vec::new() };
    restart_watcher(app, &mut s);
    Ok(s)
}

/// Reports state. If no passphrase is set, opens the vault right away using
/// the Windows-account-only key (this never counts as a wrong attempt).
#[tauri::command]
pub async fn app_status(app: AppHandle, state: State<'_, AppState>) -> Result<Status> {
    if state.vault.exists() && state.session.read().await.is_none() {
        let _g = state.unlock_gate.lock().await;
        if state.session.read().await.is_none() {
            if let Ok(bytes) = state.vault.read() {
                let opened = tauri::async_runtime::spawn_blocking(move || vault::open(&bytes, vault::NO_PASSPHRASE)).await.ok();
                if let Some(Ok((data, key))) = opened {
                    *state.session.write().await = Some(new_session(&app, key, data)?);
                    state.touch();
                }
            }
        }
    }
    let g = state.session.read().await;
    Ok(Status {
        vault_exists: state.vault.exists(),
        unlocked: g.is_some(),
        retry_after: state.lockout.load().wait_remaining(now_unix()),
        passphrase: g.as_ref().map(|s| s.data.prefs.passphrase).unwrap_or(true),
    })
}

#[tauri::command]
pub async fn setup(app: AppHandle, state: State<'_, AppState>, base_url: String, token: String, passphrase: Option<String>) -> Result<Profile> {
    let token = Zeroizing::new(token);
    let has_pass = passphrase.as_deref().is_some_and(|p| !p.is_empty());
    let passphrase = Zeroizing::new(if has_pass { passphrase.unwrap_or_default() } else { vault::NO_PASSPHRASE.to_string() });
    let _g = state.unlock_gate.lock().await;
    if state.vault.exists() {
        return Err(CoreError::Invalid("Studydesk is already set up. Unlock it instead.".into()));
    }
    if has_pass {
        vault::check_new_passphrase(&passphrase)?;
    }
    let canvas = Canvas::new(&base_url, &token, false)?;
    let user = canvas.user_self().await?;
    let data = VaultData {
        base_url: canvas.base_str(),
        token: token.trim().to_string(),
        user_id: user.id,
        user_name: user.name.clone(),
        folder_links: Default::default(),
        prefs: Prefs { passphrase: has_pass, ..Prefs::default() },
        google: None,
    };
    let data_for_seal = data.clone();
    let (bytes, key) = tauri::async_runtime::spawn_blocking(move || vault::create(&passphrase, &data_for_seal, KdfParams::DEFAULT))
        .await
        .map_err(|_| CoreError::Io("Encryption task failed.".into()))??;
    state.vault.write(&bytes)?;
    state.lockout.reset()?;
    let p = profile(&data);
    *state.session.write().await = Some(new_session(&app, key, data)?);
    state.touch();
    Ok(p)
}

#[tauri::command]
pub async fn unlock(app: AppHandle, state: State<'_, AppState>, passphrase: String) -> Result<Profile> {
    let passphrase = Zeroizing::new(passphrase);
    let _g = state.unlock_gate.lock().await;
    if let Some(s) = state.session.read().await.as_ref() {
        return Ok(profile(&s.data));
    }
    state.lockout.check(now_unix())?;
    let bytes = state.vault.read()?;
    let opened = tauri::async_runtime::spawn_blocking(move || vault::open(&bytes, &passphrase))
        .await
        .map_err(|_| CoreError::Io("Decryption task failed.".into()))?;
    match opened {
        Ok((data, key)) => {
            state.lockout.reset()?;
            let p = profile(&data);
            *state.session.write().await = Some(new_session(&app, key, data)?);
            state.touch();
            Ok(p)
        }
        Err(CoreError::BadPassphrase) => {
            let st = state.lockout.record_failure(now_unix())?;
            match st.wait_remaining(now_unix()) {
                0 => Err(CoreError::BadPassphrase),
                n => Err(CoreError::Throttled(n)),
            }
        }
        Err(e) => Err(e),
    }
}

pub async fn do_lock(app: &AppHandle, state: &AppState) {
    // Dropping the session zeroizes the token and key and stops the watcher.
    let was = state.session.write().await.take();
    if was.is_some() {
        let _ = app.emit("locked", ());
    }
}

#[tauri::command]
pub async fn lock(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    if state.session.read().await.as_ref().is_some_and(|s| !s.data.prefs.passphrase) {
        return Err(CoreError::Invalid("Set a passphrase in Settings first; without one, locking does nothing.".into()));
    }
    do_lock(&app, &state).await;
    Ok(())
}

#[tauri::command]
pub async fn touch(state: State<'_, AppState>) -> Result<()> {
    state.touch();
    Ok(())
}

/// Sets, changes or removes the passphrase. `current` is ignored when none is
/// set; `new_passphrase` None/empty removes it (Windows-account-only).
#[tauri::command]
pub async fn change_passphrase(state: State<'_, AppState>, current: Option<String>, new_passphrase: Option<String>) -> Result<()> {
    let _g = state.unlock_gate.lock().await;
    let has_now = state.session.read().await.as_ref().ok_or(CoreError::Locked)?.data.prefs.passphrase;
    let current = Zeroizing::new(if has_now { current.unwrap_or_default() } else { vault::NO_PASSPHRASE.to_string() });
    let want = new_passphrase.as_deref().is_some_and(|p| !p.is_empty());
    let new_passphrase = Zeroizing::new(if want { new_passphrase.unwrap_or_default() } else { vault::NO_PASSPHRASE.to_string() });
    if want {
        vault::check_new_passphrase(&new_passphrase)?;
    }
    if has_now {
        state.lockout.check(now_unix())?;
        let bytes = state.vault.read()?;
        let cur = current.clone();
        let verified = tauri::async_runtime::spawn_blocking(move || vault::open(&bytes, &cur).map(|_| ()))
            .await
            .map_err(|_| CoreError::Io("Decryption task failed.".into()))?;
        match verified {
            Ok(()) => {}
            Err(CoreError::BadPassphrase) => {
                state.lockout.record_failure(now_unix())?;
                return Err(CoreError::Invalid("Your current passphrase is wrong.".into()));
            }
            Err(e) => return Err(e),
        }
    }
    let mut guard = state.session.write().await;
    let s = guard.as_mut().ok_or(CoreError::Locked)?;
    s.data.prefs.passphrase = want;
    if !want {
        s.data.prefs.auto_lock_minutes = 0;
    }
    let to_seal = s.data.clone();
    let (bytes, key) = tauri::async_runtime::spawn_blocking(move || vault::create(&new_passphrase, &to_seal, KdfParams::DEFAULT))
        .await
        .map_err(|_| CoreError::Io("Encryption task failed.".into()))??;
    state.vault.write(&bytes)?;
    s.key = key;
    state.lockout.reset()?;
    Ok(())
}

#[tauri::command]
pub async fn replace_token(state: State<'_, AppState>, token: String) -> Result<Profile> {
    let token = Zeroizing::new(token);
    let base = state.session.read().await.as_ref().ok_or(CoreError::Locked)?.data.base_url.clone();
    let canvas = Canvas::new(&base, &token, false)?;
    let user = canvas.user_self().await?;
    let mut guard = state.session.write().await;
    let s = guard.as_mut().ok_or(CoreError::Locked)?;
    if user.id != s.data.user_id {
        return Err(CoreError::Invalid(format!("That token belongs to a different Canvas account ({}). Use a token from your own account.", user.name)));
    }
    s.data.token = token.trim().to_string();
    s.data.user_name = user.name;
    s.canvas = Arc::new(canvas);
    state.persist(s)?;
    Ok(profile(&s.data))
}

#[tauri::command]
pub async fn reset_app(app: AppHandle, state: State<'_, AppState>) -> Result<bool> {
    let ok = ui::confirm(
        &app,
        "Erase Studydesk data?",
        "This deletes the saved Canvas token, folder links and settings from this computer.\n\nYour files and everything on Canvas are not touched. You'll need to set Studydesk up again.".into(),
        "Erase",
    )
    .await;
    if !ok {
        return Ok(false);
    }
    let _g = state.unlock_gate.lock().await;
    do_lock(&app, &state).await;
    state.vault.delete()?;
    state.lockout.reset()?;
    Ok(true)
}

// ------------------------------------------------------------------ settings

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderLink {
    course_id: u64,
    path: String,
    exists: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    base_url: String,
    user_name: String,
    auto_lock_minutes: u32,
    folder_links: Vec<FolderLink>,
    hidden_courses: Vec<u64>,
    passphrase: bool,
    notify: bool,
    close_to_tray: bool,
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<Settings> {
    state.touch();
    let g = state.session.read().await;
    let s = g.as_ref().ok_or(CoreError::Locked)?;
    Ok(Settings {
        base_url: s.data.base_url.clone(),
        user_name: s.data.user_name.clone(),
        auto_lock_minutes: s.data.prefs.auto_lock_minutes,
        folder_links: s
            .data
            .folder_links
            .iter()
            .map(|(id, p)| FolderLink { course_id: *id, path: p.clone(), exists: std::path::Path::new(p).is_dir() })
            .collect(),
        hidden_courses: s.data.prefs.hidden_courses.iter().copied().collect(),
        passphrase: s.data.prefs.passphrase,
        notify: s.data.prefs.notify,
        close_to_tray: s.data.prefs.close_to_tray,
    })
}

#[tauri::command]
pub async fn set_auto_lock(state: State<'_, AppState>, minutes: u32) -> Result<()> {
    if minutes > 240 {
        return Err(CoreError::Invalid("Auto-lock can be at most 240 minutes.".into()));
    }
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    if minutes > 0 && !s.data.prefs.passphrase {
        return Err(CoreError::Invalid("Set a passphrase first; auto-lock needs one to mean anything.".into()));
    }
    s.data.prefs.auto_lock_minutes = minutes;
    state.persist(s)
}

#[tauri::command]
pub async fn set_course_hidden(state: State<'_, AppState>, course_id: u64, hidden: bool) -> Result<()> {
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    if hidden {
        s.data.prefs.hidden_courses.insert(course_id);
    } else {
        s.data.prefs.hidden_courses.remove(&course_id);
    }
    state.persist(s)
}

#[tauri::command]
pub async fn link_folder(app: AppHandle, state: State<'_, AppState>, course_id: u64, course_label: String) -> Result<Option<String>> {
    if state.session.read().await.is_none() {
        return Err(CoreError::Locked);
    }
    let title: String = format!("Choose the folder for {}", course_label.chars().take(80).collect::<String>());
    let Some(dir) = ui::pick_folder(&app, &title).await else { return Ok(None) };
    let dir = paths::canonical(&dir)?;
    if dir.parent().is_none() {
        return Err(CoreError::Invalid("Choose a course folder, not a whole drive.".into()));
    }
    let shown = dir.to_string_lossy().to_string();
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    s.data.folder_links.insert(course_id, shown.clone());
    state.persist(s)?;
    restart_watcher(&app, s);
    Ok(Some(shown))
}

#[tauri::command]
pub async fn unlink_folder(app: AppHandle, state: State<'_, AppState>, course_id: u64) -> Result<()> {
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    s.data.folder_links.remove(&course_id);
    state.persist(s)?;
    restart_watcher(&app, s);
    Ok(())
}

#[tauri::command]
pub async fn set_prefs(state: State<'_, AppState>, notify: Option<bool>, close_to_tray: Option<bool>) -> Result<()> {
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    if let Some(v) = notify {
        s.data.prefs.notify = v;
    }
    if let Some(v) = close_to_tray {
        s.data.prefs.close_to_tray = v;
        state.close_to_tray.store(v, std::sync::atomic::Ordering::Relaxed);
    }
    state.persist(s)
}

#[tauri::command]
pub async fn autostart_get(app: AppHandle) -> Result<bool> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| CoreError::Io(format!("Couldn't read the startup setting: {e}")))
}

#[tauri::command]
pub async fn autostart_set(app: AppHandle, enabled: bool) -> Result<()> {
    use tauri_plugin_autostart::ManagerExt;
    let r = if enabled { app.autolaunch().enable() } else { app.autolaunch().disable() };
    r.map_err(|e| CoreError::Io(format!("Couldn't change the startup setting: {e}")))
}
