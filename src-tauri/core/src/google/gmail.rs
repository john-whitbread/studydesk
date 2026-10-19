//! Gmail API client. The access token is sent only to gmail.googleapis.com
//! (and the refresh token only to oauth2.googleapis.com); redirects are
//! never followed.

use super::mime::{self, b64url_decode, MailAttachment, Part};
use super::oauth::{token_request, REVOKE_URL, TOKEN_URL};
use crate::url_guard::same_origin;
use crate::{CoreError, Result};
use futures_util::stream::{self, StreamExt};
use reqwest::{Client, Method, RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use url::Url;
use zeroize::Zeroizing;

pub struct Endpoints {
    pub token_url: String,
    pub revoke_url: String,
    pub api_base: Url,
    pub allow_loopback_http: bool,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints { token_url: TOKEN_URL.into(), revoke_url: REVOKE_URL.into(), api_base: Url::parse("https://gmail.googleapis.com/").unwrap(), allow_loopback_http: false }
    }
}

pub struct Gmail {
    http: Client,
    ep: Endpoints,
    client_id: String,
    client_secret: Zeroizing<String>,
    refresh_token: Zeroizing<String>,
    pub email: String,
    access: Mutex<Option<(Zeroizing<String>, Instant)>>,
    /// Thread summaries keyed by id, with the historyId they were built from.
    /// Gmail bumps historyId on any change (new message, read, star, label),
    /// so an unchanged id means the cached summary is still exact.
    cache: std::sync::Mutex<HashMap<String, (String, ThreadSummary)>>,
}

