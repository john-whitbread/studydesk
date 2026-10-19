# Studydesk

Canvas, your course folders and your school email in one window.

- **Today**: a **Next up** card for the most pressing thing, a 14-day **workload strip**, and everything due in the next two weeks, as a list or as **deadline gravity** (deadlines pulled toward a glowing *now* line, growing hotter as they approach).
- **Heat colours and live countdowns**: blue (a week+) → teal → amber → orange (under 24 h, ticking countdown) → red (under 6 h) → deep red (overdue).
- **Key dates**: scans each course's Canvas calendar, syllabus, home page and course-outline files (on Canvas and in your linked folder) for exams, quizzes and milestones. Every date shows the sentence it came from; pin the ones you want.
- **Reminders**: Windows notifications 24 h and 2 h before anything unsubmitted and before pinned key dates. Closing the window keeps Studydesk in the tray; optional start with Windows.
- **Courses**: assignments, full details, rubric and feedback, with the course folder from your computer beside them.
- **Submit from your folder**: drag a file onto an assignment (from the folder pane or File Explorer), or take the **"looks like the one"** suggestion (it matches file names like `Lab3_Whitbread.pdf` to "Lab 3"). Studydesk checks it against Canvas (file type, attempts, lock date, lateness), then asks you to confirm in a Windows dialog.
- **Canvas inbox**: a fast two-pane inbox with keyboard shortcuts, one-click "message the instructor", file attachments from your folders, and a 5-second undo on send.
- **Email (optional)**: your school Gmail next to Canvas: Gmail search, reply / reply all, archive, star, attachments.
- **Ctrl K**: jump to any course, assignment or action.

---

## 1. Build and run on Windows

You need **Rust**, **Visual Studio Build Tools with "Desktop development with C++"**, and **Node.js 20+**. WebView2 is built into Windows 11.

