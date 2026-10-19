// Typed wrappers for every backend command. The page can do nothing else:
// no filesystem, network or shell access exists on this side.

import type {
  PinnedDate, ScanResult, UpdateInfo, CalStatus, ExtEvents, Appearance,
  GmailStatus, ReplyInfo, ThreadDetail, ThreadPage,
  ApiError, AssignmentDetail, Conversation, Dashboard, Entry, FileRef, Page, PickedFile, Preflight, Profile, Recipient, Settings, Status, Submission,
} from "./types.ts";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <T>(event: string, cb: (payload: T) => void) => Promise<() => void>;
interface Backend { invoke: Invoke; listen: Listen }

// `MODE` is replaced at build time, so the mock is never part of a real build.
const backend: Promise<Backend> =
  import.meta.env.MODE === "mock"
    ? import("../mock/backend.ts").then((m) => m.backend)
    : Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]).then(([core, ev]) => ({
        invoke: core.invoke as Invoke,
        listen: (<T,>(name: string, cb: (p: T) => void) => ev.listen<T>(name, (e) => cb(e.payload))) as Listen,
      }));

export function toApiError(e: unknown): ApiError {
  if (e && typeof e === "object" && "message" in e) {
    const o = e as Partial<ApiError>;
    return { kind: o.kind ?? "unknown", message: String(o.message), retryAfter: o.retryAfter ?? null };
  }
  return { kind: "unknown", message: typeof e === "string" ? e : "Something went wrong.", retryAfter: null };
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const b = await backend;
  try {
    return await b.invoke<T>(cmd, args);
  } catch (e) {
    throw toApiError(e);
  }
}

export async function listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  return (await backend).listen<T>(event, cb);
}

