//! Canvas LMS REST client.
//!
//! Token rules, enforced in one place (`authed`):
//! * the token is attached only to requests whose origin equals the Canvas
//!   origin entered at setup;
//! * redirects are never followed automatically (so the token can't be
//!   carried to another host by a redirect);
//! * pagination links are followed only if they point back to the same
//!   origin and the `/api/v1/` path.

pub mod api;
pub mod models;
pub mod upload;

use crate::url_guard::{normalize_base_url, same_origin};
use crate::{CoreError, Result};
use reqwest::header::{HeaderMap, ACCEPT, LINK, WWW_AUTHENTICATE};
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::time::Duration;
use url::Url;
use zeroize::Zeroizing;

const MAX_PAGES: usize = 60;

pub struct Canvas {
    http: Client,
    upload_http: Client,
    base: Url,
    token: Zeroizing<String>,
    allow_loopback_http: bool,
}

/// One page of a list plus an opaque cursor for the next page.
#[derive(Serialize, Debug)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next: Option<String>,
}

impl Canvas {
    pub fn new(base_input: &str, token: &str, allow_loopback_http: bool) -> Result<Self> {
        let base = normalize_base_url(base_input, allow_loopback_http)?;
        let token = token.trim();
        if token.is_empty() || token.len() > 512 || token.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(CoreError::Invalid("That access token doesn't look right. Copy it again from Canvas.".into()));
        }
        let ua = concat!("Studydesk/", env!("CARGO_PKG_VERSION"));
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(60))
            .user_agent(ua)
            .https_only(!allow_loopback_http)
            .build()
            .map_err(|e| CoreError::Network(e.to_string()))?;
        let upload_http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(20))
            .user_agent(ua)
            .https_only(!allow_loopback_http)
            .build()
            .map_err(|e| CoreError::Network(e.to_string()))?;
        Ok(Canvas { http, upload_http, base, token: Zeroizing::new(token.to_string()), allow_loopback_http })
    }

    pub fn base(&self) -> &Url {
        &self.base
    }

    pub fn base_str(&self) -> String {
        self.base.as_str().to_string()
    }

    fn api_url(&self, path: &str) -> Result<Url> {
        if !path.starts_with("/api/v1/") {
            return Err(CoreError::Invalid("Internal error: bad API path.".into()));
        }
        self.base.join(path).map_err(|_| CoreError::Invalid("Internal error: bad API path.".into()))
    }

    /// The only place the token is attached.
    fn authed(&self, method: Method, url: Url) -> Result<RequestBuilder> {
        if !same_origin(&url, &self.base) {
            return Err(CoreError::Invalid("Refused to send the access token to a different site.".into()));
        }
        Ok(self.http.request(method, url).bearer_auth(self.token.as_str()).header(ACCEPT, "application/json"))
    }

    /// Sends with up to two retries on rate limiting.
    async fn send(&self, rb: RequestBuilder) -> Result<Response> {
        let mut delay = Duration::from_millis(1000);
        let mut attempt = 0;
        loop {
            let this = rb.try_clone().ok_or_else(|| CoreError::Invalid("Internal error: request not retryable.".into()))?;
            let resp = this.send().await?;
            match check(resp).await {
                Err(CoreError::RateLimited) if attempt < 2 => {
                    attempt += 1;
                    tokio::time::sleep(delay).await;
                    delay *= 3;
                }
                other => return other,
            }
        }
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str, query: &[(&str, String)]) -> Result<T> {
        let rb = self.authed(Method::GET, self.api_url(path)?)?.query(query);
        let resp = self.send(rb).await?;
        parse_json(resp).await
    }

    /// Follows `rel="next"` links and concatenates every page.
    pub async fn get_all<T: DeserializeOwned>(&self, path: &str, query: &[(&str, String)]) -> Result<Vec<T>> {
        let mut out = Vec::new();
        let mut rb = self.authed(Method::GET, self.api_url(path)?)?.query(query);
        for _ in 0..MAX_PAGES {
            let resp = self.send(rb).await?;
            let next = self.validated_next(resp.headers());
            let mut items: Vec<T> = parse_json(resp).await?;
            out.append(&mut items);
            match next {
                Some(url) => rb = self.authed(Method::GET, url)?,
                None => return Ok(out),
            }
        }
        Ok(out)
    }

    /// One page. `cursor` is either None (first page from `path`) or a value
    /// previously returned in `Page::next`, which is re-validated here.
    pub async fn get_page<T: DeserializeOwned>(&self, path: &str, query: &[(&str, String)], cursor: Option<&str>) -> Result<Page<T>> {
        let rb = match cursor {
            Some(c) => {
                let url = Url::parse(c).map_err(|_| CoreError::Invalid("Bad page cursor.".into()))?;
                if !self.is_api_url(&url) || !url.path().starts_with(path) {
                    return Err(CoreError::Invalid("Bad page cursor.".into()));
                }
                self.authed(Method::GET, url)?
            }
            None => self.authed(Method::GET, self.api_url(path)?)?.query(query),
        };
        let resp = self.send(rb).await?;
        let next = self.validated_next(resp.headers()).map(|u| u.to_string());
        Ok(Page { items: parse_json(resp).await?, next })
    }

    pub async fn send_form<T: DeserializeOwned>(&self, method: Method, path: &str, form: &[(String, String)]) -> Result<T> {
        let rb = self.authed(method, self.api_url(path)?)?.form(form);
        let resp = self.send(rb).await?;
        parse_json(resp).await
    }

    /// Downloads a Canvas file into memory (max `max_bytes`). The token is
    /// sent only to the Canvas origin; Canvas then redirects to its storage
    /// host, which is fetched without the token. Never written to disk.
    pub async fn download(&self, url: &str, max_bytes: u64) -> Result<Vec<u8>> {
        let mut url = Url::parse(url).map_err(|_| CoreError::Invalid("Bad file link.".into()))?;
        if !same_origin(&url, &self.base) {
            return Err(CoreError::Invalid("That file isn't on your Canvas site.".into()));
        }
        let mut resp = self.http.get(url.clone()).bearer_auth(self.token.as_str()).send().await?;
        for _ in 0..4 {
            if !resp.status().is_redirection() {
                break;
            }
            let loc = resp.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).ok_or_else(|| CoreError::Api { status: 0, message: "Download redirect had no location.".into() })?;
            url = url.join(loc).map_err(|_| CoreError::Api { status: 0, message: "Bad download redirect.".into() })?;
            resp = if same_origin(&url, &self.base) {
                self.http.get(url.clone()).bearer_auth(self.token.as_str()).send().await?
            } else {
                self.upload_http.get(crate::url_guard::upload_target(url.as_str(), self.allow_loopback_http)?).send().await?
            };
        }
        let mut resp = check(resp).await?;
        if resp.content_length().is_some_and(|n| n > max_bytes) {
            return Err(CoreError::Invalid("File is too large to scan.".into()));
        }
        let mut out = Vec::new();
        while let Some(chunk) = resp.chunk().await? {
            out.extend_from_slice(&chunk);
            if out.len() as u64 > max_bytes {
                return Err(CoreError::Invalid("File is too large to scan.".into()));
            }
        }
        Ok(out)
    }

    fn is_api_url(&self, url: &Url) -> bool {
        same_origin(url, &self.base) && url.path().starts_with("/api/v1/")
    }

    fn validated_next(&self, headers: &HeaderMap) -> Option<Url> {
        let raw = next_link(headers)?;
        let url = Url::parse(&raw).ok()?;
        self.is_api_url(&url).then_some(url)
    }
}

