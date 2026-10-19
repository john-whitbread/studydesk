//! Plain text from course documents (PDF, Word, PowerPoint, text, HTML), in
//! memory only. Limits protect against huge files and zip bombs, and a
//! malformed file is reported and skipped instead of crashing the app.

use crate::{CoreError, Result};
use std::io::Read;

pub const MAX_FILE_BYTES: u64 = 15 * 1000 * 1000;
const MAX_XML_BYTES: u64 = 20 * 1000 * 1000;
const MAX_SLIDES: usize = 200;

pub fn supported(ext: &str) -> bool {
    matches!(ext, "pdf" | "docx" | "pptx" | "txt" | "md" | "html" | "htm")
}

pub fn text_of(ext: &str, bytes: &[u8]) -> Result<String> {
    match ext {
        "pdf" => pdf(bytes),
        "docx" => office(bytes, &["word/document.xml"], "w"),
        "pptx" => {
            let names = slide_names(bytes)?;
            let refs: Vec<&str> = names.iter().map(String::as_str).collect();
            office(bytes, &refs, "a")
        }
        "txt" | "md" => Ok(String::from_utf8_lossy(bytes).into_owned()),
        "html" | "htm" => Ok(crate::dates::html_to_text(&String::from_utf8_lossy(bytes))),
        _ => Err(CoreError::Invalid("Unsupported file type.".into())),
    }
}

fn pdf(bytes: &[u8]) -> Result<String> {
    let owned = bytes.to_vec();
    // pdf-extract can panic on unusual PDFs; contain it.
    let r = std::panic::catch_unwind(move || pdf_extract::extract_text_from_mem(&owned));
    match r {
        Ok(Ok(t)) if t.trim().is_empty() => Err(CoreError::Invalid("No text in this PDF (it may be a scan).".into())),
        Ok(Ok(t)) => Ok(t),
        Ok(Err(_)) | Err(_) => Err(CoreError::Invalid("This PDF couldn't be read.".into())),
    }
}

fn slide_names(bytes: &[u8]) -> Result<Vec<String>> {
    let z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| CoreError::Invalid("Not a valid PowerPoint file.".into()))?;
    let mut names: Vec<(u32, String)> = z
        .file_names()
        .filter_map(|n| {
            let num = n.strip_prefix("ppt/slides/slide")?.strip_suffix(".xml")?.parse().ok()?;
            Some((num, n.to_string()))
        })
        .collect();
    names.sort();
    Ok(names.into_iter().take(MAX_SLIDES).map(|(_, n)| n).collect())
}

/// Reads XML parts from an Office zip and turns paragraphs into lines and
/// table cells into " | " separated columns.
fn office(bytes: &[u8], parts: &[&str], ns: &str) -> Result<String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| CoreError::Invalid("Not a valid Office file.".into()))?;
    let para = regex::Regex::new(&format!(r"</{ns}:p>")).unwrap();
    let cell = regex::Regex::new(r"</(?:w|a):tc>").unwrap();
    let row = regex::Regex::new(r"(?s)<(?:w|a):tr\b.*?</(?:w|a):tr>").unwrap();
    let tab = regex::Regex::new(r"<(?:w|a):(?:tab|br)\b[^>]*/>").unwrap();
    let tags = regex::Regex::new(r"(?s)<[^>]*>").unwrap();
    let spaces = regex::Regex::new(r"[ \t]{2,}").unwrap();
    let mut out = String::new();
    let mut budget = MAX_XML_BYTES;
    for name in parts {
        let Ok(f) = z.by_name(name) else { continue };
        let mut xml = String::new();
        f.take(budget).read_to_string(&mut xml).map_err(|_| CoreError::Invalid("The document is damaged.".into()))?;
        budget = budget.saturating_sub(xml.len() as u64);
        // Keep each table row on one line: paragraphs inside a row become spaces.
        let s = row.replace_all(&xml, |c: &regex::Captures| para.replace_all(&c[0], " ").into_owned() + "\n");
        let s = cell.replace_all(&s, " | ");
        let s = para.replace_all(&s, "\n");
        let s = tab.replace_all(&s, " ");
        let s = tags.replace_all(&s, "");
        let s = crate::google::gmail::decode_entities(&s);
        out.push_str(&spaces.replace_all(&s, " "));
        out.push('\n');
        if budget == 0 {
            break;
        }
    }
    if out.trim().is_empty() {
        return Err(CoreError::Invalid("No text found in this document.".into()));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn docx(xml: &str) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            z.start_file("word/document.xml", zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(xml.as_bytes()).unwrap();
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn docx_paragraphs_and_tables() {
        let xml = r#"<w:document><w:body><w:p><w:r><w:t>Course Schedule</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Oct 28</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Midterm &amp; review</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>"#;
        let t = text_of("docx", &docx(xml)).unwrap();
        assert!(t.contains("Course Schedule\n"));
        assert!(t.contains("Oct 28"));
        assert!(t.contains("Midterm & review"));
        assert!(t.contains("Oct 28 | Midterm & review"), "{t:?}");
    }

    #[test]
    fn bad_files_are_errors_not_panics() {
        assert!(text_of("pdf", b"not a pdf at all").is_err());
        assert!(text_of("docx", b"PK\x03\x04garbage").is_err());
        assert!(text_of("exe", b"MZ").is_err());
    }

    /// Builds a minimal valid PDF with correct xref offsets.
    fn tiny_pdf(text: &str) -> Vec<u8> {
        let content = format!("BT /F1 12 Tf 72 720 Td ({text}) Tj ET");
        let objs = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
            format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_string(),
        ];
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offs = Vec::new();
        for (i, o) in objs.iter().enumerate() {
            offs.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n{o}\nendobj\n", i + 1).as_bytes());
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1).as_bytes());
        for o in offs {
            out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objs.len() + 1).as_bytes());
        out
    }

    #[test]
    fn reads_a_real_pdf() {
        let t = text_of("pdf", &tiny_pdf("Midterm exam Oct 28 at 10 am")).unwrap();
        assert!(t.contains("Midterm exam Oct 28"), "{t:?}");
    }

    #[test]
    fn plain_and_html() {
        assert_eq!(text_of("txt", b"Quiz Nov 5").unwrap(), "Quiz Nov 5");
        assert!(text_of("html", b"<p>Quiz</p><p>Nov 5</p>").unwrap().contains("Quiz"));
    }
}
