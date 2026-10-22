//! "What changed" since the last refresh: due dates moved, assignments added
//! or removed, grades posted. Canvas changes these silently; this makes it visible.

use crate::canvas::models::Assignment;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const KEEP_DAYS: i64 = 21;
pub const MAX_CHANGES: usize = 150;

/// What Studydesk remembers about an assignment between refreshes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Snap {
    pub course_id: u64,
    pub name: String,
    pub due_at: Option<String>,
    pub score: Option<f64>,
    pub grade: Option<String>,
    pub graded_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: String,
    /// Unix ms when Studydesk noticed it.
    pub at: i64,
    pub course_id: u64,
    pub assignment_id: u64,
    /// due_moved | due_added | due_removed | new | removed | graded | regraded
    pub kind: String,
    pub name: String,
    pub from: Option<String>,
    pub to: Option<String>,
    pub seen: bool,
}

pub fn snap_of(a: &Assignment) -> Snap {
    let s = a.submission.as_ref();
    Snap {
        course_id: a.course_id,
        name: a.name.clone(),
        due_at: a.due_at.clone(),
        score: s.and_then(|s| s.score),
        grade: s.and_then(|s| s.grade.clone()),
        graded_at: s.and_then(|s| s.graded_at.clone()),
    }
}

fn same_instant(a: &Option<String>, b: &Option<String>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) => match (chrono::DateTime::parse_from_rfc3339(x), chrono::DateTime::parse_from_rfc3339(y)) {
            (Ok(p), Ok(q)) => p == q,
            _ => x == y,
        },
        (None, None) => true,
        _ => false,
    }
}

/// Compares `now` with the previous snapshot. Only courses in `fetched` are
/// compared, so a course that failed to load never looks like "everything removed".
/// An empty previous snapshot is a first run: nothing is reported.
pub fn diff(prev: &BTreeMap<u64, Snap>, now: &[Assignment], fetched: &BTreeSet<u64>, at: i64) -> Vec<Change> {
    if prev.is_empty() {
        return vec![];
    }
    let known_courses: BTreeSet<u64> = prev.values().map(|s| s.course_id).collect();
    let mut out = Vec::new();
    let mut push = |a_id: u64, course_id: u64, kind: &str, name: &str, from: Option<String>, to: Option<String>| {
        let id = format!("{a_id}:{kind}:{}", to.clone().unwrap_or_default());
        out.push(Change { id, at, course_id, assignment_id: a_id, kind: kind.into(), name: name.into(), from, to, seen: false });
    };
    let mut seen_ids = BTreeSet::new();
    for a in now {
        if !fetched.contains(&a.course_id) {
            continue;
        }
        seen_ids.insert(a.id);
        let n = snap_of(a);
        match prev.get(&a.id) {
            // A newly visible course (just un-hidden) isn't "new work".
            None if known_courses.contains(&a.course_id) => push(a.id, a.course_id, "new", &a.name, None, n.due_at.clone()),
            None => {}
            Some(p) => {
                if !same_instant(&p.due_at, &n.due_at) {
                    let kind = match (&p.due_at, &n.due_at) {
                        (None, Some(_)) => "due_added",
                        (Some(_), None) => "due_removed",
                        _ => "due_moved",
                    };
                    push(a.id, a.course_id, kind, &a.name, p.due_at.clone(), n.due_at.clone());
                }
                let had = p.score.is_some() || p.grade.is_some();
                let has = n.score.is_some() || n.grade.is_some();
                let fmt = |s: &Snap| s.score.map(|x| format!("{x}")).or_else(|| s.grade.clone());
                if !had && has {
                    push(a.id, a.course_id, "graded", &a.name, None, fmt(&n));
                } else if had && has && (p.score != n.score || p.grade != n.grade) {
                    push(a.id, a.course_id, "regraded", &a.name, fmt(p), fmt(&n));
                }
            }
        }
    }
    for (id, p) in prev {
        if fetched.contains(&p.course_id) && !seen_ids.contains(id) {
            push(*id, p.course_id, "removed", &p.name, p.due_at.clone(), None);
        }
    }
    out
}

/// Adds new changes (same id = same change, kept once) and drops old ones.
pub fn merge(list: &mut Vec<Change>, new: Vec<Change>, now_ms: i64) {
    for c in new {
        if !list.iter().any(|x| x.id == c.id) {
            list.push(c);
        }
    }
    let cutoff = now_ms - KEEP_DAYS * 86_400_000;
    list.retain(|c| c.at >= cutoff);
    list.sort_by(|a, b| b.at.cmp(&a.at));
    list.truncate(MAX_CHANGES);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(id: u64, course: u64, due: Option<&str>, score: Option<f64>) -> Assignment {
        let mut x: Assignment = serde_json::from_value(serde_json::json!({"id": id, "course_id": course, "name": format!("A{id}"), "due_at": due})).unwrap();
        if let Some(s) = score {
            x.submission = serde_json::from_value(serde_json::json!({"score": s, "workflow_state": "graded"})).unwrap();
        }
        x
    }

    #[test]
    fn detects_moves_new_removed_and_grades() {
        let before = [a(1, 10, Some("2026-10-22T23:59:00Z"), None), a(2, 10, None, None), a(3, 10, Some("2026-10-30T15:00:00Z"), None), a(9, 20, None, None)];
        let prev: BTreeMap<u64, Snap> = before.iter().map(|x| (x.id, snap_of(x))).collect();
        let now = [
            a(1, 10, Some("2026-10-26T23:59:00Z"), None),  // moved
            a(2, 10, None, Some(18.0)),                     // graded
            a(4, 10, Some("2026-11-02T23:59:00Z"), None),  // new
            a(5, 30, None, None),                           // newly visible course: ignored
            // 3 removed; course 20 failed to load, so 9 is not "removed"
        ];
        let fetched = BTreeSet::from([10, 30]);
        let ch = diff(&prev, &now, &fetched, 1000);
        let kinds: Vec<(u64, &str)> = ch.iter().map(|c| (c.assignment_id, c.kind.as_str())).collect();
        assert_eq!(kinds, vec![(1, "due_moved"), (2, "graded"), (4, "new"), (3, "removed")]);
        assert_eq!(ch[0].from.as_deref(), Some("2026-10-22T23:59:00Z"));
        assert_eq!(ch[1].to.as_deref(), Some("18"));
        // Same instant written differently is not a move.
        let p2: BTreeMap<u64, Snap> = [(1, Snap { course_id: 10, due_at: Some("2026-10-22T19:59:00-04:00".into()), ..Default::default() })].into();
        assert!(diff(&p2, &[a(1, 10, Some("2026-10-22T23:59:00Z"), None)], &BTreeSet::from([10]), 0).is_empty());
        // First run reports nothing.
        assert!(diff(&BTreeMap::new(), &now, &fetched, 0).is_empty());
    }

    #[test]
    fn merge_dedupes_and_expires() {
        let mk = |id: &str, at: i64| Change { id: id.into(), at, course_id: 1, assignment_id: 1, kind: "new".into(), name: "x".into(), from: None, to: None, seen: false };
        let mut list = vec![mk("a", 0)];
        let day = 86_400_000;
        merge(&mut list, vec![mk("a", 5 * day), mk("b", 30 * day)], 30 * day);
        assert_eq!(list.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["b"], "a is older than 21 days");
    }
}
