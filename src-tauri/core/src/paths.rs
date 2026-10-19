//! Filesystem access. The UI never sends absolute paths: it sends a course id
//! plus a relative path, and everything is resolved and checked here so a
//! request can't escape the folder you linked (no `..`, no symlink tricks).
//! Studydesk only reads, opens and reveals files. It never edits, moves or
//! deletes anything.

use crate::{CoreError, Result};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    /// Path relative to the linked folder, with `/` separators.
    pub rel: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: Option<i64>,
    /// Lower-case extension without the dot; empty for folders.
    pub ext: String,
}

pub fn canonical(p: &Path) -> Result<PathBuf> {
    // dunce avoids Windows `\\?\` verbatim prefixes so paths stay readable.
    dunce::canonicalize(p).map_err(Into::into)
}

/// Resolves `rel` inside `root`, rejecting anything that leaves it.
pub fn resolve_within(root: &Path, rel: &str) -> Result<PathBuf> {
    let root = canonical(root)?;
    let mut joined = root.clone();
    for part in rel.split(['/', '\\']).filter(|s| !s.is_empty()) {
        let p = Path::new(part);
        let mut comps = p.components();
        match (comps.next(), comps.next()) {
            (Some(Component::Normal(c)), None) => joined.push(c),
            (Some(Component::CurDir), None) => {}
            _ => return Err(CoreError::Invalid("That path is outside the linked folder.".into())),
        }
    }
    let resolved = canonical(&joined)?;
    if !resolved.starts_with(&root) {
        return Err(CoreError::Invalid("That path is outside the linked folder.".into()));
    }
    Ok(resolved)
}

fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .map(|r| r.components().filter_map(|c| c.as_os_str().to_str()).collect::<Vec<_>>().join("/"))
        .unwrap_or_default()
}

pub fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default()
}

