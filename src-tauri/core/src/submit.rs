//! Pre-flight checks for a submission. The UI shows exactly this list, and
//! the backend re-runs it against a freshly fetched assignment immediately
//! before uploading, so what you see is what is enforced.

use crate::canvas::models::Assignment;
use chrono::{DateTime, Local, Utc};
use serde::Serialize;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Files,
    Text,
    Url,
}

impl Kind {
    pub fn canvas_type(self) -> &'static str {
        match self {
            Kind::Files => "online_upload",
            Kind::Text => "online_text_entry",
            Kind::Url => "online_url",
        }
    }
}

#[derive(Clone, Debug)]
pub struct FileFacts {
    pub name: String,
    pub size: u64,
    pub ext: String,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Preflight {
    /// Any entry here blocks submitting.
    pub problems: Vec<String>,
    /// Shown, but don't block.
    pub warnings: Vec<String>,
    /// Number this submission will be, e.g. 2 for a resubmission.
    pub next_attempt: i64,
    /// None = unlimited.
    pub allowed_attempts: Option<i64>,
}

pub fn parse_time(s: &Option<String>) -> Option<DateTime<Utc>> {
    s.as_deref().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.with_timezone(&Utc))
}

pub fn fmt_local(t: DateTime<Utc>) -> String {
    t.with_timezone(&Local).format("%a %b %-d, %-I:%M %p").to_string()
}

pub fn fmt_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1000 {
        return format!("{bytes} B");
    }
    let mut v = bytes as f64;
    let mut i = 0;
    v /= 1000.0;
    while v >= 1000.0 && i < UNITS.len() - 1 {
        v /= 1000.0;
        i += 1;
    }
    if v < 10.0 { format!("{v:.1} {}", UNITS[i]) } else { format!("{v:.0} {}", UNITS[i]) }
}

pub fn type_label(t: &str) -> &str {
    match t {
        "online_upload" => "file upload",
        "online_text_entry" => "text entry",
        "online_url" => "website URL",
        "media_recording" => "media recording",
        "student_annotation" => "student annotation",
        "online_quiz" => "quiz",
        "discussion_topic" => "discussion",
        "external_tool" => "external tool",
        "on_paper" => "on paper",
        "none" => "no submission",
        other => other,
    }
}

pub fn preflight(a: &Assignment, kind: Kind, files: &[FileFacts], now: DateTime<Utc>) -> Preflight {
    let mut p = Preflight::default();
    let sub = a.submission.as_ref();
    let used = sub.and_then(|s| s.attempt).unwrap_or(0).max(0);
    p.next_attempt = used + 1;
    p.allowed_attempts = a.allowed_attempts.filter(|n| *n > 0);

    if !a.submission_types.iter().any(|t| t == kind.canvas_type()) {
        let accepted: Vec<&str> = a.submission_types.iter().map(|t| type_label(t)).collect();
        p.problems.push(format!(
            "This assignment doesn't accept a {}. It accepts: {}.",
            type_label(kind.canvas_type()),
            if accepted.is_empty() { "nothing online".to_string() } else { accepted.join(", ") }
        ));
    }
    if a.locked_for_user == Some(true) {
        p.problems.push(a.lock_explanation.clone().filter(|s| !s.trim().is_empty()).map(strip_tags).unwrap_or_else(|| "This assignment is locked.".into()));
    } else {
        if let Some(u) = parse_time(&a.unlock_at).filter(|u| *u > now) {
            p.problems.push(format!("Not open until {}.", fmt_local(u)));
        }
        if let Some(l) = parse_time(&a.lock_at).filter(|l| *l <= now) {
            p.problems.push(format!("Closed on {}. Canvas no longer accepts submissions.", fmt_local(l)));
        }
    }
    if let Some(max) = p.allowed_attempts {
        if used >= max {
            p.problems.push(format!("You've used all {max} allowed attempts."));
        }
    }
    if sub.and_then(|s| s.excused) == Some(true) {
        p.warnings.push("You're excused from this assignment.".into());
    }

    if kind == Kind::Files {
        if files.is_empty() {
            p.problems.push("Choose at least one file.".into());
        }
        let allowed: Vec<String> = a.allowed_extensions.iter().map(|e| e.trim_start_matches('.').to_ascii_lowercase()).collect();
        for f in files {
            if f.size == 0 {
                p.problems.push(format!("{} is empty (0 bytes).", f.name));
            }
            if !allowed.is_empty() && !allowed.contains(&f.ext.to_ascii_lowercase()) {
                let shown = if f.ext.is_empty() { "files without an extension".to_string() } else { format!(".{}", f.ext) };
                p.problems.push(format!("{}: {} not accepted. Allowed: {}.", f.name, shown, allowed.join(", ")));
            }
        }
        let mut names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        names.sort_unstable();
        if names.windows(2).any(|w| w[0].eq_ignore_ascii_case(w[1])) {
            p.warnings.push("Two selected files have the same name.".into());
        }
    }

    // Late warning whenever Canvas would still accept it (not when it's closed).
    let closed = a.locked_for_user == Some(true) || parse_time(&a.lock_at).is_some_and(|l| l <= now);
    if let Some(due) = parse_time(&a.due_at).filter(|d| *d < now) {
        if !closed {
            p.warnings.push(format!("Past the due date ({}). Canvas will mark this late.", fmt_local(due)));
        }
    }
    if used > 0 {
        p.warnings.push(format!("You already submitted. This becomes attempt {}.", used + 1));
    }
    p
}

