//! Finds important dates in course text (syllabus, outlines, calendar).
//!
//! Precision over recall: a date is reported only when the same line also
//! names something that matters (exam, quiz, due, lab, project, …). Every
//! finding carries the sentence it came from so you can verify it, and
//! nothing is used until you pin it. Ambiguous numeric dates (03/04) are
//! flagged, never silently guessed.

use chrono::{Datelike, Duration, NaiveDate, Weekday};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Exam,
    Quiz,
    Deliverable,
    Info,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// calendar | syllabus | page | file | local | announcement
    pub kind: String,
    pub name: String,
    pub url: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub course_id: u64,
    /// YYYY-MM-DD (local calendar date).
    pub date: String,
    /// HH:MM 24 h, when stated.
    pub time: Option<String>,
    /// Inclusive end date for "Week N" ranges.
    pub end_date: Option<String>,
    pub kind: Kind,
    pub label: String,
    pub weight: Option<String>,
    pub snippet: String,
    pub confidence: Confidence,
    /// Why to double-check, e.g. "03/04 could be 3 April".
    pub caution: Option<String>,
    pub sources: Vec<Source>,
    /// Name of a Canvas assignment already covering this date, if any.
    pub in_canvas: Option<String>,
}

/// What the extractor needs to resolve partial dates.
#[derive(Clone, Copy, Debug)]
pub struct Context {
    pub today: NaiveDate,
    pub term_start: Option<NaiveDate>,
    pub term_end: Option<NaiveDate>,
}

struct Res {
    month_first: Regex,
    day_first: Regex,
    iso: Regex,
    numeric: Regex,
    week: Regex,
    time: Regex,
    time24: Regex,
    weight: Regex,
    numeric_cue: Regex,
    kinds: Vec<(Kind, Regex)>,
    noise: Regex,
}

const MONTHS: &str = r"(?P<mon>jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

fn res() -> &'static Res {
    static R: OnceLock<Res> = OnceLock::new();
    R.get_or_init(|| Res {
        month_first: Regex::new(&format!(r"(?i)\b{MONTHS}\.?\s+(?P<day>[0-3]?\d)(?:st|nd|rd|th)?\b(?:,?\s+(?P<year>20\d\d))?")).unwrap(),
        day_first: Regex::new(&format!(r"(?i)\b(?P<day>[0-3]?\d)(?:st|nd|rd|th)?\s+(?:of\s+)?{MONTHS}\b\.?(?:,?\s+(?P<year>20\d\d))?")).unwrap(),
        iso: Regex::new(r"\b(?P<year>20\d\d)-(?P<m>[01]?\d)-(?P<d>[0-3]?\d)\b").unwrap(),
        numeric: Regex::new(r"(?:^|[^\d/.])(?P<a>[0-3]?\d)/(?P<b>[0-3]?\d)(?:/(?P<y>(?:20)?\d\d))?(?:$|[^\d/])").unwrap(),
        week: Regex::new(r"(?i)\bweek\s*(?P<n>\d{1,2})\b").unwrap(),
        time: Regex::new(r"(?i)\b(?P<h>1[0-2]|0?[1-9])(?::(?P<m>[0-5]\d))?\s*(?P<ap>a\.?m\.?|p\.?m\.?)|\b(?P<word>noon|midnight)\b").unwrap(),
        time24: Regex::new(r"\b(?P<h>[01]?\d|2[0-3]):(?P<m>[0-5]\d)\b").unwrap(),
        weight: Regex::new(r"\b(?P<w>\d{1,3}(?:\.\d+)?)\s?%").unwrap(),
        numeric_cue: Regex::new(r"(?i)(\bon|\bby|\bdue|\bdate[ds]?|\buntil|day|\b(?:mon|tue|wed|thu|fri|sat|sun))[\s,:.\-]*$").unwrap(),
        kinds: vec![
            (Kind::Exam, Regex::new(r"(?i)\b(mid-?terms?|final\s+(?:exam(?:ination)?|test|assessment)s?|finals\s+week|exams?|examinations?)\b").unwrap()),
            (Kind::Quiz, Regex::new(r"(?i)\b(quiz(?:zes)?|tests?)\b").unwrap()),
            (
                Kind::Deliverable,
                Regex::new(r"(?i)\b(due|deadlines?|submit|submissions?|hand[- ]in|labs?|laboratory|reports?|projects?|presentations?|proposals?|demos?|demonstrations?|milestones?|assignments?|essays?|design\s+reviews?|posters?|deliverables?)\b").unwrap(),
            ),
            (Kind::Info, Regex::new(r"(?i)\b(reading\s+week|study\s+week|no\s+class(?:es)?|holiday|cancell?ed|last\s+day\s+to\s+(?:drop|withdraw)|withdraw)\b").unwrap()),
        ],
        // Lines that mention dates but aren't deadlines for you.
        noise: Regex::new(r"(?i)\b(office\s+hours?|copyright|©|published|last\s+(?:updated|modified|revised)|retrieved|accessed|printed\s+on)\b").unwrap(),
    })
}