const CACHE_MAX: usize = 3000;
/// Parallel thread fetches. Each costs 10 quota units; Gmail allows about
/// 250 units per second per user, so 4 in flight stays well under it.
const PARALLEL: usize = 4;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub subject: String,
    /// Display names of senders in the thread, oldest first, de-duplicated.
    pub senders: Vec<String>,
    pub snippet: String,
    pub last_ms: i64,
    pub unread: bool,
    pub starred: bool,
    pub in_inbox: bool,
    pub message_count: usize,
    pub has_attachments: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPage {
    pub items: Vec<ThreadSummary>,
    pub next: Option<String>,
    pub estimate: u64,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MailMessage {
    pub id: String,
    pub from_name: String,
    pub from_email: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub reply_to: Option<String>,
    pub date_ms: i64,
    pub text: Option<String>,
    pub html: Option<String>,
    pub attachments: Vec<MailAttachment>,
    pub unread: bool,
    pub message_id_header: Option<String>,
    pub references: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDetail {
    pub id: String,
    pub subject: String,
    pub messages: Vec<MailMessage>,
    pub starred: bool,
    pub in_inbox: bool,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawMessage {
    id: String,
    label_ids: Vec<String>,
    internal_date: String,
    payload: Part,
}

#[derive(Deserialize, Default)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
struct RawThread {
    id: String,
    /// Present in threads.list items; used as the cache version.
    history_id: String,
    snippet: String,
    messages: Vec<RawMessage>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawThreadList {
    threads: Vec<RawThread>,
    next_page_token: Option<String>,
    result_size_estimate: u64,
}

#[derive(Deserialize, Default, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Profile {
    pub email_address: String,
}

const BUSY: &str = "Gmail is limiting how fast Studydesk can read mail. Wait a minute, then retry.";

/// Turns a failed Gmail response into a user-facing error.
pub fn classify(status: StatusCode, body: &str) -> CoreError {
    let v = serde_json::from_str::<serde_json::Value>(body).ok();
    let msg = v.as_ref().and_then(|v| v.pointer("/error/message")).and_then(|m| m.as_str()).unwrap_or("").to_string();
    let reasons: String = v
        .as_ref()
        .and_then(|v| v.pointer("/error/errors"))
        .and_then(|e| e.as_array())
        .map(|a| a.iter().filter_map(|e| e.get("reason").and_then(|r| r.as_str())).collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    let low = format!("{msg} {reasons}").to_lowercase();
    let limited = low.contains("rate") || low.contains("quota") || low.contains("too many");
    match status {
        StatusCode::UNAUTHORIZED => CoreError::Invalid("Google rejected the sign-in. Reconnect Gmail in Settings.".into()),
        StatusCode::TOO_MANY_REQUESTS => CoreError::Busy(BUSY.into()),
        StatusCode::FORBIDDEN if limited => CoreError::Busy(BUSY.into()),
        StatusCode::FORBIDDEN => CoreError::Refused(if msg.is_empty() {
            "Gmail refused access. Your school may block this app.".into()
        } else {
            format!("Gmail refused this: {msg}")
        }),
        StatusCode::NOT_FOUND => CoreError::NotFound,
        s => CoreError::Api { status: s.as_u16(), message: if msg.is_empty() { "Gmail error.".into() } else { format!("Gmail: {msg}") } },
    }
}

/// Gmail ids and page tokens are URL-safe tokens; anything else is refused
/// so a value can never change the request path.
pub fn check_id(s: &str) -> Result<&str> {
    if !s.is_empty() && s.len() <= 512 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(s)
    } else {
        Err(CoreError::Invalid("Bad Gmail id.".into()))
    }
}

pub fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest.find(';').filter(|e| *e <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let ent = &rest[1..end];
        let ch = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            e if e.starts_with("#x") || e.starts_with("#X") => u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32),
            e if e.starts_with('#') => e[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn message_of(m: &RawMessage) -> MailMessage {
    let p = &m.payload;
    let (from_name, from_email) = mime::split_address(p.header("From").unwrap_or(""));
    let ex = mime::extract(p);
    MailMessage {
        id: m.id.clone(),
        from_name,
        from_email,
        to: p.header("To").map(mime::split_list).unwrap_or_default(),
        cc: p.header("Cc").map(mime::split_list).unwrap_or_default(),
        reply_to: p.header("Reply-To").map(str::to_string),
        date_ms: m.internal_date.parse().unwrap_or(0),
        text: ex.text,
        html: ex.html,
        attachments: ex.attachments,
        unread: m.label_ids.iter().any(|l| l == "UNREAD"),
        message_id_header: p.header("Message-ID").or_else(|| p.header("Message-Id")).map(str::to_string),
        references: p.header("References").map(str::to_string),
    }
}

fn summary_of(t: &RawThread) -> ThreadSummary {
    let labels = |l: &str| t.messages.iter().any(|m| m.label_ids.iter().any(|x| x == l));
    let mut senders: Vec<String> = Vec::new();
    for m in &t.messages {
        let (name, _) = mime::split_address(m.payload.header("From").unwrap_or(""));
        if !name.is_empty() && !senders.contains(&name) {
            senders.push(name);
        }
    }
    ThreadSummary {
        id: t.id.clone(),
        subject: t.messages.first().and_then(|m| m.payload.header("Subject")).unwrap_or("").to_string(),
        senders,
        snippet: decode_entities(&t.snippet),
        last_ms: t.messages.iter().filter_map(|m| m.internal_date.parse::<i64>().ok()).max().unwrap_or(0),
        unread: labels("UNREAD"),
        starred: labels("STARRED"),
        in_inbox: labels("INBOX"),
        message_count: t.messages.len(),
        has_attachments: t.messages.iter().any(|m| m.payload.mime_type.eq_ignore_ascii_case("multipart/mixed")),
    }
}

impl Gmail {
    pub fn new(ep: Endpoints, client_id: &str, client_secret: &str, refresh_token: &str, email: &str) -> Result<Self> {
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .https_only(!ep.allow_loopback_http)
            .user_agent(concat!("Studydesk/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| CoreError::Network(e.to_string()))?;
        Ok(Gmail {
            http,
            ep,
            client_id: client_id.trim().to_string(),
            client_secret: Zeroizing::new(client_secret.trim().to_string()),
            refresh_token: Zeroizing::new(refresh_token.to_string()),
            email: email.to_string(),
            access: Mutex::new(None),
            cache: std::sync::Mutex::new(HashMap::new()),
        })
    }

    pub fn http(&self) -> &Client {
        &self.http
    }

    async fn token(&self, force: bool) -> Result<Zeroizing<String>> {
        let mut g = self.access.lock().await;
        if !force {
            if let Some((t, exp)) = g.as_ref() {
                if Instant::now() + Duration::from_secs(60) < *exp {
                    return Ok(t.clone());
                }
            }
        }
        let r = token_request(
            &self.http,
            &self.ep.token_url,
            &[("client_id", &self.client_id), ("client_secret", &self.client_secret), ("refresh_token", &self.refresh_token), ("grant_type", "refresh_token")],
        )
        .await?;
        let t = Zeroizing::new(r.access_token);
        *g = Some((t.clone(), Instant::now() + Duration::from_secs(r.expires_in.max(60))));
        Ok(t)
    }

    fn url(&self, path: &str) -> Result<Url> {
        let u = self.ep.api_base.join(path).map_err(|_| CoreError::Invalid("Bad Gmail path.".into()))?;
        if !same_origin(&u, &self.ep.api_base) {
            return Err(CoreError::Invalid("Refused to send the Google token to a different site.".into()));
        }
        Ok(u)
    }

    /// Sends a request built by `build`. Refreshes the token once on 401 and
    /// backs off (1s, 2s, 4s, or Google's Retry-After) when rate limited.
    async fn send(&self, build: impl Fn(&str) -> RequestBuilder) -> Result<reqwest::Response> {
        let mut refreshed = false;
        let mut waits = 0u32;
        loop {
            let tok = self.token(refreshed).await?;
            let resp = build(tok.as_str()).send().await?;
            let status = resp.status();
            if status == StatusCode::UNAUTHORIZED && !refreshed {
                refreshed = true;
                continue;
            }
            if status.is_success() {
                return Ok(resp);
            }
            let retry_after = resp
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok());
            let body = resp.text().await.unwrap_or_default();
            let err = classify(status, &body);
            if matches!(err, CoreError::Busy(_)) && waits < 3 {
                let secs = retry_after.unwrap_or(1u64 << waits).clamp(1, 20);
                waits += 1;
                tokio::time::sleep(Duration::from_secs(secs)).await;
                continue;
            }
            return Err(err);
        }
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str, query: &[(&str, String)]) -> Result<T> {
        let url = self.url(path)?;
        let resp = self.send(|t| self.http.request(Method::GET, url.clone()).bearer_auth(t).query(query)).await?;
        resp.json().await.map_err(|_| CoreError::Api { status: 0, message: "Gmail sent an unexpected response.".into() })
    }

    pub async fn profile(&self) -> Result<Profile> {
        self.get_json("gmail/v1/users/me/profile", &[]).await
    }

    /// `view`: inbox | unread | starred | sent | all. `query` uses Gmail search syntax.
    pub async fn threads(&self, view: &str, query: &str, page: Option<&str>) -> Result<ThreadPage> {
        let mut q: Vec<(&str, String)> = vec![("maxResults", "30".into())];
        match view {
            "inbox" => q.push(("labelIds", "INBOX".into())),
            "unread" => {
                q.push(("labelIds", "INBOX".into()));
                q.push(("labelIds", "UNREAD".into()));
            }
            "starred" => q.push(("labelIds", "STARRED".into())),
            "sent" => q.push(("labelIds", "SENT".into())),
            "all" => {}
            _ => return Err(CoreError::Invalid("Unknown Gmail folder.".into())),
        }
        let query = query.trim();
        if query.len() > 500 {
            return Err(CoreError::Invalid("Search is too long.".into()));
        }
        if !query.is_empty() {
            q.push(("q", query.to_string()));
        }
        if let Some(p) = page {
            q.push(("pageToken", check_id(p)?.to_string()));
        }
        let list: RawThreadList = self.get_json("gmail/v1/users/me/threads", &q).await?;
        let futures: Vec<_> = list
            .threads
            .iter()
            .map(|t| (t.id.clone(), t.history_id.clone(), t.snippet.clone()))
            .map(|(id, hist, snippet)| async move {
                let hit = self.cache.lock().unwrap().get(&id).filter(|(h, _)| !hist.is_empty() && *h == hist).map(|(_, s)| s.clone());
                if let Some(mut s) = hit {
                    s.snippet = decode_entities(&snippet);
                    return Ok(s);
                }
                let r: Result<RawThread> = self
                    .get_json(
                        &format!("gmail/v1/users/me/threads/{}", check_id(&id)?),
                        &[("format", "metadata".into()), ("metadataHeaders", "From".into()), ("metadataHeaders", "Subject".into())],
                    )
                    .await;
                r.map(|mut t| {
                    t.snippet = snippet;
                    let s = summary_of(&t);
                    // Keyed by the list's historyId: that's what the next list compares.
                    if !hist.is_empty() {
                        let mut c = self.cache.lock().unwrap();
                        if c.len() >= CACHE_MAX {
                            c.clear();
                        }
                        c.insert(s.id.clone(), (hist, s.clone()));
                    }
                    s
                })
            })
            .collect();
        let results: Vec<Result<ThreadSummary>> = stream::iter(futures).buffered(PARALLEL).collect().await;
        let mut items = Vec::with_capacity(results.len());
        for r in results {
            match r {
                Ok(s) => items.push(s),
                Err(CoreError::NotFound) => {} // deleted between list and fetch
                Err(e) => return Err(e),
            }
        }
        Ok(ThreadPage { items, next: list.next_page_token, estimate: list.result_size_estimate })
    }

    /// Unread conversations in the inbox: one cheap request instead of
    /// listing and fetching every unread thread.
    pub async fn inbox_unread(&self) -> Result<u64> {
        #[derive(Deserialize, Default)]
        #[serde(default, rename_all = "camelCase")]
        struct Label {
            threads_unread: u64,
        }
        let l: Label = self.get_json("gmail/v1/users/me/labels/INBOX", &[]).await?;
        Ok(l.threads_unread)
    }

    pub async fn thread(&self, id: &str) -> Result<ThreadDetail> {
        let t: RawThread = self.get_json(&format!("gmail/v1/users/me/threads/{}", check_id(id)?), &[("format", "full".into())]).await?;
        let s = summary_of(&t);
        Ok(ThreadDetail { id: t.id.clone(), subject: s.subject, messages: t.messages.iter().map(message_of).collect(), starred: s.starred, in_inbox: s.in_inbox })
    }

    pub async fn modify(&self, id: &str, add: &[&str], remove: &[&str]) -> Result<()> {
        let allowed = ["UNREAD", "INBOX", "STARRED"];
        if add.iter().chain(remove).any(|l| !allowed.contains(l)) {
            return Err(CoreError::Invalid("Unsupported label change.".into()));
        }
        let url = self.url(&format!("gmail/v1/users/me/threads/{}/modify", check_id(id)?))?;
        let body = serde_json::json!({ "addLabelIds": add, "removeLabelIds": remove });
        self.send(|t| self.http.post(url.clone()).bearer_auth(t).json(&body)).await?;
        Ok(())
    }

    /// Sends a raw RFC 5322 message via the media upload endpoint (35 MB limit).
    pub async fn send_raw(&self, raw: Vec<u8>, thread_id: Option<&str>) -> Result<String> {
        if raw.len() > 35 * 1024 * 1024 {
            return Err(CoreError::Invalid("That message is larger than Gmail's 35 MB limit (attachments are counted about 1.4×).".into()));
        }
        let meta = match thread_id {
            Some(t) => serde_json::json!({ "threadId": check_id(t)? }),
            None => serde_json::json!({}),
        };
        let boundary = "studydesk_related_boundary_7f3a";
        let mut body = Vec::with_capacity(raw.len() + 256);
        body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: message/rfc822\r\n\r\n").as_bytes());
        body.extend_from_slice(&raw);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let mut url = self.url("upload/gmail/v1/users/me/messages/send")?;
        url.query_pairs_mut().append_pair("uploadType", "multipart");
        let resp = self
            .send(|t| {
                self.http
                    .post(url.clone())
                    .bearer_auth(t)
                    .header(reqwest::header::CONTENT_TYPE, format!("multipart/related; boundary={boundary}"))
                    .body(body.clone())
            })
            .await?;
        let v: serde_json::Value = resp.json().await.map_err(|_| CoreError::Api { status: 0, message: "Gmail sent an unexpected response.".into() })?;
        Ok(v.get("id").and_then(|x| x.as_str()).unwrap_or_default().to_string())
    }

    pub async fn attachment(&self, message_id: &str, attachment_id: &str) -> Result<Vec<u8>> {
        let v: serde_json::Value =
            self.get_json(&format!("gmail/v1/users/me/messages/{}/attachments/{}", check_id(message_id)?, check_id(attachment_id)?), &[]).await?;
        v.get("data").and_then(|d| d.as_str()).and_then(b64url_decode).ok_or_else(|| CoreError::Api { status: 0, message: "The attachment couldn't be decoded.".into() })
    }

    /// Revokes the refresh token at Google (best effort).
    pub async fn revoke(&self) {
        let _ = self.http.post(&self.ep.revoke_url).form(&[("token", self.refresh_token.as_str())]).send().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entities() {
        assert_eq!(decode_entities("It&#39;s &lt;due&gt; &amp; done &#x2014; ok &bogus; &"), "It's <due> & done — ok &bogus; &");
    }

    #[test]
    fn ids() {
        assert!(check_id("18c2f0a1b2c3d4e5").is_ok());
        assert!(check_id("ANGjdJ_x-9").is_ok());
        assert!(check_id("../profile").is_err());
        assert!(check_id("a/b").is_err());
        assert!(check_id("").is_err());
    }
}
