//! Office hours in syllabi, home pages and announcements:
//! "Office hours: Mon & Wed 2:00–3:30 pm, ENG 2040" → Mon/Wed 14:00–15:30, ENG 2040.
//! Suggestions only; nothing is used until you confirm it.

use crate::dates::{html_to_text, Source};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OfficeHours {
    pub id: String,
    pub course_id: u64,
    /// 0 = Monday … 6 = Sunday.
    pub days: Vec<u8>,
    /// HH:MM, 24 h.
    pub start: String,
    pub end: String,
    pub location: Option<String>,
    pub who: Option<String>,
    pub snippet: String,
    pub source: String,
}

static CUE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\boffice\s*hours?\b|\bstudent\s+hours\b|\bdrop[- ]in\s+hours\b").unwrap());
static DAY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(mon(?:day)?s?|tue(?:s(?:day)?)?s?|wed(?:nesday)?s?|thu(?:rs(?:day)?)?s?|fri(?:day)?s?|sat(?:urday)?s?|sun(?:day)?s?)\b\.?").unwrap()
});
/// "2:00–3:30 pm", "2-4pm", "10 am - 12 pm", "14:00–15:30".
static RANGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(?P<h1>\d{1,2})(?::(?P<m1>[0-5]\d))?\s*(?P<ap1>a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to|until)\s*(?P<h2>\d{1,2})(?::(?P<m2>[0-5]\d))?\s*(?P<ap2>a\.?m\.?|p\.?m\.?|noon)?",
    )
    .unwrap()
});
static ROOM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:room\s+)?(?P<room>[A-Z]{2,5}\s?-?\s?[A-Z]?\d{3,4}[A-Z]?)\b|\b(?P<online>online|zoom|microsoft teams|teams|virtual|discord)\b").unwrap()
});
static WHO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?P<who>(?:Dr|Prof|Professor|Mr|Ms|Mrs)\.?\s+[A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+)?|TA:?\s+[A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+)?|Instructor:?\s+[A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+)?)").unwrap()
});

fn day_num(s: &str) -> Option<u8> {
    let s = s.to_ascii_lowercase();
    Some(match &s[..3.min(s.len())] {
        "mon" => 0,
        "tue" => 1,
        "wed" => 2,
        "thu" => 3,
        "fri" => 4,
        "sat" => 5,
        "sun" => 6,
        _ => return None,
    })
}

fn to24(h: u32, m: u32, ap: Option<&str>) -> Option<(u32, u32)> {
    if h > 23 || m > 59 {
        return None;
    }
    let h = match ap.map(|a| a.to_ascii_lowercase()) {
        Some(a) if a.starts_with('p') && h < 12 => h + 12,
        Some(a) if a.starts_with('a') && h == 12 => 0,
        Some(a) if a == "noon" => 12,
        _ => h,
    };
    Some((h, m))
}

/// Parses one range; a missing first am/pm borrows the second ("2-4 pm").
/// Without any am/pm, hours 1–7 are read as afternoon (nobody holds 3 am office hours).
fn parse_range(c: &regex::Captures) -> Option<(String, String)> {
    let h1: u32 = c["h1"].parse().ok()?;
    let h2: u32 = c["h2"].parse().ok()?;
    let m1: u32 = c.name("m1").map_or(Some(0), |m| m.as_str().parse().ok())?;
    let m2: u32 = c.name("m2").map_or(Some(0), |m| m.as_str().parse().ok())?;
    let ap2 = c.name("ap2").map(|m| m.as_str());
    let ap1 = c.name("ap1").map(|m| m.as_str()).or_else(|| {
        // "11-1 pm" crosses noon: the first is am.
        if ap2.is_some_and(|a| a.to_ascii_lowercase().starts_with('p')) && h1 > h2 && h1 < 12 { Some("am") } else { ap2 }
    });
    fn afternoon(h: u32, ap: Option<&str>) -> Option<&str> {
        if ap.is_none() && (1..=7).contains(&h) { Some("pm") } else { ap }
    }
    let (a, b) = (to24(h1, m1, afternoon(h1, ap1))?, to24(h2, m2, afternoon(h2, ap2))?);
    if b <= a || (b.0 - a.0) > 6 {
        return None; // not a plausible office-hours block
    }
    Some((format!("{:02}:{:02}", a.0, a.1), format!("{:02}:{:02}", b.0, b.1)))
}

