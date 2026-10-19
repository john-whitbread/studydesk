//! Canvas Inbox (Conversations API).

use crate::cmd_submit::UploadProgress;
use crate::state::{AppState, FileRef};
use std::sync::Arc;
use studydesk_core::canvas::models::{Conversation, Recipient};
use studydesk_core::canvas::upload::UploadKind;
use studydesk_core::canvas::Page;
use studydesk_core::{CoreError, Result};
use tauri::{AppHandle, Emitter, State};

const MAX_BODY: usize = 20_000;

fn check_body(body: &str) -> Result<()> {
    if body.trim().is_empty() {
        return Err(CoreError::Invalid("Write a message first.".into()));
    }
    if body.chars().count() > MAX_BODY {
        return Err(CoreError::Invalid("That message is too long for Canvas.".into()));
    }
    Ok(())
}

async fn upload_attachments(app: &AppHandle, state: &AppState, files: &[FileRef], job: &str) -> Result<Vec<u64>> {
    if files.len() > 10 {
        return Err(CoreError::Invalid("Attach at most 10 files.".into()));
    }
    let paths: Vec<_> = {
        let g = state.session.read().await;
        let s = g.as_ref().ok_or(CoreError::Locked)?;
        files.iter().map(|f| s.resolve(f)).collect::<Result<_>>()?
    };
    let canvas = state.canvas().await?;
    let count = paths.len();
    let mut ids = Vec::new();
    for (index, p) in paths.iter().enumerate() {
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let (app2, job2, name2) = (app.clone(), job.to_string(), name.clone());
        let progress = Arc::new(move |sent: u64, total: u64| {
            let _ = app2.emit("upload-progress", UploadProgress { job: job2.clone(), index, count, name: name2.clone(), sent, total });
        });
        let up = canvas
            .upload_file(&UploadKind::MessageAttachment, p, progress)
            .await
            .map_err(|e| CoreError::Invalid(format!("Attaching {name} failed, so the message was not sent. {e}")))?;
        ids.push(up.id);
    }
    Ok(ids)
}

#[tauri::command]
pub async fn list_conversations(state: State<'_, AppState>, scope: String, course_id: Option<u64>, cursor: Option<String>) -> Result<Page<Conversation>> {
    state.canvas().await?.conversations(&scope, course_id, cursor.as_deref()).await
}

#[tauri::command]
pub async fn get_conversation(state: State<'_, AppState>, id: u64) -> Result<Conversation> {
    state.canvas().await?.conversation(id).await
}

#[tauri::command]
pub async fn update_conversation(state: State<'_, AppState>, id: u64, workflow_state: Option<String>, starred: Option<bool>) -> Result<Conversation> {
    state.canvas().await?.update_conversation(id, workflow_state.as_deref(), starred).await
}

#[tauri::command]
pub async fn unread_count(state: State<'_, AppState>) -> Result<u64> {
    state.canvas().await?.unread_count().await
}

#[tauri::command]
pub async fn send_reply(app: AppHandle, state: State<'_, AppState>, id: u64, body: String, files: Vec<FileRef>, job: String) -> Result<Conversation> {
    check_body(&body)?;
    let ids = upload_attachments(&app, &state, &files, &job).await?;
    state.canvas().await?.add_message(id, &body, &ids).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn send_message(
    app: AppHandle,
    state: State<'_, AppState>,
    course_id: u64,
    recipients: Vec<String>,
    subject: String,
    body: String,
    group: bool,
    files: Vec<FileRef>,
    job: String,
) -> Result<Vec<Conversation>> {
    check_body(&body)?;
    if recipients.is_empty() {
        return Err(CoreError::Invalid("Add at least one recipient.".into()));
    }
    if recipients.len() > 50 || recipients.iter().any(|r| r.is_empty() || !r.chars().all(|c| c.is_ascii_digit())) {
        return Err(CoreError::Invalid("Recipients must be people chosen from the course list.".into()));
    }
    let subject = subject.trim();
    if subject.is_empty() {
        return Err(CoreError::Invalid("Add a subject.".into()));
    }
    if subject.chars().count() > 255 {
        return Err(CoreError::Invalid("The subject is too long (255 characters max).".into()));
    }
    let ids = upload_attachments(&app, &state, &files, &job).await?;
    state.canvas().await?.create_conversation(course_id, &recipients, subject, &body, group, &ids).await
}

#[tauri::command]
pub async fn search_recipients(state: State<'_, AppState>, course_id: u64, search: String, role: Option<String>) -> Result<Vec<Recipient>> {
    let mut r = state.canvas().await?.search_recipients(course_id, &search, role.as_deref()).await?;
    // Only individual users; drop group/section contexts.
    r.retain(|x| x.id.chars().all(|c| c.is_ascii_digit()));
    Ok(r)
}
