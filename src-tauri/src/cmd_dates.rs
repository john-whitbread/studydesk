//! Important-date scanner: reads each course's calendar events, syllabus,
//! front page, course-outline style files on Canvas and in your linked folder,
//! and proposes dates. Nothing is used until you pin it.

use crate::state::AppState;
use chrono::{Local, NaiveDate, TimeZone};
use futures_util::stream::{self, StreamExt};
use regex::Regex;
use serde::Serialize;
use std::sync::Arc;
use std::sync::OnceLock;
use studydesk_core::canvas::models::{Assignment, Course, CourseFile};
use studydesk_core::canvas::Canvas;
use studydesk_core::dates::{self, Confidence, Context, Finding, Source};
use studydesk_core::textract::{self, MAX_FILE_BYTES};
use studydesk_core::office_hours::{self, OfficeHours};
use studydesk_core::vault::PinnedDate;
use studydesk_core::{paths, CoreError, Result};
use tauri::{AppHandle, Emitter, State};

const MAX_CANVAS_FILES: usize = 8;
const MAX_LOCAL_FILES: usize = 5;

/// File names that usually hold schedules, ranked: earlier pattern = scanned first.
fn name_rank(name: &str) -> Option<usize> {
    static R: OnceLock<Vec<Regex>> = OnceLock::new();
    let r = R.get_or_init(|| {
        [
            r"(?i)outline|syllabus|syllabi",
            r"(?i)schedule|calendar|timeline|important\s*dates|key\s*dates|due\s*dates?|deadlines?",
            r"(?i)course\s*(info|information|overview|plan)|overview",
            r"(?i)assessment|evaluation|grading|marking|deliverables?",
            r"(?i)exam|midterm|final|quiz|test",
            r"(?i)lab\s*manual|project\s*(description|brief|outline|handout)",
        ]
        .iter()
        .map(|p| Regex::new(p).unwrap())
        .collect()
    });
    r.iter().position(|re| re.is_match(name))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Scanned {
    course_id: u64,
    kind: String,
    name: String,
    ok: bool,
    found: usize,
    note: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    findings: Vec<Finding>,
    scanned: Vec<Scanned>,
    /// Office hours found, not yet confirmed or dismissed.
    office_hours: Vec<OfficeHours>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    done: usize,
    total: usize,
    course: String,
}

fn local_date(iso: &Option<String>) -> Option<NaiveDate> {
    studydesk_core::submit::parse_time(iso).map(|t| t.with_timezone(&Local).date_naive())
}

fn ctx_for(c: &Course) -> Context {
    let term = c.term.as_ref();
    Context {
        today: Local::now().date_naive(),
        term_start: local_date(&c.start_at).or_else(|| term.and_then(|t| local_date(&t.start_at))),
        term_end: local_date(&c.end_at).or_else(|| term.and_then(|t| local_date(&t.end_at))),
    }
}

struct CourseScan {
    findings: Vec<Finding>,
    scanned: Vec<Scanned>,
    office_hours: Vec<OfficeHours>,
}

fn note(e: &CoreError) -> String {
    match e {
        CoreError::Forbidden(_) | CoreError::NotFound => "Hidden by the instructor".into(),
        other => other.to_string(),
    }
}

async fn scan_course(canvas: Arc<Canvas>, c: Course, local_root: Option<std::path::PathBuf>) -> CourseScan {
    let ctx = ctx_for(&c);
    let mut findings = Vec::new();
    let mut scanned = Vec::new();
    let mut hours: Vec<OfficeHours> = Vec::new();
    let mut record = |kind: &str, name: &str, r: std::result::Result<usize, String>| {
        scanned.push(Scanned {
            course_id: c.id,
            kind: kind.into(),
            name: name.into(),
            ok: r.is_ok(),
            found: *r.as_ref().unwrap_or(&0),
            note: r.err(),
        })
    };

    // 1. Calendar events: exact dates posted by the instructor.
    let start = (ctx.today - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
    let end = (ctx.today + chrono::Duration::days(200)).format("%Y-%m-%d").to_string();
    match canvas.calendar_events(c.id, &start, &end).await {
        Ok(events) => {
            let mut n = 0;
            for ev in events {
                let Some(t) = studydesk_core::submit::parse_time(&ev.start_at) else { continue };
                let local = t.with_timezone(&Local);
                let desc = ev.description.as_deref().map(dates::html_to_text).unwrap_or_default();
                let kind = dates::classify(&ev.title).or_else(|| dates::classify(&desc)).map(|(k, _)| k);
                let Some(kind) = kind else { continue }; // lectures, office hours, etc.
                let date = local.date_naive().to_string();
                let label = ev.title.trim().to_string();
                findings.push(Finding {
                    id: dates::finding_id(c.id, &date, &label),
                    course_id: c.id,
                    date,
                    time: (ev.all_day != Some(true)).then(|| local.format("%H:%M").to_string()),
                    end_date: None,
                    kind,
                    label,
                    weight: None,
                    snippet: dates::snippet(
                        &[ev.location_name.clone().unwrap_or_default(), desc.trim().to_string()].into_iter().filter(|x| !x.trim().is_empty()).collect::<Vec<_>>().join(" · "),
                    ),
                    confidence: Confidence::High,
                    caution: None,
                    sources: vec![Source { kind: "calendar".into(), name: "Canvas calendar".into(), url: ev.html_url.clone() }],
                    in_canvas: None,
                });
                n += 1;
            }
            record("calendar", "Canvas calendar", Ok(n));
        }
        Err(e) => record("calendar", "Canvas calendar", Err(note(&e))),
    }

    // 2. Syllabus page.
    match canvas.syllabus(c.id).await {
        Ok(Some(html)) => {
            let src = Source { kind: "syllabus".into(), name: "Syllabus".into(), url: Some(format!("{}courses/{}/assignments/syllabus", canvas.base_str(), c.id)) };
            hours.extend(office_hours::extract(&html, c.id, &src));
            let f = dates::extract(&dates::html_to_text(&html), c.id, &src, &ctx);
            record("syllabus", "Syllabus", Ok(f.len()));
            findings.extend(f);
        }
        Ok(None) => record("syllabus", "Syllabus", Err("Empty".into())),
        Err(e) => record("syllabus", "Syllabus", Err(note(&e))),
    }

    // 3. Course home page.
    match canvas.front_page(c.id).await {
        Ok(Some(p)) => {
            let name = p.title.clone().unwrap_or_else(|| "Home page".into());
            let src = Source { kind: "page".into(), name: name.clone(), url: p.html_url.clone() };
            hours.extend(office_hours::extract(p.body.as_deref().unwrap_or(""), c.id, &src));
            let f = dates::extract(&dates::html_to_text(p.body.as_deref().unwrap_or("")), c.id, &src, &ctx);
            record("page", &name, Ok(f.len()));
            findings.extend(f);
        }
        Ok(None) => {}
        Err(e) => record("page", "Home page", Err(note(&e))),
    }

    // 4. Outline-type files on Canvas.
    match canvas.course_files(c.id).await {
        Ok(files) => {
            let mut picks: Vec<(usize, CourseFile)> = files
                .into_iter()
                .filter(|f| f.locked_for_user != Some(true) && f.hidden_for_user != Some(true))
                .filter(|f| f.size.unwrap_or(0) <= MAX_FILE_BYTES && f.url.is_some())
                .filter(|f| textract::supported(&paths::ext_of(std::path::Path::new(&f.display_name))))
                .filter_map(|f| name_rank(&f.display_name).map(|r| (r, f)))
                .collect();
            picks.sort_by_key(|(r, _)| *r); // stable: keeps newest-first within a rank
            for (_, f) in picks.into_iter().take(MAX_CANVAS_FILES) {
                let ext = paths::ext_of(std::path::Path::new(&f.display_name));
                let r = match canvas.download(f.url.as_deref().unwrap_or(""), MAX_FILE_BYTES).await {
                    Ok(bytes) => tauri::async_runtime::spawn_blocking(move || textract::text_of(&ext, &bytes)).await.unwrap_or_else(|_| Err(CoreError::Invalid("Couldn't read it.".into()))),
                    Err(e) => Err(e),
                };
                match r {
                    Ok(text) => {
                        let src = Source { kind: "file".into(), name: f.display_name.clone(), url: Some(format!("{}courses/{}/files/{}", canvas.base_str(), c.id, f.id)) };
                        hours.extend(office_hours::extract(&text, c.id, &src));
                        let found = dates::extract(&text, c.id, &src, &ctx);
                        record("file", &f.display_name, Ok(found.len()));
                        findings.extend(found);
                    }
                    Err(e) => record("file", &f.display_name, Err(note(&e))),
                }
            }
        }
        Err(e) => record("file", "Course files", Err(note(&e))),
    }

    // 5. Outline-type files in your linked folder.
    if let Some(root) = local_root {
        let exts: Vec<String> = ["pdf", "docx", "pptx", "txt", "md"].iter().map(|s| s.to_string()).collect();
        let list = tauri::async_runtime::spawn_blocking(move || paths::recent_files(&root, &exts, 300).map(|v| (root, v))).await;
        if let Ok(Ok((root, entries))) = list {
            let mut picks: Vec<_> = entries.into_iter().filter(|e| e.size <= MAX_FILE_BYTES).filter_map(|e| name_rank(&e.name).map(|r| (r, e))).collect();
            picks.sort_by_key(|(r, _)| *r);
            for (_, e) in picks.into_iter().take(MAX_LOCAL_FILES) {
                let path = match paths::resolve_within(&root, &e.rel) {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                let ext = e.ext.clone();
                let r = tauri::async_runtime::spawn_blocking(move || std::fs::read(&path).map_err(CoreError::from).and_then(|b| textract::text_of(&ext, &b)))
                    .await
                    .unwrap_or_else(|_| Err(CoreError::Invalid("Couldn't read it.".into())));
                match r {
                    Ok(text) => {
                        let src = Source { kind: "local".into(), name: e.rel.clone(), url: None };
                        hours.extend(office_hours::extract(&text, c.id, &src));
                        let found = dates::extract(&text, c.id, &src, &ctx);
                        record("local", &e.rel, Ok(found.len()));
                        findings.extend(found);
                    }
                    Err(err) => record("local", &e.rel, Err(note(&err))),
                }
            }
        }
    }
    // 6. Announcements this term: "Quiz 2 is this Thursday", office-hour changes.
    let from = ctx.term_start.map(|d| d - chrono::Duration::days(7)).unwrap_or(ctx.today - chrono::Duration::days(120));
    let to = ctx.today + chrono::Duration::days(1);
    match canvas.announcements(&[c.id], &from.format("%Y-%m-%d").to_string(), &to.format("%Y-%m-%d").to_string()).await {
        Ok(list) => {
            let mut n = 0;
            for an in &list {
                let Some(posted) = local_date(&an.posted_at) else { continue };
                let src = Source { kind: "announcement".into(), name: an.title.clone(), url: an.html_url.clone() };
                let body = an.message.as_deref().unwrap_or("");
                hours.extend(office_hours::extract(body, c.id, &src));
                let f = studydesk_core::announce::extract(&an.title, body, posted, c.id, &src, &ctx);
                n += f.len();
                findings.extend(f);
            }
            record("announcement", &format!("Announcements ({})", list.len()), Ok(n));
        }
        Err(e) => record("announcement", "Announcements", Err(note(&e))),
    }
    CourseScan { findings, scanned, office_hours: hours }
}

/// Scans all visible courses (or the given ones).
#[tauri::command]
pub async fn dates_scan(app: AppHandle, state: State<'_, AppState>, course_ids: Option<Vec<u64>>) -> Result<ScanResult> {
    let canvas = state.canvas().await?;
    let (hidden, links, dismissed) = {
        let g = state.session.read().await;
        let s = g.as_ref().ok_or(CoreError::Locked)?;
        (s.data.prefs.hidden_courses.clone(), s.data.folder_links.clone(), s.data.prefs.dismissed.clone())
    };
    let courses: Vec<Course> = canvas
        .courses()
        .await?
        .into_iter()
        .filter(|c| !hidden.contains(&c.id))
        .filter(|c| course_ids.as_ref().map_or(true, |ids| ids.contains(&c.id)))
        .collect();
    let total = courses.len();
    let futures: Vec<_> = courses
        .into_iter()
        .map(|c| {
            let canvas = canvas.clone();
            let root = links.get(&c.id).map(std::path::PathBuf::from).filter(|p| p.is_dir());
            let label = if c.course_code.is_empty() { c.name.clone() } else { c.course_code.clone() };
            async move { (label, scan_course(canvas, c, root).await) }
        })
        .collect();
    let mut done = 0;
    let mut all = Vec::new();
    let mut scanned = Vec::new();
    let mut hours: Vec<OfficeHours> = Vec::new();
    let mut s = stream::iter(futures).buffer_unordered(3);
    while let Some((label, r)) = s.next().await {
        done += 1;
        let _ = app.emit("scan-progress", Progress { done, total, course: label });
        all.extend(r.findings);
        scanned.extend(r.scanned);
        hours.extend(r.office_hours);
    }

    let mut findings = dates::merge(all);
    findings.retain(|f| !dismissed.contains(&f.id));
    // Mark ones that a Canvas assignment already covers.
    {
        let g = state.session.read().await;
        if let Some(s) = g.as_ref() {
            for f in &mut findings {
                f.in_canvas = s
                    .upcoming
                    .iter()
                    .map(|(_, a)| a)
                    .filter(|a| a.course_id == f.course_id && local_date(&a.due_at).map(|d| d.to_string()).as_deref() == Some(f.date.as_str()))
                    .find(|a| dates::same_item(&f.label, f.kind, &a.name))
                    .map(|a: &Assignment| a.name.clone());
            }
        }
    }
    // Office hours: one suggestion per course/days/time, minus ones you've handled.
    let (confirmed, dismissed_now) = {
        let g = state.session.read().await;
        let s = g.as_ref().ok_or(CoreError::Locked)?;
        (s.data.prefs.office_hours.iter().map(|o| o.id.clone()).collect::<Vec<_>>(), s.data.prefs.dismissed.clone())
    };
    let mut office_hours: Vec<OfficeHours> = Vec::new();
    for o in hours {
        if !confirmed.contains(&o.id) && !dismissed_now.contains(&format!("oh:{}", o.id)) && !office_hours.iter().any(|x| x.id == o.id) {
            office_hours.push(o);
        }
    }
    Ok(ScanResult { findings, scanned, office_hours })
}

#[tauri::command]
pub async fn dates_pinned(state: State<'_, AppState>) -> Result<Vec<PinnedDate>> {
    let g = state.session.read().await;
    Ok(g.as_ref().ok_or(CoreError::Locked)?.data.prefs.pinned.clone())
}

fn validate(p: &mut PinnedDate) -> Result<()> {
    NaiveDate::parse_from_str(&p.date, "%Y-%m-%d").map_err(|_| CoreError::Invalid("Use a valid date.".into()))?;
    if let Some(t) = p.time.as_deref().filter(|t| !t.is_empty()) {
        chrono::NaiveTime::parse_from_str(t, "%H:%M").map_err(|_| CoreError::Invalid("Use a valid time (HH:MM).".into()))?;
    } else {
        p.time = None;
    }
    p.label = p.label.trim().chars().take(120).collect();
    if p.label.is_empty() {
        return Err(CoreError::Invalid("Give it a name.".into()));
    }
    if !matches!(p.kind.as_str(), "exam" | "quiz" | "deliverable" | "info") {
        return Err(CoreError::Invalid("Unknown type.".into()));
    }
    p.source = p.source.chars().take(200).collect();
    p.weight = p.weight.take().map(|w| w.chars().take(12).collect()).filter(|w: &String| !w.is_empty());
    if p.id.is_empty() || p.id.len() > 64 || !p.id.chars().all(|c| c.is_ascii_alphanumeric()) {
        p.id = dates::finding_id(p.course_id, &p.date, &format!("{}{}", p.label, crate::state::random_id()));
    }
    Ok(())
}

#[tauri::command]
pub async fn dates_pin(app: tauri::AppHandle, state: State<'_, AppState>, item: PinnedDate) -> Result<Vec<PinnedDate>> {
    let mut item = item;
    validate(&mut item)?;
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    s.data.prefs.pinned.retain(|p| p.id != item.id);
    s.data.prefs.pinned.push(item);
    s.data.prefs.pinned.sort_by(|a, b| (a.date.as_str(), a.time.as_deref()).cmp(&(b.date.as_str(), b.time.as_deref())));
    state.persist(s)?;
    let out = s.data.prefs.pinned.clone();
    drop(g);
    crate::cmd_calendar::spawn_push(app);
    Ok(out)
}

#[tauri::command]
pub async fn dates_unpin(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Result<Vec<PinnedDate>> {
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    // A date added from an announcement and removed by you stays removed.
    if s.data.prefs.pinned.iter().any(|p| p.id == id && p.auto) && s.data.prefs.dismissed.len() < 3000 {
        s.data.prefs.dismissed.insert(id.clone());
    }
    s.data.prefs.pinned.retain(|p| p.id != id);
    state.persist(s)?;
    let out = s.data.prefs.pinned.clone();
    drop(g);
    crate::cmd_calendar::spawn_push(app);
    Ok(out)
}

#[tauri::command]
pub async fn dates_dismiss(state: State<'_, AppState>, id: String) -> Result<()> {
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    if s.data.prefs.dismissed.len() > 3000 {
        s.data.prefs.dismissed.clear();
    }
    s.data.prefs.dismissed.insert(id.chars().take(64).collect());
    state.persist(s)
}

#[tauri::command]
pub async fn dates_restore_dismissed(state: State<'_, AppState>) -> Result<()> {
    let mut g = state.session.write().await;
    let s = g.as_mut().ok_or(CoreError::Locked)?;
    s.data.prefs.dismissed.clear();
    state.persist(s)
}

/// Pinned dates as reminder items (due at the stated time, or 9:00 if none).
pub fn pinned_items(pins: &[PinnedDate], labels: &std::collections::HashMap<u64, String>, estimates: &std::collections::BTreeMap<String, f64>) -> Vec<studydesk_core::reminders::Item> {
    pins.iter()
        .filter(|p| p.kind != "info")
        .filter_map(|p| {
            let d = NaiveDate::parse_from_str(&p.date, "%Y-%m-%d").ok()?;
            let t = p.time.as_deref().and_then(|t| chrono::NaiveTime::parse_from_str(t, "%H:%M").ok()).unwrap_or(chrono::NaiveTime::from_hms_opt(9, 0, 0)?);
            let local = Local.from_local_datetime(&d.and_time(t)).earliest()?;
            Some(studydesk_core::reminders::Item {
                key_base: format!("pin:{}:{}", p.id, local.to_rfc3339()),
                name: p.label.clone(),
                course: labels.get(&p.course_id).cloned().unwrap_or_default(),
                due: local.with_timezone(&chrono::Utc),
                // Exams need studying: they get a "start soon" nudge like big assignments.
                hours: (p.kind == "exam").then(|| studydesk_core::effort::default_hours("exam", estimates)),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use studydesk_core::dates::Kind;

    #[test]
    fn ranks_outline_files_first() {
        assert_eq!(name_rank("MECE2420 Course Outline F26.pdf"), Some(0));
        assert_eq!(name_rank("Lab schedule.docx"), Some(1));
        assert_eq!(name_rank("Midterm review.pdf"), Some(4));
        assert_eq!(name_rank("Lecture 7 - torsion.pdf"), None);
    }

    fn docx(text_rows: &[(&str, &str)]) -> Vec<u8> {
        use std::io::Write;
        let rows: String = text_rows
            .iter()
            .map(|(a, b)| format!("<w:tr><w:tc><w:p><w:r><w:t>{a}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>{b}</w:t></w:r></w:p></w:tc></w:tr>"))
            .collect();
        let xml = format!("<w:document><w:body><w:p><w:r><w:t>Course schedule</w:t></w:r></w:p><w:tbl>{rows}</w:tbl></w:body></w:document>");
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            z.start_file("word/document.xml", zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(xml.as_bytes()).unwrap();
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    /// Whole pipeline against a fake Canvas course.
    #[tokio::test]
    async fn scans_calendar_syllabus_and_outline_file() {
        use wiremock::matchers::{method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let s = MockServer::start().await;
        let storage = MockServer::start().await;
        let today = Local::now().date_naive();
        let d = |n: i64| today + chrono::Duration::days(n);
        let fmt = |x: NaiveDate| x.format("%B %-d, %Y").to_string();
        let exam_at = Local.from_local_datetime(&d(10).and_hms_opt(14, 0, 0).unwrap()).unwrap().with_timezone(&chrono::Utc).to_rfc3339();
        Mock::given(path("/api/v1/calendar_events"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"id": 1, "title": "Midterm Exam", "start_at": exam_at, "location_name": "ERC 1094"},
                {"id": 2, "title": "Lecture 12", "start_at": exam_at}
            ])))
            .mount(&s)
            .await;
        Mock::given(path("/api/v1/courses/7"))
            .and(query_param("include[]", "syllabus_body"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "syllabus_body": format!("<p>Final project report due {} at 11:59 pm (30%)</p><p>Office hours: {}</p>", fmt(d(30)), fmt(d(3)))
            })))
            .mount(&s)
            .await;
        Mock::given(path("/api/v1/courses/7/front_page")).respond_with(ResponseTemplate::new(404)).mount(&s).await;
        Mock::given(path("/api/v1/courses/7/files"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"id": 50, "display_name": "Course Outline.docx", "size": 4000, "url": format!("{}/files/50/download", s.uri())},
                {"id": 51, "display_name": "Lecture 3.pdf", "size": 4000, "url": format!("{}/files/51/download", s.uri())}
            ])))
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(path("/files/50/download"))
            .respond_with(ResponseTemplate::new(302).insert_header("Location", format!("{}/blob/50", storage.uri()).as_str()))
            .mount(&s)
            .await;
        let quiz_day = d(17);
        Mock::given(path("/blob/50"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(docx(&[(&quiz_day.format("%b %-d").to_string(), "Quiz 2 (5%)"), ("Week 3", "Lecture only")])))
            .mount(&storage)
            .await;

        let canvas = Arc::new(Canvas::new(&s.uri(), "7~tok", true).unwrap());
        let course = Course { id: 7, name: "Solid Mechanics".into(), course_code: "MECE 2420U".into(), ..Default::default() };
        let r = scan_course(canvas, course, None).await;
        let got: Vec<(String, Kind, Option<String>, Confidence, String)> =
            dates::merge(r.findings).into_iter().map(|f| (f.date, f.kind, f.time, f.confidence, f.sources[0].kind.clone())).collect();
        assert_eq!(
            got,
            vec![
                (d(10).to_string(), Kind::Exam, Some("14:00".into()), Confidence::High, "calendar".into()),
                (d(17).to_string(), Kind::Quiz, None, Confidence::Medium, "file".into()),
                (d(30).to_string(), Kind::Deliverable, Some("23:59".into()), Confidence::Medium, "syllabus".into()),
            ]
        );
        assert!(!storage.received_requests().await.unwrap()[0].headers.contains_key("authorization"));
        assert!(r.scanned.iter().all(|x| x.name != "Lecture 3.pdf"), "lecture slides are not scanned");
    }

    #[test]
    fn validates_pins() {
        let mut p = PinnedDate { course_id: 1, date: "2026-10-28".into(), time: Some("10:00".into()), label: " Midterm ".into(), kind: "exam".into(), ..Default::default() };
        validate(&mut p).unwrap();
        assert_eq!(p.label, "Midterm");
        assert_eq!(p.id.len(), 16);
        let mut bad = PinnedDate { date: "28/10/2026".into(), label: "x".into(), kind: "exam".into(), ..Default::default() };
        assert!(validate(&mut bad).is_err());
        let mut bad = PinnedDate { date: "2026-10-28".into(), label: "x".into(), kind: "party".into(), ..Default::default() };
        assert!(validate(&mut bad).is_err());
    }
}

// ------------------------------------------------------------ announcements

/// Dates found in announcements: quizzes, exams and due dates are pinned
/// automatically (unless Canvas already lists them as assignments or you
/// removed them before); a "moved" announcement updates the pin it moved.
/// Returns what was added or changed, for the "added from announcement" notice.
pub fn auto_pin(s: &mut crate::state::Session, courses: &[Course], announcements: &[studydesk_core::canvas::models::Announcement]) -> Vec<PinnedDate> {
    if !s.data.prefs.auto_dates {
        return vec![];
    }
    let today = Local::now().date_naive();
    let mut touched = Vec::new();
    for an in announcements {
        let Some(cid) = an.context_code.as_deref().and_then(|c| c.strip_prefix("course_")).and_then(|c| c.parse::<u64>().ok()) else { continue };
        let Some(course) = courses.iter().find(|c| c.id == cid) else { continue };
        let Some(posted) = local_date(&an.posted_at) else { continue };
        let src = Source { kind: "announcement".into(), name: an.title.clone(), url: an.html_url.clone() };
        let found = studydesk_core::announce::extract(&an.title, an.message.as_deref().unwrap_or(""), posted, cid, &src, &ctx_for(course));
        let moved = studydesk_core::announce::mentions_move(&an.title, an.message.as_deref().unwrap_or(""));
        for f in found {
            if touched.len() >= 10 || f.kind == dates::Kind::Info || f.confidence < Confidence::Medium {
                continue;
            }
            let Ok(d) = NaiveDate::parse_from_str(&f.date, "%Y-%m-%d") else { continue };
            if d < today || s.data.prefs.dismissed.contains(&f.id) || s.data.prefs.pinned.iter().any(|p| p.id == f.id) {
                continue;
            }
            let kind = format!("{:?}", f.kind).to_lowercase();
            // Already a Canvas assignment that day? Then it's on your list already.
            let in_canvas = s.upcoming.iter().map(|(_, a)| a).filter(|a| a.course_id == cid && local_date(&a.due_at) == Some(d)).any(|a| f.kind == dates::Kind::Deliverable || dates::same_item(&f.label, f.kind, &a.name));
            if in_canvas {
                continue;
            }
            // Same day, same kind already pinned (by you or the scanner).
            if s.data.prefs.pinned.iter().any(|p| p.course_id == cid && p.date == f.date && p.kind == kind) {
                continue;
            }
            // "Quiz 2 moved to Friday": move the pin rather than adding a second one.
            if moved {
                if let Some(p) = s.data.prefs.pinned.iter_mut().find(|p| p.auto && p.course_id == cid && p.kind == kind && p.date != f.date && dates::same_item(&p.label, f.kind, &f.label)) {
                    p.date = f.date.clone();
                    p.time = f.time.clone().or(p.time.take());
                    p.source = format!("Announcement: {} (moved)", an.title);
                    touched.push(p.clone());
                    continue;
                }
            }
            let pin = PinnedDate {
                id: f.id.clone(),
                course_id: cid,
                date: f.date.clone(),
                time: f.time.clone(),
                label: f.label.chars().take(120).collect(),
                kind,
                weight: f.weight.clone(),
                source: format!("Announcement: {}", an.title.chars().take(100).collect::<String>()),
                auto: true,
                url: an.html_url.clone(),
            };
            s.data.prefs.pinned.push(pin.clone());
            touched.push(pin);
        }
    }
    if !touched.is_empty() {
        s.data.prefs.pinned.sort_by(|a, b| (a.date.as_str(), a.time.as_deref()).cmp(&(b.date.as_str(), b.time.as_deref())));
    }
    touched
}
