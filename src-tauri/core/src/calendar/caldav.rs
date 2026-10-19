//! iCloud Calendar over CalDAV (RFC 4791), signed in with an Apple ID and an
//! app-specific password.
//!
//! Safety rules:
//! - The password is sent (HTTP Basic, over HTTPS) only to hosts ending in
//!   `.icloud.com`. Redirects are followed by hand, at most 3, and only to
//!   such hosts; any other target is refused.
//! - Studydesk writes only inside the "Studydesk" calendar it created; it never
//!   changes or deletes anything in your other calendars.

use crate::{CoreError, Result};
use reqwest::{header, Client, Method, StatusCode};
use std::time::Duration;
use url::Url;
use zeroize::Zeroizing;

pub const ICLOUD: &str = "https://caldav.icloud.com/";
const MAX_BODY: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalInfo {
    /// Absolute URL of the calendar collection.
    pub href: String,
    pub name: String,
    /// `#rrggbb` or empty.
    pub color: String,
    pub writable: bool,
}

#[derive(Debug, Clone)]
pub struct Resource {
    /// Absolute URL.
    pub href: String,
    pub etag: String,
    /// Raw iCalendar text (empty when only etags were asked for).
    pub data: String,
}

/// How a PUT may treat an existing event.
#[derive(Debug, Clone, Copy)]
pub enum PutCond<'a> {
    /// Only if nothing is there yet.
    Create,
    /// Only if it's still the version we wrote (etag).
    Replace(&'a str),
    /// Whatever is there (only used inside the Studydesk calendar).
    Overwrite,
}

pub struct CalDav {
    http: Client,
    user: String,
    password: Zeroizing<String>,
    base: Url,
    /// Tests only: allows http://127.0.0.1 servers.
    loopback: bool,
}

fn webdav_err(status: StatusCode, what: &str) -> CoreError {
    match status {
        StatusCode::UNAUTHORIZED => CoreError::Invalid(
            "Apple didn't accept the Apple ID or app-specific password. Make a new app-specific password at appleid.apple.com and connect again.".into(),
        ),
        StatusCode::FORBIDDEN => CoreError::Refused(format!("iCloud refused to {what}.")),
        StatusCode::NOT_FOUND => CoreError::NotFound,
        StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE => CoreError::Busy("iCloud is busy. Try again in a minute.".into()),
        StatusCode::PRECONDITION_FAILED => CoreError::Invalid("The event changed in iCloud at the same time. It will be updated on the next sync.".into()),
        s => CoreError::Api { status: s.as_u16(), message: format!("iCloud couldn't {what}.") },
    }
}

impl CalDav {
    pub fn icloud(user: &str, password: &str) -> Result<Self> {
        Self::with_base(Url::parse(ICLOUD).unwrap(), user, password, false)
    }

