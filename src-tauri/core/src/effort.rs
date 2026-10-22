//! How much work something is, in hours. Defaults by kind; your own estimate
//! (per assignment) or your own defaults (per kind) win. Mirrors src/lib/effort.ts.

use std::collections::BTreeMap;

/// Kinds of work with a default estimate in hours.
pub const KINDS: [(&str, &str, f64); 8] = [
    ("exam", "Exam prep", 8.0),
    ("project", "Project / report", 8.0),
    ("lab", "Lab", 4.0),
    ("problem_set", "Problem set", 3.0),
    ("essay", "Essay / writing", 5.0),
    ("quiz", "Quiz", 1.0),
    ("short", "Short task (reflection, post)", 1.0),
    ("other", "Other", 2.0),
];

fn has(n: &str, words: &[&str]) -> bool {
    words.iter().any(|w| {
        n.match_indices(w).any(|(i, _)| {
            let before = n[..i].chars().last();
            let after = n[i + w.len()..].chars().next();
            !before.is_some_and(|c| c.is_alphanumeric()) && !after.is_some_and(|c| c.is_alphabetic())
        })
    })
}

/// The kind of work an assignment is, from its name and how it's submitted.
pub fn kind_of(name: &str, submission_types: &[String], is_quiz: bool) -> &'static str {
    let n = name.to_lowercase();
    if is_quiz || submission_types.iter().any(|t| t == "online_quiz") || has(&n, &["quiz", "test"]) {
        return "quiz";
    }
    if has(&n, &["midterm", "final exam", "exam"]) {
        return "exam";
    }
    if has(&n, &["project", "report", "design", "proposal", "presentation", "poster", "capstone", "milestone"]) {
        return "project";
    }
    if has(&n, &["lab", "laboratory", "experiment"]) {
        return "lab";
    }
    if has(&n, &["essay", "paper", "case study", "literature review", "memo"]) {
        return "essay";
    }
    if has(&n, &["problem set", "ps", "pset", "homework", "hw", "assignment", "webwork", "tutorial", "exercise", "worksheet"]) {
        return "problem_set";
    }
    if has(&n, &["reflection", "discussion", "post", "response", "survey", "check-in", "attendance", "participation"])
        || submission_types.iter().any(|t| t == "discussion_topic")
    {
        return "short";
    }
    "other"
}

/// Hours for `kind`: your default if set, else Studydesk's.
pub fn default_hours(kind: &str, mine: &BTreeMap<String, f64>) -> f64 {
    mine.get(kind).copied().filter(|h| h.is_finite() && *h > 0.0).unwrap_or_else(|| KINDS.iter().find(|k| k.0 == kind).map_or(2.0, |k| k.2))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn k(n: &str) -> &'static str {
        kind_of(n, &["online_upload".to_string()], false)
    }
    #[test]
    fn kinds() {
        assert_eq!(k("Lab 3 – Thick-walled cylinders"), "lab");
        assert_eq!(k("Problem Set 6 – Torsion"), "problem_set");
        assert_eq!(k("PS6"), "problem_set", "a number may follow the word");
        assert_eq!(k("PS 6"), "problem_set");
        assert_eq!(k("Final project report"), "project");
        assert_eq!(k("Reflection – CANDU site visit"), "short");
        assert_eq!(k("Midterm exam"), "exam");
        assert_eq!(k("Collaboration"), "other", "'lab' inside a word doesn't count");
        assert_eq!(kind_of("Week 7", &["online_quiz".into()], false), "quiz");
        let mut mine = BTreeMap::new();
        assert_eq!(default_hours("lab", &mine), 4.0);
        mine.insert("lab".into(), 6.0);
        assert_eq!(default_hours("lab", &mine), 6.0);
        assert_eq!(default_hours("unknown", &mine), 2.0);
    }
}
