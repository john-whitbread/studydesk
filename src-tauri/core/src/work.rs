//! Your own work on an assignment: requirements checklist, rubric self-check,
//! notes and time estimate. Stored in the encrypted vault, keyed "course:assignment".

use crate::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_NOTES: usize = 20_000;
pub const MAX_ITEMS: usize = 60;
pub const MAX_ITEM_TEXT: usize = 300;
pub const MAX_ENTRIES: usize = 2_000;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct CheckItem {
    pub text: String,
    pub done: bool,
    /// Came from the description (false = you added it).
    pub auto: bool,
    /// Appeared after the description changed.
    pub new: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct RubricCheck {
    pub done: bool,
    /// Your own estimate of the points you'd get.
    pub score: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkItem {
    pub checklist: Vec<CheckItem>,
    /// Rubric criterion id -> your tick and self-score.
    pub rubric: BTreeMap<String, RubricCheck>,
    pub notes: String,
    /// Your estimate in hours (None = use the default for the type).
    pub hours: Option<f64>,
    /// Hash of the description the checklist was built from.
    pub desc_hash: String,
    /// Unix ms of the last change.
    pub updated: i64,
}

/// "123:456" with both parts numeric.
pub fn check_key(k: &str) -> Result<()> {
    let ok = k.split_once(':').is_some_and(|(a, b)| !a.is_empty() && !b.is_empty() && a.len() < 20 && b.len() < 20 && a.bytes().chain(b.bytes()).all(|c| c.is_ascii_digit()));
    if ok { Ok(()) } else { Err(CoreError::Invalid("Bad assignment key.".into())) }
}

/// Trims and caps everything so a bug in the page can't bloat the vault.
pub fn sanitize(mut w: WorkItem) -> Result<WorkItem> {
    if w.notes.chars().count() > MAX_NOTES {
        return Err(CoreError::Invalid(format!("Notes are limited to {MAX_NOTES} characters.")));
    }
    if w.checklist.len() > MAX_ITEMS {
        return Err(CoreError::Invalid(format!("A checklist can have up to {MAX_ITEMS} items.")));
    }
    for it in &mut w.checklist {
        it.text = it.text.trim().chars().take(MAX_ITEM_TEXT).collect();
    }
    w.checklist.retain(|i| !i.text.is_empty());
    if w.rubric.len() > 100 {
        return Err(CoreError::Invalid("Too many rubric rows.".into()));
    }
    w.rubric.retain(|k, _| !k.is_empty() && k.len() <= 64);
    for r in w.rubric.values_mut() {
        r.score = r.score.filter(|s| s.is_finite() && *s >= 0.0 && *s <= 10_000.0);
    }
    w.hours = w.hours.filter(|h| h.is_finite() && *h > 0.0 && *h <= 500.0);
    w.desc_hash = w.desc_hash.chars().take(64).collect();
    Ok(w)
}

/// Nothing worth keeping.
pub fn is_empty(w: &WorkItem) -> bool {
    w.checklist.is_empty() && w.rubric.values().all(|r| !r.done && r.score.is_none()) && w.notes.trim().is_empty() && w.hours.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keys_and_limits() {
        assert!(check_key("101:7").is_ok());
        for bad in ["", "101", "a:1", "1:", "1:2:3", "../1:2"] {
            assert!(check_key(bad).is_err(), "{bad}");
        }
        let w = WorkItem { notes: "x".repeat(MAX_NOTES + 1), ..Default::default() };
        assert!(sanitize(w).is_err());
        let w = sanitize(WorkItem { checklist: vec![CheckItem { text: "  ".into(), ..Default::default() }, CheckItem { text: " FBD ".into(), ..Default::default() }], hours: Some(f64::NAN), ..Default::default() }).unwrap();
        assert_eq!(w.checklist.len(), 1);
        assert_eq!(w.checklist[0].text, "FBD");
        assert_eq!(w.hours, None);
        assert!(is_empty(&WorkItem::default()));
    }
}
