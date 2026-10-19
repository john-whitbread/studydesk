//! Look-and-feel settings: theme, accent preset and per-course colours.
//! Everything is validated here so the page can only ever receive values
//! from these fixed lists or a plain `#rrggbb` colour.

use crate::{CoreError, Result};

pub const THEMES: [&str; 3] = ["system", "light", "dark"];

/// Accent presets. Each has a light and dark variant in styles.css, chosen
/// so button text and accent-coloured text stay readable (WCAG AA).
pub const ACCENTS: [&str; 8] = ["blue", "indigo", "violet", "pink", "orange", "green", "teal", "graphite"];

pub fn check_theme(t: &str) -> Result<&str> {
    THEMES.iter().find(|x| **x == t).copied().ok_or_else(|| CoreError::Invalid("Unknown theme.".into()))
}

pub fn check_accent(a: &str) -> Result<&str> {
    ACCENTS.iter().find(|x| **x == a).copied().ok_or_else(|| CoreError::Invalid("Unknown accent colour.".into()))
}

/// Accepts `#rgb` or `#rrggbb` (any case) and returns lowercase `#rrggbb`.
pub fn normalize_hex(c: &str) -> Result<String> {
    let c = c.trim();
    let hex = c.strip_prefix('#').unwrap_or("");
    if !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(CoreError::Invalid("Colours must look like #1a2b3c.".into()));
    }
    match hex.len() {
        6 => Ok(format!("#{}", hex.to_ascii_lowercase())),
        3 => Ok(format!("#{}", hex.chars().flat_map(|ch| [ch, ch]).collect::<String>().to_ascii_lowercase())),
        _ => Err(CoreError::Invalid("Colours must look like #1a2b3c.".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex() {
        assert_eq!(normalize_hex("#1A2b3C").unwrap(), "#1a2b3c");
        assert_eq!(normalize_hex(" #f0a ").unwrap(), "#ff00aa");
        for bad in ["", "#", "1a2b3c", "#12345", "#1234567", "#ggg", "red", "#12 456", "url(x)", "#1a2b3c;color:red"] {
            assert!(normalize_hex(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn lists() {
        assert_eq!(check_theme("dark").unwrap(), "dark");
        assert!(check_theme("Dark").is_err());
        assert!(check_accent("teal").is_ok());
        assert!(check_accent("red\"").is_err());
    }
}
