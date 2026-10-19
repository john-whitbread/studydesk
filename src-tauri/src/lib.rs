//! Studydesk app shell: window hardening, command registration, auto-lock.

mod cmd_data;
mod cmd_dates;
mod cmd_files;
mod cmd_gmail;
mod cmd_inbox;
mod cmd_session;
mod cmd_submit;
mod cmd_update;
mod state;
mod ui;
mod watch;

use serde::Serialize;
use state::AppState;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;

/// Keep in sync with build.rs (that list generates the permissions).
macro_rules! handlers {
    () => {
        tauri::generate_handler![
            cmd_session::app_status,
            cmd_session::setup,
            cmd_session::unlock,
            cmd_session::lock,
            cmd_session::touch,
            cmd_session::change_passphrase,
            cmd_session::replace_token,
            cmd_session::reset_app,
            cmd_session::get_settings,
            cmd_session::set_auto_lock,
            cmd_session::set_course_hidden,
            cmd_session::link_folder,
            cmd_session::unlink_folder,
            cmd_session::set_prefs,
            cmd_session::autostart_get,
            cmd_session::autostart_set,
            cmd_dates::dates_scan,
            cmd_dates::dates_pinned,
            cmd_dates::dates_pin,
            cmd_dates::dates_unpin,
            cmd_dates::dates_dismiss,
            cmd_dates::dates_restore_dismissed,
            cmd_data::sync_all,
            cmd_data::assignment_detail,
            cmd_data::mark_announcement_read,
            cmd_data::open_external,
            cmd_data::open_in_canvas,
            cmd_files::list_dir,
            cmd_files::recent_files,
            cmd_files::open_file,
            cmd_files::reveal_file,
            cmd_files::file_path,
            cmd_files::pick_files,
            cmd_files::describe_files,
            cmd_submit::preflight_check,
            cmd_submit::submit_files,
            cmd_submit::submit_text,
            cmd_submit::submit_url,
            cmd_inbox::list_conversations,
            cmd_inbox::get_conversation,
            cmd_inbox::update_conversation,
            cmd_inbox::unread_count,
            cmd_inbox::send_reply,
            cmd_inbox::send_message,
            cmd_inbox::search_recipients,
            cmd_gmail::gmail_status,
            cmd_gmail::gmail_connect,
            cmd_gmail::gmail_cancel_connect,
            cmd_gmail::gmail_disconnect,
            cmd_gmail::gmail_threads,
            cmd_gmail::gmail_thread,
            cmd_gmail::gmail_unread,
            cmd_update::update_check,
            cmd_update::update_install,
            cmd_update::app_version,
            cmd_session::get_appearance,
            cmd_session::set_appearance,
            cmd_session::set_course_color,
            cmd_gmail::gmail_modify,
            cmd_gmail::gmail_send,
            cmd_gmail::gmail_save_attachment,
        ]
    };
}

/// Only the bundled app may load in the window. Everything else (a link in
/// an assignment description, a redirect) is blocked; links are opened in
/// the normal browser through `open_external` instead.
fn allowed_navigation(url: &url::Url) -> bool {
    if url.scheme() == "tauri" {
        return true;
    }
    if matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost") {
        return true;
    }
    cfg!(debug_assertions) && url.scheme() == "http" && url.host_str() == Some("localhost") && url.port() == Some(1420)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OsDrag {
    phase: &'static str,
    x: f64,
    y: f64,
    files: Vec<cmd_files::PickedFile>,
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Studydesk", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Studydesk", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut b = TrayIconBuilder::with_id("main")
        .tooltip("Studydesk")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(app)?;
    Ok(())
}

/// Every minute: show Windows notifications for deadlines 24 h / 2 h away.
fn spawn_reminders(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            let state = app.state::<AppState>();
            let mut g = state.session.write().await;
            let Some(s) = g.as_mut() else { continue };
            if !s.data.prefs.notify {
                continue;
            }
            let now = chrono::Utc::now();
            let mut items = studydesk_core::reminders::from_assignments(&s.upcoming, now);
            items.extend(cmd_dates::pinned_items(&s.data.prefs.pinned, &s.course_labels));
            let due = studydesk_core::reminders::due_items(&items, now, &s.data.prefs.notified);
            if due.is_empty() {
                continue;
            }
            for r in &due {
                let _ = app.notification().builder().title(&r.title).body(&r.body).show();
                s.data.prefs.notified.extend(r.keys.iter().cloned());
            }
            studydesk_core::reminders::prune(&mut s.data.prefs.notified, now);
            let _ = state.persist(s);
        }
    });
}

fn build_window(app: &AppHandle, start_hidden: bool) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Studydesk")
        .visible(!start_hidden)
        .inner_size(1360.0, 860.0)
        .min_inner_size(560.0, 480.0)
        .center()
        .on_navigation(allowed_navigation)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .build()?;

    // Files dragged in from File Explorer. Paths stay in the backend; the
    // page only receives ids.
    let handle = app.clone();
    let win = window.clone();
    window.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            // Keep running in the tray so reminders still arrive.
            if handle.state::<AppState>().close_to_tray.load(Ordering::Relaxed) {
                api.prevent_close();
                let _ = win.hide();
            }
            return;
        }
        let WindowEvent::DragDrop(ev) = e else { return };
        let (phase, pos, paths) = match ev {
            DragDropEvent::Enter { position, .. } => ("enter", *position, vec![]),
            DragDropEvent::Over { position } => ("over", *position, vec![]),
            DragDropEvent::Drop { paths, position } => ("drop", *position, paths.clone()),
            DragDropEvent::Leave => ("leave", tauri::PhysicalPosition::new(0.0, 0.0), vec![]),
            _ => return,
        };
        let h = handle.clone();
        tauri::async_runtime::spawn(async move {
            let state = h.state::<AppState>();
            if state.session.read().await.is_none() {
                return;
            }
            let files = if phase == "drop" {
                let only_files = paths.into_iter().filter(|p| p.is_file()).collect();
                cmd_files::register(&state, only_files).await.unwrap_or_default()
            } else {
                vec![]
            };
            let _ = h.emit("os-drag", OsDrag { phase, x: pos.x, y: pos.y, files });
        });
    });
    Ok(())
}

/// Locks after the configured idle time. On Windows "idle" means no
/// keyboard or mouse input anywhere, so walking away (or locking Windows)
/// locks Studydesk too.
fn spawn_auto_lock(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(10));
        loop {
            tick.tick().await;
            let state = app.state::<AppState>();
            let minutes = match state.session.read().await.as_ref() {
                Some(s) if s.data.prefs.passphrase && s.data.prefs.auto_lock_minutes > 0 => s.data.prefs.auto_lock_minutes,
                _ => continue,
            };
            let app_idle = Duration::from_millis(state::now_ms().saturating_sub(state.last_activity.load(Ordering::Relaxed)));
            let idle = studydesk_core::idle::system_idle().unwrap_or(app_idle);
            if idle >= Duration::from_secs(u64::from(minutes) * 60) {
                cmd_session::do_lock(&app, &state).await;
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch just focuses the existing window.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(cmd_update::Pending::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(AppState::new(dir));
            let start_hidden = std::env::args().any(|a| a == "--minimized");
            build_window(app.handle(), start_hidden)?;
            build_tray(app.handle())?;
            spawn_auto_lock(app.handle().clone());
            spawn_reminders(app.handle().clone());
            cmd_update::spawn_checks(app.handle().clone());
            Ok(())
        })
        .invoke_handler(handlers!())
        .run(tauri::generate_context!())
        .expect("error while running Studydesk");
}