export const api = {
  appStatus: () => call<Status>("app_status"),
  setup: (baseUrl: string, token: string, passphrase: string | null) => call<Profile>("setup", { baseUrl, token, passphrase }),
  unlock: (passphrase: string) => call<Profile>("unlock", { passphrase }),
  lock: () => call<void>("lock"),
  touch: () => call<void>("touch"),
  /** current: null when no passphrase is set; newPassphrase: null removes it. */
  changePassphrase: (current: string | null, newPassphrase: string | null) => call<void>("change_passphrase", { current, newPassphrase }),
  setPrefs: (p: { notify?: boolean; closeToTray?: boolean }) => call<void>("set_prefs", { notify: p.notify ?? null, closeToTray: p.closeToTray ?? null }),
  autostartGet: () => call<boolean>("autostart_get"),
  autostartSet: (enabled: boolean) => call<void>("autostart_set", { enabled }),
  datesScan: (courseIds: number[] | null) => call<ScanResult>("dates_scan", { courseIds }),
  datesPinned: () => call<PinnedDate[]>("dates_pinned"),
  datesPin: (item: PinnedDate) => call<PinnedDate[]>("dates_pin", { item }),
  datesUnpin: (id: string) => call<PinnedDate[]>("dates_unpin", { id }),
  datesDismiss: (id: string) => call<void>("dates_dismiss", { id }),
  datesRestoreDismissed: () => call<void>("dates_restore_dismissed"),
  replaceToken: (token: string) => call<Profile>("replace_token", { token }),
  resetApp: () => call<boolean>("reset_app"),

  getSettings: () => call<Settings>("get_settings"),
  setAutoLock: (minutes: number) => call<void>("set_auto_lock", { minutes }),
  setCourseHidden: (courseId: number, hidden: boolean) => call<void>("set_course_hidden", { courseId, hidden }),
  linkFolder: (courseId: number, courseLabel: string) => call<string | null>("link_folder", { courseId, courseLabel }),
  unlinkFolder: (courseId: number) => call<void>("unlink_folder", { courseId }),

  syncAll: () => call<Dashboard>("sync_all"),
  assignmentDetail: (courseId: number, assignmentId: number) => call<AssignmentDetail>("assignment_detail", { courseId, assignmentId }),
  markAnnouncementRead: (courseId: number, topicId: number) => call<void>("mark_announcement_read", { courseId, topicId }),
  openExternal: (url: string) => call<void>("open_external", { url }),
  openInCanvas: (url: string) => call<void>("open_in_canvas", { url }),

  listDir: (courseId: number, rel: string) => call<Entry[]>("list_dir", { courseId, rel }),
  recentFiles: (courseId: number, extensions: string[], limit = 8) => call<Entry[]>("recent_files", { courseId, extensions, limit }),
  openFile: (file: FileRef) => call<void>("open_file", { file }),
  revealFile: (file: FileRef) => call<void>("reveal_file", { file }),
  filePath: (file: FileRef) => call<string>("file_path", { file }),
  pickFiles: (courseId?: number) => call<PickedFile[]>("pick_files", { courseId: courseId ?? null }),
  describeFiles: (files: FileRef[]) => call<PickedFile[]>("describe_files", { files }),

  preflight: (courseId: number, assignmentId: number, kind: "files" | "text" | "url", files: FileRef[]) =>
    call<Preflight>("preflight_check", { courseId, assignmentId, kind, files }),
  submitFiles: (courseId: number, assignmentId: number, files: FileRef[], comment: string | null, job: string) =>
    call<Submission>("submit_files", { courseId, assignmentId, files, comment, job }),
  submitText: (courseId: number, assignmentId: number, text: string) => call<Submission>("submit_text", { courseId, assignmentId, text }),
  submitUrl: (courseId: number, assignmentId: number, url: string) => call<Submission>("submit_url", { courseId, assignmentId, url }),

  listConversations: (scope: string, courseId: number | null, cursor: string | null) =>
    call<Page<Conversation>>("list_conversations", { scope, courseId, cursor }),
  getConversation: (id: number) => call<Conversation>("get_conversation", { id }),
  updateConversation: (id: number, workflowState: string | null, starred: boolean | null) =>
    call<Conversation>("update_conversation", { id, workflowState, starred }),
  unreadCount: () => call<number>("unread_count"),
  sendReply: (id: number, body: string, files: FileRef[], job: string) => call<Conversation>("send_reply", { id, body, files, job }),
  sendMessage: (courseId: number, recipients: string[], subject: string, body: string, group: boolean, files: FileRef[], job: string) =>
    call<Conversation[]>("send_message", { courseId, recipients, subject, body, group, files, job }),
  searchRecipients: (courseId: number, search: string, role: "teachers" | "tas" | null) =>
    call<Recipient[]>("search_recipients", { courseId, search, role }),

  gmailStatus: () => call<GmailStatus>("gmail_status"),
  gmailConnect: (clientId: string, clientSecret: string, loginHint: string | null) => call<string>("gmail_connect", { clientId, clientSecret, loginHint }),
  gmailCancelConnect: () => call<void>("gmail_cancel_connect"),
  gmailDisconnect: () => call<void>("gmail_disconnect"),
  getAppearance: () => call<Appearance>("get_appearance"),
  setAppearance: (theme: string | null, accent: string | null) => call<Appearance>("set_appearance", { theme, accent }),
  setCourseColor: (courseId: number, color: string | null) => call<Appearance>("set_course_color", { courseId, color }),
  calendarStatus: () => call<CalStatus>("calendar_status"),
  calendarConnectApple: (email: string, password: string) => call<CalStatus>("calendar_connect_apple", { email, password }),
  calendarDisconnectApple: (removeCalendar: boolean) => call<CalStatus>("calendar_disconnect_apple", { removeCalendar }),
  calendarSetShown: (id: string, shown: boolean) => call<CalStatus>("calendar_set_shown", { id, shown }),
  calendarSetPush: (on: boolean) => call<CalStatus>("calendar_set_push", { on }),
  calendarPushNow: () => call<void>("calendar_push_now"),
  calendarAddLink: (name: string, url: string) => call<CalStatus>("calendar_add_link", { name, url }),
  calendarRemoveLink: (id: string) => call<CalStatus>("calendar_remove_link", { id }),
  calendarEvents: (from: number, to: number, refresh = false) => call<ExtEvents>("calendar_events", { from, to, refresh }),
  tourPending: () => call<boolean>("tour_pending"),
  tourDone: () => call<void>("tour_done"),
  appVersion: () => call<string>("app_version"),
  updateCheck: () => call<UpdateInfo>("update_check"),
  updateInstall: () => call<void>("update_install"),
  gmailUnread: () => call<number>("gmail_unread"),
  gmailThreads: (view: string, query: string, page: string | null) => call<ThreadPage>("gmail_threads", { view, query, page }),
  gmailThread: (id: string) => call<ThreadDetail>("gmail_thread", { id }),
  gmailModify: (id: string, action: "read" | "unread" | "archive" | "inbox" | "star" | "unstar") => call<void>("gmail_modify", { id, action }),
  gmailSend: (to: string[], cc: string[], subject: string, body: string, files: FileRef[], reply: ReplyInfo | null) =>
    call<string>("gmail_send", { to, cc, subject, body, files, reply }),
  gmailSaveAttachment: (messageId: string, attachmentId: string, filename: string) =>
    call<string | null>("gmail_save_attachment", { messageId, attachmentId, filename }),
};
