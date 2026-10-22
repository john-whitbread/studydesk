//! Dates in announcements. Instructors write "Quiz 2 is this Thursday in
//! tutorial" far more often than a full date, so on top of the normal date
//! formats this reads relative days (today, tomorrow, this/next/on Friday),
//! worked out from when the announcement was posted.
//!
//! The kind (quiz, exam, due…) may come from the line or from the title:
//! title "Quiz 2 reminder", body "It's on Thursday at 2 pm" is one finding.

use crate::dates::{self, clean_label, dates_in, html_to_text, lines, parse_time, res, Confidence, Context, Finding, Source};
use chrono::{Datelike, Duration, NaiveDate, Weekday};
use regex::Regex;
use std::sync::LazyLock;

/// How far ahead an announcement date is believed.
const AHEAD_DAYS: i64 = 150;

static RELATIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(?:(?P<pre>this|next|coming|on|by|until|before|due)\s+(?:(?:the\s+)?coming\s+)?)?(?P<wd>monday|tuesday|wednesday|thursday|friday|saturday|sunday|tues|thurs|mon|wed|fri)\b(?:'s)?(?P<plural>s\b)?|\b(?P<rel>today|tonight|tomorrow)\b",
    )
    .unwrap()
});
/// Lines about the past ("Quiz 1 was on Monday", "results from Friday's quiz").
static PAST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(was|were|took place|last\s+(?:week|monday|tuesday|wednesday|thursday|friday)|returned|results?|graded|marked|solutions?\s+(?:are|have been)\s+posted)\b").unwrap());
/// Cancellations and moves change a date rather than add one.
static MOVED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(moved|postponed|rescheduled|pushed\s+back|delayed|changed\s+to|now\s+(?:on|due))\b").unwrap());

fn weekday(s: &str) -> Option<Weekday> {
    let s = s.to_ascii_lowercase();
    Some(match &s[..3.min(s.len())] {
        "mon" => Weekday::Mon,
        "tue" => Weekday::Tue,
        "wed" => Weekday::Wed,
        "thu" => Weekday::Thu,
        "fri" => Weekday::Fri,
        "sat" => Weekday::Sat,
        "sun" => Weekday::Sun,
        _ => return None,
    })
}

/// First `wd` on or after `from` (strict = after).
fn next_weekday(from: NaiveDate, wd: Weekday, strict: bool) -> NaiveDate {
    let mut d = if strict { from + Duration::days(1) } else { from };
    while d.weekday() != wd {
        d += Duration::days(1);
    }
    d
}

struct Rel {
    date: NaiveDate,
    start: usize,
    end: usize,
    phrase: String,
    ambiguous: bool,
}

/// Relative day phrases in a line, resolved against the posting date.
fn relative_in(line: &str, posted: NaiveDate) -> Vec<Rel> {
    let mut out = Vec::new();
    for c in RELATIVE.captures_iter(line) {
        let m = c.get(0).unwrap();
        if c.name("plural").is_some() {
            continue; // "Thursdays" = every week, e.g. office hours
        }
        let phrase = m.as_str().trim().to_string();
        if let Some(r) = c.name("rel") {
            let d = match r.as_str().to_ascii_lowercase().as_str() {
                "tomorrow" => posted + Duration::days(1),
                _ => posted,
            };
            out.push(Rel { date: d, start: m.start(), end: m.end(), phrase, ambiguous: false });
            continue;
        }
        let Some(wd) = c.name("wd").and_then(|w| weekday(w.as_str())) else { continue };
        let pre = c.name("pre").map(|p| p.as_str().to_ascii_lowercase());
        let (date, ambiguous) = match pre.as_deref() {
            Some("this") => (next_weekday(posted, wd, false), false),
            Some("next") => {
                // "next Friday" said on a Monday could mean this week's or next week's.
                let first = next_weekday(posted, wd, true);
                if first.iso_week() == posted.iso_week() { (first + Duration::days(7), true) } else { (first, false) }
            }
            _ => (next_weekday(posted, wd, true), false),
        };
        out.push(Rel { date, start: m.start(), end: m.end(), phrase, ambiguous });
    }
    out
}

