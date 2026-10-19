//! Google sign-in for installed apps (RFC 8252): the system browser opens
//! Google's own sign-in page, Google redirects to a one-shot listener on
//! 127.0.0.1, and the code is exchanged with PKCE. Studydesk never sees the
//! Google password.

use crate::{CoreError, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;
use zeroize::Zeroizing;

pub const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
/// Read, label, archive and send. Cannot permanently delete mail.
pub const SCOPE: &str = "https://www.googleapis.com/auth/gmail.modify";

pub struct Pkce {
    pub verifier: Zeroizing<String>,
    pub challenge: String,
    pub state: String,
}

fn random_b64(n: usize) -> Result<String> {
    let mut b = vec![0u8; n];
    getrandom::getrandom(&mut b).map_err(|_| CoreError::Io("The system random number generator failed.".into()))?;
    Ok(URL_SAFE_NO_PAD.encode(b))
}

impl Pkce {
    pub fn new() -> Result<Self> {
        let verifier = Zeroizing::new(random_b64(48)?); // 64 chars
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Ok(Pkce { verifier, challenge, state: random_b64(24)? })
    }
}

pub fn check_client(client_id: &str, client_secret: &str) -> Result<()> {
    let id = client_id.trim();
    if !id.ends_with(".apps.googleusercontent.com") || id.len() > 200 || id.contains(char::is_whitespace) {
        return Err(CoreError::Invalid("The client ID should end in .apps.googleusercontent.com. Copy it again from Google Cloud.".into()));
    }
    let s = client_secret.trim();
    if s.is_empty() || s.len() > 200 || s.contains(char::is_whitespace) {
        return Err(CoreError::Invalid("Paste the client secret from the same Google Cloud client.".into()));
    }
    Ok(())
}

pub fn auth_url(client_id: &str, redirect: &str, p: &Pkce, login_hint: Option<&str>) -> String {
    let mut u = Url::parse(AUTH_URL).unwrap();
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("client_id", client_id.trim())
            .append_pair("redirect_uri", redirect)
            .append_pair("response_type", "code")
            .append_pair("scope", SCOPE)
            .append_pair("code_challenge", &p.challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &p.state)
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent");
        if let Some(h) = login_hint.filter(|h| !h.is_empty()) {
            q.append_pair("login_hint", h);
        }
    }
    u.to_string()
}

/// Binds the loopback listener on a random free port.
pub async fn bind() -> Result<(TcpListener, String)> {
    let l = TcpListener::bind("127.0.0.1:0").await?;
    let port = l.local_addr()?.port();
    Ok((l, format!("http://127.0.0.1:{port}")))
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Studydesk</title><body style=\"font:16px system-ui;margin:4em;color:#222\"><h2>Signed in</h2><p>You can close this tab and go back to Studydesk.</p>";
const FAIL_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Studydesk</title><body style=\"font:16px system-ui;margin:4em;color:#222\"><h2>Sign-in didn't finish</h2><p>Go back to Studydesk for details.</p>";

/// Waits for Google's redirect and returns the authorization code.
/// Requests with the wrong `state` are rejected (CSRF protection).
pub async fn wait_for_code(listener: TcpListener, expected_state: &str, timeout: Duration) -> Result<Zeroizing<String>> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let (mut sock, _) = match tokio::time::timeout_at(deadline, listener.accept()).await {
            Ok(r) => r?,
            Err(_) => return Err(CoreError::Invalid("Google sign-in timed out. If Google said \"Access blocked\", your school doesn't allow this app.".into())),
        };
        let mut buf = vec![0u8; 8192];
        let mut n = 0;
        while n < buf.len() {
            let read = match tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf[n..])).await {
                Ok(Ok(r)) => r,
                _ => 0,
            };
            if read == 0 {
                break;
            }
            n += read;
            if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        let req = String::from_utf8_lossy(&buf[..n]).to_string();
        let target = req.lines().next().and_then(|l| l.strip_prefix("GET ")).and_then(|l| l.split(' ').next()).unwrap_or("");
        let reply = |status: &str, body: &str| {
            format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}", body.len())
        };
        let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
            let _ = sock.write_all(reply("400 Bad Request", FAIL_PAGE).as_bytes()).await;
            continue;
        };
        if url.path() != "/" {
            let _ = sock.write_all(reply("404 Not Found", "").as_bytes()).await;
            continue;
        }
        let get = |k: &str| url.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.to_string());
        if get("state").as_deref() != Some(expected_state) {
            let _ = sock.write_all(reply("400 Bad Request", FAIL_PAGE).as_bytes()).await;
            continue; // not our redirect; keep waiting for the real one
        }
        if let Some(err) = get("error") {
            let _ = sock.write_all(reply("200 OK", FAIL_PAGE).as_bytes()).await;
            return Err(CoreError::Invalid(match err.as_str() {
                "access_denied" => "Google sign-in was cancelled or not allowed.".into(),
                other => format!("Google sign-in failed ({other})."),
            }));
        }
        if let Some(code) = get("code") {
            let _ = sock.write_all(reply("200 OK", DONE_PAGE).as_bytes()).await;
            return Ok(Zeroizing::new(code));
        }
        let _ = sock.write_all(reply("400 Bad Request", FAIL_PAGE).as_bytes()).await;
    }
}