**Easiest:** in this folder, in any PowerShell window, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-windows.ps1
```

The script:
- checks each prerequisite and says exactly what to install if something's missing;
- finds Visual Studio and switches to its **64-bit** C++ tools (this is what fixes `linker 'link.exe' not found`);
- installs the locked dependencies and builds the installer;
- opens the folder containing `Studydesk_0.1.0_x64-setup.exe`.

Run the installer. Studydesk is then in the Start menu like any other app. It installs for your Windows user only. SmartScreen will warn because the installer isn't code-signed: choose **More info → Run anyway**.

**By hand instead:** open **x64 Native Tools Command Prompt for VS 2022** from the Start menu (not ordinary PowerShell), then run:

```
npm ci
npm run tauri build
```

**If you see `link.exe not found`:** the 64-bit C++ tools aren't active in that window. Use the script or the x64 Native Tools prompt. In ordinary PowerShell, `where link` doesn't search for programs; `where.exe link` does.

### Tests

```powershell
npm test                                  # date/status logic (Node test runner)
cd src-tauri; cargo test --workspace      # vault, path guards, Canvas + Gmail clients
```

> **Not compiled before shipping:** the Windows-only code (`core/src/dpapi.rs`, `core/src/idle.rs`, and the hidden-file check in `core/src/paths.rs`). Everything else was built and tested on Linux. If the first Windows build fails, the error will be in one of those three places.

---

## 1a. Updates

After the first install, Studydesk updates itself: it checks GitHub Releases
when it opens and every 6 hours, and shows **Restart to update**. Settings →
Updates has a manual check. Only releases signed with the project's key are
accepted.

**Publishing a release:** raise `version` in `src-tauri/Cargo.toml` and
`package.json`, then push to `main`. The Release workflow builds the
installer on GitHub's Windows machines, signs it with the
`TAURI_SIGNING_PRIVATE_KEY` secret, and publishes `v<version>`.

## 2. First run: connect Canvas

1. **Canvas address**: what's in your browser bar when you're signed in to Canvas.
2. **Access token**: in Canvas, open **Account → Settings → + New Access Token**. Purpose: `Studydesk`. Set an expiry (end of term is sensible). Paste it straight into Studydesk.
   If that button doesn't exist, your school has disabled student tokens and Studydesk can't connect.
3. **Protection**: by default your token is encrypted and tied to your Windows account, and Studydesk opens straight away. You can also require a passphrase, either now or later in Settings. Auto-lock is off unless you turn it on, which needs a passphrase.

Then link each course to its folder: open the course, click **Link a folder…**, or use **Settings → Courses and folders**.

**Try your first submission on something low-stakes.** Every submission counts as an attempt in Canvas.

---

## 3. Optional: connect school Gmail

Google only lets a desktop app read mail if you register it in your own Google Cloud project. This takes about 10 minutes, once. (Google's console layout changes from time to time; the names below match it as of late 2026.)

1. Go to **console.cloud.google.com**. **Sign in with your school account first** (see "Internal vs External" below). Create a project named `Studydesk`.
2. **APIs & Services → Library**: search **Gmail API**, then **Enable**.
3. **Google Auth Platform → Get started** (older layout: *OAuth consent screen*):
   - App name `Studydesk`, support email = your email.
   - **Audience: Internal** if it's offered (only with a school-owned project). Otherwise **External**.
4. If you chose **External**: **Audience → Test users → Add** your school email.
5. **Clients → Create client** → Application type **Desktop app** → Create. Copy the **Client ID** and **Client secret**.
6. In Studydesk: **Settings → School email → Connect Gmail…**, paste both, then **Sign in with Google**. Your browser opens Google's sign-in page; approve, then come back.

**Internal vs External**

| | Internal | External (Testing) |
|---|---|---|
| Who can create it | Only if Ontario Tech lets students create Cloud projects with their school account | Anyone |
| Stays signed in | Yes | **Google ends the sign-in after 7 days**; reconnect in Settings |

**If Google says "Access blocked" or "admin_policy_enforced"**, the school blocks unapproved apps for student accounts. Gmail can't be connected; everything else still works.

Studydesk asks for the `gmail.modify` permission: read, label, archive and send. It **cannot permanently delete** mail. Disconnecting in Settings also revokes the permission at Google.

---

## 4. Keyboard

| Where | Keys |
|---|---|
| Anywhere | **Ctrl K** search/jump · **Ctrl N** new message · **Ctrl L** lock (with a passphrase) · **F5** refresh · **Alt 1/2/3/4** Today / Canvas inbox / Email / Key dates |
| Assignment list, file list | **↑ ↓** move · **Enter** open · **Backspace** up a folder · **Esc** close details |
| Inboxes | **↑ ↓** or **J K** move · **E** archive · **U** unread · **S** star · **R** reply · **C** new · **/** search (Email) · **Ctrl Enter** send |

---

## 5. Project layout

```
src/                     React UI (no network, no filesystem access of its own)
  components/            views: Today, CourseView, Inbox, Mail, Settings, …
  lib/                   status rules, dates, sanitiser, store, API wrappers
  mock/                  fake backend for `npm run mock` (design work only, never built in)
src-tauri/
  core/                  all security-relevant logic, unit + integration tested
    src/vault.rs         Argon2id + XChaCha20-Poly1305 vault (+ Windows DPAPI)
    src/canvas/          Canvas REST client, uploads, submissions
    src/google/          Google sign-in (PKCE, loopback), Gmail client, MIME
    src/paths.rs         linked-folder guards
    src/dates.rs         key-date extraction (dates, times, weights, "Week N")
    src/textract.rs      text from PDF / Word / PowerPoint, in memory
    src/reminders.rs     24 h / 2 h reminder rules
    src/submit.rs        pre-submission checks
  src/                   Tauri shell: commands, window hardening, auto-lock
  capabilities/main.json the exact list of commands the UI may call
```

`npm run mock` serves the UI in a normal browser with invented data at http://127.0.0.1:5174 (add `?pass=1&locked=1` to test the lock screen; passphrase `correct horse`). Useful for UI changes without touching Canvas.

See **SECURITY.md** for what is protected, how, and the limits.
