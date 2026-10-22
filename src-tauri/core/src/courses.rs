//! Canvas course names as people say them. Mirrors tidyCourse in src/lib/util.ts:
//! "202609 - Statics - MECE-2230U-002" → code "MECE 2230U", name "Statics";
//! "Statics 09.202609.XLIST" (code MECE 2230U) → "Statics";
//! "Thermodynamics - 43421" (no course code) → "Thermodynamics" for both.

use regex::Regex;
use std::sync::LazyLock;

static TERM_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\d{6}\s*[-–—:|]\s*").unwrap());
static NOISE_SUFFIX: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    [Regex::new(r"(?i)\s+\d{1,3}\.\d{6}\.XLIST\b.*$").unwrap(), Regex::new(r"\s*[-–—]\s*\d{5}\s*$").unwrap(), Regex::new(r"\s*\(\d{5,6}\)\s*$").unwrap()]
});
static CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b([A-Z]{2,5})[\s_-]*(\d{4}[A-Z]?)\b").unwrap());
static CODE_IN_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s*[-–—|:(]?\s*\b[A-Z]{2,5}[\s_-]*\d{4}[A-Z]?\b(?:[\s_-]*\(?\d{3}\)?)?\)?\s*[-–—|:)]?\s*").unwrap());
static EDGES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\s\-–—|:]+|[\s\-–—|:]+$").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s{2,}").unwrap());

fn strip_noise(s: &str) -> String {
    let mut t = TERM_PREFIX.replace(s, "").to_string();
    for re in NOISE_SUFFIX.iter() {
        t = re.replace(&t, "").to_string();
    }
    SPACES.replace_all(&EDGES.replace_all(&t, ""), " ").trim().to_string()
}

/// (short code, title).
pub fn tidy(course_code: &str, name: &str) -> (String, String) {
    let raw_code = course_code.trim();
    let raw_name = name.trim();
    let m = CODE.captures(raw_code).or_else(|| CODE.captures(raw_name));
    let mut title = strip_noise(raw_name);
    if m.is_some() {
        title = strip_noise(&CODE_IN_NAME.replacen(&title, 1, " "));
    }
    if title.is_empty() {
        title = strip_noise(raw_code);
        if title.is_empty() {
            title = raw_name.to_string();
        }
    }
    let code = match &m {
        Some(c) => format!("{} {}", &c[1], &c[2]),
        None => {
            let c = strip_noise(raw_code);
            if c.is_empty() { title.clone() } else { c }
        }
    };
    let code = if code == strip_noise(raw_name) { title.clone() } else { code };
    (code, title)
}

#[cfg(test)]
mod tests {
    use super::tidy;
    fn t(c: &str, n: &str) -> (String, String) {
        tidy(c, n)
    }
    fn p(a: &str, b: &str) -> (String, String) {
        (a.to_string(), b.to_string())
    }
    #[test]
    fn same_cases_as_the_ui() {
        assert_eq!(t("202609 - Differential Equations - MATH-2860U-001", "202609 - Differential Equations - MATH-2860U-001"), p("MATH 2860U", "Differential Equations"));
        assert_eq!(t("202609 - Statics - MECE-2230U-002", "202609 - Statics - MECE-2230U-002"), p("MECE 2230U", "Statics"));
        assert_eq!(t("MECE-2230U", "202609 - Statics"), p("MECE 2230U", "Statics"));
        assert_eq!(t("202609 - Nuclear Plant Operation (NUCL 2020U)", "202609 - Nuclear Plant Operation (NUCL 2020U)"), p("NUCL 2020U", "Nuclear Plant Operation"));
        assert_eq!(t("MECE 2420U", "Solid Mechanics II"), p("MECE 2420U", "Solid Mechanics II"));
        assert_eq!(t("AI-Students", "Academic Integrity Modules for Students"), p("AI-Students", "Academic Integrity Modules for Students"));
        assert_eq!(t("202609 - Prof Competencies", "202609 - Prof Competencies"), p("Prof Competencies", "Prof Competencies"));
        assert_eq!(t("", ""), p("", ""));
    }
    #[test]
    fn ontario_tech_xlist_and_crn() {
        assert_eq!(t("MATH 2860U", "Differential Equations for Eng 46.202609.XLIST"), p("MATH 2860U", "Differential Equations for Eng"));
        assert_eq!(t("MECE 2230U", "Statics 09.202609.XLIST"), p("MECE 2230U", "Statics"));
        assert_eq!(t("Nuclear Plant Operation - 44162", "Nuclear Plant Operation - 44162"), p("Nuclear Plant Operation", "Nuclear Plant Operation"));
        assert_eq!(t("Thermodynamics - 43421", "Thermodynamics - 43421"), p("Thermodynamics", "Thermodynamics"));
        assert_eq!(t("Structure & Prop. of Materials - 43380", "Structure & Prop. of Materials - 43380"), p("Structure & Prop. of Materials", "Structure & Prop. of Materials"));
    }
}
