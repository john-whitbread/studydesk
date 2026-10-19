//! Calendar tab: your Apple (iCloud) calendars and calendar links shown next
//! to deadlines, and a "Studydesk" calendar kept in iCloud.

use crate::state::AppState;
use serde::Serialize;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use studydesk_core::calendar::caldav::{CalDav, CalInfo};
use studydesk_core::calendar::{fetch_feed, feed_url, ics, items, push};
use studydesk_core::vault::{AppleCal, CalLink};
use studydesk_core::{CoreError, Result};
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

const CACHE_FOR: Duration = Duration::from_secs(5 * 60);
const STUDYDESK_SLUG: &str = "studydesk";
/// Colours for calendar links, in order of adding.
const LINK_COLORS: [&str; 6] = ["#0891b2", "#9333ea", "#ea580c", "#16a34a", "#db2777", "#64748b"];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PushReport {
    at: i64,
    written: usize,
    removed: usize,
    failed: usize,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleView {
    email: String,
    calendars: Vec<CalView>,
    push: bool,
    pushing: bool,
    last_push: Option<PushReport>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalView {
    id: String,
    name: String,
    color: String,
    shown: bool,
    /// The calendar Studydesk keeps; shown but not listed as "yours".
    studydesk: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalStatus {
    apple: Option<AppleView>,
    links: Vec<CalView>,
}

fn status_of(state: &AppState, apple: Option<&AppleCal>, links: &[CalLink]) -> CalStatus {
    CalStatus {
        apple: apple.map(|a| AppleView {
            email: a.email.clone(),
            calendars: a
                .calendars
                .iter()
                .map(|c| CalView {
                    id: c.href.clone(),
                    name: c.name.clone(),
                    color: c.color.clone(),
                    shown: a.shown.contains(&c.href),
                    studydesk: a.studydesk_href.as_deref() == Some(c.href.as_str()),
                })
                .collect(),
            push: a.push,
            pushing: state.cal_pushing.load(Ordering::Relaxed),
            last_push: state.cal_report.lock().unwrap().clone(),
        }),
        // Links are secret: only the name goes to the page.
        links: links.iter().map(|l| CalView { id: l.id.clone(), name: l.name.clone(), color: l.color.clone(), shown: l.shown, studydesk: false }).collect(),
    }
}

#[tauri::command]
pub async fn calendar_status(state: State<'_, AppState>) -> Result<CalStatus> {
    let g = state.session.read().await;
    let s = g.as_ref().ok_or(CoreError::Locked)?;
    Ok(status_of(&state, s.data.apple.as_ref(), &s.data.cal_links))
}

fn dav_of(a: &AppleCal) -> Result<CalDav> {
    CalDav::icloud(&a.email, &a.password)
}

/// Signs in to iCloud, lists calendars (all shown at first) and turns on the
/// Studydesk calendar.
#[tauri::command]
pub async fn calendar_connect_apple(app: AppHandle, state: State<'_, AppState>, email: String, password: String) -> Result<CalStatus> {
    let dav = CalDav::icloud(&email, &password)?;
    let home = dav.discover().await?;
    let calendars = dav.calendars(&home).await?;
    let existing = calendars.iter().find(|c| c.href.trim_end_matches('/').ends_with(&format!("/{STUDYDESK_SLUG}"))).map(|c| c.href.clone());
    let apple = AppleCal {
        email: email.trim().to_string(),
        password: password.chars().filter(|c| c.is_ascii_lowercase()).collect(),
        home: home.to_string(),
        shown: calendars.iter().map(|c| c.href.clone()).collect(),
        calendars,
        push: true,
        studydesk_href: existing,
        pushed: Default::default(),
    };
    let st = {
        let mut g = state.session.write().await;
        let s = g.as_mut().ok_or(CoreError::Locked)?;
        s.data.apple = Some(apple);
        state.persist(s)?;
        status_of(&state, s.data.apple.as_ref(), &s.data.cal_links)
    };
    state.cal_cache.lock().await.clear();
    spawn_push(app);
    Ok(st)
}

/// Forgets the iCloud connection. With `remove_calendar`, also deletes the
/// Studydesk calendar from iCloud (nothing else is touched).
#[tauri::command]
pub async fn calendar_disconnect_apple(state: State<'_, AppState>, remove_calendar: bool) -> Result<CalStatus> {
    let apple = state.session.read().await.as_ref().ok_or(CoreError::Locked)?.data.apple.clone();
    if let (true, Some(a)) = (remove_calendar, apple.as_ref()) {
        if let Some(href) = &a.studydesk_href {
            let dav = dav_of(a)?;
            let url = dav.resolve(&Url::parse(&a.home).map_err(|_| CoreError::Invalid("Bad iCloud address.".into()))?, href)?;
            if url.path().trim_end_matches('/').ends_with(&format!("/{STUDYDESK_SLUG}")) {
                dav.delete(&url).await?;
            }
        }
    }
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    s.data.apple = None;
    state.persist(s)?;
    *state.cal_report.lock().unwrap() = None;
    drop(g);
    state.cal_cache.lock().await.clear();
    let g = state.session.read().await;
    let s = g.as_ref().ok_or(CoreError::Locked)?;
    Ok(status_of(&state, None, &s.data.cal_links))
}

#[tauri::command]
pub async fn calendar_set_shown(state: State<'_, AppState>, id: String, shown: bool) -> Result<CalStatus> {
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    if let Some(l) = s.data.cal_links.iter_mut().find(|l| l.id == id) {
        l.shown = shown;
    } else if let Some(a) = s.data.apple.as_mut().filter(|a| a.calendars.iter().any(|c| c.href == id)) {
        if shown {
            a.shown.insert(id);
        } else {
            a.shown.remove(&id);
        }
    } else {
        return Err(CoreError::NotFound);
    }
    state.persist(s)?;
    Ok(status_of(&state, s.data.apple.as_ref(), &s.data.cal_links))
}

#[tauri::command]
pub async fn calendar_set_push(app: AppHandle, state: State<'_, AppState>, on: bool) -> Result<CalStatus> {
    let st = {
        let mut g = state.session.write().await;
        let s = g.as_mut().ok_or(CoreError::Locked)?;
        let a = s.data.apple.as_mut().ok_or_else(|| CoreError::Invalid("Connect Apple Calendar first.".into()))?;
        a.push = on;
        state.persist(s)?;
        status_of(&state, s.data.apple.as_ref(), &s.data.cal_links)
    };
    if on {
        spawn_push(app);
    }
    Ok(st)
}

#[tauri::command]
pub async fn calendar_push_now(app: AppHandle) -> Result<()> {
    spawn_push(app);
    Ok(())
}

/// Adds a read-only calendar link after checking it really is a calendar.
#[tauri::command]
pub async fn calendar_add_link(state: State<'_, AppState>, name: String, url: String) -> Result<CalStatus> {
    let u = feed_url(&url)?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(CoreError::Invalid("Give the calendar a name (up to 60 characters).".into()));
    }
    let text = fetch_feed(&u, false).await?;
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    if s.data.cal_links.len() >= 12 {
        return Err(CoreError::Invalid("You can add up to 12 calendar links.".into()));
    }
    if s.data.cal_links.iter().any(|l| l.url == u.as_str()) {
        return Err(CoreError::Invalid("That calendar is already added.".into()));
    }
    let mut id = [0u8; 8];
    getrandom::getrandom(&mut id).map_err(|_| CoreError::Io("No randomness available.".into()))?;
    let id = format!("link-{}", id.iter().map(|b| format!("{b:02x}")).collect::<String>());
    let color = LINK_COLORS[s.data.cal_links.len() % LINK_COLORS.len()].to_string();
    s.data.cal_links.push(CalLink { id: id.clone(), name: name.to_string(), url: u.to_string(), color, shown: true });
    state.persist(s)?;
    let st = status_of(&state, s.data.apple.as_ref(), &s.data.cal_links);
    drop(g);
    state.cal_cache.lock().await.insert(format!("{id}|feed"), (Instant::now(), text));
    Ok(st)
}

#[tauri::command]
pub async fn calendar_remove_link(state: State<'_, AppState>, id: String) -> Result<CalStatus> {
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    s.data.cal_links.retain(|l| l.id != id);
    state.persist(s)?;
    Ok(status_of(&state, s.data.apple.as_ref(), &s.data.cal_links))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtEvent {
    source: String,
    title: String,
    location: String,
    start: i64,
    end: i64,
    all_day: bool,
    color: String,
    calendar: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceError {
    calendar: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtEvents {
    events: Vec<ExtEvent>,
    errors: Vec<SourceError>,
}

/// Events from shown external calendars overlapping [from, to). The window is
/// widened to whole months so moving week to week reuses the cache.
#[tauri::command]
pub async fn calendar_events(state: State<'_, AppState>, from: i64, to: i64, refresh: Option<bool>) -> Result<ExtEvents> {
    if to <= from || to - from > 120 * 86_400_000 {
        return Err(CoreError::Invalid("Pick a shorter date range.".into()));
    }
    let (apple, links) = {
        let g = state.session.read().await;
        let s = g.as_ref().ok_or(CoreError::Locked)?;
        (s.data.apple.clone(), s.data.cal_links.iter().filter(|l| l.shown).cloned().collect::<Vec<_>>())
    };
    if refresh == Some(true) {
        state.cal_cache.lock().await.clear();
    }
    const MONTH: i64 = 31 * 86_400_000;
    let (wf, wt) = (from.div_euclid(MONTH) * MONTH - MONTH, (to.div_euclid(MONTH) + 2) * MONTH);

    let mut jobs: Vec<(String, String, String, Source)> = Vec::new();
    if let Some(a) = apple.as_ref() {
        for c in a.calendars.iter().filter(|c| a.shown.contains(&c.href)) {
            jobs.push((c.href.clone(), c.name.clone(), c.color.clone(), Source::Apple(c.clone())));
        }
    }
    for l in &links {
        jobs.push((l.id.clone(), l.name.clone(), l.color.clone(), Source::Link(l.url.clone())));
    }
    let dav = match apple.as_ref() {
        Some(a) => Some(dav_of(a)?),
        None => None,
    };
    let st: &AppState = &state;
    let results = futures_util::future::join_all(jobs.into_iter().map(|(id, name, color, src)| {
        let dav = dav.as_ref();
        async move {
            let r = fetch_source(st, dav, &id, &src, wf, wt).await;
            (id, name, color, r)
        }
    }))
    .await;

    let mut out = ExtEvents { events: Vec::new(), errors: Vec::new() };
    for (id, name, color, r) in results {
        match r {
            Ok(texts) => {
                for t in texts {
                    for o in ics::occurrences(&t, from, to) {
                        out.events.push(ExtEvent { source: id.clone(), title: o.title, location: o.location, start: o.start, end: o.end, all_day: o.all_day, color: color.clone(), calendar: name.clone() });
                    }
                }
            }
            Err(e) => out.errors.push(SourceError { calendar: name, message: e.to_string() }),
        }
    }
    out.events.sort_by_key(|e| (e.start, e.end));
    out.events.truncate(4000);
    Ok(out)
}

enum Source {
    Apple(CalInfo),
    Link(String),
}

async fn fetch_source(state: &AppState, dav: Option<&CalDav>, id: &str, src: &Source, wf: i64, wt: i64) -> Result<Vec<String>> {
    let key = match src {
        Source::Apple(_) => format!("{id}|{wf}|{wt}"),
        Source::Link(_) => format!("{id}|feed"),
    };
    if let Some((at, text)) = state.cal_cache.lock().await.get(&key) {
        if at.elapsed() < CACHE_FOR {
            return Ok(serde_json::from_str::<Vec<String>>(text).unwrap_or_else(|_| vec![text.clone()]));
        }
    }
    let texts = match src {
        Source::Apple(c) => {
            let dav = dav.ok_or(CoreError::NotFound)?;
            let url = dav.resolve(&Url::parse(&c.href).map_err(|_| CoreError::Invalid("Bad calendar address.".into()))?, &c.href)?;
            dav.events(&url, wf, wt).await?.into_iter().map(|r| r.data).collect::<Vec<_>>()
        }
        Source::Link(u) => vec![fetch_feed(&feed_url(u)?, false).await?],
    };
    let stored = serde_json::to_string(&texts).unwrap_or_default();
    state.cal_cache.lock().await.insert(key, (Instant::now(), stored));
    Ok(texts)
}

// ------------------------------------------------------------ pushing

/// Starts an Apple Calendar update in the background (one at a time).
pub fn spawn_push(app: AppHandle) {
    let state = app.state::<AppState>();
    if state.cal_pushing.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app.emit("calendar-push", "start");
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let r = push_once(&state).await;
        let report = match r {
            Ok(Some(o)) => Some(PushReport { at: chrono::Utc::now().timestamp_millis(), written: o.written, removed: o.removed, failed: o.failed, error: o.first_error }),
            Ok(None) => None,
            Err(e) => Some(PushReport { at: chrono::Utc::now().timestamp_millis(), written: 0, removed: 0, failed: 1, error: Some(e.to_string()) }),
        };
        if report.is_some() {
            *state.cal_report.lock().unwrap() = report;
        }
        state.cal_pushing.store(false, Ordering::SeqCst);
        let _ = app.emit("calendar-push", "done");
    });
}

async fn push_once(state: &AppState) -> Result<Option<push::Outcome>> {
    // Snapshot what's needed, then do the network work without holding the lock.
    let (apple, desired) = {
        let g = state.session.read().await;
        let Some(s) = g.as_ref() else { return Ok(None) };
        let Some(a) = s.data.apple.clone().filter(|a| a.push) else { return Ok(None) };
        if s.upcoming.is_empty() && s.course_labels.is_empty() {
            return Ok(None); // not synced with Canvas yet: don't remove everything
        }
        let codes = s.upcoming.iter().map(|(code, a)| (a.course_id, code.clone())).collect();
        let desired = items::desired(&s.upcoming, &s.data.prefs.pinned, &codes, &s.data.prefs.hidden_courses, chrono::Utc::now());
        (a, desired)
    };
    let dav = dav_of(&apple)?;
    let home = Url::parse(&apple.home).map_err(|_| CoreError::Invalid("Bad iCloud address.".into()))?;
    let cal = match &apple.studydesk_href {
        Some(h) => dav.resolve(&home, h)?,
        None => {
            let url = match dav.make_calendar(&home, STUDYDESK_SLUG, "Studydesk", "#1d4ed8").await {
                Ok(u) => u,
                // Already there (e.g. from another computer): use it.
                Err(CoreError::Api { status: 405, .. }) => dav.resolve(&home, &format!("{STUDYDESK_SLUG}/"))?,
                Err(e) => return Err(e),
            };
            let mut g = state.session.write().await;
            if let Some(a) = g.as_mut().and_then(|s| s.data.apple.as_mut()) {
                a.studydesk_href = Some(url.to_string());
                if !a.calendars.iter().any(|c| c.href == url.as_str()) {
                    a.calendars.push(CalInfo { href: url.to_string(), name: "Studydesk".into(), color: "#1d4ed8".into(), writable: true });
                }
            }
            if let Some(s) = g.as_ref() {
                state.persist(s)?;
            }
            url
        }
    };
    let mut pushed = apple.pushed.clone();
    let plan = push::plan(&desired, &pushed);
    if plan.put.is_empty() && plan.delete.is_empty() {
        return Ok(Some(push::Outcome::default()));
    }
    let outcome = push::apply(&dav, &cal, plan, &mut pushed, chrono::Utc::now().timestamp_millis()).await?;
    let mut g = state.session.write().await;
    if let Some(s) = g.as_mut() {
        if let Some(a) = s.data.apple.as_mut().filter(|a| a.email == apple.email) {
            a.pushed = pushed;
            state.persist(s)?;
        }
    }
    drop(g);
    state.cal_cache.lock().await.retain(|k, _| !k.starts_with(cal.as_str()));
    Ok(Some(outcome))
}