/// Extracts the `rel="next"` URL from one or more Link headers.
pub fn next_link(headers: &HeaderMap) -> Option<String> {
    for value in headers.get_all(LINK) {
        let Ok(s) = value.to_str() else { continue };
        let mut rest = s;
        while let Some(start) = rest.find('<') {
            let after = &rest[start + 1..];
            let Some(end) = after.find('>') else { break };
            let url = &after[..end];
            let tail = &after[end + 1..];
            let params_end = tail.find('<').unwrap_or(tail.len());
            let params = &tail[..params_end];
            let is_next = params.split(';').any(|p| {
                let p = p.trim().trim_end_matches(',').trim();
                p.eq_ignore_ascii_case("rel=\"next\"") || p.eq_ignore_ascii_case("rel=next")
            });
            if is_next {
                return Some(url.to_string());
            }
            rest = &tail[params_end..];
        }
    }
    None
}

pub(crate) async fn check(resp: Response) -> Result<Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let has_www_auth = resp.headers().contains_key(WWW_AUTHENTICATE);
    let body = resp.text().await.unwrap_or_default();
    let msg = error_message(&body);
    Err(match status {
        StatusCode::UNAUTHORIZED if has_www_auth => CoreError::Unauthorized,
        StatusCode::UNAUTHORIZED => CoreError::Forbidden(msg.unwrap_or_else(|| "you are not authorized to do that.".into())),
        StatusCode::FORBIDDEN if body.contains("Rate Limit Exceeded") => CoreError::RateLimited,
        StatusCode::FORBIDDEN => CoreError::Forbidden(msg.unwrap_or_else(|| "access denied.".into())),
        StatusCode::TOO_MANY_REQUESTS => CoreError::RateLimited,
        StatusCode::NOT_FOUND => CoreError::NotFound,
        s if s.is_redirection() => CoreError::Api { status: s.as_u16(), message: "Canvas tried to redirect the request; it was not followed.".into() },
        s => CoreError::Api { status: s.as_u16(), message: msg.unwrap_or_else(|| s.canonical_reason().unwrap_or("error").to_string()) },
    })
}

