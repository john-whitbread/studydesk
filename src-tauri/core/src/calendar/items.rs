//! Which Studydesk items go into your Apple calendar, and how they read there.

use super::ics::OutEvent;
use crate::canvas::models::Assignment;
use crate::reminders::needs_action;
use crate::vault::PinnedDate;
use chrono::{DateTime, Duration, Local, NaiveDate, NaiveTime, TimeZone, Utc};
use std::collections::{BTreeSet, HashMap};

const BACK_DAYS: i64 = 14;
const AHEAD_DAYS: i64 = 200;

fn kind_label(k: &str) -> &'static str {
    match k {
        "exam" => "Exam",
        "quiz" => "Quiz",
        "deliverable" => "Due",
        _ => "Note",
    }
}

fn submitted(a: &Assignment) -> bool {
    a.submission.as_ref().is_some_and(|s| s.submitted_at.is_some() || matches!(s.workflow_state.as_deref(), Some("submitted" | "graded" | "pending_review")))
}

/// `assignments`: (course code, assignment). `codes`: course id -> code, for pins.
pub fn desired(assignments: &[(String, Assignment)], pins: &[PinnedDate], codes: &HashMap<u64, String>, hidden: &BTreeSet<u64>, now: DateTime<Utc>) -> Vec<OutEvent> {
    let (lo, hi) = (now - Duration::days(BACK_DAYS), now + Duration::days(AHEAD_DAYS));
    let mut out = Vec::new();
    for (code, a) in assignments {
        if hidden.contains(&a.course_id) {
            continue;
        }
        let Some(due) = a.due_at.as_deref().and_then(|d| DateTime::parse_from_rfc3339(d).ok()).map(|d| d.with_timezone(&Utc)) else { continue };
        if due < lo || due > hi {
            continue;
        }
        let done = submitted(a);
        let mark = if done { "✓ " } else { "" };
        let summary = if code.is_empty() { format!("{mark}{}", a.name) } else { format!("{mark}{code} – {}", a.name) };
        let mut desc = vec![format!("Due {}", due.with_timezone(&Local).format("%a %b %-d, %-I:%M %p"))];
        if let Some(p) = a.points_possible.filter(|p| *p > 0.0) {
            desc.push(format!("{} pts", if p.fract() == 0.0 { format!("{p:.0}") } else { format!("{p}") }));
        }
        if done {
            desc.push("Submitted".into());
        } else if !needs_action(a, now) {
            desc.push("Not submitted online".into());
        }
        desc.push("Added by Studydesk".into());
        out.push(OutEvent {
            uid: format!("asg-{}-{}@studydesk.app", a.course_id, a.id),
            summary,
            description: desc.join(" · "),
            url: a.html_url.clone().filter(|u| u.starts_with("https://")),
            // At the due time; zero length so it never spills into the next day.
            start: due.timestamp_millis(),
            end: due.timestamp_millis(),
            all_day: false,
        });
    }
    for p in pins {
        if hidden.contains(&p.course_id) {
            continue;
        }
        let Ok(d) = NaiveDate::parse_from_str(&p.date, "%Y-%m-%d") else { continue };
        let time = p.time.as_deref().and_then(|t| NaiveTime::parse_from_str(t, "%H:%M").ok());
        let Some(start) = Local.from_local_datetime(&d.and_time(time.unwrap_or_default())).earliest() else { continue };
        let start = start.with_timezone(&Utc);
        if start < lo || start > hi {
            continue;
        }
        let code = codes.get(&p.course_id).cloned().unwrap_or_default();
        let what = if code.is_empty() { p.label.clone() } else { format!("{code} – {}", p.label) };
        let mut desc = Vec::new();
        if let Some(w) = p.weight.as_deref().filter(|w| !w.is_empty()) {
            desc.push(format!("{w} of grade"));
        }
        if !p.source.is_empty() {
            desc.push(format!("From {}", p.source));
        }
        desc.push("Key date added by Studydesk".into());
        out.push(OutEvent {
            uid: format!("pin-{}@studydesk.app", p.id),
            summary: format!("{}: {what}", kind_label(&p.kind)),
            description: desc.join(" · "),
            url: None,
            start: start.timestamp_millis(),
            end: (start + if time.is_some() { Duration::hours(1) } else { Duration::days(1) }).timestamp_millis(),
            all_day: time.is_none(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asg(id: u64, course: u64, name: &str, due: Option<&str>, submitted: bool) -> Assignment {
        let mut a: Assignment = serde_json::from_value(serde_json::json!({
            "id": id, "course_id": course, "name": name, "due_at": due, "submission_types": ["online_upload"],
            "html_url": format!("https://canvas.example.edu/courses/{course}/assignments/{id}")
        }))
        .unwrap();
        if submitted {
            a.submission = serde_json::from_value(serde_json::json!({"workflow_state": "submitted", "submitted_at": "2026-10-17T12:00:00Z"})).unwrap();
        }
        a
    }

    #[test]
    fn builds_events() {
        let now = DateTime::parse_from_rfc3339("2026-10-18T12:00:00Z").unwrap().with_timezone(&Utc);
        let items = vec![
            ("MECE 2420U".to_string(), asg(1, 101, "Lab 3", Some("2026-10-19T03:59:00Z"), false)),
            ("MECE 2420U".to_string(), asg(2, 101, "PS 5", Some("2026-10-15T21:00:00Z"), true)),
            ("MECE 2420U".to_string(), asg(3, 101, "No date", None, false)),
            ("MECE 2420U".to_string(), asg(4, 101, "Long ago", Some("2026-01-01T00:00:00Z"), false)),
            ("ENGR 2310U".to_string(), asg(5, 105, "Hidden course", Some("2026-10-20T00:00:00Z"), false)),
        ];
        let pins = vec![PinnedDate { id: "p1".into(), course_id: 101, date: "2026-10-28".into(), time: Some("10:00".into()), label: "Midterm".into(), kind: "exam".into(), weight: Some("25%".into()), source: "Course outline.pdf".into(), ..Default::default() }];
        let codes = HashMap::from([(101, "MECE 2420U".to_string())]);
        let hidden = BTreeSet::from([105]);
        let ev = desired(&items, &pins, &codes, &hidden, now);
        let s: Vec<&str> = ev.iter().map(|e| e.summary.as_str()).collect();
        assert_eq!(s, vec!["MECE 2420U – Lab 3", "✓ MECE 2420U – PS 5", "Exam: MECE 2420U – Midterm"]);
        assert_eq!(ev[0].uid, "asg-101-1@studydesk.app");
        assert_eq!(ev[0].start, ev[0].end);
        assert!(ev[0].url.as_deref().unwrap().starts_with("https://canvas.example.edu/"));
        assert_eq!(ev[2].end - ev[2].start, 3_600_000);
        assert!(ev[2].description.contains("25% of grade"));
    }
}
