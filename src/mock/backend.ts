// DEVELOPMENT ONLY. Fake backend so the UI can run in a normal browser
// (`npm run mock`). All names and data are invented. Never part of a build:
// api.ts only imports this when Vite's mode is "mock".

import type { Assignment, Conversation, Course, Entry, PickedFile } from "../lib/types.ts";

const H = 3600_000;
const D = 24 * H;
const now = Date.now();
const at = (days: number, hour = 23, min = 59) => {
  const d = new Date(now + days * D);
  d.setHours(hour, min, 0, 0);
  return d.toISOString();
};
const ago = (ms: number) => new Date(now - ms).toISOString();

let unlocked = new URLSearchParams(location.search).get("locked") == null;
let vault = new URLSearchParams(location.search).get("setup") == null;

const courses: Course[] = [
  { id: 101, name: "Solid Mechanics II", course_code: "MECE 2420U", term: { name: "Fall 2026" }, enrollments: [{ type: "student", computed_current_score: 84.6, computed_current_grade: "A-" }], color: "#2563eb", folder: "C:\\Users\\student\\School\\MECE 2420U", hidden: false },
  { id: 102, name: "Fluid Mechanics", course_code: "MECE 2860U", term: { name: "Fall 2026" }, enrollments: [{ type: "student", computed_current_score: 78.25, computed_current_grade: "B+" }], color: "#0d9488", folder: "C:\\Users\\student\\School\\MECE 2860U", hidden: false },
  { id: 103, name: "Differential Equations", course_code: "MATH 2860U", term: { name: "Fall 2026" }, enrollments: [{ type: "student", computed_current_score: 91.1, computed_current_grade: "A+" }], color: "#9333ea", folder: null, hidden: false },
  { id: 104, name: "Introduction to Nuclear Engineering", course_code: "NUCL 2020U", term: { name: "Fall 2026" }, enrollments: [{ type: "student", computed_current_score: null }], color: "#d97706", folder: "C:\\Users\\student\\School\\NUCL 2020U", hidden: false },
  { id: 105, name: "Engineering Design Studio", course_code: "ENGR 2310U", term: { name: "Fall 2026" }, enrollments: [{ type: "student" }], color: "#e11d48", folder: null, hidden: false },
];

const sub = (s: Partial<NonNullable<Assignment["submission"]>> = {}) => ({ attachments: [], submission_comments: [], workflow_state: "unsubmitted", ...s });
const A = (o: Partial<Assignment> & { id: number; course_id: number; name: string }): Assignment => ({
  submission_types: ["online_upload"],
  allowed_extensions: ["pdf"],
  rubric: [],
  points_possible: 10,
  allowed_attempts: -1,
  html_url: `https://canvas.example.edu/courses/${o.course_id}/assignments/${o.id}`,
  submission: sub(),
  ...o,
});

const desc = `<p>Analyse the thick-walled cylinder in <strong>Figure 3</strong> using Lamé's equations. Submit one PDF containing:</p>
<ol><li>Free-body diagram and assumptions</li><li>Radial and hoop stress distributions (plot both on one graph)</li><li>Comparison with the FEA result from SolidWorks Simulation, with % difference</li></ol>
<p>Use the report template on the course page. <a href="https://canvas.example.edu/courses/101/files/55">Lab report template.docx</a></p>
<img src="https://canvas.example.edu/x.png" alt="Figure 3"><p>Late penalty: 10% per day, up to 3 days.</p>`;