fn modified_ms(m: &std::fs::Metadata) -> Option<i64> {
    m.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

/// Files a student never wants to see in a course folder.
fn is_hidden(name: &str, meta: &std::fs::Metadata) -> bool {
    let lower = name.to_ascii_lowercase();
    if name.starts_with('.') || name.starts_with("~$") || lower == "desktop.ini" || lower == "thumbs.db" {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        if meta.file_attributes() & (HIDDEN | SYSTEM) != 0 {
            return true;
        }
    }
    let _ = meta;
    false
}

/// Lists one directory inside a linked folder. Symlinks and junctions are
/// skipped entirely.
pub fn list_dir(root: &Path, rel: &str) -> Result<Vec<Entry>> {
    let root_c = canonical(root)?;
    let dir = resolve_within(&root_c, rel)?;
    if !dir.is_dir() {
        return Err(CoreError::Invalid("That is not a folder.".into()));
    }
    let mut out = Vec::new();
    for item in std::fs::read_dir(&dir)? {
        let Ok(item) = item else { continue };
        let Ok(meta) = std::fs::symlink_metadata(item.path()) else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        let name = item.file_name().to_string_lossy().to_string();
        if is_hidden(&name, &meta) {
            continue;
        }
        let path = item.path();
        out.push(Entry {
            rel: rel_of(&root_c, &path),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified_ms: modified_ms(&meta),
            ext: if meta.is_dir() { String::new() } else { ext_of(&path) },
            name,
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// Walks a linked folder (bounded) and returns the most recently modified
/// files, optionally only those with an allowed extension. Used to suggest
/// what to submit.
pub fn recent_files(root: &Path, allowed_ext: &[String], limit: usize) -> Result<Vec<Entry>> {
    const MAX_DEPTH: usize = 6;
    const MAX_VISITED: usize = 5000;
    let root_c = canonical(root)?;
    let allowed: Vec<String> = allowed_ext.iter().map(|e| e.trim_start_matches('.').to_ascii_lowercase()).collect();
    let mut stack = vec![(root_c.clone(), 0usize)];
    let mut visited = 0usize;
    let mut files = Vec::new();
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for item in rd.flatten() {
            visited += 1;
            if visited > MAX_VISITED {
                break;
            }
            let Ok(meta) = std::fs::symlink_metadata(item.path()) else { continue };
            let name = item.file_name().to_string_lossy().to_string();
            if meta.file_type().is_symlink() || is_hidden(&name, &meta) {
                continue;
            }
            let path = item.path();
            if meta.is_dir() {
                if depth + 1 < MAX_DEPTH {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let ext = ext_of(&path);
            if !allowed.is_empty() && !allowed.contains(&ext) {
                continue;
            }
            files.push(Entry { rel: rel_of(&root_c, &path), is_dir: false, size: meta.len(), modified_ms: modified_ms(&meta), ext, name });
        }
    }
    files.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    files.truncate(limit);
    Ok(files)
}

/// Extensions Studydesk refuses to launch. You can still run these from
/// File Explorer; this only stops a stray click in Studydesk from executing
/// something.
const BLOCKED_EXT: &[&str] = &[
    "exe", "com", "bat", "cmd", "msi", "msp", "msc", "scr", "pif", "cpl", "ps1", "psm1", "psd1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
    "hta", "lnk", "url", "reg", "inf", "jar", "appref-ms", "application", "gadget", "scf", "appx", "appxbundle", "msix", "msixbundle",
    "xll", "dll", "sys", "drv", "ocx", "chm", "sct", "settingcontent-ms", "library-ms", "search-ms", "diagcab", "iso", "img", "vhd",
    "vhdx",
];

pub fn is_blocked_for_open(p: &Path) -> bool {
    BLOCKED_EXT.contains(&ext_of(p).as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tree() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("Labs/Lab 3")).unwrap();
        fs::write(d.path().join("Labs/Lab 3/report.pdf"), b"%PDF").unwrap();
        fs::write(d.path().join("notes.docx"), b"x").unwrap();
        fs::write(d.path().join(".hidden"), b"x").unwrap();
        fs::write(d.path().join("~$notes.docx"), b"x").unwrap();
        d
    }

    #[test]
    fn lists_sorted_dirs_first_and_hides_junk() {
        let d = tree();
        let e = list_dir(d.path(), "").unwrap();
        let names: Vec<_> = e.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, vec!["Labs", "notes.docx"]);
        let sub = list_dir(d.path(), "Labs/Lab 3").unwrap();
        assert_eq!(sub[0].rel, "Labs/Lab 3/report.pdf");
        assert_eq!(sub[0].ext, "pdf");
    }

    #[test]
    fn traversal_rejected() {
        let d = tree();
        assert!(resolve_within(d.path(), "../").is_err());
        assert!(resolve_within(d.path(), "Labs/../../etc").is_err());
        assert!(resolve_within(d.path(), "Labs\\..\\..").is_err());
        assert!(resolve_within(d.path(), "Labs/./Lab 3").is_ok());
    }

    #[test]
    fn absolute_looking_paths_stay_inside() {
        // Leading separators are ignored, so "/etc/passwd" means <root>/etc/passwd,
        // which doesn't exist and therefore fails to canonicalize.
        let d = tree();
        assert!(resolve_within(d.path(), "/etc/passwd").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_rejected_and_hidden() {
        let d = tree();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), b"s").unwrap();
        std::os::unix::fs::symlink(outside.path(), d.path().join("link")).unwrap();
        assert!(resolve_within(d.path(), "link/secret.txt").is_err());
        assert!(list_dir(d.path(), "").unwrap().iter().all(|e| e.name != "link"));
        assert!(recent_files(d.path(), &[], 50).unwrap().iter().all(|e| e.name != "secret.txt"));
    }

    #[test]
    fn recent_filters_by_extension() {
        let d = tree();
        let pdfs = recent_files(d.path(), &["PDF".into()], 10).unwrap();
        assert_eq!(pdfs.len(), 1);
        assert_eq!(pdfs[0].name, "report.pdf");
        assert_eq!(recent_files(d.path(), &[], 10).unwrap().len(), 2);
    }

    #[test]
    fn blocks_executables() {
        assert!(is_blocked_for_open(Path::new("C:/x/setup.EXE")));
        assert!(is_blocked_for_open(Path::new("run.ps1")));
        assert!(is_blocked_for_open(Path::new("Shortcut.lnk")));
        assert!(!is_blocked_for_open(Path::new("report.pdf")));
        assert!(!is_blocked_for_open(Path::new("model.SLDPRT")));
    }
}
