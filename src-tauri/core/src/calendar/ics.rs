//! iCalendar (RFC 5545) reading and writing: just what calendars from Apple,
//! Google and Outlook need. Reading expands repeating events (RRULE, EXDATE,
//! moved or cancelled occurrences) into concrete occurrences in a window;
//! writing produces one VEVENT per Studydesk deadline.

use chrono::{DateTime, Duration, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use rrule::{RRule, RRuleSet, Tz, Unvalidated};
use std::collections::HashMap;
use std::str::FromStr;

/// One concrete event in the requested window.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Occurrence {
    pub uid: String,
    pub title: String,
    pub location: String,
    /// Unix ms. For all-day events: local midnight of the first day.
    pub start: i64,
    /// Unix ms, exclusive. For all-day events: local midnight after the last day.
    pub end: i64,
    pub all_day: bool,
}

const MAX_PER_EVENT: u16 = 1000;
const MAX_TOTAL: usize = 5000;

// ---------------------------------------------------------------- lexing

#[derive(Debug, Clone)]
struct Prop {
    name: String,
    params: Vec<(String, String)>,
    value: String,
}

impl Prop {
    fn param(&self, k: &str) -> Option<&str> {
        self.params.iter().find(|(n, _)| n.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str())
    }
}

/// Joins folded lines (a line starting with a space or tab continues the previous one).
fn unfold(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = line.strip_prefix(' ').or_else(|| line.strip_prefix('\t')) {
            if let Some(last) = out.last_mut() {
                last.push_str(rest);
                continue;
            }
        }
        if !line.is_empty() {
            out.push(line.to_string());
        }
    }
    out
}

fn parse_prop(line: &str) -> Option<Prop> {
    // The value starts at the first ':' that isn't inside a quoted parameter.
    let mut in_q = false;
    let mut colon = None;
    for (i, ch) in line.char_indices() {
        match ch {
            '"' => in_q = !in_q,
            ':' if !in_q => {
                colon = Some(i);
                break;
            }
            _ => {}
        }
    }
    let colon = colon?;
    let (head, value) = (&line[..colon], &line[colon + 1..]);
    let mut parts = Vec::new();
    let mut cur = String::new();
    in_q = false;
    for ch in head.chars() {
        match ch {
            '"' => in_q = !in_q,
            ';' if !in_q => parts.push(std::mem::take(&mut cur)),
            c => cur.push(c),
        }
    }
    parts.push(cur);
    let name = parts.first()?.trim().to_ascii_uppercase();
    let params = parts[1..]
        .iter()
        .filter_map(|p| p.split_once('=').map(|(k, v)| (k.trim().to_ascii_uppercase(), v.trim().to_string())))
        .collect();
    Some(Prop { name, params, value: value.to_string() })
}

