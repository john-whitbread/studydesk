//! Submitting to Canvas. Order of operations for every submission:
//! 1. fetch the assignment fresh from Canvas;
//! 2. re-run the same pre-flight checks the UI showed; refuse on problems;
//! 3. show a native confirmation dialog (the page can't skip it);
//! 4. upload, then submit.

use crate::cmd_files::facts;
use crate::state::{AppState, FileRef};
use crate::ui;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use studydesk_core::canvas::models::{Assignment, Submission};
use studydesk_core::canvas::upload::UploadKind;
use studydesk_core::submit::{confirm_text, fmt_size, preflight, FileFacts, Kind, Preflight};
use studydesk_core::url_guard::external_link;
use studydesk_core::{CoreError, Result};
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UploadProgress {
    pub job: String,
    pub index: usize,
    pub count: usize,
    pub name: String,
    pub sent: u64,
    pub total: u64,
}

fn parse_kind(k: &str) -> Result<Kind> {
    match k {
        "files" => Ok(Kind::Files),
        "text" => Ok(Kind::Text),
        "url" => Ok(Kind::Url),
        _ => Err(CoreError::Invalid("Unknown submission type.".into())),
    }
}

async fn resolve_all(state: &AppState, files: &[FileRef]) -> Result<Vec<(PathBuf, FileFacts)>> {
    let g = state.session.read().await;
    let s = g.as_ref().ok_or(CoreError::Locked)?;
    files
        .iter()
        .map(|f| {
            let p = s.resolve(f)?;
            let (name, size, ext, _) = facts(&p)?;
            Ok((p, FileFacts { name, size, ext }))
        })
        .collect()
}

async fn fresh(state: &AppState, course_id: u64, assignment_id: u64) -> Result<Assignment> {
    let mut a = state.canvas().await?.assignment(course_id, assignment_id).await?;
    a.course_id = course_id;
    Ok(a)
}

#[tauri::command]
pub async fn preflight_check(state: State<'_, AppState>, course_id: u64, assignment_id: u64, kind: String, files: Vec<FileRef>) -> Result<Preflight> {
    let kind = parse_kind(&kind)?;
    let resolved = resolve_all(&state, &files).await?;
    let a = fresh(&state, course_id, assignment_id).await?;
    let facts: Vec<FileFacts> = resolved.into_iter().map(|(_, f)| f).collect();
    Ok(preflight(&a, kind, &facts, chrono::Utc::now()))
}

async fn gate_and_confirm(app: &AppHandle, state: &AppState, a: &Assignment, kind: Kind, facts: &[FileFacts], what: String) -> Result<()> {
    let now = chrono::Utc::now();
    let pf = preflight(a, kind, facts, now);
    if !pf.problems.is_empty() {
        return Err(CoreError::Invalid(pf.problems.join("\n")));
    }
    let label = state.session.read().await.as_ref().and_then(|s| s.course_labels.get(&a.course_id).cloned()).unwrap_or_default();
    let text = confirm_text(a, &label, &what, &pf, now);
    if !ui::confirm(app, "Submit to Canvas?", text, "Submit").await {
        return Err(CoreError::Cancelled);
    }
    Ok(())
}

#[tauri::command]
pub async fn submit_files(
    app: AppHandle,
    state: State<'_, AppState>,
    course_id: u64,
    assignment_id: u64,
    files: Vec<FileRef>,
    comment: Option<String>,
    job: String,
) -> Result<Submission> {
    let _busy = state.submit_gate.try_lock().map_err(|_| CoreError::Invalid("Another submission is in progress.".into()))?;
    let resolved = resolve_all(&state, &files).await?;
    let a = fresh(&state, course_id, assignment_id).await?;
    let facts: Vec<FileFacts> = resolved.iter().map(|(_, f)| f.clone()).collect();
    let what = format!(
        "Files ({}): {}",
        facts.len(),
        facts.iter().map(|f| format!("{} ({})", f.name, fmt_size(f.size))).collect::<Vec<_>>().join(", ")
    );
    gate_and_confirm(&app, &state, &a, Kind::Files, &facts, what).await?;

    let canvas = state.canvas().await?;
    let count = resolved.len();
    let mut ids = Vec::with_capacity(count);
    for (index, (path, f)) in resolved.iter().enumerate() {
        let app2 = app.clone();
        let (job2, name) = (job.clone(), f.name.clone());
        let progress = Arc::new(move |sent: u64, total: u64| {
            let _ = app2.emit("upload-progress", UploadProgress { job: job2.clone(), index, count, name: name.clone(), sent, total });
        });
        let up = canvas
            .upload_file(&UploadKind::Submission { course_id, assignment_id }, path, progress)
            .await
            .map_err(|e| CoreError::Invalid(format!("Upload of {} failed, so nothing was submitted. {e}", f.name)))?;
        ids.push(up.id);
    }
    canvas.submit_files(course_id, assignment_id, &ids, comment.as_deref()).await
}

#[tauri::command]
pub async fn submit_text(app: AppHandle, state: State<'_, AppState>, course_id: u64, assignment_id: u64, text: String) -> Result<Submission> {
    let _busy = state.submit_gate.try_lock().map_err(|_| CoreError::Invalid("Another submission is in progress.".into()))?;
    if text.trim().is_empty() {
        return Err(CoreError::Invalid("The text is empty.".into()));
    }
    let a = fresh(&state, course_id, assignment_id).await?;
    let words = text.split_whitespace().count();
    let preview: String = text.chars().take(160).collect();
    let what = format!("Text entry ({words} words): \"{}{}\"", preview.trim(), if text.chars().count() > 160 { "…" } else { "" });
    gate_and_confirm(&app, &state, &a, Kind::Text, &[], what).await?;
    state.canvas().await?.submit_text(course_id, assignment_id, &text, None).await
}

#[tauri::command]
pub async fn submit_url(app: AppHandle, state: State<'_, AppState>, course_id: u64, assignment_id: u64, url: String) -> Result<Submission> {
    let _busy = state.submit_gate.try_lock().map_err(|_| CoreError::Invalid("Another submission is in progress.".into()))?;
    let u = external_link(&url)?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(CoreError::Invalid("Enter a web address starting with https://".into()));
    }
    let a = fresh(&state, course_id, assignment_id).await?;
    gate_and_confirm(&app, &state, &a, Kind::Url, &[], format!("Website URL: {u}")).await?;
    state.canvas().await?.submit_url(course_id, assignment_id, u.as_str(), None).await
}