/// Pulls a human-readable message out of Canvas's several error shapes.
fn error_message(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(strip_guard(body)).ok()?;
    let pick = |v: &serde_json::Value| v.get("message").and_then(|m| m.as_str()).map(str::to_string);
    if let Some(errs) = v.get("errors") {
        if let Some(arr) = errs.as_array() {
            if let Some(m) = arr.iter().find_map(pick) {
                return Some(m);
            }
        }
        if let Some(obj) = errs.as_object() {
            for (field, val) in obj {
                if let Some(m) = val.as_array().and_then(|a| a.iter().find_map(pick)) {
                    return Some(format!("{field}: {m}"));
                }
                if let Some(m) = val.as_str() {
                    return Some(m.to_string());
                }
            }
        }
    }
    pick(&v).or_else(|| v.get("error").and_then(|m| m.as_str()).map(str::to_string))
}

/// Canvas may prefix JSON with `while(1);` as an anti-hijacking guard.
fn strip_guard(s: &str) -> &str {
    s.trim_start().strip_prefix("while(1);").unwrap_or(s)
}

pub(crate) async fn parse_json<T: DeserializeOwned>(resp: Response) -> Result<T> {
    let bytes = resp.bytes().await?;
    let text = std::str::from_utf8(&bytes).map_err(|_| CoreError::Api { status: 0, message: "Canvas sent invalid text.".into() })?;
    serde_json::from_str(strip_guard(text))
        .map_err(|e| CoreError::Api { status: 0, message: format!("Canvas sent data in an unexpected format ({e}).") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    #[test]
    fn parses_link_header() {
        let mut h = HeaderMap::new();
        h.insert(
            LINK,
            HeaderValue::from_static(
                "<https://s.example/api/v1/courses?page=1&per_page=10>; rel=\"current\",<https://s.example/api/v1/courses?page=2&per_page=10>; rel=\"next\",<https://s.example/api/v1/courses?page=5>; rel=\"last\"",
            ),
        );
        assert_eq!(next_link(&h).as_deref(), Some("https://s.example/api/v1/courses?page=2&per_page=10"));
    }

    #[test]
    fn no_next_on_last_page() {
        let mut h = HeaderMap::new();
        h.insert(LINK, HeaderValue::from_static("<https://s.example/api/v1/x?page=1>; rel=\"first\", <https://s.example/api/v1/x?page=3>; rel=\"last\""));
        assert_eq!(next_link(&h), None);
    }

    #[test]
    fn error_shapes() {
        assert_eq!(error_message(r#"{"errors":[{"message":"bad thing"}]}"#).as_deref(), Some("bad thing"));
        assert_eq!(error_message(r#"{"errors":{"recipients":[{"message":"invalid"}]}}"#).as_deref(), Some("recipients: invalid"));
        assert_eq!(error_message(r#"{"message":"nope"}"#).as_deref(), Some("nope"));
        assert_eq!(error_message("while(1);{\"message\":\"g\"}").as_deref(), Some("g"));
        assert_eq!(error_message("<html>"), None);
    }

    #[test]
    fn rejects_bad_tokens() {
        assert!(Canvas::new("school.instructure.com", "", false).is_err());
        assert!(Canvas::new("school.instructure.com", "abc def", false).is_err());
        assert!(Canvas::new("school.instructure.com", "7~abc", false).is_ok());
    }
}