fn month_num(s: &str) -> Option<u32> {
    let s = s.to_ascii_lowercase();
    let m = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    m.iter().position(|p| s.starts_with(p)).map(|i| i as u32 + 1)
}

/// Picks the year for a month/day without one: inside the term when known,
/// otherwise the occurrence nearest to today (looking up to 10 months ahead).
fn infer_year(month: u32, day: u32, ctx: &Context) -> Option<NaiveDate> {
    let years = [ctx.today.year() - 1, ctx.today.year(), ctx.today.year() + 1];
    let cands: Vec<NaiveDate> = years.iter().filter_map(|y| NaiveDate::from_ymd_opt(*y, month, day)).collect();
    if let (Some(s), Some(e)) = (ctx.term_start, ctx.term_end) {
        if let Some(d) = cands.iter().find(|d| **d >= s - Duration::days(14) && **d <= e + Duration::days(30)) {
            return Some(*d);
        }
    }
    cands.into_iter().filter(|d| *d >= ctx.today - Duration::days(60) && *d <= ctx.today + Duration::days(300)).min_by_key(|d| (*d - ctx.today).num_days().abs())
}

fn parse_time(s: &str) -> Option<String> {
    let r = res();
    if let Some(c) = r.time.captures(s) {
        if let Some(w) = c.name("word") {
            return Some(if w.as_str().eq_ignore_ascii_case("noon") { "12:00".into() } else { "23:59".into() });
        }
        let mut h: u32 = c["h"].parse().ok()?;
        let m: u32 = c.name("m").map(|m| m.as_str().parse().unwrap_or(0)).unwrap_or(0);
        let pm = c["ap"].to_ascii_lowercase().starts_with('p');
        if pm && h != 12 {
            h += 12;
        }
        if !pm && h == 12 {
            h = 0;
        }
        return Some(format!("{h:02}:{m:02}"));
    }
    r.time24.captures(s).map(|c| format!("{:02}:{}", c["h"].parse::<u32>().unwrap_or(0), &c["m"]))
}

struct Hit {
    date: NaiveDate,
    start: usize,
    end: usize,
    caution: Option<String>,
    explicit_year: bool,
}

