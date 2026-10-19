//! URL validation. The access token may only ever be sent to the Canvas origin
//! the user entered at setup; these helpers enforce that.

use crate::{CoreError, Result};
use url::Url;

/// Turns user input like `school.instructure.com` or
/// `https://school.instructure.com/courses/1` into the bare origin
/// `https://school.instructure.com/`.
///
/// `allow_loopback_http` exists only so tests can talk to a local mock server.
pub fn normalize_base_url(input: &str, allow_loopback_http: bool) -> Result<Url> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(CoreError::Invalid("Enter your Canvas address.".into()));
    }
    let with_scheme = if trimmed.contains("://") { trimmed.to_string() } else { format!("https://{trimmed}") };
    let mut url = Url::parse(&with_scheme)
        .map_err(|_| CoreError::Invalid("That doesn't look like a web address.".into()))?;

    let host = url.host_str().unwrap_or("").to_string();
    if host.is_empty() {
        return Err(CoreError::Invalid("The address needs a host name, like school.instructure.com.".into()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CoreError::Invalid("The address must not contain a user name or password.".into()));
    }
    match url.scheme() {
        "https" => {}
        "http" if allow_loopback_http && is_loopback(&url) => {}
        _ => return Err(CoreError::Invalid("The Canvas address must start with https://".into())),
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn is_loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("127.0.0.1") | Some("localhost") | Some("[::1]"))
}

/// Same scheme, host and effective port.
pub fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str().map(str::to_ascii_lowercase) == b.host_str().map(str::to_ascii_lowercase)
        && a.port_or_known_default() == b.port_or_known_default()
}

/// A link the user clicked that will be opened in their normal browser.
pub fn external_link(raw: &str) -> Result<Url> {
    let url = Url::parse(raw.trim()).map_err(|_| CoreError::Invalid("That link is not a valid web address.".into()))?;
    if !matches!(url.scheme(), "https" | "http" | "mailto") {
        return Err(CoreError::Invalid("Only web and email links can be opened.".into()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CoreError::Invalid("Links containing credentials are blocked.".into()));
    }
    Ok(url)
}

/// Upload targets returned by Canvas (often a separate storage host). Must be
/// https in production. The token is never sent to these.
pub fn upload_target(raw: &str, allow_loopback_http: bool) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| CoreError::Api { status: 0, message: "Canvas returned an invalid upload address.".into() })?;
    match url.scheme() {
        "https" => Ok(url),
        "http" if allow_loopback_http && is_loopback(&url) => Ok(url),
        _ => Err(CoreError::Api { status: 0, message: "Canvas returned an insecure upload address; upload refused.".into() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_bare_host() {
        let u = normalize_base_url("School.Instructure.com", false).unwrap();
        assert_eq!(u.as_str(), "https://school.instructure.com/");
    }

    #[test]
    fn strips_path_query_fragment() {
        let u = normalize_base_url("https://canvas.example.ca/courses/12?x=1#y", false).unwrap();
        assert_eq!(u.as_str(), "https://canvas.example.ca/");
    }

    #[test]
    fn rejects_http_and_credentials() {
        assert!(normalize_base_url("http://canvas.example.ca", false).is_err());
        assert!(normalize_base_url("http://127.0.0.1:9000", false).is_err());
        assert!(normalize_base_url("https://user:pw@canvas.example.ca", false).is_err());
        assert!(normalize_base_url("   ", false).is_err());
        assert!(normalize_base_url("ftp://canvas.example.ca", false).is_err());
    }

    #[test]
    fn loopback_http_only_when_allowed() {
        assert!(normalize_base_url("http://127.0.0.1:9000", true).is_ok());
        assert!(normalize_base_url("http://evil.example", true).is_err());
    }

    #[test]
    fn origin_comparison() {
        let a = Url::parse("https://a.example/x").unwrap();
        assert!(same_origin(&a, &Url::parse("https://A.example:443/y").unwrap()));
        assert!(!same_origin(&a, &Url::parse("https://a.example:444/").unwrap()));
        assert!(!same_origin(&a, &Url::parse("http://a.example/").unwrap()));
        assert!(!same_origin(&a, &Url::parse("https://a.example.evil.com/").unwrap()));
    }

    #[test]
    fn external_links() {
        assert!(external_link("https://example.com/a").is_ok());
        assert!(external_link("mailto:prof@example.com").is_ok());
        assert!(external_link("javascript:alert(1)").is_err());
        assert!(external_link("file:///C:/Windows/system32/calc.exe").is_err());
        assert!(external_link("https://u:p@example.com").is_err());
    }

    #[test]
    fn upload_targets() {
        assert!(upload_target("https://inscloudgate.net/x", false).is_ok());
        assert!(upload_target("http://inscloudgate.net/x", false).is_err());
    }
}
