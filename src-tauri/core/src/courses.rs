//! Canvas course names as people say them. Ontario Tech (and many schools)
//! name courses like "202609 - Statics - MECE-2230U-002"; Studydesk shows
//! code "MECE 2230U" and name "Statics". Mirrors tidyCourse in src/lib/util.ts.

use regex::Regex;
use std::sync::LazyLock;

static TERM_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\d{6}\s*[-–—:|]\s*").unwrap());
static CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b([A-Z]{2,5})[\s_-]*(\d{4}[A-Z]?)\b").unwrap());
static CODE_IN_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s*[-–—|:(]?\s*\b[A-Z]{2,5}[\s_-]*\d{4}[A-Z]?\b(?:[\s_-]*\(?\d{3}\)?)?\)?\s*[-–—|:)]?\s*").unwrap());
static EDGES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\s\-–—|:]+|[\s\-–—|:]+$").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s{2,}").unwrap());

/// (short code, title).
pub fn tidy(course_code: &str, name: &str) -> (String, String) {
    let raw_code = course_code.trim();
    let raw_name = name.trim();
    let m = CODE.captures(raw_code).or_else(|| CODE.captures(raw_name));
    let code = match &m {
        Some(c) => format!("{} {}", &c[1], &c[2]),
        None => TERM_PREFIX.replace(raw_code, "").trim().to_string(),
    };
    let mut title = TERM_PREFIX.replace(raw_name, "").to_string();
    if m.is_some() {
        title = CODE_IN_NAME.replacen(&title, 1, " ").to_string();
    }
    title = SPACES.replace_all(&EDGES.replace_all(&title, ""), " ").trim().to_string();
    if title.is_empty() || title == code {
        let t = TERM_PREFIX.replace(raw_name, "").trim().to_string();
        title = if t.is_empty() { raw_name.to_string() } else { t };
    }
    let code = if code.is_empty() { title.clone() } else { code };
    (code, title)
}

#[cfg(test)]
mod tests {
    use super::tidy;
    fn t(c: &str, n: &str) -> (String, String) {
        tidy(c, n)
    }
    #[test]
    fn same_cases_as_the_ui() {
        let p = |a: &str, b: &str| (a.to_string(), b.to_string());
        assert_eq!(t("202609 - Differential Equations - MATH-2860U-001", "202609 - Differential Equations - MATH-2860U-001"), p("MATH 2860U", "Differential Equations"));
        assert_eq!(t("202609 - Statics - MECE-2230U-002", "202609 - Statics - MECE-2230U-002"), p("MECE 2230U", "Statics"));
        assert_eq!(t("MECE-2230U", "202609 - Statics"), p("MECE 2230U", "Statics"));
        assert_eq!(t("202609 - Nuclear Plant Operation (NUCL 2020U)", "202609 - Nuclear Plant Operation (NUCL 2020U)"), p("NUCL 2020U", "Nuclear Plant Operation"));
        assert_eq!(t("MECE 2420U", "Solid Mechanics II"), p("MECE 2420U", "Solid Mechanics II"));
        assert_eq!(t("AI-Students", "Academic Integrity Modules for Students"), p("AI-Students", "Academic Integrity Modules for Students"));
        assert_eq!(t("202609 - Prof Competencies", "202609 - Prof Competencies"), p("Prof Competencies", "Prof Competencies"));
        assert_eq!(t("", ""), p("", ""));
    }
}