fn dates_in(line: &str, ctx: &Context) -> Vec<Hit> {
    let r = res();
    let mut hits: Vec<Hit> = Vec::new();
    let mut taken: Vec<(usize, usize)> = Vec::new();
    let mut push = |hits: &mut Vec<Hit>, h: Hit| {
        if !taken.iter().any(|(s, e)| h.start < *e && *s < h.end) {
            taken.push((h.start, h.end));
            hits.push(h);
        }
    };
    for re in [&r.month_first, &r.day_first] {
        for c in re.captures_iter(line) {
            let (Some(mon), Ok(day)) = (month_num(&c["mon"]), c["day"].parse::<u32>()) else { continue };
            let m = c.get(0).unwrap();
            let date = match c.name("year").and_then(|y| y.as_str().parse::<i32>().ok()) {
                Some(y) => NaiveDate::from_ymd_opt(y, mon, day),
                None => infer_year(mon, day, ctx),
            };
            if let Some(date) = date {
                push(&mut hits, Hit { date, start: m.start(), end: m.end(), caution: None, explicit_year: c.name("year").is_some() });
            }
        }
    }
    for c in r.iso.captures_iter(line) {
        let m = c.get(0).unwrap();
        if let Some(date) = NaiveDate::from_ymd_opt(c["year"].parse().unwrap_or(0), c["m"].parse().unwrap_or(0), c["d"].parse().unwrap_or(0)) {
            push(&mut hits, Hit { date, start: m.start(), end: m.end(), caution: None, explicit_year: true });
        }
    }
    for c in r.numeric.captures_iter(line) {
        let (a, b): (u32, u32) = (c["a"].parse().unwrap_or(0), c["b"].parse().unwrap_or(0));
        let whole = c.get(0).unwrap();
        let start = c.name("a").unwrap().start();
        // Without a year, "3/4" is only a date after a cue like "on", "due" or a weekday.
        if c.name("y").is_none() && !r.numeric_cue.is_match(&line[..start]) {
            continue;
        }
        let end = c.name("y").or(c.name("b")).unwrap().end().min(whole.end());
        // Month/day (North American) unless that's impossible.
        let (mon, day, caution) = if a > 12 && b <= 12 {
            (b, a, None)
        } else if b > 12 && a <= 12 {
            (a, b, None)
        } else if a <= 12 && b <= 12 && a != b {
            (a, b, Some(format!("\"{a}/{b}\" could be {} {} instead. Check the source.", b, month_name(a).unwrap_or(""))))
        } else {
            (a, b, None)
        };
        let year = c.name("y").map(|y| {
            let v: i32 = y.as_str().parse().unwrap_or(0);
            if v < 100 { 2000 + v } else { v }
        });
        let date = match year {
            Some(y) => NaiveDate::from_ymd_opt(y, mon, day),
            None => infer_year(mon, day, ctx),
        };
        if let Some(date) = date {
            push(&mut hits, Hit { date, start, end, caution, explicit_year: year.is_some() });
        }
    }
    hits.sort_by_key(|h| h.start);
    hits
}

fn month_name(m: u32) -> Option<&'static str> {
    ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].get(m.checked_sub(1)? as usize).copied()
}

pub fn classify(line: &str) -> Option<(Kind, String)> {
    res().kinds.iter().find_map(|(k, re)| re.find(line).map(|m| (*k, m.as_str().to_string())))
}

fn clean_label(line: &str, remove: &[(usize, usize)], kind: Kind, keyword: &str) -> String {
    let mut s = String::with_capacity(line.len());
    let mut i = 0;
    let mut cuts: Vec<(usize, usize)> = remove.to_vec();
    cuts.sort();
    for (a, b) in cuts {
        if a >= i {
            s.push_str(&line[i..a]);
            s.push(' ');
        }
        i = b.max(i);
    }
    s.push_str(&line[i..]);
    // Drop weekday names, leading list markers and separator runs.
    let wd = Regex::new(r"(?i)\b(mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\b\.?,?").unwrap();
    let s = wd.replace_all(&s, " ");
    let s = Regex::new(r"\(\s*\)|\[\s*\]").unwrap().replace_all(&s, " ");
    let s = Regex::new(r"(?i)\b(at|on|by|before|from|to)\s*(?:[-–—:|,.]|\s)*$").unwrap().replace_all(s.trim(), "");
    let s: String = s.split(|c: char| c == '|' || c == '\t' || c == '•' || c == '▪').map(str::trim).filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" · ");
    let s = Regex::new(r"\s+").unwrap().replace_all(&s, " ");
    let s = s.trim_matches(|c: char| c.is_whitespace() || ",;:–—-·.()".contains(c)).to_string();
    let s = if s.chars().count() > 90 { format!("{}…", s.chars().take(88).collect::<String>().trim_end()) } else { s };
    if s.chars().filter(|c| c.is_alphabetic()).count() < 3 {
        let mut k = keyword.to_string();
        if let Some(f) = k.get_mut(0..1) {
            f.make_ascii_uppercase();
        }
        return if k.is_empty() { format!("{kind:?}") } else { k };
    }
    s
}

pub fn snippet(line: &str) -> String {
    let t = line.split_whitespace().collect::<Vec<_>>().join(" ");
    let t = t.trim_matches(|c: char| c == '|' || c == '·' || c.is_whitespace()).to_string();
    if t.chars().count() > 240 { format!("{}…", t.chars().take(238).collect::<String>()) } else { t }
}

