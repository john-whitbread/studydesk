# Security

Goal: only you, signed in to your own Windows account, can use Studydesk or read what it stores, and everything it sends goes only to Canvas or Google over verified HTTPS. A passphrase is an optional extra layer.

## What is stored, and where

| File | Contents | Protection |
|---|---|---|
| `%APPDATA%\app.studydesk.desktop\vault.bin` | Canvas address and token, Gmail sign-in (if connected), folder links, pinned dates, settings | Encrypted (XChaCha20-Poly1305), then wrapped by Windows DPAPI so only your Windows account can open it; plus your passphrase if you set one |
| `%APPDATA%\app.studydesk.desktop\lockout.json` | Count of wrong passphrases | Not secret |
| `%LOCALAPPDATA%\app.studydesk.desktop\EBWebView` | WebView2's own cache of the app's UI files | No Canvas or mail data: the UI uses no browser storage |

Canvas data, messages and email exist only in memory while unlocked. Nothing is cached to disk.

## How it's protected

**Encryption at rest**
- **Default (no passphrase):** the vault key comes from an internal value nobody can type, so protection rests on Windows DPAPI: the file can only be decrypted by your Windows account on this PC. Studydesk opens without a prompt when you're signed in to Windows.
- **With a passphrase (optional):** key = Argon2id(passphrase, random salt; 64 MiB, 3 passes), so each guess costs real time and memory, on top of DPAPI.
- Cipher = XChaCha20-Poly1305. The header (including the Argon2 settings) is authenticated, so the file can't be tampered with undetected.
- Windows DPAPI wraps the result. A copied `vault.bin` is useless on another PC or Windows account, even with the passphrase.
- Writes are atomic (write, flush, rename), so a crash can't corrupt the vault.

**Locking (only with a passphrase)**
- Locked = no token, key or Canvas/Gmail client in memory. Secrets are zeroed when dropped.
- Auto-lock is **off by default**. You can set it to lock after N minutes with no keyboard or mouse input anywhere on the PC.
- Wrong passphrases: 5 free tries, then waits of 30 s, 60 s, 120 s … up to 15 min. The count survives restarts.

**Secure connections**
- HTTPS only (TLS 1.2 or 1.3 via rustls), with certificates checked against the Windows certificate store. Plain-HTTP addresses are refused.

**Tokens can't leak**
- The Canvas token is attached in exactly one place (`canvas/mod.rs`, `authed`), and only when the request's origin equals the Canvas address you entered.
- Redirects are never followed. Pagination links pointing anywhere else are ignored.
- Uploads go to Canvas's storage host *without* the token. The token goes back on only if the confirmation redirect returns to your Canvas origin.
- Gmail: the refresh token goes only to `oauth2.googleapis.com`, and the access token only to `gmail.googleapis.com`.
- HTTPS only.
- Integration tests (`core/tests/`) run real HTTP servers on different origins and assert all of the above.

**The window**
- The UI has no Node.js, no filesystem and no network access. Its Content Security Policy is `connect-src ipc:` only, with no inline scripts, frames, objects or forms.
- It can call only the commands listed in `capabilities/main.json`. Plugin commands such as shell, fs and http are not granted.
- Every command re-checks its inputs in Rust: ids, paths, URLs, header values.
- Navigation away from the app, popups and downloads are blocked in the window builder. Links open in your normal browser.
- Canvas HTML (descriptions, announcements, HTML email) is sanitised with DOMPurify (patched version) and rendered without images, scripts, styles, frames or forms.

**Your files**
- The UI never sends raw paths. It sends "course id + relative path", which is resolved, canonicalised and checked to stay inside the folder you linked (no `..`, symlinks or junctions).
- Studydesk only lists, opens and reveals files. The only file it ever writes is a Gmail attachment, to a location you choose in a Save dialog.
- The key-date scanner downloads outline files from Canvas into memory only (15 MB cap; zip-bomb limits on Word/PowerPoint) and never saves them. A malformed file is skipped, not run.
- It refuses to launch programs, scripts and shortcuts (`.exe`, `.bat`, `.ps1`, `.lnk`, …).

**Actions that can't be undone**
- Submissions: the assignment is fetched fresh, checked (type, extension, attempts, lock/unlock dates), then confirmed in a **native Windows dialog** the page can't fake or skip. One submission at a time.
- Messages and email: 5-second undo before anything is sent.

## Limits (honest)

- **Malware running as you while Studydesk is unlocked** can read its memory, and a keylogger can capture your passphrase. No desktop app can prevent that. Keep Windows updated and use Defender.
- Without a passphrase, **anyone signed in as you on Windows** can open Studydesk, just like your browser's saved logins. Keep a Windows password or PIN set. Add a Studydesk passphrase if others use your Windows account.
- With a passphrase, someone with your Windows login *and* the passphrase has full access. Pick one you don't use elsewhere.
- Someone with your Windows login can **reset the wrong-passphrase counter** by deleting `lockout.json`. Argon2 still slows each guess, and DPAPI still ties the file to your account.
- The Gmail **client secret** is not truly secret for desktop apps; that's Google's design. The refresh token is what grants access, and it's encrypted in the vault.
- The installer isn't code-signed, so Windows can't verify who built it. Build it yourself from this source.
- Nothing here has had a professional security audit.

## Reporting a problem

Fix it in `src-tauri/core` first, add a test in `core/tests/` that fails without the fix, then run `cargo test --workspace`.
