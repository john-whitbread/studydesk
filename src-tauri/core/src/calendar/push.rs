//! Keeping the "Studydesk" calendar in iCloud in step with your deadlines.
//! Only changed events are sent; events whose item disappeared are removed.

use super::caldav::{CalDav, PutCond};
use super::ics::{to_ics, OutEvent};
use crate::vault::Pushed;
use crate::{CoreError, Result};
use futures_util::stream::{self, StreamExt};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use url::Url;

/// More than this many changes in one go is almost certainly a bug; stop.
pub const MAX_CHANGES: usize = 600;

/// File name for an event: stable, and free of characters iCloud might mangle.
pub fn file_name(uid: &str) -> String {
    let h = Sha256::digest(uid.as_bytes());
    format!("sd-{}.ics", h.iter().take(10).map(|b| format!("{b:02x}")).collect::<String>())
}

/// Hash of the event's content (DTSTAMP excluded), to detect changes.
pub fn content_hash(e: &OutEvent) -> String {
    let h = Sha256::digest(to_ics(e, 0).as_bytes());
    h.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, Default)]
pub struct Plan {
    /// New or changed: (event, what was written before).
    pub put: Vec<(OutEvent, Option<Pushed>)>,
    /// uid and what was written, for events that should go.
    pub delete: Vec<(String, Pushed)>,
}

pub fn plan(desired: &[OutEvent], pushed: &BTreeMap<String, Pushed>) -> Plan {
    let mut p = Plan::default();
    for e in desired {
        match pushed.get(&e.uid) {
            Some(old) if old.hash == content_hash(e) => {}
            old => p.put.push((e.clone(), old.cloned())),
        }
    }
    for (uid, old) in pushed {
        if !desired.iter().any(|e| &e.uid == uid) {
            p.delete.push((uid.clone(), old.clone()));
        }
    }
    p
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub written: usize,
    pub removed: usize,
    pub failed: usize,
    pub first_error: Option<String>,
}

/// Applies a plan to `calendar`, updating `pushed` for everything that worked.
pub async fn apply(dav: &CalDav, calendar: &Url, plan: Plan, pushed: &mut BTreeMap<String, Pushed>, now_ms: i64) -> Result<Outcome> {
    if plan.put.len() + plan.delete.len() > MAX_CHANGES {
        return Err(CoreError::Invalid(format!("Studydesk stopped: {} calendar changes at once looks wrong.", plan.put.len() + plan.delete.len())));
    }
    let mut out = Outcome::default();
    let puts = stream::iter(plan.put.into_iter().map(|(e, old)| async move {
        let url = calendar.join(&file_name(&e.uid)).map_err(|_| CoreError::Invalid("Bad event address.".into()))?;
        let ics = to_ics(&e, now_ms);
        let first = match &old {
            Some(o) => dav.put(&url, ics.clone(), PutCond::Replace(&o.etag)).await,
            None => dav.put(&url, ics.clone(), PutCond::Create).await,
        };
        // Changed in iCloud meanwhile, or already there from an earlier install:
        // it's our own calendar, so our version wins.
        let etag = match first {
            Err(CoreError::Invalid(m)) if m.contains("changed in iCloud") => dav.put(&url, ics, PutCond::Overwrite).await?,
            Err(CoreError::Api { status: 412, .. }) => dav.put(&url, ics, PutCond::Overwrite).await?,
            other => other?,
        };
        Ok::<_, CoreError>((e.uid.clone(), Pushed { href: url.to_string(), etag, hash: content_hash(&e) }))
    }))
    .buffer_unordered(4)
    .collect::<Vec<_>>()
    .await;
    for r in puts {
        match r {
            Ok((uid, p)) => {
                pushed.insert(uid, p);
                out.written += 1;
            }
            Err(e) => {
                out.failed += 1;
                out.first_error.get_or_insert(e.to_string());
            }
        }
    }
    for (uid, old) in plan.delete {
        let r = match dav.resolve(calendar, &old.href) {
            Ok(u) if u.as_str().starts_with(calendar.as_str()) => dav.delete(&u).await,
            Ok(_) => Ok(()), // never delete outside the Studydesk calendar
            Err(e) => Err(e),
        };
        match r {
            Ok(()) => {
                pushed.remove(&uid);
                out.removed += 1;
            }
            Err(e) => {
                out.failed += 1;
                out.first_error.get_or_insert(e.to_string());
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ev(uid: &str, summary: &str) -> OutEvent {
        OutEvent { uid: uid.into(), summary: summary.into(), description: String::new(), url: None, start: 1_792_000_000_000, end: 1_792_000_900_000, all_day: false }
    }
    #[test]
    fn plans_only_changes() {
        let a = ev("a", "Lab 3");
        let b = ev("b", "PS 6");
        let mut pushed = BTreeMap::new();
        pushed.insert("a".to_string(), Pushed { href: "x/a".into(), etag: "1".into(), hash: content_hash(&a) });
        pushed.insert("gone".to_string(), Pushed { href: "x/g".into(), etag: "1".into(), hash: "h".into() });
        let p = plan(&[a.clone(), b.clone()], &pushed);
        assert_eq!(p.put.iter().map(|(e, _)| e.uid.as_str()).collect::<Vec<_>>(), vec!["b"]);
        assert_eq!(p.delete.iter().map(|(u, _)| u.as_str()).collect::<Vec<_>>(), vec!["gone"]);
        let changed = ev("a", "Lab 3 (extended)");
        let p = plan(&[changed], &pushed);
        assert!(p.put[0].1.is_some(), "replaces with the old etag");
        assert_eq!(file_name("asg-101-1@studydesk.app"), file_name("asg-101-1@studydesk.app"));
        assert!(file_name("x").starts_with("sd-") && file_name("x").ends_with(".ics"));
    }
}