pub fn finding_id(course_id: u64, date: &str, label: &str) -> String {
    let norm: String = label.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect();
    let h = Sha256::digest(format!("{course_id}|{date}|{norm}").as_bytes());
    h.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Monday of teaching week `n`, where week 1 contains the term start.
pub fn week_range(term_start: NaiveDate, n: u32) -> Option<(NaiveDate, NaiveDate)> {
    if n == 0 || n > 20 {
        return None;
    }
    let monday = term_start - Duration::days(term_start.weekday().num_days_from_monday() as i64);
    let s = monday + Duration::weeks(n as i64 - 1);
    Some((s, s + Duration::days(4)))
}

/// Splits text into candidate lines: real line breaks, plus sentence breaks
/// inside very long lines (PDF paragraphs).
fn lines(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let l = raw.trim();
        if l.is_empty() {
            continue;
        }
        if l.len() > 260 {
            out.extend(l.split_inclusive(". ").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
        } else {
            out.push(l.to_string());
        }
    }
    out
}

pub fn extract(text: &str, course_id: u64, source: &Source, ctx: &Context) -> Vec<Finding> {
    let r = res();
    let mut out = Vec::new();
    for line in lines(text) {
        if r.noise.is_match(&line) {
            continue;
        }
        let Some((kind, keyword)) = classify(&line) else { continue };
        let hits = dates_in(&line, ctx);
        let weight = r.weight.captures(&line).map(|c| format!("{}%", &c["w"]));
        if hits.is_empty() {
            // "Week 7: Midterm" style, resolvable only with the term start.
            if let (Some(c), Some(ts)) = (r.week.captures(&line), ctx.term_start) {
                let n: u32 = c["n"].parse().unwrap_or(0);
                if let Some((s, e)) = week_range(ts, n) {
                    if e >= ctx.today && kind != Kind::Info {
                        let m = c.get(0).unwrap();
                        let label = clean_label(&line, &[(m.start(), m.end())], kind, &keyword);
                        out.push(Finding {
                            id: finding_id(course_id, &s.to_string(), &label),
                            course_id,
                            date: s.to_string(),
                            end_date: Some(e.to_string()),
                            time: None,
                            kind,
                            label,
                            weight: weight.clone(),
                            snippet: snippet(&line),
                            confidence: Confidence::Low,
                            caution: Some(format!("Only \"Week {n}\" is given; the exact day isn't stated.")),
                            sources: vec![source.clone()],
                            in_canvas: None,
                        });
                    }
                }
            }
            continue;
        }
        let mut cuts: Vec<(usize, usize)> = hits.iter().map(|h| (h.start, h.end)).collect();
        if let Some(m) = r.week.find(&line) {
            cuts.push((m.start(), m.end()));
        }
        for m in r.time.find_iter(&line).chain(r.time24.find_iter(&line)) {
            cuts.push((m.start(), m.end()));
        }
        if let Some(m) = r.weight.find(&line) {
            cuts.push((m.start(), m.end()));
        }
        let label = clean_label(&line, &cuts, kind, &keyword);
        for (i, h) in hits.iter().enumerate() {
            if h.date < ctx.today || h.date > ctx.today + Duration::days(300) {
                continue;
            }
            // A time belongs to this date if it appears before the next date.
            let until = hits.get(i + 1).map(|n| n.start).unwrap_or(line.len());
            let time = parse_time(&line[h.end..until]).or_else(|| if hits.len() == 1 { parse_time(&line[..h.start]) } else { None });
            let date = h.date.to_string();
            out.push(Finding {
                id: finding_id(course_id, &date, &label),
                course_id,
                date,
                end_date: None,
                time,
                kind,
                label: label.clone(),
                weight: weight.clone(),
                snippet: snippet(&line),
                confidence: if h.caution.is_some() { Confidence::Low } else { Confidence::Medium },
                caution: h.caution.clone().or_else(|| {
                    (!h.explicit_year && ctx.term_start.is_none()).then(|| "No year given; assumed the nearest upcoming one.".to_string())
                }),
                sources: vec![source.clone()],
                in_canvas: None,
            });
        }
    }
    out
}

/// Merges duplicates (same course, date and kind) keeping the most confident,
/// most descriptive version and every source.
pub fn merge(mut all: Vec<Finding>) -> Vec<Finding> {
    all.sort_by(|a, b| (a.course_id, &a.date, a.kind).cmp(&(b.course_id, &b.date, b.kind)).then(b.confidence.cmp(&a.confidence)).then(b.label.len().cmp(&a.label.len())));
    let mut out: Vec<Finding> = Vec::new();
    for f in all {
        if let Some(last) = out.last_mut() {
            if last.course_id == f.course_id && last.date == f.date && last.kind == f.kind {
                for s in f.sources {
                    if !last.sources.contains(&s) {
                        last.sources.push(s);
                    }
                }
                if last.time.is_none() {
                    last.time = f.time;
                }
                if last.weight.is_none() {
                    last.weight = f.weight;
                }
                continue;
            }
        }
        out.push(f);
    }
    out.sort_by(|a, b| a.date.cmp(&b.date).then(a.kind.cmp(&b.kind)));
    out
}

/// True if a Canvas assignment on the same day plausibly is this item.
pub fn same_item(label: &str, kind: Kind, assignment_name: &str) -> bool {
    let words = |s: &str| -> Vec<String> {
        s.to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() >= 3 || w.chars().all(|c| c.is_ascii_digit()))
            .filter(|w| !["the", "and", "for", "due", "week", "submit", "submission"].contains(w))
            .map(str::to_string)
            .collect()
    };
    let a = words(label);
    let b = words(assignment_name);
    let shared = a.iter().filter(|w| b.contains(w)).count();
    shared >= 2 || (shared >= 1 && (kind == Kind::Quiz) == assignment_name.to_lowercase().contains("quiz"))
}

