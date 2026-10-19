# Security

Goal: only you, signed in to your own Windows account, can use Studydesk or read what it stores, and everything it sends goes only to Canvas, Google, Apple (iCloud) or calendar links you add, over verified HTTPS. A passphrase is an optional extra layer.

## What is stored, and where

| File | Contents | Protection |
|---|---|---|
| `%APPDATA%\app.studydesk.desktop\vault.bin` | Canvas address and token, Gmail sign-in, Apple ID email and app-specific password, calendar links (if connected), folder links, pinned dates, settings | Encrypted (XChaCha20-Poly1305), then wrapped by Windows DPAPI so only your Windows account can open it; plus your passphrase if you set one |
| `%APPDATA%\app.studydesk.desktop\lockout.json` | Count of wrong passphrases | Not secret |
| `%LOCALAPPDATA%\app.studydesk.desktop\EBWebView` | WebView2's cache of the UI files, plus two harmless preferences in browser storage: the last theme/accent (so the first frame has the right colours) and the last calendar view | No Canvas, mail, calendar data or secrets |

Canvas data, messages, email and calendar events exist only in memory while unlocked (calendar downloads are cached in memory for 5 minutes and cleared on lock). Nothing is cached to disk.

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
- Apple Calendar: the app-specific password is sent (HTTP Basic, over HTTPS on port 443) only to hosts ending in `.icloud.com`. Redirects are followed by hand, at most 3, and only to such hosts. Server XML is parsed with DTDs disabled. Studydesk rejects anything that isn't shaped like an app-specific password (16 letters), so a normal Apple ID password is almost always refused before it's sent anywhere.
- Calendar links (Google's secret iCal address and similar) are treated as secrets: stored in the vault, never sent to the UI, fetched over HTTPS only, and must really be an iCalendar file.
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

**Your Apple calendars**
- Studydesk reads your calendars and writes only inside the one calendar it creates, named **Studydesk**. Every write and delete is addressed inside that calendar, and deletes are refused if the address isn't. It never edits or deletes events in your other calendars.
- Only changed events are sent. A sync that would change more than 600 events at once is stopped as a likely bug.
- Disconnecting forgets the password; you can also delete the Studydesk calendar from iCloud at the same time. Revoke the app-specific password at account.apple.com if you won't use it again.

**Updates**
- Studydesk checks `github.com/john-whitbread/studydesk` releases for a newer version. Each update is signed with the project's private key (kept as a GitHub secret, never in the code) and verified against the public key built into the app before it's installed. A modified or unsigned update is refused.
- Updates run the same per-user installer as the first install.

**Actions that can't be undone**
- Submissions: the assignment is fetched fresh, checked (type, extension, attempts, lock/unlock dates), then confirmed in a **native Windows dialog** the page can't fake or skip. One submission at a time.
- Messages and email: 5-second undo before anything is sent.

## Limits (honest)

- **Malware running as you while Studydesk is unlocked** can read its memory, and a keylogger can capture your passphrase. No desktop app can prevent that. Keep Windows updated and use Defender.
- Without a passphrase, **anyone signed in as you on Windows** can open Studydesk, just like your browser's saved logins. Keep a Windows password or PIN set. Add a Studydesk passphrase if others use your Windows account.
- With a passphrase, someone with your Windows login *and* the passphrase has full access. Pick one you don't use elsewhere.
- Someone with your Windows login can **reset the wrong-passphrase counter** by deleting `lockout.json`. Argon2 still slows each guess, and DPAPI still ties the file to your account.
- The Gmail **client secret** is not truly secret for desktop apps; that's Google's design. The refresh token is what grants access, and it's encrypted in the vault.
- The installer isn't code-signed, so Windows SmartScreen can't verify who built it. Updates are signature-checked by Studydesk itself (see Updates); for the first install, download only from this repository's Releases page, or build it yourself.
- Anyone with the update signing key could publish an update installed copies would accept. Keep the private key file and its password backed up and private.
- An Apple app-specific password can read and change all your iCloud calendars and contacts; that's Apple's design. Studydesk only uses it for calendars as described above.
- Nothing here has had a professional security audit.

## Reporting a problem

Fix it in `src-tauri/core` first, add a test in `core/tests/` that fails without the fix, then run `cargo test --workspace`.
