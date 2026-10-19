//! Course folder browsing. Read-only: open, reveal and list. Nothing here can
//! modify or delete a file.

use crate::state::{AppState, FileRef};
use crate::ui;
use serde::Serialize;
use std::path::Path;
use studydesk_core::paths::{self, Entry};
use studydesk_core::{CoreError, Result};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    #[serde(rename = "ref")]
    pub file_ref: FileRef,
    pub name: String,
    pub size: u64,
    pub ext: String,
    pub modified_ms: Option<i64>,
}

pub fn facts(p: &Path) -> Result<(String, u64, String, Option<i64>)> {
    let m = std::fs::metadata(p)?;
    if !m.is_file() {
        return Err(CoreError::Invalid(format!("{} is a folder, not a file.", p.display())));
    }
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let modified = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64);
    Ok((name, m.len(), paths::ext_of(p), modified))
}

async fn root_of(state: &AppState, course_id: u64) -> Result<std::path::PathBuf> {
    state.touch();
    let g = state.session.read().await;
    g.as_ref().ok_or(CoreError::Locked)?.root(course_id)
}

async fn resolve(state: &AppState, r: &FileRef) -> Result<std::path::PathBuf> {
    state.touch();
    let g = state.session.read().await;
    g.as_ref().ok_or(CoreError::Locked)?.resolve(r)
}

#[tauri::command]
pub async fn list_dir(state: State<'_, AppState>, course_id: u64, rel: String) -> Result<Vec<Entry>> {
    let root = root_of(&state, course_id).await?;
    tauri::async_runtime::spawn_blocking(move || paths::list_dir(&root, &rel)).await.map_err(|_| CoreError::Io("Listing failed.".into()))?
}

#[tauri::command]
pub async fn recent_files(state: State<'_, AppState>, course_id: u64, extensions: Vec<String>, limit: Option<usize>) -> Result<Vec<Entry>> {
    let root = root_of(&state, course_id).await?;
    let limit = limit.unwrap_or(10).min(50);
    tauri::async_runtime::spawn_blocking(move || paths::recent_files(&root, &extensions, limit))
        .await
        .map_err(|_| CoreError::Io("Scan failed.".into()))?
}

#[tauri::command]
pub async fn open_file(app: AppHandle, state: State<'_, AppState>, file: FileRef) -> Result<()> {
    let p = resolve(&state, &file).await?;
    if p.is_file() && paths::is_blocked_for_open(&p) {
        return Err(CoreError::Invalid(format!(
            "Studydesk doesn't launch programs, scripts or shortcuts (.{}). Use \"Show in folder\" if you really want to run it.",
            paths::ext_of(&p)
        )));
    }
    app.opener().open_path(p.to_string_lossy().to_string(), None::<&str>).map_err(|e| CoreError::Io(format!("Windows couldn't open it: {e}")))
}

#[tauri::command]
pub async fn reveal_file(app: AppHandle, state: State<'_, AppState>, file: FileRef) -> Result<()> {
    let p = resolve(&state, &file).await?;
    app.opener().reveal_item_in_dir(&p).map_err(|e| CoreError::Io(format!("Couldn't open File Explorer: {e}")))
}

#[tauri::command]
pub async fn file_path(state: State<'_, AppState>, file: FileRef) -> Result<String> {
    Ok(resolve(&state, &file).await?.to_string_lossy().to_string())
}

/// Native file picker. Chosen files are remembered by id for this session.
#[tauri::command]
pub async fn pick_files(app: AppHandle, state: State<'_, AppState>, course_id: Option<u64>) -> Result<Vec<PickedFile>> {
    let start = match course_id {
        Some(id) => root_of(&state, id).await.ok(),
        None => None,
    };
    if state.session.read().await.is_none() {
        return Err(CoreError::Locked);
    }
    let chosen = ui::pick_files(&app, "Choose files", start).await;
    register(&state, chosen).await
}

pub async fn register(state: &AppState, chosen: Vec<std::path::PathBuf>) -> Result<Vec<PickedFile>> {
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    let mut out = Vec::new();
    for p in chosen.into_iter().take(50) {
        let Ok(p) = paths::canonical(&p) else { continue };
        let Ok((name, size, ext, modified_ms)) = facts(&p) else { continue };
        let id = s.add_picked(p);
        out.push(PickedFile { file_ref: FileRef::Picked { id }, name, size, ext, modified_ms });
    }
    Ok(out)
}

#[tauri::command]
pub async fn describe_files(state: State<'_, AppState>, files: Vec<FileRef>) -> Result<Vec<PickedFile>> {
    let mut out = Vec::new();
    for f in files {
        let p = resolve(&state, &f).await?;
        let (name, size, ext, modified_ms) = facts(&p)?;
        out.push(PickedFile { file_ref: f, name, size, ext, modified_ms });
    }
    Ok(out)
}
