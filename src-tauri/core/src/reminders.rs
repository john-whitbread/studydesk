//! Deadline reminders: one Windows notification 24 h before and one 2 h
//! before anything you still need to submit. Keys are remembered (in the
//! vault) so a reminder is never shown twice, even across restarts. A changed
//! due date produces a new key, so extensions get fresh reminders.

use crate::canvas::models::Assignment;
use crate::submit::{fmt_local, parse_time};
use chrono::{DateTime, Duration, Utc};
use std::collections::BTreeSet;

const OFFLINE: [&str; 4] = ["none", "on_paper", "not_graded", "wiki_page"];
const LEADS: [(i64, &str); 2] = [(24 * 60, "24h"), (2 * 60, "2h")];

#[derive(Debug, Clone, PartialEq)]
pub struct Reminder {
    pub keys: Vec<String>,
    pub title: String,
    pub body: String,
}

/// Same rule as the UI's "needs action": not submitted, not excused, takes an
/// online submission, and not closed.
pub fn needs_action(a: &Assignment, now: DateTime<Utc>) -> bool {
    let s = a.submission.as_ref();
    if s.and_then(|s| s.excused) == Some(true) {
        return false;
    }
    if s.is_some_and(|s| s.submitted_at.is_some() || matches!(s.workflow_state.as_deref(), Some("submitted" | "graded" | "pending_review"))) {
        return false;
    }
    if a.submission_types.is_empty() || a.submission_types.iter().all(|t| OFFLINE.contains(&t.as_str())) {
        return false;
    }
    if a.locked_for_user == Some(true) || parse_time(&a.lock_at).is_some_and(|l| l <= now) {
        return false;
    }
    true
}

fn left(d: Duration) -> String {
    let m = d.num_minutes().max(0);
    if m < 60 {
        format!("{m} min")
    } else if m < 6 * 60 && m % 60 != 0 {
        format!("{} h {} min", m / 60, m % 60)
    } else {
        format!("{} h", (m + 30) / 60)
    }
}

/// Anything with a deadline: an assignment, or a date you pinned.
#[derive(Debug, Clone)]
pub struct Item {
    /// Stable identity including the due time, so a moved date re-arms.
    pub key_base: String,
    pub name: String,
    pub course: String,
    pub due: DateTime<Utc>,
}

/// `items` = (course label, assignment). Keeps only those still needing action.
pub fn from_assignments(items: &[(String, Assignment)], now: DateTime<Utc>) -> Vec<Item> {
    items
        .iter()
        .filter(|(_, a)| needs_action(a, now))
        .filter_map(|(course, a)| {
            Some(Item {
                key_base: format!("{}:{}:{}", a.course_id, a.id, a.due_at.as_deref()?),
                name: a.name.clone(),
                course: course.clone(),
                due: parse_time(&a.due_at)?,
            })
        })
        .collect()
}

pub fn due(items: &[(String, Assignment)], now: DateTime<Utc>, already: &BTreeSet<String>) -> Vec<Reminder> {
    due_items(&from_assignments(items, now), now, already)
}

pub fn due_items(items: &[Item], now: DateTime<Utc>, already: &BTreeSet<String>) -> Vec<Reminder> {
    let mut out = Vec::new();
    for it in items {
        let (due, course, base) = (it.due, &it.course, &it.key_base);
        if due <= now {
            continue;
        }
        // Leads that have been reached, e.g. both 24h and 2h when first seen at 1 h out.
        let reached: Vec<&str> = LEADS.iter().filter(|(mins, _)| due - now <= Duration::minutes(*mins)).map(|(_, l)| *l).collect();
        let fresh: Vec<String> = reached.iter().map(|l| format!("{base}:{l}")).filter(|k| !already.contains(k)).collect();
        if fresh.is_empty() {
            continue;
        }
        out.push(Reminder {
            keys: reached.iter().map(|l| format!("{base}:{l}")).collect(),
            title: format!("Due in {}: {}", left(due - now), it.name),
            body: format!("{course} · {}", fmt_local(due)),
        });
    }
    out
}