    pub fn with_base(base: Url, user: &str, password: &str, loopback: bool) -> Result<Self> {
        let user = user.trim();
        let password: String = password.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
        if !user.contains('@') || user.len() > 254 {
            return Err(CoreError::Invalid("Enter the email address of your Apple ID.".into()));
        }
        // App-specific passwords are 16 letters (shown as xxxx-xxxx-xxxx-xxxx).
        if password.len() != 16 || !password.chars().all(|c| c.is_ascii_lowercase()) {
            return Err(CoreError::Invalid(
                "That doesn't look like an app-specific password. It's 16 letters, shown as xxxx-xxxx-xxxx-xxxx, from appleid.apple.com → Sign-In and Security.".into(),
            ));
        }
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(60))
            .https_only(!loopback)
            .user_agent(concat!("Studydesk/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| CoreError::Network(e.to_string()))?;
        Ok(CalDav { http, user: user.to_string(), password: Zeroizing::new(password), base, loopback })
    }

    fn allowed(&self, u: &Url) -> bool {
        if self.loopback {
            return u.host_str() == self.base.host_str() && u.port_or_known_default() == self.base.port_or_known_default();
        }
        u.scheme() == "https"
            && u.port_or_known_default() == Some(443)
            && u.host_str().is_some_and(|h| {
                let h = h.to_ascii_lowercase();
                h == "icloud.com" || h.ends_with(".icloud.com")
            })
            && u.username().is_empty()
            && u.password().is_none()
    }

    pub fn resolve(&self, base: &Url, href: &str) -> Result<Url> {
        let u = base.join(href.trim()).map_err(|_| CoreError::Api { status: 0, message: "iCloud sent an unreadable address.".into() })?;
        if !self.allowed(&u) {
            return Err(CoreError::Refused("iCloud pointed Studydesk at a server outside icloud.com, so it stopped.".into()));
        }
        Ok(u)
    }

    async fn send(&self, method: Method, url: &Url, depth: Option<&str>, headers: &[(&str, String)], body: Option<String>, what: &str) -> Result<(Url, reqwest::Response)> {
        let mut url = url.clone();
        for _ in 0..4 {
            if !self.allowed(&url) {
                return Err(CoreError::Refused("Studydesk only sends your Apple password to icloud.com.".into()));
            }
            let mut rb = self.http.request(method.clone(), url.clone()).basic_auth(&self.user, Some(self.password.as_str()));
            if let Some(d) = depth {
                rb = rb.header("Depth", d);
            }
            for (k, v) in headers {
                rb = rb.header(*k, v);
            }
            if let Some(b) = &body {
                rb = rb.header(header::CONTENT_TYPE, if method == Method::PUT { "text/calendar; charset=utf-8" } else { "application/xml; charset=utf-8" }).body(b.clone());
            }
            let resp = rb.send().await?;
            let st = resp.status();
            if st.is_redirection() {
                let loc = resp.headers().get(header::LOCATION).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                url = self.resolve(&url, &loc)?;
                continue;
            }
            if st.is_success() || st == StatusCode::MULTI_STATUS {
                return Ok((url, resp));
            }
            return Err(webdav_err(st, what));
        }
        Err(CoreError::Api { status: 0, message: "iCloud redirected too many times.".into() })
    }

    async fn text(resp: reqwest::Response) -> Result<String> {
        if resp.content_length().is_some_and(|n| n as usize > MAX_BODY) {
            return Err(CoreError::Api { status: 0, message: "iCloud sent more data than expected.".into() });
        }
        let b = resp.bytes().await?;
        if b.len() > MAX_BODY {
            return Err(CoreError::Api { status: 0, message: "iCloud sent more data than expected.".into() });
        }
        Ok(String::from_utf8_lossy(&b).into_owned())
    }

    async fn propfind(&self, url: &Url, depth: &str, props: &str, what: &str) -> Result<(Url, Vec<MsResponse>)> {
        let body = format!(
            r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop>{props}</d:prop></d:propfind>"#
        );
        let (at, resp) = self.send(Method::from_bytes(b"PROPFIND").unwrap(), url, Some(depth), &[], Some(body), what).await?;
        let xml = Self::text(resp).await?;
        Ok((at, multistatus(&xml)?))
    }

    /// Finds the calendar home (e.g. https://p52-caldav.icloud.com/123/calendars/).
    pub async fn discover(&self) -> Result<Url> {
        let (at, r) = self.propfind(&self.base, "0", "<d:current-user-principal/>", "sign in").await?;
        let principal = r.iter().find_map(|x| x.prop_href("current-user-principal")).ok_or_else(|| CoreError::Api { status: 0, message: "iCloud didn't say where your calendars are.".into() })?;
        let principal = self.resolve(&at, &principal)?;
        let (at, r) = self.propfind(&principal, "0", "<c:calendar-home-set/>", "find your calendars").await?;
        let home = r.iter().find_map(|x| x.prop_href("calendar-home-set")).ok_or_else(|| CoreError::Api { status: 0, message: "iCloud didn't list a calendar home.".into() })?;
        let mut home = self.resolve(&at, &home)?;
        if !home.path().ends_with('/') {
            home.set_path(&format!("{}/", home.path()));
        }
        Ok(home)
    }

    /// Event calendars in the home (reminders lists and inboxes are skipped).
    pub async fn calendars(&self, home: &Url) -> Result<Vec<CalInfo>> {
        let (at, r) = self
            .propfind(home, "1", "<d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/><d:current-user-privilege-set/>", "list your calendars")
            .await?;
        let mut out = Vec::new();
        for x in r {
            if !x.ok || !x.has_resourcetype("calendar") {
                continue;
            }
            if !x.components.is_empty() && !x.components.iter().any(|c| c == "VEVENT") {
                continue;
            }
            let href = self.resolve(&at, &x.href)?;
            let color = normalize_color(&x.text("calendar-color"));
            let writable = x.privileges.is_empty() || x.privileges.iter().any(|p| p == "write" || p == "all" || p == "write-content");
            out.push(CalInfo { href: href.to_string(), name: x.text("displayname").trim().to_string(), color, writable });
        }
        out.sort_by_key(|a| a.name.to_lowercase());
        Ok(out)
    }

    /// Events (with recurrence masters) overlapping [from, to).
    pub async fn events(&self, calendar: &Url, from_ms: i64, to_ms: i64) -> Result<Vec<Resource>> {
        let f = |ms: i64| chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().format("%Y%m%dT%H%M%SZ").to_string();
        let body = format!(
            r#"<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="{}" end="{}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>"#,
            f(from_ms),
            f(to_ms)
        );
        let (at, resp) = self.send(Method::from_bytes(b"REPORT").unwrap(), calendar, Some("1"), &[], Some(body), "read your calendar").await?;
        let xml = Self::text(resp).await?;
        let mut out = Vec::new();
        for x in multistatus(&xml)? {
            if !x.ok {
                continue;
            }
            let data = x.text("calendar-data");
            if data.is_empty() {
                continue;
            }
            out.push(Resource { href: self.resolve(&at, &x.href)?.to_string(), etag: x.text("getetag"), data });
        }
        Ok(out)
    }

    /// Hrefs and etags of every item in a calendar (no data).
    pub async fn list(&self, calendar: &Url) -> Result<Vec<Resource>> {
        let (at, r) = self.propfind(calendar, "1", "<d:getetag/><d:resourcetype/>", "read the Studydesk calendar").await?;
        let mut out = Vec::new();
        for x in r {
            if !x.ok || x.has_resourcetype("calendar") || x.has_resourcetype("collection") {
                continue;
            }
            out.push(Resource { href: self.resolve(&at, &x.href)?.to_string(), etag: x.text("getetag"), data: String::new() });
        }
        Ok(out)
    }

    /// Creates a calendar named `name` under the home and returns its URL.
    ///
    /// iCloud is stricter than the CalDAV standard: it expects the new
    /// calendar's address to be a random ID (as Apple's own apps use), and it
    /// can refuse some properties in the same request. So: a random UUID path,
    /// first with name, colour and type; if refused, again with the name only.
    pub async fn create_calendar(&self, home: &Url, name: &str, color: &str) -> Result<Url> {
        let mut last = None;
        for minimal in [false, true] {
            let url = self.resolve(home, &format!("{}/", new_uuid()?))?;
            let props = if minimal {
                format!("<d:displayname>{}</d:displayname>", xml_escape(name))
            } else {
                format!(
                    r#"<d:displayname>{}</d:displayname><a:calendar-color>{}</a:calendar-color><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>"#,
                    xml_escape(name),
                    xml_escape(color)
                )
            };
            let body = format!(
                r#"<?xml version="1.0" encoding="utf-8"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:set><d:prop>{props}</d:prop></d:set></c:mkcalendar>"#
            );
            match self.send(Method::from_bytes(b"MKCALENDAR").unwrap(), &url, None, &[], Some(body), "create the Studydesk calendar").await {
                Ok(_) => return Ok(url),
                // Worth one simpler retry: refused, or a property it didn't like.
                Err(e @ (CoreError::Refused(_) | CoreError::Api { status: 400 | 403 | 409 | 415 | 422, .. })) => last = Some(e),
                Err(e) => return Err(e),
            }
        }
        Err(last.unwrap_or(CoreError::Refused("iCloud refused to create the Studydesk calendar.".into())))
    }

    /// Creates or replaces an event. Returns the new etag if iCloud sent one.
    pub async fn put(&self, url: &Url, ics: String, cond: PutCond<'_>) -> Result<String> {
        let headers: Vec<(&str, String)> = match cond {
            PutCond::Create => vec![("If-None-Match", "*".into())],
            PutCond::Replace(e) if !e.is_empty() => vec![("If-Match", e.to_string())],
            PutCond::Replace(_) | PutCond::Overwrite => vec![],
        };
        let (_, resp) = self.send(Method::PUT, url, None, &headers, Some(ics), "save an event").await?;
        Ok(resp.headers().get(header::ETAG).and_then(|v| v.to_str().ok()).unwrap_or("").to_string())
    }

    pub async fn delete(&self, url: &Url) -> Result<()> {
        match self.send(Method::DELETE, url, None, &[], None, "remove an event").await {
            Ok(_) | Err(CoreError::NotFound) => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// Random UUID v4 in Apple's style (upper case).
fn new_uuid() -> Result<String> {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).map_err(|_| CoreError::Io("No randomness available.".into()))?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02X}")).collect();
    Ok(format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32]))
}