let assignments: Assignment[] = [
  A({ id: 1, course_id: 101, name: "Lab 3 – Thick-walled cylinders", due_at: at(0, 23, 59), points_possible: 20, allowed_extensions: ["pdf"], allowed_attempts: 2, description: desc,
      rubric: [{ id: "r1", description: "Free-body diagram & assumptions", points: 4, ratings: [] }, { id: "r2", description: "Stress distributions", points: 8, ratings: [] }, { id: "r3", description: "FEA comparison", points: 6, ratings: [] }, { id: "r4", description: "Presentation", points: 2, ratings: [] }] }),
  A({ id: 2, course_id: 101, name: "Problem Set 6 – Torsion of non-circular shafts", due_at: at(3, 17, 0), points_possible: 15, allowed_extensions: ["pdf"] }),
  A({ id: 3, course_id: 101, name: "Problem Set 5 – Energy methods", due_at: at(-4, 17, 0), points_possible: 15, submission: sub({ workflow_state: "graded", submitted_at: at(-5, 21, 10), graded_at: ago(1 * D), score: 13.5, grade: "13.5", attempt: 1,
      submission_comments: [{ id: 9, author_name: "Dr. R. Alvarez", comment: "Good work. Q3 is missing the strain energy from shear, see the solution posted on the course page.", created_at: ago(1 * D), attachments: [] }] }) }),
  A({ id: 4, course_id: 101, name: "Midterm exam", due_at: at(9, 10, 0), submission_types: ["on_paper"], allowed_extensions: [], points_possible: 100 }),
  A({ id: 5, course_id: 102, name: "Lab 2 – Pipe friction losses", due_at: at(-1, 23, 59), points_possible: 25, allowed_extensions: ["pdf", "docx"], submission: sub({ missing: false }) }),
  A({ id: 6, course_id: 102, name: "Quiz 4 – Bernoulli and energy equation", due_at: at(1, 9, 0), submission_types: ["online_quiz"], is_quiz_assignment: true, allowed_extensions: [], points_possible: 5 }),
  A({ id: 7, course_id: 102, name: "Assignment 4 – Dimensional analysis", due_at: at(5, 23, 59), points_possible: 20, allowed_extensions: ["pdf", "zip"], submission: sub({ workflow_state: "submitted", submitted_at: ago(2 * H), attempt: 1 }) }),
  A({ id: 8, course_id: 103, name: "Webwork 7 – Laplace transforms", due_at: at(2, 23, 59), submission_types: ["external_tool"], allowed_extensions: [], points_possible: 4 }),
  A({ id: 9, course_id: 103, name: "Written assignment 3", due_at: at(6, 23, 59), points_possible: 30, allowed_extensions: ["pdf"] }),
  A({ id: 10, course_id: 103, name: "Written assignment 2", due_at: at(-8, 23, 59), points_possible: 30, submission: sub({ workflow_state: "graded", submitted_at: at(-9), graded_at: ago(3 * D), score: 28, attempt: 1 }) }),
  A({ id: 11, course_id: 104, name: "Reflection – CANDU site visit", due_at: at(4, 23, 59), submission_types: ["online_text_entry", "online_upload"], allowed_extensions: ["pdf", "docx"], points_possible: 5 }),
  A({ id: 12, course_id: 104, name: "Problem Set 3 – Radioactive decay chains", due_at: at(0, 11, 0), points_possible: 10, allowed_extensions: ["pdf"], submission: sub({ workflow_state: "submitted", submitted_at: ago(20 * H), attempt: 1 }) }),
  A({ id: 13, course_id: 105, name: "Design review 1 – Concept selection", due_at: at(-2, 12, 0), lock_at: at(-1, 12, 0), points_possible: 10, submission: sub({ missing: true }) }),
  A({ id: 14, course_id: 105, name: "Team charter", due_at: null, points_possible: 2, allowed_extensions: [] }),
  A({ id: 15, course_id: 105, name: "Prototype demo video", due_at: at(12, 23, 59), submission_types: ["online_url", "online_upload"], allowed_extensions: ["mp4", "mov"], points_possible: 15 }),
];