pub fn weekday_name(d: Weekday) -> &'static str {
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d.num_days_from_monday() as usize]
}

/// Plain text from HTML: block tags become line breaks, entities decoded.
pub fn html_to_text(html: &str) -> String {
    let br = Regex::new(r"(?i)<\s*(br|/p|/div|/li|/tr|/h[1-6]|/table|/ul|/ol)\b[^>]*>").unwrap();
    let cell = Regex::new(r"(?i)<\s*/t[dh]\s*>").unwrap();
    let tags = Regex::new(r"(?s)<[^>]*>").unwrap();
    let s = br.replace_all(html, "\n");
    let s = cell.replace_all(&s, " | ");
    let s = tags.replace_all(&s, " ");
    crate::google::gmail::decode_entities(&s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Context {
        Context {
            today: NaiveDate::from_ymd_opt(2026, 10, 18).unwrap(),
            term_start: NaiveDate::from_ymd_opt(2026, 9, 3),
            term_end: NaiveDate::from_ymd_opt(2026, 12, 18),
        }
    }
    fn src() -> Source {
        Source { kind: "file".into(), name: "Course outline.pdf".into(), url: None }
    }
    fn run(t: &str) -> Vec<Finding> {
        extract(t, 101, &src(), &ctx())
    }

    #[test]
    fn outline_table_rows() {
        let f = run("Week 8 | Wed, Oct 28 | Midterm Exam (25%) | in class, 10:00 am\nWeek 9 | Nov 4 | Lab 4 report due 11:59 pm | 10%");
        assert_eq!(f.len(), 2);
        assert_eq!((f[0].date.as_str(), f[0].kind, f[0].time.as_deref(), f[0].weight.as_deref()), ("2026-10-28", Kind::Exam, Some("10:00"), Some("25%")));
        assert_eq!(f[0].label, "Midterm Exam · in class");
        assert_eq!((f[1].date.as_str(), f[1].kind, f[1].time.as_deref()), ("2026-11-04", Kind::Deliverable, Some("23:59")));
        assert_eq!(f[1].label, "Lab 4 report due");
        assert_eq!(f[0].confidence, Confidence::Medium);
    }

    #[test]
    fn formats_and_years() {
        let f = run("Final exam: December 14th, 2026 at 2 p.m.\nProject proposal due 2026-11-06\nQuiz 3 on 21 November");
        let d: Vec<_> = f.iter().map(|x| (x.date.as_str(), x.kind)).collect();
        assert_eq!(d, vec![("2026-12-14", Kind::Exam), ("2026-11-06", Kind::Deliverable), ("2026-11-21", Kind::Quiz)]);
        assert_eq!(f[0].time.as_deref(), Some("14:00"));
    }

    #[test]
    fn requires_a_keyword_and_skips_noise_and_past() {
        assert!(run("Thanksgiving is October 12 and we will meet on Nov 3.").is_empty());
        assert!(run("Office hours: Monday Oct 26, 2-4 pm, lab room").is_empty());
        assert!(run("Last updated Oct 30, 2026 - assignment policy").is_empty());
        assert!(run("Lab 1 report due Sept 20").is_empty(), "past dates are dropped");
    }

    #[test]
    fn ambiguous_numeric_flagged_unambiguous_not() {
        let f = run("Test 2 on 11/04");
        assert_eq!(f[0].date, "2026-11-04");
        assert_eq!(f[0].confidence, Confidence::Low);
        assert!(f[0].caution.as_deref().unwrap().contains("could be 4 November"));
        let f = run("Test 2 on 25/11/2026");
        assert_eq!((f[0].date.as_str(), f[0].caution.is_none()), ("2026-11-25", true));
        assert!(run("Score 1/2 on the lab").is_empty(), "past 1/2 Jan is dropped");
    }

    #[test]
    fn week_only_lines_resolve_with_term_start() {
        let f = run("Week 12: Design review presentations");
        assert_eq!(f.len(), 1);
        assert_eq!((f[0].date.as_str(), f[0].end_date.as_deref()), ("2026-11-16", Some("2026-11-20")));
        assert_eq!(f[0].confidence, Confidence::Low);
        assert_eq!(week_range(NaiveDate::from_ymd_opt(2026, 9, 3).unwrap(), 1).unwrap().0.to_string(), "2026-08-31");
    }

    #[test]
    fn two_dates_one_line_get_their_own_times() {
        let f = run("Lab 5: pre-lab due Nov 2 at 9 am; report due Nov 9 at 11:59 pm");
        assert_eq!(f.iter().map(|x| (x.date.as_str(), x.time.as_deref())).collect::<Vec<_>>(), vec![("2026-11-02", Some("09:00")), ("2026-11-09", Some("23:59"))]);
    }

    #[test]
    fn year_inferred_within_term_without_term_uses_nearest() {
        let no_term = Context { term_start: None, term_end: None, ..ctx() };
        let f = extract("Final exam Jan 12", 1, &src(), &no_term);
        assert_eq!(f[0].date, "2027-01-12");
        assert!(f[0].caution.is_some());
    }

    #[test]
    fn merge_and_match() {
        let mut a = run("Midterm exam Oct 28 (25%)");
        let mut b = extract("Midterm Exam – Wednesday October 28 10:00 am", 101, &Source { kind: "syllabus".into(), name: "Syllabus".into(), url: None }, &ctx());
        a.append(&mut b);
        let m = merge(a);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].sources.len(), 2);
        assert_eq!((m[0].time.as_deref(), m[0].weight.as_deref()), (Some("10:00"), Some("25%")));
        assert!(same_item("Lab 4 report due", Kind::Deliverable, "Lab 4 – Pipe friction report"));
        assert!(!same_item("Midterm Exam", Kind::Exam, "Lab 4 report"));
    }

    #[test]
    fn final_project_is_not_an_exam() {
        let f = run("Final project report due Nov 17 (30%)\nFinal exam Dec 12");
        assert_eq!(f.iter().map(|x| x.kind).collect::<Vec<_>>(), vec![Kind::Deliverable, Kind::Exam]);
    }

    #[test]
    fn html_text() {
        let t = html_to_text("<table><tr><td>Oct 28</td><td>Midterm&nbsp;exam</td></tr></table><p>Quiz&#39;s on Nov 5</p>");
        let f = run(&t);
        assert_eq!(f.iter().map(|x| x.date.as_str()).collect::<Vec<_>>(), vec!["2026-10-28", "2026-11-05"]);
    }
}