/// The calendar called "Studydesk", if there is one Studydesk can write to.
pub fn studydesk_calendar(cals: &[CalInfo]) -> Option<&CalInfo> {
    cals.iter().find(|c| c.writable && c.name.trim().eq_ignore_ascii_case("studydesk"))
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Apple stores colours as #RRGGBBAA; Studydesk uses #rrggbb.
fn normalize_color(c: &str) -> String {
    let c = c.trim();
    let hex = c.strip_prefix('#').unwrap_or("");
    if (hex.len() == 6 || hex.len() == 8) && hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        format!("#{}", hex[..6].to_ascii_lowercase())
    } else {
        String::new()
    }
}

// ---------------------------------------------------------------- XML

/// One `<response>` of a WebDAV multistatus, with the properties of its 200 propstat.
#[derive(Debug, Default)]
pub struct MsResponse {
    pub href: String,
    ok: bool,
    /// local name -> text content (for simple props).
    props: Vec<(String, String)>,
    /// local name -> first nested <href>.
    hrefs: Vec<(String, String)>,
    resourcetypes: Vec<String>,
    components: Vec<String>,
    privileges: Vec<String>,
}

impl MsResponse {
    fn text(&self, name: &str) -> String {
        self.props.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone()).unwrap_or_default()
    }
    fn prop_href(&self, name: &str) -> Option<String> {
        self.hrefs.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone())
    }
    fn has_resourcetype(&self, t: &str) -> bool {
        self.resourcetypes.iter().any(|x| x == t)
    }
}

