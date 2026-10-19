//! Calendars: iCalendar parsing/writing, iCloud CalDAV, and read-only
//! calendar links (Google's "secret address in iCal format", Outlook, etc.).

pub mod caldav;
pub mod ics;
pub mod items;
pub mod push;

use crate::{CoreError, Result};
use std::time::Duration;
use url::Url;

const MAX_FEED: usize = 15 * 1024 * 1024;

/// Accepts https:// and webcal:// links (webcal is https). Anything else is refused.
pub fn feed_url(s: &str) -> Result<Url> {
    let s = s.trim();
    let s = if let Some(rest) = s.strip_prefix("webcal://").or_else(|| s.strip_prefix("webcals://")) { format!("https://{rest}") } else { s.to_string() };
    let u = Url::parse(&s).map_err(|_| CoreError::Invalid("That isn't a calendar link. It should start with https:// or webcal://.".into()))?;
    if u.scheme() != "https" || u.host_str().is_none() || !u.username().is_empty() || u.password().is_some() {
        return Err(CoreError::Invalid("Calendar links must start with https:// or webcal://.".into()));
    }
    Ok(u)
}

/// Downloads a calendar link. Redirects are followed (at most 3) only to https.
pub async fn fetch_feed(url: &Url, loopback_for_tests: bool) -> Result<String> {
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .https_only(!loopback_for_tests)
        .user_agent(concat!("Studydesk/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| CoreError::Network(e.to_string()))?;
    let mut url = url.clone();
    for _ in 0..4 {
        let resp = http.get(url.clone()).send().await?;
        let st = resp.status();
        if st.is_redirection() {
            let loc = resp.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).unwrap_or("");
            let next = url.join(loc).map_err(|_| CoreError::Invalid("The calendar link redirected somewhere unreadable.".into()))?;
            if next.scheme() != "https" && !loopback_for_tests {
                return Err(CoreError::Refused("The calendar link redirected to an insecure address, so Studydesk stopped.".into()));
            }
            url = next;
            continue;
        }
        if !st.is_success() {
            return Err(match st.as_u16() {
                401 | 403 | 404 => CoreError::Invalid("The calendar link didn't work. It may have been reset; copy it again from your calendar's settings.".into()),
                s => CoreError::Api { status: s, message: "The calendar server returned an error.".into() },
            });
        }
        if resp.content_length().is_some_and(|n| n as usize > MAX_FEED) {
            return Err(CoreError::Invalid("That calendar is too large to load.".into()));
        }
        let b = resp.bytes().await?;
        if b.len() > MAX_FEED {
            return Err(CoreError::Invalid("That calendar is too large to load.".into()));
        }
        let text = String::from_utf8_lossy(&b).into_owned();
        if !text.trim_start_matches('\u{feff}').trim_start().to_ascii_uppercase().starts_with("BEGIN:VCALENDAR") {
            return Err(CoreError::Invalid("That link isn't an iCal calendar. In Google Calendar use \"Secret address in iCal format\".".into()));
        }
        return Ok(text);
    }
    Err(CoreError::Invalid("The calendar link redirected too many times.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn feed_urls() {
        assert_eq!(feed_url("webcal://p01-calendars.icloud.com/published/2/abc").unwrap().as_str(), "https://p01-calendars.icloud.com/published/2/abc");
        assert!(feed_url("https://calendar.google.com/calendar/ical/x%40gmail.com/private-abc/basic.ics").is_ok());
        for bad in ["http://example.com/a.ics", "file:///C:/a.ics", "javascript:alert(1)", "https://u:p@x.com/a.ics", "not a url"] {
            assert!(feed_url(bad).is_err(), "{bad}");
        }
    }
}
