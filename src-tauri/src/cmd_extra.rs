//! Commands for: your work per assignment (checklist, rubric, notes, hours),
//! office hours, estimates, "what changed", grades data, modules, text size
//! and the diagnostics report.

use crate::state::AppState;
use crate::ui;
use serde::Serialize;
use std::collections::BTreeMap;
use studydesk_core::canvas::models::{AssignmentGroup, Module};
use studydesk_core::changes::Change;
use studydesk_core::office_hours::OfficeHours;
use studydesk_core::work::{self, WorkItem};
use studydesk_core::{CoreError, Result};
use tauri::{AppHandle, Manager, State};

// ------------------------------------------------------------ my work

#[tauri::command]
pub async fn work_all(state: State<'_, AppState>) -> Result<BTreeMap<String, WorkItem>> {
    let g = state.session.read().await;
    Ok(g.as_ref().ok_or(CoreError::Locked)?.data.work.clone())
}

/// Saves your work on one assignment ("course:assignment"); an empty item is removed.
#[tauri::command]
pub async fn work_put(state: State<'_, AppState>, key: String, item: WorkItem) -> Result<()> {
    work::check_key(&key)?;
    let mut item = work::sanitize(item)?;
    item.updated = chrono::Utc::now().timestamp_millis();
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    if work::is_empty(&item) {
        s.data.work.remove(&key);
    } else {
        if !s.data.work.contains_key(&key) && s.data.work.len() >= work::MAX_ENTRIES {
            return Err(CoreError::Invalid("Too many assignments with notes; remove some old ones first.".into()));
        }
        s.data.work.insert(key, item);
    }
    state.persist(s)
}

// ------------------------------------------------------------ office hours

#[tauri::command]
pub async fn office_hours_list(state: State<'_, AppState>) -> Result<Vec<OfficeHours>> {
    let g = state.session.read().await;
    Ok(g.as_ref().ok_or(CoreError::Locked)?.data.prefs.office_hours.clone())
}

fn valid_hm(t: &str) -> bool {
    chrono::NaiveTime::parse_from_str(t, "%H:%M").is_ok()
}

/// Confirms (or edits) office hours.
#[tauri::command]
pub async fn office_hours_save(state: State<'_, AppState>, item: OfficeHours) -> Result<Vec<OfficeHours>> {
    let mut item = item;
    if item.days.is_empty() || item.days.iter().any(|d| *d > 6) || !valid_hm(&item.start) || !valid_hm(&item.end) || item.end <= item.start {
        return Err(CoreError::Invalid("Office hours need at least one day and a start before the end.".into()));
    }
    item.days.sort();
    item.days.dedup();
    let cap = |s: &mut Option<String>, n: usize| *s = s.take().map(|x| x.trim().chars().take(n).collect::<String>()).filter(|x| !x.is_empty());
    cap(&mut item.location, 80);
    cap(&mut item.who, 80);
    item.snippet = item.snippet.chars().take(240).collect();
    item.source = item.source.chars().take(120).collect();
    if item.id.is_empty() || item.id.len() > 40 || !item.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(CoreError::Invalid("Bad office hours id.".into()));
    }
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    s.data.prefs.office_hours.retain(|o| o.id != item.id);
    if s.data.prefs.office_hours.len() >= 60 {
        return Err(CoreError::Invalid("That's a lot of office hours; remove some first.".into()));
    }
    s.data.prefs.office_hours.push(item);
    state.persist(s)?;
    Ok(s.data.prefs.office_hours.clone())
}

#[tauri::command]
pub async fn office_hours_remove(state: State<'_, AppState>, id: String) -> Result<Vec<OfficeHours>> {
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    s.data.prefs.office_hours.retain(|o| o.id != id);
    // Don't suggest it again.
    if s.data.prefs.dismissed.len() < 3000 {
        s.data.prefs.dismissed.insert(format!("oh:{id}"));
    }
    state.persist(s)?;
    Ok(s.data.prefs.office_hours.clone())
}

// ------------------------------------------------------------ preferences

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPrefs {
    auto_dates: bool,
    estimates: BTreeMap<String, f64>,
    /// (id, label, Studydesk's default hours)
    kinds: Vec<(String, String, f64)>,
}