#[derive(Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub expires_in: u64,
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub scope: String,
}

#[derive(Deserialize)]
struct TokenError {
    error: String,
    #[serde(default)]
    error_description: String,
}

pub async fn token_request(http: &reqwest::Client, token_url: &str, form: &[(&str, &str)]) -> Result<TokenResponse> {
    let resp = http.post(token_url).form(form).send().await?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if status.is_success() {
        return serde_json::from_str(&body).map_err(|_| CoreError::Api { status: 0, message: "Google sent an unexpected sign-in response.".into() });
    }
    let e: Option<TokenError> = serde_json::from_str(&body).ok();
    Err(match e {
        Some(e) if e.error == "invalid_grant" => CoreError::Invalid(
            "Your Google sign-in has expired or was revoked. Reconnect Gmail in Settings. (Apps in Google's Testing mode must sign in again every 7 days.)".into(),
        ),
        Some(e) if e.error == "invalid_client" => CoreError::Invalid("Google rejected the client ID or secret. Check them in Google Cloud.".into()),
        Some(e) => CoreError::Invalid(format!("Google sign-in error: {} {}", e.error, e.error_description).trim().to_string()),
        None => CoreError::Api { status: status.as_u16(), message: "Google sign-in failed.".into() },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_shape() {
        let p = Pkce::new().unwrap();
        assert_eq!(p.verifier.len(), 64);
        assert_eq!(p.challenge.len(), 43);
        assert_eq!(p.challenge, URL_SAFE_NO_PAD.encode(Sha256::digest(p.verifier.as_bytes())));
        assert_ne!(Pkce::new().unwrap().state, p.state);
    }

    #[test]
    fn auth_url_contents() {
        let p = Pkce::new().unwrap();
        let u = Url::parse(&auth_url("x.apps.googleusercontent.com", "http://127.0.0.1:5000", &p, Some("me@school.net"))).unwrap();
        let get = |k: &str| u.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.to_string()).unwrap();
        assert_eq!(u.host_str(), Some("accounts.google.com"));
        assert_eq!(get("scope"), SCOPE);
        assert_eq!(get("code_challenge_method"), "S256");
        assert_eq!(get("redirect_uri"), "http://127.0.0.1:5000");
        assert_eq!(get("login_hint"), "me@school.net");
    }

    #[test]
    fn client_checks() {
        assert!(check_client("123-abc.apps.googleusercontent.com", "GOCSPX-x").is_ok());
        assert!(check_client("123-abc", "x").is_err());
        assert!(check_client("123-abc.apps.googleusercontent.com", "").is_err());
    }

    async fn hit(url: String) -> String {
        let u = Url::parse(&url).unwrap();
        let mut s = tokio::net::TcpStream::connect((u.host_str().unwrap(), u.port().unwrap())).await.unwrap();
        let path = format!("{}{}", u.path(), u.query().map(|q| format!("?{q}")).unwrap_or_default());
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    #[tokio::test]
    async fn loopback_ignores_wrong_state_then_accepts_right_one() {
        let (l, base) = bind().await.unwrap();
        let waiter = tokio::spawn(async move { wait_for_code(l, "good", Duration::from_secs(5)).await });
        assert!(hit(format!("{base}/favicon.ico")).await.starts_with("HTTP/1.1 404"));
        assert!(hit(format!("{base}/?state=evil&code=stolen")).await.starts_with("HTTP/1.1 400"));
        assert!(hit(format!("{base}/?state=good&code=4%2Fabc")).await.contains("Signed in"));
        assert_eq!(waiter.await.unwrap().unwrap().as_str(), "4/abc");
    }

    #[tokio::test]
    async fn loopback_reports_denial_and_timeout() {
        let (l, base) = bind().await.unwrap();
        let waiter = tokio::spawn(async move { wait_for_code(l, "s", Duration::from_secs(5)).await });
        hit(format!("{base}/?state=s&error=access_denied")).await;
        assert!(waiter.await.unwrap().unwrap_err().to_string().contains("cancelled"));
        let (l, _) = bind().await.unwrap();
        assert!(wait_for_code(l, "s", Duration::from_millis(50)).await.unwrap_err().to_string().contains("timed out"));
    }
}
