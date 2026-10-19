# Studydesk

**Canvas, your course folders, school email and your calendar in one Windows app.**

Studydesk shows what's due next and how close it is, lets you submit straight from your own files, and keeps messages, email and calendar beside your coursework. It's a native Windows desktop app (Tauri + Rust): small, fast, and it keeps your data encrypted on your PC.

---

## Features

**See what matters next**
- **Today**: a **Next up** card with a live countdown, a 14-day **workload strip**, and everything due in the next two weeks, as a list or as **Gravity** (deadlines on a timeline pulled toward *now*, growing bigger and hotter as they approach).
- **Heat colours**: blue (a week or more) → teal → amber → orange (under 24 h, ticking countdown) → red (under 6 h) → deep red (overdue). Every colour also has a text label.
- **Reminders**: Windows notifications 24 h and 2 h before anything unsubmitted and before pinned key dates. Closing the window keeps Studydesk in the tray; it can start with Windows.

**Courses and submitting**
- **Courses**: assignments, details, rubric and feedback, with the course folder from your PC beside them.
- **Submit from your folder**: drag a file onto an assignment (from the folder pane or File Explorer), or take the **"looks like the one"** suggestion, which matches `Lab3_Whitbread.pdf` to "Lab 3". Studydesk checks the file against Canvas (type, attempts, lock date, lateness), then asks you to confirm in a Windows dialog.
- **Key dates**: scans each course's Canvas calendar, syllabus, home page and outline files (on Canvas and in your linked folder) for exams, quizzes and milestones. Each date shows the sentence it came from; pin the ones you want.
- **Tidy course names**: "202609 - Statics - MECE-2230U-002" shows as **MECE 2230U · Statics**.

**Calendar**
- **Calendar tab**: month, week and list views of Canvas deadlines, key dates and your own calendars, including repeating events and time zones.
- **Apple Calendar (two-way)**: your iCloud calendars show in Studydesk, and Studydesk keeps your deadlines and key dates in a calendar called **Studydesk** in iCloud, so they're on your iPhone and Mac.
- **Google Calendar, Outlook and others**: read-only, through their private iCal link.

**Messages**
- **Canvas inbox**: a fast two-pane inbox with keyboard shortcuts, one-click "message the instructor", attachments from your folders, and a 5-second undo on send.
- **Email (optional)**: your school Gmail next to Canvas, with Gmail search, reply / reply all, archive, star and attachments.

**Comfort**
- **Ctrl K** jumps to any course, assignment or action.
- **Appearance**: System, Light or Dark theme, eight accent colours (all readable in both themes), and your own colour for each course.
- **Any screen**: works on portrait monitors, with Windows display scaling, and in small windows. The sidebar folds into a slim strip, and views show one pane at a time when space is tight.
- **Updates itself**: checks GitHub when it opens and every 6 hours, and only installs updates signed with the project's key.
- **First-run tour**: new installs get a short, skippable tour of the main features.

---

## 1. Install