fn prefs_of(p: &studydesk_core::vault::Prefs) -> WorkPrefs {
    WorkPrefs {
        auto_dates: p.auto_dates,
        estimates: p.estimates.clone(),
        kinds: studydesk_core::effort::KINDS.iter().map(|(a, b, h)| (a.to_string(), b.to_string(), *h)).collect(),
    }
}

#[tauri::command]
pub async fn work_prefs(state: State<'_, AppState>) -> Result<WorkPrefs> {
    let g = state.session.read().await;
    Ok(prefs_of(&g.as_ref().ok_or(CoreError::Locked)?.data.prefs))
}

#[tauri::command]
pub async fn set_work_prefs(state: State<'_, AppState>, auto_dates: Option<bool>, estimates: Option<BTreeMap<String, f64>>) -> Result<WorkPrefs> {
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    if let Some(a) = auto_dates {
        s.data.prefs.auto_dates = a;
    }
    if let Some(e) = estimates {
        let known: Vec<&str> = studydesk_core::effort::KINDS.iter().map(|k| k.0).collect();
        s.data.prefs.estimates = e.into_iter().filter(|(k, h)| known.contains(&k.as_str()) && h.is_finite() && *h > 0.0 && *h <= 200.0).collect();
    }
    state.persist(s)?;
    Ok(prefs_of(&s.data.prefs))
}

// ------------------------------------------------------------ what changed

#[tauri::command]
pub async fn changes_seen(state: State<'_, AppState>, ids: Vec<String>) -> Result<Vec<Change>> {
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    for c in &mut s.data.changes {
        if ids.is_empty() || ids.contains(&c.id) {
            c.seen = true;
        }
    }
    state.persist(s)?;
    Ok(s.data.changes.clone())
}

// ------------------------------------------------------------ grades and modules

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradeGroups {
    course_id: u64,
    groups: Vec<AssignmentGroup>,
}