/// Findings from one announcement. `posted` is the local posting date.
pub fn extract(title: &str, body_html: &str, posted: NaiveDate, course_id: u64, source: &Source, ctx: &Context) -> Vec<Finding> {
    let r = res();
    let title = title.trim();
    let title_kind = dates::classify(title);
    let body = html_to_text(body_html);
    let mut out = Vec::new();
    let mut all_lines = vec![title.to_string()];
    all_lines.extend(lines(&body));

    // A label from the title, used when a line's own words are weak ("It's on Thursday").
    let title_label = title_kind.as_ref().map(|(k, kw)| clean_label(title, &title_dates(title, posted, ctx), *k, kw));

    for (i, line) in all_lines.iter().enumerate() {
        if r.noise.is_match(line) || PAST.is_match(line) {
            continue;
        }
        let own = dates::classify(line);
        let Some((kind, keyword)) = own.clone().or_else(|| title_kind.clone()) else { continue };
        let moved = MOVED.is_match(line) || MOVED.is_match(title);
        let explicit = dates_in(line, ctx);
        let weight = r.weight.captures(line).map(|c| format!("{}%", &c["w"]));

        // (date, start, end, caution, confidence)
        let mut found: Vec<(NaiveDate, usize, usize, Option<String>, Confidence)> = explicit
            .iter()
            .map(|h| (h.date, h.start, h.end, h.caution.clone(), if h.caution.is_some() { Confidence::Low } else { Confidence::Medium }))
            .collect();
        if found.is_empty() {
            for rel in relative_in(line, posted) {
                let posted_s = format!("{} {} {}", dates::weekday_name(posted.weekday()), month_abbr(posted.month()), posted.day());
                let caution = if rel.ambiguous {
                    format!("\"{}\" in an announcement posted {posted_s} could mean either week. Check the date.", rel.phrase)
                } else {
                    format!("Worked out from \"{}\" in an announcement posted {posted_s}.", rel.phrase)
                };
                found.push((rel.date, rel.start, rel.end, Some(caution), if rel.ambiguous { Confidence::Low } else { Confidence::Medium }));
            }
        }
        if found.is_empty() {
            continue;
        }

        let mut cuts: Vec<(usize, usize)> = found.iter().map(|f| (f.1, f.2)).collect();
        for m in r.time.find_iter(line).chain(r.time24.find_iter(line)) {
            cuts.push((m.start(), m.end()));
        }
        if let Some(m) = r.weight.find(line) {
            cuts.push((m.start(), m.end()));
        }
        let line_label = clean_label(line, &cuts, kind, &keyword);
        // Prefer a label that names the item ("Quiz 2"): the line's own if it has
        // the keyword and a number or is the title, else the title's.
        let label = match (&own, &title_label) {
            (Some(_), Some(tl)) if i > 0 && !has_number(&line_label) && has_number(tl) => tl.clone(),
            (Some(_), _) => line_label,
            (None, Some(tl)) => tl.clone(),
            (None, None) => line_label,
        };

        found.sort_by_key(|f| f.1);
        for (j, (date, _s, end, caution, conf)) in found.iter().enumerate() {
            if *date < ctx.today || *date > ctx.today + Duration::days(AHEAD_DAYS) {
                continue;
            }
            let until = found.get(j + 1).map(|n| n.1).unwrap_or(line.len());
            let time = parse_time(&line[*end..until]).or_else(|| if found.len() == 1 { parse_time(line) } else { None });
            let d = date.to_string();
            let caution = if moved { Some(format!("{} This announcement mentions a change of date.", caution.clone().unwrap_or_default()).trim().to_string()) } else { caution.clone() };
            out.push(Finding {
                id: dates::finding_id(course_id, &d, &label),
                course_id,
                date: d,
                time,
                end_date: None,
                kind,
                label: label.clone(),
                weight: weight.clone(),
                snippet: dates::snippet(line),
                confidence: *conf,
                caution,
                sources: vec![source.clone()],
                in_canvas: None,
            });
        }
    }
    dates::merge(out)
}

/// Spans of dates and relative days in the title, removed from its label.
fn title_dates(title: &str, posted: NaiveDate, ctx: &Context) -> Vec<(usize, usize)> {
    let mut v: Vec<(usize, usize)> = dates_in(title, ctx).iter().map(|h| (h.start, h.end)).collect();
    v.extend(relative_in(title, posted).iter().map(|r| (r.start, r.end)));
    let r = res();
    v.extend(r.time.find_iter(title).chain(r.time24.find_iter(title)).map(|m| (m.start(), m.end())));
    v
}