const files: Record<number, Entry[]> = {
  101: [
    { name: "Labs", rel: "Labs", isDir: true, size: 0, modifiedMs: now - 2 * H, ext: "" },
    { name: "Lectures", rel: "Lectures", isDir: true, size: 0, modifiedMs: now - 3 * D, ext: "" },
    { name: "Problem sets", rel: "Problem sets", isDir: true, size: 0, modifiedMs: now - 4 * D, ext: "" },
    { name: "Formula sheet.pdf", rel: "Formula sheet.pdf", isDir: false, size: 412_000, modifiedMs: now - 6 * D, ext: "pdf" },
    { name: "Course outline.pdf", rel: "Course outline.pdf", isDir: false, size: 188_400, modifiedMs: now - 40 * D, ext: "pdf" },
  ],
  102: [
    { name: "Lab 2", rel: "Lab 2", isDir: true, size: 0, modifiedMs: now - 1 * D, ext: "" },
    { name: "A4 dimensional analysis.pdf", rel: "A4 dimensional analysis.pdf", isDir: false, size: 1_320_000, modifiedMs: now - 3 * H, ext: "pdf" },
    { name: "moody chart.png", rel: "moody chart.png", isDir: false, size: 640_000, modifiedMs: now - 9 * D, ext: "png" },
  ],
  104: [{ name: "Site visit notes.docx", rel: "Site visit notes.docx", isDir: false, size: 54_300, modifiedMs: now - 5 * H, ext: "docx" }],
};
const sub101: Record<string, Entry[]> = {
  Labs: [
    { name: "Lab 3", rel: "Labs/Lab 3", isDir: true, size: 0, modifiedMs: now - 2 * H, ext: "" },
    { name: "Lab 2 report.pdf", rel: "Labs/Lab 2 report.pdf", isDir: false, size: 2_100_000, modifiedMs: now - 12 * D, ext: "pdf" },
  ],
  "Labs/Lab 3": [
    { name: "cylinder_fea.SLDPRT", rel: "Labs/Lab 3/cylinder_fea.SLDPRT", isDir: false, size: 3_480_000, modifiedMs: now - 5 * H, ext: "sldprt" },
    { name: "Lab3_Whitbread.docx", rel: "Labs/Lab 3/Lab3_Whitbread.docx", isDir: false, size: 860_000, modifiedMs: now - 2.2 * H, ext: "docx" },
    { name: "Lab3_Whitbread.pdf", rel: "Labs/Lab 3/Lab3_Whitbread.pdf", isDir: false, size: 2_412_000, modifiedMs: now - 2 * H, ext: "pdf" },
    { name: "stress_plot.py", rel: "Labs/Lab 3/stress_plot.py", isDir: false, size: 4_200, modifiedMs: now - 6 * H, ext: "py" },
  ],
};

const people = { me: { id: 7, name: "J. Student" }, prof: { id: 31, name: "Dr. R. Alvarez", full_name: "Dr. Rosa Alvarez" }, ta: { id: 32, name: "Priya N. (TA)" }, prof2: { id: 41, name: "Prof. K. Osei" } };
let conversations: Conversation[] = [
  { id: 501, subject: "Lab 3 – FEA mesh question", workflow_state: "unread", last_message: "Yes, a 2D axisymmetric study is fine as long as you state it in your assumptions.", last_message_at: ago(40 * 60_000), message_count: 2, starred: false, properties: [], audience: [31], participants: [people.me, people.prof], context_name: "MECE 2420U", context_code: "course_101",
    messages: [
      { id: 2, created_at: ago(40 * 60_000), body: "Yes, a 2D axisymmetric study is fine as long as you state it in your assumptions. Make sure the mesh is refined near the inner wall; I'd like to see a convergence check (three mesh sizes is enough).\n\nSee you in lab, R.A.", author_id: 31, attachments: [], participating_user_ids: [7, 31] },
      { id: 1, created_at: ago(5 * H), body: "Hi Dr. Alvarez,\n\nFor Lab 3, can we model the cylinder as 2D axisymmetric in SolidWorks Simulation, or do you want the full 3D model?\n\nThanks", author_id: 7, attachments: [], participating_user_ids: [7, 31] },
    ] },
  { id: 502, subject: "Pipe friction lab: data files posted", workflow_state: "unread", last_message: "The raw data for all lab sections is attached. Use the section that matches your group.", last_message_at: ago(1 * D + 2 * H), message_count: 1, starred: true, properties: ["attachments"], audience: [32], participants: [people.me, people.ta], context_name: "MECE 2860U", context_code: "course_102",
    messages: [{ id: 3, created_at: ago(1 * D + 2 * H), body: "Hi all,\n\nThe raw data for all lab sections is attached. Use the section that matches your group. Reports are due tomorrow night.", author_id: 32, attachments: [{ id: 77, display_name: "pipe_friction_data.xlsx", size: 88_000, url: "https://canvas.example.edu/files/77/download" }], participating_user_ids: [7, 32] }] },
  { id: 503, subject: "Site visit logistics", workflow_state: "read", last_message: "Bus leaves from the north parking lot at 8:15. Bring government ID and closed-toe shoes.", last_message_at: ago(3 * D), message_count: 1, starred: false, properties: [], audience: [41], participants: [people.me, people.prof2], context_name: "NUCL 2020U", context_code: "course_104",
    messages: [{ id: 4, created_at: ago(3 * D), body: "Bus leaves from the north parking lot at 8:15. Bring government ID and closed-toe shoes. No phones or cameras past the security gate.", author_id: 41, attachments: [], participating_user_ids: [7, 41] }] },
];

