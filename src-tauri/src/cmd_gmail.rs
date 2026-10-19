//! School Gmail. Optional: everything else works without it.

use crate::state::{AppState, FileRef};
use crate::ui;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use studydesk_core::google::gmail::{Endpoints, Gmail, ThreadDetail, ThreadPage};
use studydesk_core::google::mime::{self, OutAttachment, Outgoing};
use studydesk_core::google::oauth::{self, Pkce};
use studydesk_core::vault::GoogleAuth;
use studydesk_core::{CoreError, Result};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use zeroize::Zeroizing;

const MAX_ATTACH_BYTES: u64 = 25 * 1000 * 1000; // Gmail's limit

pub fn client_from(g: &GoogleAuth) -> Result<Gmail> {
    Gmail::new(Endpoints::default(), &g.client_id, &g.client_secret, &g.refresh_token, &g.email)
}

async fn gmail(state: &AppState) -> Result<Arc<Gmail>> {
    state.touch();
    let g = state.session.read().await;
    let s = g.as_ref().ok_or(CoreError::Locked)?;
    s.gmail.clone().ok_or_else(|| CoreError::Invalid("Gmail isn't connected. Connect it in Settings.".into()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailStatus {
    connected: bool,
    email: Option<String>,
    client_id: Option<String>,
}

#[tauri::command]
pub async fn gmail_status(state: State<'_, AppState>) -> Result<GmailStatus> {
    let g = state.session.read().await;
    let s = g.as_ref().ok_or(CoreError::Locked)?;
    Ok(GmailStatus {
        connected: s.gmail.is_some(),
        email: s.data.google.as_ref().map(|x| x.email.clone()),
        client_id: s.data.google.as_ref().map(|x| x.client_id.clone()),
    })
}

/// Opens Google's sign-in page in your browser and waits (up to 5 minutes)
/// for you to finish there.
#[tauri::command]
pub async fn gmail_connect(app: AppHandle, state: State<'_, AppState>, client_id: String, client_secret: String, login_hint: Option<String>) -> Result<String> {
    let client_secret = Zeroizing::new(client_secret);
    oauth::check_client(&client_id, &client_secret)?;
    if state.session.read().await.is_none() {
        return Err(CoreError::Locked);
    }
    let pkce = Pkce::new()?;
    let (listener, redirect) = oauth::bind().await?;
    let url = oauth::auth_url(&client_id, &redirect, &pkce, login_hint.as_deref());
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    *state.gmail_cancel.lock().unwrap() = Some(tx);
    app.opener().open_url(url, None::<&str>).map_err(|e| CoreError::Io(format!("Couldn't open your browser: {e}")))?;

    let code = tokio::select! {
        r = oauth::wait_for_code(listener, &pkce.state, Duration::from_secs(300)) => r,
        _ = rx => Err(CoreError::Cancelled),
    };
    state.gmail_cancel.lock().unwrap().take();
    let code = code?;

    let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).https_only(true).build().map_err(|e| CoreError::Network(e.to_string()))?;
    let tok = oauth::token_request(
        &http,
        oauth::TOKEN_URL,
        &[
            ("code", code.as_str()),
            ("client_id", client_id.trim()),
            ("client_secret", client_secret.trim()),
            ("redirect_uri", &redirect),
            ("grant_type", "authorization_code"),
            ("code_verifier", pkce.verifier.as_str()),
        ],
    )
    .await?;
    if !tok.scope.split(' ').any(|s| s == oauth::SCOPE) {
        return Err(CoreError::Invalid("Google didn't grant mail access. Try again and tick the Gmail permission.".into()));
    }
    let refresh = Zeroizing::new(tok.refresh_token.ok_or_else(|| CoreError::Invalid("Google didn't return a long-term sign-in. Remove Studydesk at myaccount.google.com → Security → Third-party access, then connect again.".into()))?);
    let probe = Gmail::new(Endpoints::default(), &client_id, &client_secret, &refresh, "")?;
    let email = probe.profile().await?.email_address;
    let auth = GoogleAuth { client_id: client_id.trim().into(), client_secret: client_secret.trim().into(), refresh_token: refresh.to_string(), email: email.clone() };
    let client = Arc::new(client_from(&auth)?);

    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    s.data.google = Some(auth);
    state.persist(s)?;
    s.gmail = Some(client);
    Ok(email)
}

#[tauri::command]
pub async fn gmail_cancel_connect(state: State<'_, AppState>) -> Result<()> {
    if let Some(tx) = state.gmail_cancel.lock().unwrap().take() {
        let _ = tx.send(());
    }
    Ok(())
}

#[tauri::command]
pub async fn gmail_disconnect(state: State<'_, AppState>) -> Result<()> {
    let client = {
        let mut g = state.session.write().await;
        let s = g.as_mut().ok_or(CoreError::Locked)?;
        s.data.google = None;
        state.persist(s)?;
        s.gmail.take()
    };
    if let Some(c) = client {
        c.revoke().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn gmail_threads(state: State<'_, AppState>, view: String, query: String, page: Option<String>) -> Result<ThreadPage> {
    gmail(&state).await?.threads(&view, &query, page.as_deref()).await
}

#[tauri::command]
pub async fn gmail_unread(state: State<'_, AppState>) -> Result<u64> {
    gmail(&state).await?.inbox_unread().await
}

#[tauri::command]
pub async fn gmail_thread(state: State<'_, AppState>, id: String) -> Result<ThreadDetail> {
    gmail(&state).await?.thread(&id).await
}

#[tauri::command]
pub async fn gmail_modify(state: State<'_, AppState>, id: String, action: String) -> Result<()> {
    let g = gmail(&state).await?;
    let (add, remove): (&[&str], &[&str]) = match action.as_str() {
        "read" => (&[], &["UNREAD"]),
        "unread" => (&["UNREAD"], &[]),
        "archive" => (&[], &["INBOX"]),
        "inbox" => (&["INBOX"], &[]),
        "star" => (&["STARRED"], &[]),
        "unstar" => (&[], &["STARRED"]),
        _ => return Err(CoreError::Invalid("Unknown action.".into())),
    };
    g.modify(&id, add, remove).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyInfo {
    thread_id: String,
    in_reply_to: Option<String>,
    references: Option<String>,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn gmail_send(
    state: State<'_, AppState>,
    to: Vec<String>,
    cc: Vec<String>,
    subject: String,
    body: String,
    files: Vec<FileRef>,
    reply: Option<ReplyInfo>,
) -> Result<String> {
    let g = gmail(&state).await?;
    if body.trim().is_empty() {
        return Err(CoreError::Invalid("Write a message first.".into()));
    }
    if to.len() + cc.len() > 100 {
        return Err(CoreError::Invalid("Too many recipients.".into()));
    }
    let paths: Vec<_> = {
        let guard = state.session.read().await;
        let s = guard.as_ref().ok_or(CoreError::Locked)?;
        files.iter().map(|f| s.resolve(f)).collect::<Result<_>>()?
    };
    let mut total = 0u64;
    let mut attachments = Vec::new();
    for p in &paths {
        let m = tokio::fs::metadata(p).await?;
        total += m.len();
        if total > MAX_ATTACH_BYTES {
            return Err(CoreError::Invalid("Attachments are over Gmail's 25 MB limit. Share a link instead.".into()));
        }
        attachments.push(OutAttachment {
            filename: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into()),
            mime_type: mime_guess::from_path(p).first_or_octet_stream().essence_str().to_string(),
            data: tokio::fs::read(p).await?,
        });
    }
    let to: Vec<String> = to.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let cc: Vec<String> = cc.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let raw = mime::build(&Outgoing {
        from: &g.email,
        to: &to,
        cc: &cc,
        subject: subject.trim(),
        body: &body,
        in_reply_to: reply.as_ref().and_then(|r| r.in_reply_to.as_deref()),
        references: reply.as_ref().and_then(|r| r.references.as_deref()),
        attachments: &attachments,
    })?;
    g.send_raw(raw, reply.as_ref().map(|r| r.thread_id.as_str())).await
}

fn safe_file_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() { "attachment".into() } else { cleaned.chars().take(180).collect() }
}

/// Downloads an attachment to a location you choose in a Save dialog.
#[tauri::command]
pub async fn gmail_save_attachment(app: AppHandle, state: State<'_, AppState>, message_id: String, attachment_id: String, filename: String) -> Result<Option<String>> {
    let g = gmail(&state).await?;
    let Some(dest) = ui::save_file(&app, "Save attachment", &safe_file_name(&filename)).await else { return Ok(None) };
    let bytes = g.attachment(&message_id, &attachment_id).await?;
    tokio::fs::write(&dest, bytes).await?;
    Ok(Some(dest.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn file_names() {
        assert_eq!(super::safe_file_name("..\\..\\evil.exe"), "_.._evil.exe");
        assert_eq!(super::safe_file_name("Lab 3: final?.pdf"), "Lab 3_ final_.pdf");
        assert_eq!(super::safe_file_name("..."), "attachment");
    }
}
