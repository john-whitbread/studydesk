//! Watches linked course folders so the file list updates when you save,
//! rename or delete something in another program.

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct Watcher {
    _inner: Debouncer<notify::RecommendedWatcher>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Changed {
    course_ids: Vec<u64>,
}

pub fn start(app: AppHandle, roots: Vec<(u64, PathBuf)>) -> Option<Watcher> {
    if roots.is_empty() {
        return None;
    }
    let canon: Vec<(u64, PathBuf)> = roots.iter().filter_map(|(id, p)| studydesk_core::paths::canonical(p).ok().map(|c| (*id, c))).collect();
    let map = canon.clone();
    let mut deb = new_debouncer(Duration::from_millis(400), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let ids: BTreeSet<u64> =
            events.iter().flat_map(|e| map.iter().filter(|(_, root)| e.path.starts_with(root)).map(|(id, _)| *id)).collect();
        if !ids.is_empty() {
            let _ = app.emit("files-changed", Changed { course_ids: ids.into_iter().collect() });
        }
    })
    .ok()?;
    for (_, root) in &canon {
        let _ = deb.watcher().watch(root, RecursiveMode::Recursive);
    }
    Some(Watcher { _inner: deb })
}