/// Assignment groups (weights and drop rules) for each course asked for.
#[tauri::command]
pub async fn grade_groups(state: State<'_, AppState>, course_ids: Vec<u64>) -> Result<Vec<GradeGroups>> {
    use futures_util::stream::{self, StreamExt};
    if course_ids.len() > 40 {
        return Err(CoreError::Invalid("Too many courses.".into()));
    }
    let canvas = state.canvas().await?;
    let futures: Vec<_> = course_ids
        .into_iter()
        .map(|id| {
            let canvas = canvas.clone();
            async move { (id, canvas.assignment_groups(id).await) }
        })
        .collect();
    let results: Vec<(u64, Result<Vec<AssignmentGroup>>)> = stream::iter(futures).buffer_unordered(4).collect().await;
    let mut out = Vec::new();
    for (id, r) in results {
        match r {
            Ok(groups) => out.push(GradeGroups { course_id: id, groups }),
            Err(CoreError::Unauthorized) => return Err(CoreError::Unauthorized),
            Err(_) => {} // that course shows "weights unavailable"
        }
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseModules {
    course_id: u64,
    modules: Vec<Module>,
    /// Why modules couldn't be loaded (hidden by the instructor, …).
    note: Option<String>,
}

#[tauri::command]
pub async fn modules_for(state: State<'_, AppState>, course_ids: Vec<u64>) -> Result<Vec<CourseModules>> {
    use futures_util::stream::{self, StreamExt};
    if course_ids.len() > 40 {
        return Err(CoreError::Invalid("Too many courses.".into()));
    }
    let canvas = state.canvas().await?;
    let futures: Vec<_> = course_ids
        .into_iter()
        .map(|id| {
            let canvas = canvas.clone();
            async move { (id, canvas.modules(id).await) }
        })
        .collect();
    let results: Vec<(u64, Result<Vec<Module>>)> = stream::iter(futures).buffer_unordered(4).collect().await;
    let mut out = Vec::new();
    for (id, r) in results {
        match r {
            Ok(mut modules) => {
                modules.sort_by_key(|m| m.position.unwrap_or(i64::MAX));
                out.push(CourseModules { course_id: id, modules, note: None });
            }
            Err(CoreError::Unauthorized) => return Err(CoreError::Unauthorized),
            Err(CoreError::Forbidden(_) | CoreError::NotFound) => out.push(CourseModules { course_id: id, modules: vec![], note: Some("This course doesn't share its modules.".into()) }),
            Err(e) => out.push(CourseModules { course_id: id, modules: vec![], note: Some(e.to_string()) }),
        }
    }
    Ok(out)
}

/// Marks a module item done ("must mark done") or viewed ("must view") in Canvas.
#[tauri::command]
pub async fn module_item_complete(state: State<'_, AppState>, course_id: u64, module_id: u64, item_id: u64, view: bool) -> Result<()> {
    state.canvas().await?.module_item_complete(course_id, module_id, item_id, view).await
}

// ------------------------------------------------------------ text size

/// Zooms the whole window (text, spacing, layout) like a browser's Ctrl +.
#[tauri::command]
pub async fn set_zoom(app: AppHandle, scale: f64) -> Result<()> {
    if !scale.is_finite() || !(0.75..=1.75).contains(&scale) {
        return Err(CoreError::Invalid("Text size must be between 75% and 175%.".into()));
    }
    let w = app.get_webview_window("main").ok_or_else(|| CoreError::Invalid("No window.".into()))?;
    w.set_zoom(scale).map_err(|e| CoreError::Io(format!("Couldn't change the text size: {e}")))
}

// ------------------------------------------------------------ diagnostics

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    version: String,
    os: String,
    arch: String,
    unlocked: bool,
    passphrase: bool,
    canvas_host: Option<String>,
    courses_hidden: usize,
    folders_linked: usize,
    folders_missing: usize,
    gmail: bool,
    apple: bool,
    apple_push: bool,
    calendar_links: usize,
    pinned: usize,
    office_hours: usize,
    work_items: usize,
    /// Counts and whether it failed; the error text itself can name calendars, so it's left out.
    last_calendar_update: Option<serde_json::Value>,
}

/// Facts about this install, never secrets: no tokens, passwords, links, emails or file names.
#[tauri::command]
pub async fn diagnostics_info(app: AppHandle, state: State<'_, AppState>) -> Result<Diagnostics> {
    let g = state.session.read().await;
    let s = g.as_ref();
    let d = s.map(|s| &s.data);
    Ok(Diagnostics {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        unlocked: s.is_some(),
        passphrase: d.is_some_and(|d| d.prefs.passphrase),
        canvas_host: d.and_then(|d| url::Url::parse(&d.base_url).ok()).and_then(|u| u.host_str().map(str::to_string)),
        courses_hidden: d.map_or(0, |d| d.prefs.hidden_courses.len()),
        folders_linked: d.map_or(0, |d| d.folder_links.len()),
        folders_missing: d.map_or(0, |d| d.folder_links.values().filter(|p| !std::path::Path::new(p).is_dir()).count()),
        gmail: s.is_some_and(|s| s.gmail.is_some()),
        apple: d.is_some_and(|d| d.apple.is_some()),
        apple_push: d.and_then(|d| d.apple.as_ref()).is_some_and(|a| a.push),
        calendar_links: d.map_or(0, |d| d.cal_links.len()),
        pinned: d.map_or(0, |d| d.prefs.pinned.len()),
        office_hours: d.map_or(0, |d| d.prefs.office_hours.len()),
        work_items: d.map_or(0, |d| d.work.len()),
        last_calendar_update: state.cal_report.lock().unwrap().as_ref().and_then(|r| serde_json::to_value(r).ok()).map(|mut v| {
            if let Some(o) = v.as_object_mut() {
                let failed = o.get("error").is_some_and(|e| !e.is_null());
                o.insert("error".into(), serde_json::Value::Bool(failed));
            }
            v
        }),
    })
}

/// Saves the report text (built by the page from the facts above plus recent
/// error messages) where you choose.
#[tauri::command]
pub async fn diagnostics_save(app: AppHandle, text: String) -> Result<Option<String>> {
    if text.len() > 200_000 {
        return Err(CoreError::Invalid("Report too large.".into()));
    }
    let name = format!("Studydesk-report-{}.txt", chrono::Local::now().format("%Y-%m-%d-%H%M"));
    let Some(dest) = ui::save_file(&app, "Save diagnostics report", &name).await else { return Ok(None) };
    tokio::fs::write(&dest, text).await?;
    Ok(Some(dest.to_string_lossy().to_string()))
}
