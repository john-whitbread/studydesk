//! Canvas's file upload flow and submissions.
//!
//! 1. POST the file's name/size/type to Canvas (with token) -> upload ticket.
//! 2. POST multipart to `upload_url` (NO token; often a separate storage host).
//! 3. If that answers 3xx, GET the Location. The token is attached only when
//!    the Location is on the Canvas origin.
//! 4. Use the returned file id in a submission or message.

use super::models::{Submission, UploadTicket, UploadedFile};
use super::{check, parse_json, Canvas};
use crate::url_guard::{same_origin, upload_target};
use crate::{CoreError, Result};
use futures_util::StreamExt;
use reqwest::multipart::{Form, Part};
use reqwest::{Body, Method};
use std::path::Path;
use std::sync::Arc;

/// Called with (bytes_sent, total_bytes).
pub type Progress = Arc<dyn Fn(u64, u64) + Send + Sync>;

pub enum UploadKind {
    Submission { course_id: u64, assignment_id: u64 },
    /// Files attached to inbox messages live in "conversation attachments".
    MessageAttachment,
}

impl Canvas {
    pub async fn upload_file(&self, kind: &UploadKind, path: &Path, progress: Progress) -> Result<UploadedFile> {
        let meta = tokio::fs::metadata(path).await?;
        if !meta.is_file() {
            return Err(CoreError::Invalid("Only files can be uploaded.".into()));
        }
        let size = meta.len();
        let name = path.file_name().and_then(|n| n.to_str()).ok_or_else(|| CoreError::Invalid("File name is not valid text.".into()))?.to_string();
        let content_type = mime_guess::from_path(path).first_or_octet_stream().essence_str().to_string();

        // Step 1
        let (init_path, mut form) = match kind {
            UploadKind::Submission { course_id, assignment_id } => {
                (format!("/api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/self/files"), vec![])
            }
            UploadKind::MessageAttachment => (
                "/api/v1/users/self/files".to_string(),
                vec![("parent_folder_path".to_string(), "conversation attachments".to_string()), ("on_duplicate".to_string(), "rename".to_string())],
            ),
        };
        form.push(("name".into(), name.clone()));
        form.push(("size".into(), size.to_string()));
        form.push(("content_type".into(), content_type.clone()));
        let ticket: UploadTicket = self.send_form(Method::POST, &init_path, &form).await?;

        // Step 2
        let target = upload_target(&ticket.upload_url, self.allow_loopback_http)?;
        let mut multipart = Form::new();
        for (k, v) in &ticket.upload_params {
            let value = match v {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Null => continue,
                other => other.to_string(),
            };
            multipart = multipart.text(k.clone(), value);
        }
        let file = tokio::fs::File::open(path).await?;
        let mut sent = 0u64;
        let prog = progress.clone();
        let stream = tokio_util::io::ReaderStream::with_capacity(file, 64 * 1024).map(move |chunk| {
            if let Ok(c) = &chunk {
                sent += c.len() as u64;
                prog(sent, size);
            }
            chunk
        });
        let part = Part::stream_with_length(Body::wrap_stream(stream), size)
            .file_name(name.clone())
            .mime_str(&content_type)
            .map_err(|_| CoreError::Invalid("Unsupported file type.".into()))?;
        multipart = multipart.part(ticket.file_param.clone().unwrap_or_else(|| "file".into()), part);
        progress(0, size);
        let resp = self.upload_http.post(target.clone()).multipart(multipart).send().await?;

        // Step 3
        let status = resp.status();
        if status.is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| CoreError::Api { status: status.as_u16(), message: "Upload redirect had no location.".into() })?;
            let loc = target.join(loc).map_err(|_| CoreError::Api { status: 0, message: "Upload redirect was invalid.".into() })?;
            let resp = if same_origin(&loc, self.base()) {
                self.send(self.authed(Method::GET, loc)?).await?
            } else {
                check(self.upload_http.get(upload_target(loc.as_str(), self.allow_loopback_http)?).send().await?).await?
            };
            return parse_json(resp).await;
        }
        let resp = check(resp).await?;
        parse_json(resp).await
    }

    pub async fn submit_files(&self, course_id: u64, assignment_id: u64, file_ids: &[u64], comment: Option<&str>) -> Result<Submission> {
        let mut form = vec![("submission[submission_type]".to_string(), "online_upload".to_string())];
        form.extend(file_ids.iter().map(|id| ("submission[file_ids][]".to_string(), id.to_string())));
        push_comment(&mut form, comment);
        self.send_form(Method::POST, &format!("/api/v1/courses/{course_id}/assignments/{assignment_id}/submissions"), &form).await
    }

    pub async fn submit_text(&self, course_id: u64, assignment_id: u64, text: &str, comment: Option<&str>) -> Result<Submission> {
        let mut form = vec![
            ("submission[submission_type]".to_string(), "online_text_entry".to_string()),
            ("submission[body]".to_string(), text_to_html(text)),
        ];
        push_comment(&mut form, comment);
        self.send_form(Method::POST, &format!("/api/v1/courses/{course_id}/assignments/{assignment_id}/submissions"), &form).await
    }

    pub async fn submit_url(&self, course_id: u64, assignment_id: u64, url: &str, comment: Option<&str>) -> Result<Submission> {
        let mut form =
            vec![("submission[submission_type]".to_string(), "online_url".to_string()), ("submission[url]".to_string(), url.to_string())];
        push_comment(&mut form, comment);
        self.send_form(Method::POST, &format!("/api/v1/courses/{course_id}/assignments/{assignment_id}/submissions"), &form).await
    }
}

fn push_comment(form: &mut Vec<(String, String)>, comment: Option<&str>) {
    if let Some(c) = comment.map(str::trim).filter(|c| !c.is_empty()) {
        form.push(("comment[text_comment]".to_string(), c.to_string()));
    }
}

/// Plain text -> minimal HTML: escaped, blank-line paragraphs, line breaks.
pub fn text_to_html(text: &str) -> String {
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
    text.replace("\r\n", "\n")
        .split("\n\n")
        .map(str::trim_end)
        .filter(|p| !p.trim().is_empty())
        .map(|p| format!("<p>{}</p>", p.lines().map(esc).collect::<Vec<_>>().join("<br>")))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_html() {
        assert_eq!(text_to_html("a <b>\nc\n\nd & e"), "<p>a &lt;b&gt;<br>c</p><p>d &amp; e</p>");
        assert_eq!(text_to_html("\n\n"), "");
    }
}
