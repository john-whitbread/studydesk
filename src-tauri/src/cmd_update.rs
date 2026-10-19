//! Self-updates from GitHub Releases. Every update is checked against the
//! public key built into the app before it is installed, so only releases
//! signed with the project's private key (held as a GitHub secret) can run.

use serde::Serialize;
use std::time::Duration;
use studydesk_core::{CoreError, Result};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current: String,
    /// Newer version available, if any.
    available: Option<String>,
    notes: Option<String>,
}

fn err(e: tauri_plugin_updater::Error) -> CoreError {
    CoreError::Network(format!("update check failed ({e})"))
}

async fn check(app: &AppHandle) -> Result<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let found = app.updater().map_err(err)?.check().await.map_err(err)?;
    let info = UpdateInfo {
        current,
        available: found.as_ref().map(|u| u.version.clone()),
        notes: found.as_ref().and_then(|u| u.body.clone()).filter(|b| !b.trim().is_empty()),
    };
    *app.state::<Pending>().0.lock().await = found;
    Ok(info)
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo> {
    check(&app).await
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Downloads, verifies and installs the pending update, then restarts.
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, Pending>) -> Result<()> {
    let Some(update) = pending.0.lock().await.take() else {
        return Err(CoreError::Invalid("No update is waiting. Check for updates first.".into()));
    };
    let h = app.clone();
    let mut got: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                got += chunk as u64;
                let _ = h.emit("update-progress", (got, total));
            },
            || {},
        )
        .await
        .map_err(|e| CoreError::Network(format!("the update couldn't be installed ({e})")))?;
    app.restart();
}

/// Checks 20 s after launch, then every 6 hours, and tells the page.
pub fn spawn_checks(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        let mut tick = tokio::time::interval(Duration::from_secs(6 * 3600));
        loop {
            tick.tick().await;
            if let Ok(info) = check(&app).await {
                if info.available.is_some() {
                    let _ = app.emit("update-available", info);
                }
            }
        }
    });
}