/// Drops keys for deadlines more than two days past, so the set stays small.
pub fn prune(notified: &mut BTreeSet<String>, now: DateTime<Utc>) {
    notified.retain(|k| {
        // key = course:assignment:<rfc3339>:lead; the timestamp itself contains ':'
        let parts: Vec<&str> = k.splitn(3, ':').collect();
        let ts = parts.get(2).and_then(|rest| rest.rsplit_once(':')).map(|(t, _)| t.to_string());
        match ts.and_then(|t| DateTime::parse_from_rfc3339(&t).ok()) {
            Some(t) => t.with_timezone(&Utc) > now - Duration::days(2),
            None => false,
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canvas::models::Submission;
    use chrono::TimeZone;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 18, 12, 0, 0).unwrap()
    }
    fn a(due: &str) -> Assignment {
        Assignment { id: 5, course_id: 9, name: "Lab 3".into(), due_at: Some(due.into()), submission_types: vec!["online_upload".into()], ..Default::default() }
    }

    #[test]
    fn fires_24h_then_2h_once_each() {
        let items = vec![("MECE 2420U".to_string(), a("2026-10-19T03:00:00Z"))]; // 15 h out
        let mut seen = BTreeSet::new();
        let r = due(&items, now(), &seen);
        assert_eq!(r.len(), 1);
        assert!(r[0].title.starts_with("Due in 15 h: Lab 3"));
        assert_eq!(r[0].keys, vec!["9:5:2026-10-19T03:00:00Z:24h".to_string()]);
        seen.extend(r[0].keys.clone());
        assert!(due(&items, now(), &seen).is_empty(), "no repeat");
        let later = now() + Duration::hours(13) + Duration::minutes(30); // 1.5 h out
        let r = due(&items, later, &seen);
        assert_eq!(r.len(), 1);
        assert!(r[0].title.starts_with("Due in 1 h 30 min"));
    }

    #[test]
    fn first_seen_close_marks_both() {
        let items = vec![("C".to_string(), a("2026-10-18T13:00:00Z"))];
        let r = due(&items, now(), &BTreeSet::new());
        assert_eq!(r[0].keys.len(), 2);
        assert_eq!(r[0].title, "Due in 60 min: Lab 3".replace("60 min", "1 h"));
    }

    #[test]
    fn skips_submitted_offline_closed_and_far() {
        let mut s = a("2026-10-18T20:00:00Z");
        s.submission = Some(Submission { submitted_at: Some("x".into()), ..Default::default() });
        let mut off = a("2026-10-18T20:00:00Z");
        off.submission_types = vec!["on_paper".into()];
        let mut closed = a("2026-10-18T20:00:00Z");
        closed.lock_at = Some("2026-10-18T11:00:00Z".into());
        let far = a("2026-10-25T20:00:00Z");
        let past = a("2026-10-18T11:00:00Z");
        let items: Vec<_> = [s, off, closed, far, past].into_iter().map(|x| ("C".to_string(), x)).collect();
        assert!(due(&items, now(), &BTreeSet::new()).is_empty());
    }

    #[test]
    fn extension_gets_new_key_and_prune_works() {
        let mut seen: BTreeSet<String> = ["9:5:2026-10-19T03:00:00Z:24h".to_string()].into();
        let items = vec![("C".to_string(), a("2026-10-19T06:00:00Z"))];
        assert_eq!(due(&items, now(), &seen).len(), 1, "new due date, new reminder");
        seen.insert("9:5:2026-10-10T03:00:00Z:2h".into());
        prune(&mut seen, now());
        assert!(seen.contains("9:5:2026-10-19T03:00:00Z:24h"));
        assert!(!seen.iter().any(|k| k.contains("2026-10-10")));
    }
}