const listeners = new Map<string, Set<(p: unknown) => void>>();
const emit = (ev: string, p: unknown) => listeners.get(ev)?.forEach((f) => f(p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (kind: string, message: string) => Promise.reject({ kind, message, retryAfter: null });

let pickSeq = 1;
const handlers: Record<string, (a: any) => unknown> = {
  app_status: () => ({ vaultExists: vault, unlocked, retryAfter: 0, passphrase: hasPass }),
  setup: async () => (await sleep(600), (vault = true), (unlocked = true), { userId: 7, userName: "J. Student", baseUrl: "https://canvas.example.edu/" }),
  unlock: async ({ passphrase }) => {
    await sleep(400);
    if (passphrase !== "correct horse") return fail("bad_passphrase", "Wrong passphrase.");
    unlocked = true;
    return { userId: 7, userName: "J. Student", baseUrl: "https://canvas.example.edu/" };
  },
  lock: () => ((unlocked = false), emit("locked", null)),
  touch: () => null,
  sync_all: async () => (await sleep(350), {
    userId: 7, userName: "J. Student", baseUrl: "https://canvas.example.edu/", courses, assignments, unreadCount: conversations.filter((c) => c.workflow_state === "unread").length, notices: [], syncedAt: Date.now(),
    announcements: [
      { id: 801, title: "Lab 3 office hours moved to Thursday", message: "<p>This week's lab office hours move to <b>Thursday 2–4 pm</b> in ENG 2040.</p>", posted_at: ago(6 * H), context_code: "course_101", read_state: "unread", author: { display_name: "Dr. R. Alvarez" } },
      { id: 802, title: "Midterm coverage", message: "<p>The midterm covers chapters 1–5 inclusive. A formula sheet will be provided.</p>", posted_at: ago(4 * D), context_code: "course_101", read_state: "read", author: { display_name: "Dr. R. Alvarez" } },
      { id: 803, title: "Pickering site visit confirmed", message: "<p>The site visit is confirmed for next Wednesday. See your inbox for logistics.</p>", posted_at: ago(3 * D), context_code: "course_104", read_state: "unread", author: { display_name: "Prof. K. Osei" } },
    ],
  }),
  assignment_detail: async ({ courseId, assignmentId }) => {
    await sleep(150);
    const a = assignments.find((x) => x.id === assignmentId && x.course_id === courseId)!;
    return { assignment: a, submission: a.submission };
  },
  mark_announcement_read: () => null,
  open_external: () => null,
  open_in_canvas: () => null,
  get_settings: () => ({ baseUrl: "https://canvas.example.edu/", userName: "J. Student", autoLockMinutes: 0, passphrase: hasPass, notify: prefs.notify, closeToTray: prefs.closeToTray, folderLinks: courses.filter((c) => c.folder).map((c) => ({ courseId: c.id, path: c.folder, exists: true })), hiddenCourses: [] }),
  set_auto_lock: () => null,
  set_course_hidden: () => null,
  link_folder: ({ courseId }) => {
    const p = `C:\\Users\\student\\School\\${courses.find((c) => c.id === courseId)?.course_code}`;
    courses.forEach((c) => c.id === courseId && (c.folder = p));
    return p;
  },
  unlink_folder: ({ courseId }) => courses.forEach((c) => c.id === courseId && (c.folder = null)),
  list_dir: ({ courseId, rel }) => (rel ? sub101[rel] ?? [] : files[courseId] ?? []),
  recent_files: ({ courseId, extensions }) => {
    const all = [...(files[courseId] ?? []), ...(courseId === 101 ? Object.values(sub101).flat() : [])].filter((e) => !e.isDir);
    return all.filter((e) => !extensions.length || extensions.includes(e.ext)).sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0)).slice(0, 6);
  },
  open_file: () => null,
  reveal_file: () => null,
  file_path: ({ file }) => `C:\\Users\\student\\School\\${file.rel}`,
  pick_files: (): PickedFile[] => [{ ref: { kind: "picked", id: `p${pickSeq++}` }, name: "Reflection_final.pdf", size: 220_000, ext: "pdf", modifiedMs: now - H }],
  describe_files: () => [],
  preflight_check: async ({ courseId, assignmentId, kind, files: refs }) => {
    await sleep(120);
    const a = assignments.find((x) => x.id === assignmentId && x.course_id === courseId)!;
    const problems: string[] = [];
    const warnings: string[] = [];
    if (kind === "files" && refs.length === 0) problems.push("Choose at least one file.");
    if (a.lock_at && Date.parse(a.lock_at) < Date.now()) problems.push("Closed. Canvas no longer accepts submissions.");
    for (const r of refs) {
      const name: string = r.rel ?? "Reflection_final.pdf";
      const ext = name.split(".").pop()!.toLowerCase();
      if (a.allowed_extensions.length && !a.allowed_extensions.includes(ext)) problems.push(`${name.split("/").pop()}: .${ext} not accepted. Allowed: ${a.allowed_extensions.join(", ")}.`);
    }
    if (a.due_at && Date.parse(a.due_at) < Date.now() && !(a.lock_at && Date.parse(a.lock_at) < Date.now())) warnings.push("Past the due date. Canvas will mark this late.");
    const used = a.submission?.attempt ?? 0;
    if (used > 0) warnings.push(`You already submitted. This becomes attempt ${used + 1}.`);
    return { problems, warnings, next_attempt: used + 1, allowed_attempts: a.allowed_attempts && a.allowed_attempts > 0 ? a.allowed_attempts : null };
  },
  submit_files: async ({ courseId, assignmentId, files: refs, job }) => {
    if (!confirm("[Mock of the Windows dialog]\n\nSubmit to Canvas?")) return fail("cancelled", "Cancelled.");
    const total = 2_412_000;
    for (let i = 0; i < refs.length; i++)
      for (let s = 0; s <= total; s += 400_000) {
        emit("upload-progress", { job, index: i, count: refs.length, name: refs[i].rel?.split("/").pop() ?? "file", sent: Math.min(s, total), total });
        await sleep(120);
      }
    const a = assignments.find((x) => x.id === assignmentId && x.course_id === courseId)!;
    const s = sub({ workflow_state: "submitted", submitted_at: new Date().toISOString(), attempt: (a.submission?.attempt ?? 0) + 1 });
    assignments = assignments.map((x) => (x === a ? { ...x, submission: s } : x));
    return s;
  },
  submit_text: async () => sub({ workflow_state: "submitted", submitted_at: new Date().toISOString(), attempt: 1 }),
  submit_url: async () => sub({ workflow_state: "submitted", submitted_at: new Date().toISOString(), attempt: 1 }),
  list_conversations: ({ scope }) => ({
    items: conversations.filter((c) => (scope === "unread" ? c.workflow_state === "unread" : scope === "starred" ? c.starred : scope === "archived" ? c.workflow_state === "archived" : scope === "sent" ? false : c.workflow_state !== "archived")).map((c) => ({ ...c, messages: [] })),
    next: null,
  }),
  get_conversation: ({ id }) => {
    conversations = conversations.map((c) => (c.id === id && c.workflow_state === "unread" ? { ...c, workflow_state: "read" } : c));
    return conversations.find((c) => c.id === id);
  },
  update_conversation: ({ id, workflowState, starred }) => {
    conversations = conversations.map((c) => (c.id === id ? { ...c, ...(workflowState ? { workflow_state: workflowState } : {}), ...(starred != null ? { starred } : {}) } : c));
    return conversations.find((c) => c.id === id);
  },
  unread_count: () => conversations.filter((c) => c.workflow_state === "unread").length,
  send_reply: async ({ id, body }) => {
    await sleep(300);
    const m = { id: Date.now(), created_at: new Date().toISOString(), body, author_id: 7, attachments: [], participating_user_ids: [] };
    conversations = conversations.map((c) => (c.id === id ? { ...c, messages: [m, ...c.messages], last_message: body, last_message_at: m.created_at, message_count: c.message_count + 1 } : c));
    return { ...conversations.find((c) => c.id === id)!, messages: [m] };
  },
  send_message: async () => (await sleep(300), [{ ...conversations[0], id: 999 }]),
  search_recipients: ({ role, search }) =>
    role === "teachers" ? [{ id: "31", name: "Dr. R. Alvarez", full_name: "Dr. Rosa Alvarez" }] : role === "tas" ? [{ id: "32", name: "Priya N. (TA)" }] : [{ id: "55", name: `${search} Example` }, { id: "56", name: "Sam Classmate" }],
  reset_app: () => confirm("[Mock] Erase Studydesk data?") && ((vault = false), (unlocked = false), true),
  change_passphrase: ({ newPassphrase }) => ((hasPass = !!newPassphrase), null),
  set_prefs: ({ notify, closeToTray }) => ((prefs = { notify: notify ?? prefs.notify, closeToTray: closeToTray ?? prefs.closeToTray }), null),
  autostart_get: () => autostart,
  autostart_set: ({ enabled }) => ((autostart = enabled), null),
  dates_pinned: () => pins,
  dates_pin: ({ item }) => ((pins = [...pins.filter((p) => p.id !== item.id), { ...item, id: item.id || `m${Date.now()}` }].sort((a, b) => a.date.localeCompare(b.date))), pins),
  dates_unpin: ({ id }) => ((pins = pins.filter((p) => p.id !== id)), pins),
  dates_dismiss: () => null,
  dates_restore_dismissed: () => null,
  dates_scan: async () => {
    for (let i = 1; i <= 5; i++) {
      emit("scan-progress", { done: i, total: 5, course: "x" });
      await sleep(250);
    }
    return { findings, scanned };
  },
  replace_token: () => ({ userId: 7, userName: "J. Student", baseUrl: "https://canvas.example.edu/" }),

  // ----------------------------------------------------------------- gmail
  gmail_status: () => ({ connected: gmailOn, email: gmailOn ? "j.student@school.example" : null, clientId: null }),
  gmail_connect: async () => (await sleep(800), (gmailOn = true), "j.student@school.example"),
  gmail_cancel_connect: () => null,
  gmail_disconnect: () => ((gmailOn = false), null),
  gmail_threads: ({ view, query }) => {
    let list = mail;
    if (view === "unread") list = list.filter((t) => t.unread && t.inInbox);
    else if (view === "starred") list = list.filter((t) => t.starred);
    else if (view === "inbox") list = list.filter((t) => t.inInbox);
    else if (view === "sent") list = [];
    if (query) list = list.filter((t) => `${t.subject} ${t.snippet}`.toLowerCase().includes(String(query).replace(/"/g, "").toLowerCase()));
    return { items: list, next: null, estimate: list.length };
  },
  gmail_unread: () => mail.filter((t) => t.unread && t.inInbox).length,
  gmail_thread: ({ id }) => {
    const t = mail.find((x) => x.id === id)!;
    return { id, subject: t.subject, starred: t.starred, inInbox: t.inInbox, messages: mailBodies[id] };
  },
  gmail_modify: ({ id, action }) => {
    mail = mail.map((t) =>
      t.id !== id ? t : { ...t, unread: action === "unread" ? true : action === "read" ? false : t.unread, inInbox: action === "archive" ? false : action === "inbox" ? true : t.inInbox, starred: action === "star" ? true : action === "unstar" ? false : t.starred },
    );
  },
  gmail_send: async () => (await sleep(400), "sent-1"),
  gmail_save_attachment: ({ filename }) => `C:\\Users\\student\\Downloads\\${filename}`,
};

let hasPass = new URLSearchParams(location.search).get("pass") != null;
let prefs = { notify: true, closeToTray: true };
let autostart = false;
const ymd = (days: number) => {
  const d = new Date(now + days * D);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
let pins = [
  { id: "p1", courseId: 101, date: ymd(10), time: "10:00", label: "Midterm exam", kind: "exam", weight: "25%", source: "Course Outline.pdf" },
  { id: "p2", courseId: 104, date: ymd(3), time: "08:15", label: "Pickering site visit", kind: "info", weight: null, source: "Canvas calendar" },
];
const findings = [
  { id: "f1", courseId: 102, date: ymd(8), time: "18:30", endDate: null, kind: "exam", label: "Midterm Exam", weight: "30%", snippet: "Midterm Exam | Week 8 | ERC 1094, 6:30 pm (30%)", confidence: "high", caution: null, sources: [{ kind: "calendar", name: "Canvas calendar", url: "https://canvas.example.edu/calendar" }], inCanvas: null },
  { id: "f2", courseId: 103, date: ymd(13), time: null, endDate: null, kind: "quiz", label: "Quiz 4 · Laplace transforms", weight: "5%", snippet: "Nov 1 | Quiz 4 – Laplace transforms (5%)", confidence: "medium", caution: null, sources: [{ kind: "file", name: "MATH2860 Course Outline F26.pdf", url: "https://canvas.example.edu/courses/103/files/1" }], inCanvas: null },
  { id: "f3", courseId: 105, date: ymd(22), time: "12:00", endDate: null, kind: "deliverable", label: "Design review 2 presentations", weight: "15%", snippet: "Design review 2 presentations — in studio, 12:00 pm (15%)", confidence: "medium", caution: null, sources: [{ kind: "syllabus", name: "Syllabus", url: "https://canvas.example.edu/courses/105/assignments/syllabus" }, { kind: "local", name: "ENGR2310 schedule.docx", url: null }], inCanvas: null },
  { id: "f4", courseId: 105, date: ymd(29), time: null, endDate: ymd(33), kind: "deliverable", label: "Final prototype demo", weight: null, snippet: "Week 12: Final prototype demo", confidence: "low", caution: "Only \"Week 12\" is given; the exact day isn't stated.", sources: [{ kind: "file", name: "Project brief.pdf", url: "https://canvas.example.edu/courses/105/files/2" }], inCanvas: null },
  { id: "f5", courseId: 101, date: ymd(3), time: "17:00", endDate: null, kind: "deliverable", label: "Problem Set 6 due", weight: "3%", snippet: "Problem Set 6 due Oct 21, 5 pm", confidence: "medium", caution: null, sources: [{ kind: "syllabus", name: "Syllabus", url: null }], inCanvas: "Problem Set 6 – Torsion of non-circular shafts" },
];
const scanned = [
  { courseId: 101, kind: "calendar", name: "Canvas calendar", ok: true, found: 0, note: null },
  { courseId: 101, kind: "file", name: "Course Outline.pdf", ok: true, found: 4, note: null },
  { courseId: 102, kind: "calendar", name: "Canvas calendar", ok: true, found: 1, note: null },
  { courseId: 102, kind: "file", name: "Course files", ok: false, found: 0, note: "Hidden by the instructor" },
  { courseId: 103, kind: "file", name: "MATH2860 Course Outline F26.pdf", ok: true, found: 3, note: null },
  { courseId: 105, kind: "syllabus", name: "Syllabus", ok: true, found: 2, note: null },
];

let gmailOn = new URLSearchParams(location.search).get("nogmail") == null;
let mail = [
  { id: "g1", subject: "Co-op work term: interview invitation", senders: ["Co-op Office"], snippet: "Congratulations, you've been selected for an interview for the Winter 2027 work term. Please book a time…", lastMs: now - 25 * 60_000, unread: true, starred: false, inInbox: true, messageCount: 1, hasAttachments: true },
  { id: "g2", subject: "MECE 2420U – Lab group assignments", senders: ["Dr. R. Alvarez", "J. Student"], snippet: "Groups for Lab 4 are below. If you have a conflict, reply by Friday.", lastMs: now - 5 * H, unread: false, starred: true, inInbox: true, messageCount: 3, hasAttachments: false },
  { id: "g3", subject: "Library: your study room booking", senders: ["Library Services"], snippet: "Room 214 is booked for Tuesday 2:00–4:00 pm.", lastMs: now - 1.5 * D, unread: false, starred: false, inInbox: true, messageCount: 1, hasAttachments: false },
  { id: "g4", subject: "Nuclear society – meeting minutes", senders: ["Student Society"], snippet: "Thanks to everyone who came out. Minutes and next steps attached.", lastMs: now - 3 * D, unread: true, starred: false, inInbox: true, messageCount: 1, hasAttachments: true },
];
const mailBodies: Record<string, unknown[]> = {
  g1: [{ id: "m1", fromName: "Co-op Office", fromEmail: "coop@school.example", to: ["j.student@school.example"], cc: [], replyTo: null, dateMs: now - 25 * 60_000, text: "Hi,\n\nCongratulations, you've been selected for an interview for the Winter 2027 work term. Please book a time using the link below before Thursday.\n\nhttps://careers.school.example/book\n\nCo-op Office", html: null, attachments: [{ filename: "Interview prep guide.pdf", mimeType: "application/pdf", size: 312_000, attachmentId: "a1" }], unread: true, messageIdHeader: "<m1@mail>", references: null }],
  g2: [
    { id: "m2", fromName: "Dr. R. Alvarez", fromEmail: "r.alvarez@school.example", to: ["mece2420-students@school.example"], cc: [], replyTo: null, dateMs: now - 2 * D, text: "Groups for Lab 4 are below. If you have a conflict, reply by Friday.\n\nGroup 1: …", html: null, attachments: [], unread: false, messageIdHeader: "<m2@mail>", references: null },
    { id: "m3", fromName: "J. Student", fromEmail: "j.student@school.example", to: ["Dr. R. Alvarez <r.alvarez@school.example>"], cc: [], replyTo: null, dateMs: now - 1 * D, text: "Hi Dr. Alvarez, I have a conflict with Thursday's slot (co-op interview). Could I swap into Group 3?\n\nThanks", html: null, attachments: [], unread: false, messageIdHeader: "<m3@mail>", references: "<m2@mail>" },
    { id: "m4", fromName: "Dr. R. Alvarez", fromEmail: "r.alvarez@school.example", to: ["j.student@school.example"], cc: [], replyTo: null, dateMs: now - 5 * H, text: "That's fine, you're in Group 3.", html: null, attachments: [], unread: false, messageIdHeader: "<m4@mail>", references: "<m2@mail> <m3@mail>" },
  ],
  g3: [{ id: "m5", fromName: "Library Services", fromEmail: "library@school.example", to: ["j.student@school.example"], cc: [], replyTo: null, dateMs: now - 1.5 * D, text: null, html: "<p>Room <b>214</b> is booked for Tuesday 2:00–4:00 pm.</p><img src='x.png'>", attachments: [], unread: false, messageIdHeader: "<m5@mail>", references: null }],
  g4: [{ id: "m6", fromName: "Student Society", fromEmail: "society@school.example", to: ["j.student@school.example"], cc: [], replyTo: null, dateMs: now - 3 * D, text: "Thanks to everyone who came out. Minutes and next steps attached.", html: null, attachments: [{ filename: "Minutes.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 41_000, attachmentId: "a2" }], unread: true, messageIdHeader: "<m6@mail>", references: null }],
};

export const backend = {
  invoke: async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const h = handlers[cmd];
    if (!h) throw { kind: "invalid", message: `mock: no handler for ${cmd}` };
    return (await h(args ?? {})) as T;
  },
  listen: async <T,>(ev: string, cb: (p: T) => void) => {
    const set = listeners.get(ev) ?? new Set();
    set.add(cb as (p: unknown) => void);
    listeners.set(ev, set);
    return () => set.delete(cb as (p: unknown) => void);
  },
};