/// Office-hours suggestions in `text` (plain text or HTML).
pub fn extract(text_or_html: &str, course_id: u64, source: &Source) -> Vec<OfficeHours> {
    let text = if text_or_html.contains('<') { html_to_text(text_or_html) } else { text_or_html.to_string() };
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let mut out: Vec<OfficeHours> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if !CUE.is_match(line) {
            continue;
        }
        // The cue line and up to two following lines ("Office Hours:" as a heading).
        let block: Vec<&str> = lines[i..(i + 3).min(lines.len())].to_vec();
        for (j, l) in block.iter().enumerate() {
            if j > 0 && CUE.is_match(l) {
                break;
            }
            if l.to_ascii_lowercase().contains("by appointment") && !RANGE.is_match(l) {
                continue;
            }
            let days: Vec<u8> = {
                let mut d: Vec<u8> = DAY.captures_iter(l).filter_map(|c| day_num(&c[1])).collect();
                d.sort();
                d.dedup();
                d
            };
            let Some(range) = RANGE.captures(l).and_then(|c| parse_range(&c)) else { continue };
            if days.is_empty() {
                continue;
            }
            let location = ROOM.captures(l).map(|c| {
                c.name("room").map(|r| r.as_str().split_whitespace().collect::<Vec<_>>().join(" ").to_uppercase()).unwrap_or_else(|| {
                    let o = c.name("online").map(|o| o.as_str()).unwrap_or("Online");
                    let mut s = o.to_string();
                    if let Some(f) = s.get_mut(0..1) {
                        f.make_ascii_uppercase();
                    }
                    s
                })
            });
            let who = WHO.captures(l).or_else(|| WHO.captures(line)).map(|c| c["who"].trim().trim_end_matches([',', ':']).to_string());
            let key = format!("{course_id}|{days:?}|{}|{}", range.0, range.1);
            let id: String = Sha256::digest(key.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect();
            if out.iter().any(|o| o.id == id) {
                continue;
            }
            out.push(OfficeHours {
                id,
                course_id,
                days,
                start: range.0,
                end: range.1,
                location,
                who,
                snippet: crate::dates::snippet(&if j == 0 { l.to_string() } else { format!("{line} {l}") }),
                source: source.name.clone(),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(t: &str) -> Vec<OfficeHours> {
        extract(t, 7, &Source { kind: "syllabus".into(), name: "Syllabus".into(), url: None })
    }

    #[test]
    fn common_formats() {
        let o = run("Instructor: Dr. Alvarez\nOffice hours: Mon & Wed 2:00–3:30 pm, ENG 2040");
        assert_eq!(o.len(), 1);
        assert_eq!((o[0].days.clone(), o[0].start.as_str(), o[0].end.as_str()), (vec![0, 2], "14:00", "15:30"));
        assert_eq!(o[0].location.as_deref(), Some("ENG 2040"));

        let o = run("Office Hours:\nThursdays 2-4pm in ERC 1050 (TA Priya Nair)");
        assert_eq!((o[0].days.clone(), o[0].start.as_str(), o[0].end.as_str(), o[0].location.as_deref()), (vec![3], "14:00", "16:00", Some("ERC 1050")));
        assert_eq!(o[0].who.as_deref(), Some("TA Priya Nair"));

        let o = run("Student hours: Tuesday 11 - 1 pm on Zoom");
        assert_eq!((o[0].start.as_str(), o[0].end.as_str(), o[0].location.as_deref()), ("11:00", "13:00", Some("Zoom")));

        let o = run("<p><strong>Office hours</strong></p><p>Friday 10:00 am - 12:00 pm, room UA3240</p>");
        assert_eq!((o[0].days.clone(), o[0].start.as_str(), o[0].location.as_deref()), (vec![4], "10:00", Some("UA3240")));
    }

    #[test]
    fn rejects_non_office_hours() {
        assert!(run("Office hours by appointment only.").is_empty());
        assert!(run("Lectures: Mon 2-4 pm ERC 1050").is_empty(), "needs an office-hours cue");
        assert!(run("Office hours: see the course home page").is_empty());
        assert!(run("Office hours Monday 2 to 11 pm").is_empty(), "9 h is not office hours");
    }
}