fn has_number(s: &str) -> bool {
    s.chars().any(|c| c.is_ascii_digit())
}

fn month_abbr(m: u32) -> &'static str {
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(m.clamp(1, 12) - 1) as usize]
}

/// True when the announcement says an item moved (for updating a pinned date).
pub fn mentions_move(title: &str, body_html: &str) -> bool {
    MOVED.is_match(title) || MOVED.is_match(&html_to_text(body_html))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dates::Kind;

    // Tuesday Oct 13 2026 posting; "today" for filtering is Oct 14.
    fn ctx() -> Context {
        Context { today: NaiveDate::from_ymd_opt(2026, 10, 14).unwrap(), term_start: NaiveDate::from_ymd_opt(2026, 9, 3), term_end: NaiveDate::from_ymd_opt(2026, 12, 18) }
    }
    fn posted() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, 13).unwrap() // Tue
    }
    fn src() -> Source {
        Source { kind: "announcement".into(), name: "Quiz 2 reminder".into(), url: None }
    }
    fn run(title: &str, body: &str) -> Vec<Finding> {
        extract(title, body, posted(), 9, &src(), &ctx())
    }

    #[test]
    fn statics_style_quiz_in_body_with_relative_day() {
        let f = run("Quiz 2 reminder", "<p>Hi everyone,</p><p>Quiz 2 will be held this Thursday during tutorial at 2:10 pm. It covers chapters 4 and 5.</p>");
        assert_eq!(f.len(), 1, "{f:?}");
        assert_eq!((f[0].date.as_str(), f[0].kind, f[0].time.as_deref()), ("2026-10-15", Kind::Quiz, Some("14:10")));
        assert!(f[0].label.contains("Quiz 2"), "{}", f[0].label);
        assert_eq!(f[0].confidence, Confidence::Medium);
        assert!(f[0].caution.as_deref().unwrap().contains("this Thursday"));
    }

    #[test]
    fn kind_from_title_date_from_body() {
        let f = run("Midterm information", "<p>It will be on Friday, October 30 from 10:00 am to 12:00 pm in the gym.</p>");
        assert_eq!(f.len(), 1, "{f:?}");
        assert_eq!((f[0].date.as_str(), f[0].kind, f[0].time.as_deref()), ("2026-10-30", Kind::Exam, Some("10:00")));
        assert_eq!(f[0].label, "Midterm information");
    }

    #[test]
    fn tomorrow_today_on_and_explicit() {
        let f = run("Lab 4", "Reminder: the Lab 4 report is due tomorrow by 11:59 pm.");
        assert_eq!((f[0].date.as_str(), f[0].time.as_deref()), ("2026-10-14", Some("23:59")));
        let f = run("Assignment 3", "Assignment 3 is due on Monday.");
        assert_eq!(f[0].date, "2026-10-19");
        let f = run("Test 1 on Nov 4", "");
        assert_eq!(f[0].date, "2026-11-04");
    }

    #[test]
    fn next_weekday_in_same_week_is_flagged() {
        // Posted Tue Oct 13: "next Friday" could be Oct 16 or Oct 23.
        let f = run("Project", "Project proposal due next Friday.");
        assert_eq!((f[0].date.as_str(), f[0].confidence), ("2026-10-23", Confidence::Low));
        // "next Monday" from a Tuesday is unambiguous.
        let f = run("Quiz", "Quiz 3 next Monday.");
        assert_eq!((f[0].date.as_str(), f[0].confidence), ("2026-10-19", Confidence::Medium));
    }

    #[test]
    fn ignores_past_recurring_office_hours_and_no_keyword() {
        assert!(run("Quiz 1 results", "Quiz 1 was on Monday; results are posted.").is_empty());
        assert!(run("Office hours", "My office hours are Thursdays 2-4 pm in ENG 2040.").is_empty());
        assert!(run("Welcome", "See you in lecture on Wednesday!").is_empty());
        assert!(run("Tutorials", "Tutorials run on Thursdays.").is_empty());
    }

    #[test]
    fn moved_dates_are_noted() {
        let f = run("Quiz 2 moved", "Quiz 2 has been moved to Friday because of the holiday.");
        assert_eq!(f[0].date, "2026-10-16");
        assert!(f[0].caution.as_deref().unwrap().contains("change of date"));
        assert!(mentions_move("Quiz 2 moved", ""));
    }
}
