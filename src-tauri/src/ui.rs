//! Native dialogs. These are drawn by Windows, not by the web page, so the
//! page can neither fake nor skip them.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub async fn confirm(app: &AppHandle, title: &str, body: String, ok_label: &str) -> bool {
    let app = app.clone();
    let title = title.to_string();
    let ok = ok_label.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut b = app
            .dialog()
            .message(body)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(ok, "Cancel".into()));
        if let Some(w) = app.get_webview_window("main") {
            b = b.parent(&w);
        }
        b.blocking_show()
    })
    .await
    .unwrap_or(false)
}

pub async fn pick_folder(app: &AppHandle, title: &str) -> Option<PathBuf> {
    let app = app.clone();
    let title = title.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut b = app.dialog().file().set_title(title);
        if let Some(w) = app.get_webview_window("main") {
            b = b.set_parent(&w);
        }
        b.blocking_pick_folder().and_then(|f| f.into_path().ok())
    })
    .await
    .ok()
    .flatten()
}

pub async fn pick_files(app: &AppHandle, title: &str, start_dir: Option<PathBuf>) -> Vec<PathBuf> {
    let app = app.clone();
    let title = title.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut b = app.dialog().file().set_title(title);
        if let Some(d) = start_dir {
            b = b.set_directory(d);
        }
        if let Some(w) = app.get_webview_window("main") {
            b = b.set_parent(&w);
        }
        b.blocking_pick_files().unwrap_or_default().into_iter().filter_map(|f| f.into_path().ok()).collect()
    })
    .await
    .unwrap_or_default()
}

pub async fn save_file(app: &AppHandle, title: &str, suggested: &str) -> Option<PathBuf> {
    let app = app.clone();
    let title = title.to_string();
    let suggested = suggested.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut b = app.dialog().file().set_title(title).set_file_name(suggested);
        if let Some(w) = app.get_webview_window("main") {
            b = b.set_parent(&w);
        }
        b.blocking_save_file().and_then(|f| f.into_path().ok())
    })
    .await
    .ok()
    .flatten()
}