Download the latest **`Studydesk_x.y.z_x64-setup.exe`** from the [Releases page](https://github.com/john-whitbread/studydesk/releases/latest) and run it. It installs for your Windows user only. The installer isn't code-signed, so SmartScreen may warn: choose **More info → Run anyway**.

From then on Studydesk updates itself: it shows **Restart to update** when a new version is out, and **Settings → Updates** has a manual check.

---

## 2. First run: connect Canvas

1. **Canvas address**: what's in your browser bar when you're signed in to Canvas.
2. **Access token**: in Canvas, open **Account → Settings → + New Access Token**. Purpose: `Studydesk`. Set an expiry (end of term is sensible). Paste it straight into Studydesk.
   If that button doesn't exist, your school has disabled student tokens and Studydesk can't connect.
3. **Protection**: by default the token is encrypted and tied to your Windows account, and Studydesk opens straight away. You can also require a passphrase, now or later in Settings. Auto-lock is off unless you turn it on (it needs a passphrase).

Then link each course to its folder: open the course and click **Link a folder…**, or use **Settings → Courses and folders**. Courses you don't need (orientation modules and so on) can be hidden there too.

**Try your first submission on something low-stakes.** Every submission counts as an attempt in Canvas.

---

## 3. Optional: Apple Calendar

1. Go to **account.apple.com → Sign-In and Security → App-Specific Passwords → +** and name it `Studydesk`.
2. Apple shows a 16-letter password like `abcd-efgh-ijkl-mnop`. It only works for calendars and contacts, and you can revoke it there any time.
3. In Studydesk: **Settings → Calendars → Apple Calendar**, enter your Apple ID email and that password, then **Connect**.

- **Your Apple calendars** appear in the Calendar tab; tick the ones to show.
- **"Put Canvas deadlines and key dates in Apple Calendar"** (on by default) keeps a calendar called **Studydesk** in iCloud up to date after every Canvas refresh. Submitted work shows with ✓. Studydesk never changes your other calendars.
- **Disconnect** in the same place, optionally deleting the Studydesk calendar from iCloud.

Never enter your real Apple ID password; Studydesk only accepts the app-specific kind.

## 4. Optional: Google Calendar and other calendars (read-only)

**Settings → Calendars → Add a calendar link…**. For Google Calendar: on a computer, open Settings → click the calendar → **Integrate calendar** → copy **Secret address in iCal format**. Keep that link private: anyone with it can see the calendar.

---

## 5. Optional: connect school Gmail

Google only lets a desktop app read mail if you register it in your own Google Cloud project. This takes about 10 minutes, once. (Google's console layout changes from time to time; the names below match it as of late 2026.)

1. Go to **console.cloud.google.com** and create a project named `Studydesk`. If your school account isn't allowed to create projects, use a personal Google account for this step only.
2. **APIs & Services → Library**: search **Gmail API**, then **Enable**.
3. **Google Auth Platform → Get started** (older layout: *OAuth consent screen*):
   - App name `Studydesk`, support email = your email.
   - **Audience: Internal** if it's offered (only with a school-owned project). Otherwise **External**.
4. If you chose **External**: **Audience → Test users → Add** your school email.
5. **Clients → Create client** → Application type **Desktop app** → Create. Copy the **Client ID** and **Client secret**.
6. In Studydesk: **Settings → School email → Connect Gmail…**, paste both, then **Sign in with Google** and approve in your browser.

| | Internal | External (Testing) |
|---|---|---|
| Who can create it | Only if your school lets students create Cloud projects | Anyone |
| Stays signed in | Yes | **Google ends the sign-in after 7 days**; reconnect in Settings |

**If Google says "Access blocked" or "admin_policy_enforced"**, your school blocks unapproved apps for student accounts. Gmail can't be connected; everything else still works.

Studydesk asks for `gmail.modify`: read, label, archive and send. It **cannot permanently delete** mail. Disconnecting also revokes the permission at Google.

---

## 6. Keyboard

| Where | Keys |
|---|---|
| Anywhere | **Ctrl K** search/jump · **Ctrl N** new message · **Ctrl L** lock (with a passphrase) · **F5** refresh · **Alt 1–5** Today / Canvas inbox / Email / Key dates / Calendar |
| Assignment list, file list | **↑ ↓** move · **Enter** open · **Backspace** up a folder · **Esc** close details |
| Inboxes | **↑ ↓** or **J K** move · **E** archive · **U** unread · **S** star · **R** reply · **C** new · **/** search (Email) · **Ctrl Enter** send |
| Tour | **→ / Enter** next · **←** back · **Esc** skip |

---

## 7. Build from source

You need **Rust**, **Visual Studio Build Tools with "Desktop development with C++"** (including the Windows 11 SDK) and **Node.js 20+**.

In this folder, in any PowerShell window:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-windows.ps1
```

The script checks every prerequisite (and says exactly what to install if something's missing), switches to Visual Studio's 64-bit C++ tools, installs the locked dependencies, builds the installer and opens its folder.

**By hand instead:** open **x64 Native Tools Command Prompt for VS 2022** (not ordinary PowerShell), then `npm ci` and `npm run tauri build`.

**Tests**

```powershell
npm test                                  # UI logic: dates, status, calendar layout, names, contrast
cd src-tauri; cargo test --workspace      # vault, path guards, Canvas/Gmail/iCloud clients, iCalendar
```

**Preview the UI with invented data:** `npm run mock` serves it at http://127.0.0.1:5174. Add `?pass=1&locked=1` for the lock screen (passphrase `correct horse`), `?tour` for the first-run tour, `?noapple` for the calendar before Apple is connected.

## 8. Releasing an update

1. Write what's new in `RELEASE_NOTES.md` (it becomes the release text, shown in Settings → Updates).
2. Raise `version` in `src-tauri/Cargo.toml` and `package.json`.
3. Push to `main`.

The **Release** workflow builds the installer on GitHub's Windows machines, signs the update with the `TAURI_SIGNING_PRIVATE_KEY` secret and publishes `v<version>`. Installed copies offer it within 6 hours, or straight away via Settings → Updates. The **Tests** workflow runs on every push.

---

## 9. Project layout

```
src/                       React UI (no network or filesystem access of its own)
  components/              Today, CourseView, CalendarView, Inbox, Mail, Settings, Tour, …
  lib/                     status and heat rules, calendar layout, store, API wrappers
  mock/                    invented data for `npm run mock` (never built into the app)
src-tauri/
  core/                    all security-relevant logic, unit + integration tested
    src/vault.rs           Argon2id + XChaCha20-Poly1305 vault (+ Windows DPAPI)
    src/canvas/            Canvas REST client, uploads, submissions
    src/google/            Google sign-in (PKCE, loopback), Gmail client, MIME
    src/calendar/          iCalendar reader/writer, iCloud CalDAV, Studydesk calendar sync
    src/courses.rs         course name tidying
    src/dates.rs           key-date extraction
    src/textract.rs        text from PDF / Word / PowerPoint, in memory
    src/reminders.rs       24 h / 2 h reminder rules
    src/submit.rs          pre-submission checks
    src/paths.rs           linked-folder guards
  src/                     Tauri shell: commands, window hardening, tray, updater
  capabilities/main.json   the exact list of commands the UI may call
.github/workflows/         Tests on every push; signed Windows release on version bump
```

See **SECURITY.md** for what is protected, how, and the limits.