pub fn multistatus(xml: &str) -> Result<Vec<MsResponse>> {
    let opts = roxmltree::ParsingOptions { allow_dtd: false, ..Default::default() };
    let doc = roxmltree::Document::parse_with_options(xml, opts).map_err(|_| CoreError::Api { status: 0, message: "iCloud sent a response Studydesk couldn't read.".into() })?;
    let mut out = Vec::new();
    for resp in doc.descendants().filter(|n| n.is_element() && n.tag_name().name() == "response") {
        let href = resp.children().find(|n| n.tag_name().name() == "href").and_then(|n| n.text()).unwrap_or("").trim().to_string();
        let mut r = MsResponse { href, ..Default::default() };
        // A response either has propstats or a bare status.
        let bare_ok = resp.children().find(|n| n.tag_name().name() == "status").and_then(|n| n.text()).is_some_and(|s| s.contains(" 200"));
        for ps in resp.children().filter(|n| n.tag_name().name() == "propstat") {
            let ok = ps.children().find(|n| n.tag_name().name() == "status").and_then(|n| n.text()).is_some_and(|s| s.contains(" 200"));
            if !ok {
                continue;
            }
            r.ok = true;
            let Some(prop) = ps.children().find(|n| n.tag_name().name() == "prop") else { continue };
            for p in prop.children().filter(|n| n.is_element()) {
                let name = p.tag_name().name().to_string();
                match name.as_str() {
                    "resourcetype" => r.resourcetypes.extend(p.children().filter(|n| n.is_element()).map(|n| n.tag_name().name().to_string())),
                    "supported-calendar-component-set" => r.components.extend(p.children().filter(|n| n.tag_name().name() == "comp").filter_map(|n| n.attribute("name")).map(|s| s.to_ascii_uppercase())),
                    "current-user-privilege-set" => r.privileges.extend(
                        p.descendants().filter(|n| n.tag_name().name() == "privilege").flat_map(|n| n.children().filter(|c| c.is_element()).map(|c| c.tag_name().name().to_string())),
                    ),
                    _ => {
                        if let Some(h) = p.descendants().find(|n| n.tag_name().name() == "href").and_then(|n| n.text()) {
                            r.hrefs.push((name.clone(), h.trim().to_string()));
                        }
                        let t: String = p.descendants().filter(|n| n.is_text()).filter_map(|n| n.text()).collect();
                        r.props.push((name, t));
                    }
                }
            }
        }
        if !r.ok && bare_ok {
            r.ok = true;
        }
        out.push(r);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client() -> CalDav {
        CalDav::icloud("me@icloud.com", "abcd-efgh-ijkl-mnop").unwrap()
    }

    #[test]
    fn password_and_host_rules() {
        assert!(CalDav::icloud("me@icloud.com", "abcdefghijklmnop").is_ok());
        assert!(CalDav::icloud("me@icloud.com", "MyRealPassword1!").is_err(), "a normal password is refused");
        assert!(CalDav::icloud("not-an-email", "abcdefghijklmnop").is_err());
        let c = client();
        let base = Url::parse(ICLOUD).unwrap();
        assert!(c.resolve(&base, "https://p52-caldav.icloud.com:443/1/calendars/").is_ok());
        for bad in ["https://evil.com/x", "https://icloud.com.evil.com/", "http://p52-caldav.icloud.com/", "https://p52-caldav.icloud.com:8443/", "https://user:pw@p52-caldav.icloud.com/"] {
            assert!(c.resolve(&base, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn parses_multistatus() {
        let xml = r##"<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">
 <response><href>/1/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
 <response><href>/1/calendars/home/</href><propstat><prop>
   <resourcetype><collection/><C:calendar/></resourcetype><displayname>Home</displayname><A:calendar-color>#FF2968FF</A:calendar-color>
   <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
   <current-user-privilege-set><privilege><read/></privilege><privilege><write/></privilege></current-user-privilege-set>
 </prop><status>HTTP/1.1 200 OK</status></propstat>
 <propstat><prop><getctag/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response>
 <response><href>/1/calendars/tasks/</href><propstat><prop><resourcetype><collection/><C:calendar/></resourcetype><displayname>Reminders</displayname>
   <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>"##;
        let r = multistatus(xml).unwrap();
        assert_eq!(r.len(), 3);
        assert!(r[1].has_resourcetype("calendar"));
        assert_eq!(r[1].text("displayname"), "Home");
        assert_eq!(normalize_color(&r[1].text("calendar-color")), "#ff2968");
        assert_eq!(r[2].components, vec!["VTODO"]);
        assert!(multistatus("<!DOCTYPE x [<!ENTITY a 'b'>]><multistatus/>").is_err(), "DTDs refused");
    }
}