fn unescape(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut it = v.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            match it.next() {
                Some('n') | Some('N') => out.push('\n'),
                Some(o) => out.push(o),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

// ---------------------------------------------------------------- times

#[derive(Debug, Clone, Copy, PartialEq)]
enum When {
    Date(NaiveDate),
    Utc(DateTime<Utc>),
    /// Wall-clock time in a zone; None = "floating" (the computer's zone).
    Zoned(NaiveDateTime, Option<chrono_tz::Tz>),
}

/// IANA names, Mozilla-style "/mozilla.org/.../Area/City" paths, and the
/// common Windows (Outlook) names for North American and UK zones.
fn parse_tzid(id: &str) -> Option<chrono_tz::Tz> {
    let id = id.trim().trim_matches('"');
    if let Ok(tz) = chrono_tz::Tz::from_str(id) {
        return Some(tz);
    }
    // "/mozilla.org/20050126_1/America/New_York" -> try the last two segments.
    let segs: Vec<&str> = id.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() >= 2 {
        if let Ok(tz) = chrono_tz::Tz::from_str(&segs[segs.len() - 2..].join("/")) {
            return Some(tz);
        }
    }
    let win = match id {
        "Eastern Standard Time" | "US Eastern Standard Time" => "America/Toronto",
        "Central Standard Time" => "America/Chicago",
        "Mountain Standard Time" => "America/Edmonton",
        "Pacific Standard Time" => "America/Vancouver",
        "Atlantic Standard Time" => "America/Halifax",
        "Newfoundland Standard Time" => "America/St_Johns",
        "GMT Standard Time" => "Europe/London",
        "UTC" | "Coordinated Universal Time" => "UTC",
        _ => return None,
    };
    chrono_tz::Tz::from_str(win).ok()
}

fn parse_when(p: &Prop) -> Option<When> {
    let v = p.value.trim();
    let is_date = p.param("VALUE").is_some_and(|x| x.eq_ignore_ascii_case("DATE")) || (v.len() == 8 && v.bytes().all(|b| b.is_ascii_digit()));
    if is_date {
        return NaiveDate::parse_from_str(&v[..8.min(v.len())], "%Y%m%d").ok().map(When::Date);
    }
    if let Some(z) = v.strip_suffix('Z').or_else(|| v.strip_suffix('z')) {
        let n = NaiveDateTime::parse_from_str(z, "%Y%m%dT%H%M%S").ok()?;
        return Some(When::Utc(Utc.from_utc_datetime(&n)));
    }
    let n = NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok()?;
    Some(When::Zoned(n, p.param("TZID").and_then(parse_tzid)))
}

/// Resolves a wall-clock time, taking the earlier instant in a DST overlap and
/// shifting forward over a DST gap.
fn resolve<T: TimeZone>(tz: &T, n: NaiveDateTime) -> Option<DateTime<T>> {
    tz.from_local_datetime(&n).earliest().or_else(|| tz.from_local_datetime(&(n + Duration::hours(1))).earliest())
}

impl When {
    fn is_date(&self) -> bool {
        matches!(self, When::Date(_))
    }
    /// As an rrule datetime. All-day dates use UTC midnight so DST never shifts them.
    fn to_rr(self) -> Option<DateTime<Tz>> {
        match self {
            When::Date(d) => Some(Tz::UTC.from_utc_datetime(&d.and_hms_opt(0, 0, 0)?)),
            When::Utc(t) => Some(t.with_timezone(&Tz::UTC)),
            When::Zoned(n, Some(tz)) => resolve(&Tz::Tz(tz), n),
            When::Zoned(n, None) => resolve(&Tz::LOCAL, n),
        }
    }
}

/// Unix ms for an occurrence start. All-day ones (UTC-midnight encoded) map to local midnight.
fn ms_of(t: &DateTime<Tz>, all_day: bool) -> i64 {
    if all_day {
        let d = t.with_timezone(&Utc).date_naive();
        return d.and_hms_opt(0, 0, 0).and_then(|n| resolve(&Local, n)).map(|l| l.timestamp_millis()).unwrap_or_else(|| t.timestamp_millis());
    }
    t.timestamp_millis()
}

/// "PT1H30M", "P1D", "-PT15M", "P2W".
fn parse_duration(s: &str) -> Option<Duration> {
    let s = s.trim();
    let (neg, s) = match s.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let s = s.strip_prefix('P')?;
    let mut total = Duration::zero();
    let mut num = String::new();
    let mut in_time = false;
    for c in s.chars() {
        match c {
            'T' => in_time = true,
            '0'..='9' => num.push(c),
            _ => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                total += match (c, in_time) {
                    ('W', false) => Duration::weeks(n),
                    ('D', false) => Duration::days(n),
                    ('H', true) => Duration::hours(n),
                    ('M', true) => Duration::minutes(n),
                    ('S', true) => Duration::seconds(n),
                    _ => return None,
                };
            }
        }
    }
    if !num.is_empty() {
        return None;
    }
    Some(if neg { -total } else { total })
}

// ---------------------------------------------------------------- events

#[derive(Debug, Clone, Default)]
struct Event {
    uid: String,
    summary: String,
    location: String,
    start: Option<When>,
    end: Option<When>,
    duration: Option<Duration>,
    rrule: Option<String>,
    exdates: Vec<When>,
    rdates: Vec<When>,
    recurrence_id: Option<When>,
    cancelled: bool,
}

fn events_of(text: &str) -> Vec<Event> {
    let mut out = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut cur: Option<Event> = None;
    for line in unfold(text) {
        let Some(p) = parse_prop(&line) else { continue };
        match p.name.as_str() {
            "BEGIN" => {
                let comp = p.value.trim().to_ascii_uppercase();
                if comp == "VEVENT" && stack.last().map(String::as_str) != Some("VEVENT") {
                    cur = Some(Event::default());
                }
                stack.push(comp);
                continue;
            }
            "END" => {
                let comp = p.value.trim().to_ascii_uppercase();
                if stack.last() == Some(&comp) {
                    stack.pop();
                }
                if comp == "VEVENT" && !stack.iter().any(|c| c == "VEVENT") {
                    if let Some(e) = cur.take() {
                        out.push(e);
                    }
                }
                continue;
            }
            _ => {}
        }
        // Only the event's own properties, not those of a nested VALARM.
        if stack.last().map(String::as_str) != Some("VEVENT") {
            continue;
        }
        let Some(e) = cur.as_mut() else { continue };
        match p.name.as_str() {
            "UID" => e.uid = p.value.trim().to_string(),
            "SUMMARY" => e.summary = unescape(&p.value),
            "LOCATION" => e.location = unescape(&p.value),
            "DTSTART" => e.start = parse_when(&p),
            "DTEND" => e.end = parse_when(&p),
            "DURATION" => e.duration = parse_duration(&p.value),
            "RRULE" => e.rrule = Some(p.value.trim().to_string()),
            "RECURRENCE-ID" => e.recurrence_id = parse_when(&p),
            "STATUS" => e.cancelled = p.value.trim().eq_ignore_ascii_case("CANCELLED"),
            "EXDATE" | "RDATE" => {
                for v in p.value.split(',') {
                    let one = Prop { name: p.name.clone(), params: p.params.clone(), value: v.to_string() };
                    if let Some(w) = parse_when(&one) {
                        if p.name == "EXDATE" { e.exdates.push(w) } else { e.rdates.push(w) }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn length_of(e: &Event, start: &DateTime<Tz>) -> Duration {
    if let Some(d) = e.duration {
        return d.max(Duration::zero());
    }
    if let (Some(s), Some(end)) = (e.start, e.end.and_then(When::to_rr)) {
        let _ = s;
        let d = end.signed_duration_since(start.clone());
        if d > Duration::zero() {
            return d;
        }
    }
    if e.start.is_some_and(|s| s.is_date()) { Duration::days(1) } else { Duration::zero() }
}

/// Every occurrence of every event in `text` that overlaps [from_ms, to_ms).
pub fn occurrences(text: &str, from_ms: i64, to_ms: i64) -> Vec<Occurrence> {
    let events = events_of(text);
    // Moved/cancelled single occurrences, keyed by (uid, original start).
    let mut overrides: HashMap<(String, i64), &Event> = HashMap::new();
    for e in events.iter().filter(|e| e.recurrence_id.is_some()) {
        if let Some(t) = e.recurrence_id.and_then(When::to_rr) {
            overrides.insert((e.uid.clone(), t.timestamp_millis()), e);
        }
    }
    let mut out = Vec::new();
    let push = |out: &mut Vec<Occurrence>, e: &Event, s: &DateTime<Tz>, len: Duration| {
        let all_day = e.start.is_some_and(|w| w.is_date());
        let start = ms_of(s, all_day);
        let end = if all_day { ms_of(&(s.clone() + len.max(Duration::days(1))), true) } else { start + len.num_milliseconds() };
        if start < to_ms && end.max(start + 1) > from_ms && out.len() < MAX_TOTAL {
            out.push(Occurrence { uid: e.uid.clone(), title: e.summary.clone(), location: e.location.clone(), start, end, all_day });
        }
    };

    for e in events.iter().filter(|e| e.recurrence_id.is_none() && !e.cancelled) {
        let Some(start) = e.start.and_then(When::to_rr) else { continue };
        let len = length_of(e, &start);
        let Some(rule) = e.rrule.as_deref() else {
            push(&mut out, e, &start, len);
            continue;
        };
        let Some(set) = rule_set(rule, &start, e) else {
            push(&mut out, e, &start, len); // unreadable rule: show the first one
            continue;
        };
        let pad = Duration::milliseconds(len.num_milliseconds().max(0)) + Duration::days(1);
        let after = Tz::UTC.timestamp_millis_opt(from_ms).single().map(|t| t - pad);
        let before = Tz::UTC.timestamp_millis_opt(to_ms).single();
        let (Some(after), Some(before)) = (after, before) else { continue };
        for occ in set.after(after).before(before).all(MAX_PER_EVENT).dates {
            if overrides.contains_key(&(e.uid.clone(), occ.timestamp_millis())) {
                continue; // replaced (or cancelled) below
            }
            push(&mut out, e, &occ, len);
        }
    }
    for e in overrides.values() {
        if e.cancelled {
            continue;
        }
        if let Some(start) = e.start.and_then(When::to_rr) {
            let len = length_of(e, &start);
            push(&mut out, e, &start, len);
        }
    }
    out.sort_by_key(|o| (o.start, o.end));
    out
}

fn rule_set(rule: &str, start: &DateTime<Tz>, e: &Event) -> Option<RRuleSet> {
    let mut rule = rule.to_string();
    // UNTIL must match DTSTART's kind for the rrule crate: dates become end-of-day UTC.
    if let Some(i) = rule.to_ascii_uppercase().find("UNTIL=") {
        let rest = &rule[i + 6..];
        let end = rest.find(';').unwrap_or(rest.len());
        let val = &rest[..end];
        if val.len() == 8 && val.bytes().all(|b| b.is_ascii_digit()) {
            rule = format!("{}UNTIL={}T235959Z{}", &rule[..i], val, &rest[end..]);
        } else if !val.ends_with('Z') && !val.ends_with('z') {
            if let Ok(n) = NaiveDateTime::parse_from_str(val, "%Y%m%dT%H%M%S") {
                let utc = resolve(&start.timezone(), n)?.with_timezone(&Utc);
                rule = format!("{}UNTIL={}{}", &rule[..i], utc.format("%Y%m%dT%H%M%SZ"), &rest[end..]);
            }
        }
    }
    let rr: RRule<Unvalidated> = RRule::from_str(&rule).ok()?;
    let mut set = rr.build(start.clone()).ok()?;
    for x in &e.exdates {
        if let Some(t) = x.to_rr() {
            // A date EXDATE on a timed event removes that day's occurrence at the same time.
            let t = if x.is_date() && !e.start.is_some_and(|s| s.is_date()) { same_day_at(&t, start)? } else { t };
            set = set.exdate(t);
        }
    }
    for x in &e.rdates {
        if let Some(t) = x.to_rr() {
            set = set.rdate(t);
        }
    }
    Some(set)
}

fn same_day_at(day: &DateTime<Tz>, at: &DateTime<Tz>) -> Option<DateTime<Tz>> {
    let tz = at.timezone();
    resolve(&tz, day.with_timezone(&Utc).date_naive().and_time(at.naive_local().time()))
}

// ---------------------------------------------------------------- writing

/// A Studydesk item written to the user's calendar.
#[derive(Debug, Clone, PartialEq)]
pub struct OutEvent {
    pub uid: String,
    pub summary: String,
    pub description: String,
    pub url: Option<String>,
    /// Unix ms. For all-day items, any time on the day (the local date is used).
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
}

fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace(';', "\\;").replace(',', "\\,").replace("\r\n", "\\n").replace(['\n', '\r'], "\\n")
}

/// Folds to 75 octets per line without splitting a UTF-8 character.
fn fold(line: &str) -> String {
    let mut out = String::new();
    let mut width = 0;
    for ch in line.chars() {
        let w = ch.len_utf8();
        if width + w > 75 {
            out.push_str("\r\n ");
            width = 1;
        }
        out.push(ch);
        width += w;
    }
    out.push_str("\r\n");
    out
}

fn utc_stamp(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms).single().unwrap_or_default().format("%Y%m%dT%H%M%SZ").to_string()
}

fn local_date(ms: i64) -> NaiveDate {
    Local.timestamp_millis_opt(ms).single().map(|t| t.date_naive()).unwrap_or_default()
}

pub fn to_ics(e: &OutEvent, now_ms: i64) -> String {
    let mut lines = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".into(),
        "PRODID:-//Studydesk//Studydesk//EN".into(),
        "CALSCALE:GREGORIAN".into(),
        "BEGIN:VEVENT".into(),
        format!("UID:{}", e.uid),
        format!("DTSTAMP:{}", utc_stamp(now_ms)),
    ];
    if e.all_day {
        let d = local_date(e.start);
        lines.push(format!("DTSTART;VALUE=DATE:{}", d.format("%Y%m%d")));
        lines.push(format!("DTEND;VALUE=DATE:{}", (d + Duration::days(1)).format("%Y%m%d")));
    } else {
        lines.push(format!("DTSTART:{}", utc_stamp(e.start)));
        lines.push(format!("DTEND:{}", utc_stamp(e.end.max(e.start))));
    }
    lines.push(format!("SUMMARY:{}", escape(&e.summary)));
    if !e.description.is_empty() {
        lines.push(format!("DESCRIPTION:{}", escape(&e.description)));
    }
    if let Some(u) = &e.url {
        lines.push(format!("URL:{}", u.replace(['\r', '\n'], "")));
    }
    // A deadline shouldn't make you look busy.
    lines.push("TRANSP:TRANSPARENT".into());
    lines.push("END:VEVENT".into());
    lines.push("END:VCALENDAR".into());
    lines.iter().map(|l| fold(l)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(s: &str) -> i64 {
        DateTime::parse_from_rfc3339(s).unwrap().timestamp_millis()
    }
    fn wrap(body: &str) -> String {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{body}\r\nEND:VCALENDAR\r\n")
    }

    #[test]
    fn single_utc_and_zoned_events() {
        let t = wrap(
            "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Office hours\\, room 2040\r\nDTSTART:20261020T140000Z\r\nDTEND:20261020T150000Z\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Lab\r\nDTSTART;TZID=America/Toronto:20261021T090000\r\nDURATION:PT2H\r\nEND:VEVENT",
        );
        let o = occurrences(&t, ms("2026-10-19T00:00:00Z"), ms("2026-10-26T00:00:00Z"));
        assert_eq!(o.len(), 2);
        assert_eq!(o[0].title, "Office hours, room 2040");
        assert_eq!((o[0].start, o[0].end), (ms("2026-10-20T14:00:00Z"), ms("2026-10-20T15:00:00Z")));
        // 09:00 Toronto in October is 13:00 UTC (EDT).
        assert_eq!((o[1].start, o[1].end), (ms("2026-10-21T13:00:00Z"), ms("2026-10-21T15:00:00Z")));
    }

    #[test]
    fn weekly_class_across_dst_change_with_exdate_and_moved_occurrence() {
        // Mon/Wed 10:00 Toronto lecture; Nov 1 2026 is the DST change.
        let t = wrap(
            "BEGIN:VEVENT\r\nUID:lec\r\nSUMMARY:MECE 2420 Lecture\r\nDTSTART;TZID=America/Toronto:20261026T100000\r\nDTEND;TZID=America/Toronto:20261026T112000\r\n\
             RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261111T235959Z\r\nEXDATE;TZID=America/Toronto:20261028T100000\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:lec\r\nRECURRENCE-ID;TZID=America/Toronto:20261104T100000\r\nSUMMARY:MECE 2420 Lecture (moved)\r\n\
             DTSTART;TZID=America/Toronto:20261105T130000\r\nDTEND;TZID=America/Toronto:20261105T142000\r\nEND:VEVENT",
        );
        let o = occurrences(&t, ms("2026-10-25T00:00:00Z"), ms("2026-11-30T00:00:00Z"));
        let starts: Vec<(i64, &str)> = o.iter().map(|x| (x.start, x.title.as_str())).collect();
        assert_eq!(
            starts,
            vec![
                (ms("2026-10-26T14:00:00Z"), "MECE 2420 Lecture"), // EDT
                (ms("2026-11-02T15:00:00Z"), "MECE 2420 Lecture"), // EST after the change: still 10:00 local
                (ms("2026-11-05T18:00:00Z"), "MECE 2420 Lecture (moved)"),
                (ms("2026-11-09T15:00:00Z"), "MECE 2420 Lecture"),
                (ms("2026-11-11T15:00:00Z"), "MECE 2420 Lecture"),
            ]
        );
        assert_eq!(o[0].end - o[0].start, 80 * 60_000);
    }

    #[test]
    fn all_day_events_and_date_until() {
        let t = wrap(
            "BEGIN:VEVENT\r\nUID:r\r\nSUMMARY:Reading week\r\nDTSTART;VALUE=DATE:20261026\r\nDTEND;VALUE=DATE:20261031\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:d\r\nSUMMARY:Daily standup\r\nDTSTART:20261019\r\nRRULE:FREQ=DAILY;UNTIL=20261021\r\nEND:VEVENT",
        );
        let o = occurrences(&t, ms("2026-10-01T00:00:00Z"), ms("2026-11-30T00:00:00Z"));
        let rw = o.iter().find(|x| x.title == "Reading week").unwrap();
        assert!(rw.all_day);
        assert_eq!((rw.end - rw.start) / 86_400_000, 5);
        assert_eq!(o.iter().filter(|x| x.title == "Daily standup").count(), 3);
    }

    #[test]
    fn folded_lines_alarms_cancelled_and_garbage() {
        let t = wrap(
            "BEGIN:VEVENT\r\nUID:x\r\nSUMMARY:A very long title that was\r\n  folded by the server\r\nDTSTART:20261020T120000Z\r\n\
             BEGIN:VALARM\r\nTRIGGER:-PT15M\r\nSUMMARY:not the title\r\nEND:VALARM\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:c\r\nSUMMARY:Cancelled\r\nSTATUS:CANCELLED\r\nDTSTART:20261020T120000Z\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:bad\r\nSUMMARY:No start\r\nEND:VEVENT\r\nnonsense line without colon\r\n\
             BEGIN:VEVENT\r\nUID:badrule\r\nSUMMARY:Weird rule\r\nDTSTART:20261021T120000Z\r\nRRULE:FREQ=SOMETIMES\r\nEND:VEVENT",
        );
        let o = occurrences(&t, ms("2026-10-19T00:00:00Z"), ms("2026-10-26T00:00:00Z"));
        let titles: Vec<&str> = o.iter().map(|x| x.title.as_str()).collect();
        assert_eq!(titles, vec!["A very long title that was folded by the server", "Weird rule"]);
    }

    #[test]
    fn windows_and_mozilla_tzids() {
        assert_eq!(parse_tzid("Eastern Standard Time"), Some(chrono_tz::America::Toronto));
        assert_eq!(parse_tzid("/mozilla.org/20050126_1/America/New_York"), Some(chrono_tz::America::New_York));
        assert_eq!(parse_tzid("Mars/Olympus"), None);
        assert_eq!(parse_duration("PT1H30M"), Some(Duration::minutes(90)));
        assert_eq!(parse_duration("-P1D"), Some(Duration::days(-1)));
        assert_eq!(parse_duration("P2W"), Some(Duration::weeks(2)));
        assert_eq!(parse_duration("PT"), Some(Duration::zero()));
        assert_eq!(parse_duration("1H"), None);
    }

    #[test]
    fn writes_valid_round_trippable_ics() {
        let e = OutEvent {
            uid: "studydesk-asg-101-1@studydesk".into(),
            summary: "MECE 2420U: Lab 3 – Thick-walled cylinders; due, really".into(),
            description: "Submit one PDF.\nLate: 10%/day".into(),
            url: Some("https://canvas.example.edu/courses/101/assignments/1".into()),
            start: ms("2026-10-19T03:44:00Z"),
            end: ms("2026-10-19T03:59:00Z"),
            all_day: false,
        };
        let ics = to_ics(&e, ms("2026-10-18T12:00:00Z"));
        assert!(ics.lines().all(|l| l.len() <= 76), "folded");
        assert!(ics.contains("SUMMARY:MECE 2420U: Lab 3 – Thick-walled cylinders\\; due\\, really"));
        let back = occurrences(&ics, ms("2026-10-18T00:00:00Z"), ms("2026-10-20T00:00:00Z"));
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].title, e.summary);
        assert_eq!((back[0].start, back[0].end), (e.start, e.end));
        assert_eq!(back[0].uid, e.uid);
    }
}