/// Text for the native confirmation dialog.
pub fn confirm_text(a: &Assignment, course_label: &str, what: &str, pf: &Preflight, now: DateTime<Utc>) -> String {
    let mut s = format!("Assignment: {}\nCourse: {}\n{}\n", a.name, course_label, what);
    match parse_time(&a.due_at) {
        Some(d) => s.push_str(&format!("Due: {}{}\n", fmt_local(d), if d < now { " (past due)" } else { "" })),
        None => s.push_str("Due: no due date\n"),
    }
    match pf.allowed_attempts {
        Some(n) => s.push_str(&format!("Attempt: {} of {}\n", pf.next_attempt, n)),
        None => s.push_str(&format!("Attempt: {}\n", pf.next_attempt)),
    }
    for w in &pf.warnings {
        s.push_str(&format!("\n• {w}"));
    }
    s.push_str("\n\nThis can't be undone.");
    s
}

fn strip_tags(s: String) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canvas::models::Submission;
    use chrono::TimeZone;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 18, 12, 0, 0).unwrap()
    }
    fn base() -> Assignment {
        Assignment {
            id: 1,
            course_id: 2,
            name: "Lab 3".into(),
            submission_types: vec!["online_upload".into()],
            allowed_extensions: vec!["pdf".into(), "DOCX".into()],
            due_at: Some("2026-10-20T03:59:00Z".into()),
            allowed_attempts: Some(2),
            ..Default::default()
        }
    }
    fn pdf() -> FileFacts {
        FileFacts { name: "report.pdf".into(), size: 1200, ext: "pdf".into() }
    }

    #[test]
    fn clean_submission() {
        let p = preflight(&base(), Kind::Files, &[pdf()], now());
        assert_eq!(p.problems, Vec::<String>::new());
        assert_eq!(p.warnings, Vec::<String>::new());
        assert_eq!(p.next_attempt, 1);
        assert_eq!(p.allowed_attempts, Some(2));
    }

    #[test]
    fn extension_case_insensitive_and_rejects_others() {
        let docx = FileFacts { name: "a.docx".into(), size: 5, ext: "docx".into() };
        assert!(preflight(&base(), Kind::Files, &[docx], now()).problems.is_empty());
        let png = FileFacts { name: "a.png".into(), size: 5, ext: "png".into() };
        let p = preflight(&base(), Kind::Files, &[png], now());
        assert_eq!(p.problems, vec!["a.png: .png not accepted. Allowed: pdf, docx.".to_string()]);
    }

    #[test]
    fn empty_and_missing_files() {
        assert!(preflight(&base(), Kind::Files, &[], now()).problems[0].contains("at least one"));
        let empty = FileFacts { size: 0, ..pdf() };
        assert!(preflight(&base(), Kind::Files, &[empty], now()).problems[0].contains("empty"));
    }

    #[test]
    fn attempts_exhausted() {
        let mut a = base();
        a.submission = Some(Submission { attempt: Some(2), ..Default::default() });
        let p = preflight(&a, Kind::Files, &[pdf()], now());
        assert!(p.problems.iter().any(|m| m.contains("all 2 allowed attempts")));
    }

    #[test]
    fn resubmission_warns() {
        let mut a = base();
        a.submission = Some(Submission { attempt: Some(1), ..Default::default() });
        let p = preflight(&a, Kind::Files, &[pdf()], now());
        assert!(p.problems.is_empty());
        assert_eq!(p.next_attempt, 2);
        assert!(p.warnings[0].contains("attempt 2"));
    }

    #[test]
    fn unlimited_attempts() {
        let mut a = base();
        a.allowed_attempts = Some(-1);
        a.submission = Some(Submission { attempt: Some(9), ..Default::default() });
        let p = preflight(&a, Kind::Files, &[pdf()], now());
        assert!(p.problems.is_empty());
        assert_eq!(p.allowed_attempts, None);
    }

    #[test]
    fn closed_and_not_yet_open() {
        let mut a = base();
        a.lock_at = Some("2026-10-18T11:59:59Z".into());
        assert!(preflight(&a, Kind::Files, &[pdf()], now()).problems[0].starts_with("Closed on"));
        let mut a = base();
        a.unlock_at = Some("2026-10-19T00:00:00Z".into());
        assert!(preflight(&a, Kind::Files, &[pdf()], now()).problems[0].starts_with("Not open until"));
        let mut a = base();
        a.locked_for_user = Some(true);
        a.lock_explanation = Some("<p>This assignment is locked until <b>Oct 30</b>.</p>".into());
        assert_eq!(preflight(&a, Kind::Files, &[pdf()], now()).problems[0], "This assignment is locked until Oct 30.");
    }

    #[test]
    fn late_warning_only() {
        let mut a = base();
        a.due_at = Some("2026-10-17T03:59:00Z".into());
        let p = preflight(&a, Kind::Files, &[pdf()], now());
        assert!(p.problems.is_empty());
        assert!(p.warnings[0].starts_with("Past the due date"));
    }

    #[test]
    fn wrong_submission_type() {
        let mut a = base();
        a.submission_types = vec!["online_quiz".into()];
        let p = preflight(&a, Kind::Files, &[pdf()], now());
        assert_eq!(p.problems[0], "This assignment doesn't accept a file upload. It accepts: quiz.");
        assert!(preflight(&base(), Kind::Text, &[], now()).problems[0].contains("text entry"));
    }

    #[test]
    fn sizes() {
        assert_eq!(fmt_size(999), "999 B");
        assert_eq!(fmt_size(2_400_000), "2.4 MB");
        assert_eq!(fmt_size(45_000), "45 KB");
    }
}
