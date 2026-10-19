//! Parsing Gmail API message payloads and building outgoing RFC 5322 mail.

use crate::{CoreError, Result};
use base64::alphabet;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use serde::{Deserialize, Serialize};

const B64URL: GeneralPurpose = GeneralPurpose::new(&alphabet::URL_SAFE, GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent));

pub fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    B64URL.decode(s.trim()).ok()
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Header {
    pub name: String,
    pub value: String,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct Body {
    pub size: u64,
    pub data: Option<String>,
    pub attachment_id: Option<String>,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct Part {
    pub mime_type: String,
    pub filename: String,
    pub headers: Vec<Header>,
    pub body: Body,
    pub parts: Vec<Part>,
}

impl Part {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|h| h.name.eq_ignore_ascii_case(name)).map(|h| h.value.as_str())
    }
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MailAttachment {
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
    pub attachment_id: String,
}

#[derive(Default, Debug)]
pub struct Extracted {
    pub text: Option<String>,
    pub html: Option<String>,
    pub attachments: Vec<MailAttachment>,
}

fn charset_of(content_type: Option<&str>) -> String {
    content_type
        .and_then(|ct| ct.split(';').map(str::trim).find_map(|p| p.strip_prefix("charset=").or_else(|| p.strip_prefix("CHARSET="))))
        .map(|c| c.trim_matches('"').to_ascii_lowercase())
        .unwrap_or_else(|| "utf-8".into())
}

/// Bytes -> text. UTF-8 and Latin-1/Windows-1252 cover nearly all school mail.
fn decode_text(bytes: &[u8], charset: &str) -> String {
    if charset.contains("8859-1") || charset.contains("1252") || charset == "latin1" || charset == "us-ascii" {
        bytes.iter().map(|&b| b as char).collect()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

pub fn extract(p: &Part) -> Extracted {
    let mut out = Extracted::default();
    walk(p, &mut out);
    out
}

fn walk(p: &Part, out: &mut Extracted) {
    let disposition = p.header("Content-Disposition").unwrap_or("").to_ascii_lowercase();
    let is_attachment = !p.filename.is_empty() || disposition.starts_with("attachment");
    if is_attachment {
        if let Some(id) = &p.body.attachment_id {
            out.attachments.push(MailAttachment {
                filename: if p.filename.is_empty() { "attachment".into() } else { p.filename.clone() },
                mime_type: p.mime_type.clone(),
                size: p.body.size,
                attachment_id: id.clone(),
            });
        }
        return;
    }
    let mt = p.mime_type.to_ascii_lowercase();
    if mt == "text/plain" || mt == "text/html" {
        if let Some(bytes) = p.body.data.as_deref().and_then(b64url_decode) {
            let text = decode_text(&bytes, &charset_of(p.header("Content-Type")));
            let slot = if mt == "text/plain" { &mut out.text } else { &mut out.html };
            if slot.is_none() {
                *slot = Some(text);
            }
        }
    }
    for c in &p.parts {
        walk(c, out);
    }
}

/// "Jane Doe <jane@x.ca>" -> ("Jane Doe", "jane@x.ca")
pub fn split_address(s: &str) -> (String, String) {
    let s = s.trim();
    if let (Some(a), Some(b)) = (s.rfind('<'), s.rfind('>')) {
        if a < b {
            let name = s[..a].trim().trim_matches('"').trim().to_string();
            let email = s[a + 1..b].trim().to_string();
            return (if name.is_empty() { email.clone() } else { name }, email);
        }
    }
    (s.to_string(), s.to_string())
}

/// Splits an address list on commas that aren't inside quotes or <>.
pub fn split_list(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let (mut cur, mut quoted, mut angle) = (String::new(), false, false);
    for c in s.chars() {
        match c {
            '"' => quoted = !quoted,
            '<' if !quoted => angle = true,
            '>' if !quoted => angle = false,
            ',' | ';' if !quoted && !angle => {
                if !cur.trim().is_empty() {
                    out.push(cur.trim().to_string());
                }
                cur.clear();
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

// ------------------------------------------------------------------ outgoing

fn no_newlines(field: &str, v: &str) -> Result<()> {
    if v.contains('\r') || v.contains('\n') || v.contains('\0') {
        return Err(CoreError::Invalid(format!("The {field} can't contain line breaks.")));
    }
    Ok(())
}

pub fn check_address(a: &str) -> Result<()> {
    no_newlines("address", a)?;
    let (_, email) = split_address(a);
    let ok = email.len() <= 254
        && email.matches('@').count() == 1
        && !email.starts_with('@')
        && !email.ends_with('@')
        && email.split('@').nth(1).is_some_and(|d| d.contains('.') && !d.starts_with('.') && !d.ends_with('.'))
        && !email.chars().any(|c| c.is_whitespace() || c == ',' || c == ';' || c == '<' || c == '>');
    if ok { Ok(()) } else { Err(CoreError::Invalid(format!("\"{a}\" isn't a valid email address."))) }
}

fn encode_header_text(s: &str) -> String {
    if s.is_ascii() {
        s.to_string()
    } else {
        format!("=?UTF-8?B?{}?=", STANDARD.encode(s.as_bytes()))
    }
}

fn wrap76(s: &str) -> String {
    s.as_bytes().chunks(76).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("\r\n")
}

fn pct(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

pub struct OutAttachment {
    pub filename: String,
    pub mime_type: String,
    pub data: Vec<u8>,
}

pub struct Outgoing<'a> {
    pub from: &'a str,
    pub to: &'a [String],
    pub cc: &'a [String],
    pub subject: &'a str,
    pub body: &'a str,
    pub in_reply_to: Option<&'a str>,
    pub references: Option<&'a str>,
    pub attachments: &'a [OutAttachment],
}

pub fn build(m: &Outgoing) -> Result<Vec<u8>> {
    if m.to.is_empty() {
        return Err(CoreError::Invalid("Add at least one recipient.".into()));
    }
    for a in m.to.iter().chain(m.cc) {
        check_address(a)?;
    }
    check_address(m.from)?;
    no_newlines("subject", m.subject)?;
    for v in [m.in_reply_to, m.references].into_iter().flatten() {
        no_newlines("reply header", v)?;
    }
    let mut boundary = [0u8; 12];
    getrandom::getrandom(&mut boundary).map_err(|_| CoreError::Io("RNG failed.".into()))?;
    let boundary = format!("sd_{}", boundary.iter().map(|b| format!("{b:02x}")).collect::<String>());

    let mut h = String::new();
    h += &format!("From: {}\r\n", m.from);
    h += &format!("To: {}\r\n", m.to.join(", "));
    if !m.cc.is_empty() {
        h += &format!("Cc: {}\r\n", m.cc.join(", "));
    }
    h += &format!("Subject: {}\r\n", encode_header_text(m.subject));
    h += &format!("Date: {}\r\n", chrono::Local::now().to_rfc2822());
    if let Some(r) = m.in_reply_to {
        h += &format!("In-Reply-To: {r}\r\n");
    }
    if let Some(r) = m.references {
        h += &format!("References: {r}\r\n");
    }
    h += "MIME-Version: 1.0\r\n";
    let text_part = format!(
        "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n",
        wrap76(&STANDARD.encode(m.body.replace("\r\n", "\n").replace('\n', "\r\n").as_bytes()))
    );
    if m.attachments.is_empty() {
        return Ok(format!("{h}{text_part}").into_bytes());
    }
    let mut s = format!("{h}Content-Type: multipart/mixed; boundary=\"{boundary}\"\r\n\r\n--{boundary}\r\n{text_part}");
    for a in m.attachments {
        no_newlines("file name", &a.filename)?;
        let ascii: String = a.filename.chars().map(|c| if c.is_ascii() && c != '"' && c != '\\' { c } else { '_' }).collect();
        s += &format!(
            "--{boundary}\r\nContent-Type: {}; name=\"{ascii}\"\r\nContent-Disposition: attachment; filename=\"{ascii}\"; filename*=UTF-8''{}\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n",
            a.mime_type,
            pct(&a.filename),
            wrap76(&STANDARD.encode(&a.data))
        );
    }
    s += &format!("--{boundary}--\r\n");
    Ok(s.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part(json: serde_json::Value) -> Part {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn extracts_text_html_and_attachments() {
        let p = part(serde_json::json!({
            "mimeType": "multipart/mixed",
            "parts": [
                {"mimeType": "multipart/alternative", "parts": [
                    {"mimeType": "text/plain", "headers": [{"name":"Content-Type","value":"text/plain; charset=\"UTF-8\""}], "body": {"data": B64URL.encode("Hi Jöhn,\nsee attached.")}},
                    {"mimeType": "text/html", "body": {"data": B64URL.encode("<p>Hi</p>")}}
                ]},
                {"mimeType": "application/pdf", "filename": "Lab 3.pdf", "body": {"size": 1234, "attachmentId": "ANGj"}}
            ]
        }));
        let e = extract(&p);
        assert_eq!(e.text.as_deref(), Some("Hi Jöhn,\nsee attached."));
        assert_eq!(e.html.as_deref(), Some("<p>Hi</p>"));
        assert_eq!(e.attachments, vec![MailAttachment { filename: "Lab 3.pdf".into(), mime_type: "application/pdf".into(), size: 1234, attachment_id: "ANGj".into() }]);
    }

    #[test]
    fn latin1_body() {
        let p = part(serde_json::json!({"mimeType":"text/plain","headers":[{"name":"Content-Type","value":"text/plain; charset=ISO-8859-1"}],"body":{"data": B64URL.encode([0x63u8, 0x61, 0x66, 0xe9])}}));
        assert_eq!(extract(&p).text.as_deref(), Some("café"));
    }

    #[test]
    fn addresses() {
        assert_eq!(split_address("\"Doe, Jane\" <jane@x.ca>"), ("Doe, Jane".into(), "jane@x.ca".into()));
        assert_eq!(split_address("jane@x.ca"), ("jane@x.ca".into(), "jane@x.ca".into()));
        assert_eq!(split_list("\"Doe, Jane\" <jane@x.ca>, bob@y.ca"), vec!["\"Doe, Jane\" <jane@x.ca>".to_string(), "bob@y.ca".into()]);
        assert!(check_address("Prof <prof@ontariotechu.ca>").is_ok());
        assert!(check_address("nope").is_err());
        assert!(check_address("a@b").is_err());
        assert!(check_address("a@b.ca\r\nBcc: evil@x.ca").is_err());
    }

    #[test]
    fn builds_reply_with_attachment_and_blocks_header_injection() {
        let to = vec!["Prof <prof@school.ca>".to_string()];
        let att = [OutAttachment { filename: "Lab 3 – final.pdf".into(), mime_type: "application/pdf".into(), data: b"%PDF".to_vec() }];
        let raw = String::from_utf8(
            build(&Outgoing {
                from: "me@school.net",
                to: &to,
                cc: &[],
                subject: "Re: Lab 3 – question",
                body: "Thanks!\nJohn",
                in_reply_to: Some("<abc@mail.gmail.com>"),
                references: Some("<abc@mail.gmail.com>"),
                attachments: &att,
            })
            .unwrap(),
        )
        .unwrap();
        assert!(raw.contains("To: Prof <prof@school.ca>\r\n"));
        assert!(raw.contains("Subject: =?UTF-8?B?"));
        assert!(raw.contains("In-Reply-To: <abc@mail.gmail.com>\r\n"));
        assert!(raw.contains("filename*=UTF-8''Lab%203%20%E2%80%93%20final.pdf"));
        assert!(raw.contains(&STANDARD.encode("Thanks!\r\nJohn")));
        let bad = build(&Outgoing { from: "me@school.net", to: &to, cc: &[], subject: "x\r\nBcc: a@b.ca", body: "", in_reply_to: None, references: None, attachments: &[] });
        assert!(bad.is_err());
    }
}
