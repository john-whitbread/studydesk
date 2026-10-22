// Canvas objects keep Canvas's snake_case field names (matches the Canvas API
// docs). App-level objects from the Rust backend use camelCase.

export interface Term { name?: string | null }
export interface Enrollment { type?: string | null; computed_current_score?: number | null; computed_current_grade?: string | null }

export interface Course {
  id: number;
  name: string;
  original_name?: string | null;
  course_code: string;
  /** Canvas's own name, before tidyCourse shortened it. */
  full_name?: string;
  term?: Term | null;
  enrollments: Enrollment[];
  hide_final_grades?: boolean | null;
  color?: string | null;
  folder?: string | null;
  hidden: boolean;
  /** Assignment-group weights decide the grade (else total points). */
  apply_assignment_group_weights?: boolean | null;
}

export interface Attachment {
  id: number;
  display_name?: string | null;
  filename?: string | null;
  size?: number | null;
  "content-type"?: string | null;
  url?: string | null;
}

export interface SubmissionComment {
  id: number;
  author_id?: number | null;
  author_name?: string | null;
  comment?: string | null;
  created_at?: string | null;
  attachments: Attachment[];
}

export interface RubricRating { id?: string | null; description?: string | null; points?: number | null }
export interface RubricCriterion { id: string; description?: string | null; long_description?: string | null; points?: number | null; ratings: RubricRating[] }
export interface RubricMark { points?: number | null; rating_id?: string | null; comments?: string | null }

export interface Submission {
  id?: number | null;
  assignment_id?: number | null;
  attempt?: number | null;
  workflow_state?: "unsubmitted" | "submitted" | "graded" | "pending_review" | string | null;
  submitted_at?: string | null;
  graded_at?: string | null;
  posted_at?: string | null;
  score?: number | null;
  grade?: string | null;
  late?: boolean | null;
  missing?: boolean | null;
  excused?: boolean | null;
  submission_type?: string | null;
  attachments: Attachment[];
  submission_comments: SubmissionComment[];
  rubric_assessment?: Record<string, RubricMark> | null;
  url?: string | null;
}

export interface Assignment {
  id: number;
  course_id: number;
  name: string;
  description?: string | null;
  due_at?: string | null;
  lock_at?: string | null;
  unlock_at?: string | null;
  points_possible?: number | null;
  grading_type?: string | null;
  submission_types: string[];
  allowed_extensions: string[];
  allowed_attempts?: number | null;
  html_url?: string | null;
  locked_for_user?: boolean | null;
  lock_explanation?: string | null;
  is_quiz_assignment?: boolean | null;
  quiz_id?: number | null;
  rubric: RubricCriterion[];
  submission?: Submission | null;
  assignment_group_id?: number | null;
  omit_from_final_grade?: boolean | null;
}

export interface Announcement {
  id: number;
  title: string;
  message?: string | null;
  posted_at?: string | null;
  context_code?: string | null;
  html_url?: string | null;
  read_state?: "read" | "unread" | string | null;
  author?: { display_name?: string | null } | null;
}

export interface Participant { id: number; name: string; full_name?: string | null }

export interface Message {
  id: number;
  created_at?: string | null;
  body: string;
  author_id: number;
  generated?: boolean | null;
  attachments: Attachment[];
  participating_user_ids: number[];
}

export interface Conversation {
  id: number;
  subject?: string | null;
  workflow_state: "read" | "unread" | "archived" | string;
  last_message?: string | null;
  last_message_at?: string | null;
  last_authored_message_at?: string | null;
  message_count: number;
  starred: boolean;
  properties: string[];
  audience: number[];
  participants: Participant[];
  context_name?: string | null;
  context_code?: string | null;
  messages: Message[];
}

export interface Recipient { id: string; name: string; full_name?: string | null; type?: string | null }

export interface Page<T> { items: T[]; next: string | null }

// ------------------------------------------------------------- app objects

export interface Status { vaultExists: boolean; unlocked: boolean; retryAfter: number; passphrase: boolean }
export interface Profile { userId: number; userName: string; baseUrl: string }

export interface Dashboard {
  userId: number;
  userName: string;
  baseUrl: string;
  courses: Course[];
  assignments: Assignment[];
  announcements: Announcement[];
  unreadCount: number | null;
  notices: string[];
  syncedAt: number;
  changes: Change[];
  autoPinned: PinnedDate[];
}

export interface AssignmentDetail { assignment: Assignment; submission: Submission | null }

export interface Entry { name: string; rel: string; isDir: boolean; size: number; modifiedMs: number | null; ext: string }

export type FileRef = { kind: "linked"; courseId: number; rel: string } | { kind: "picked"; id: string };

export interface PickedFile { ref: FileRef; name: string; size: number; ext: string; modifiedMs: number | null }

export interface Preflight { problems: string[]; warnings: string[]; next_attempt: number; allowed_attempts: number | null }

export interface Settings {
  baseUrl: string;
  userName: string;
  autoLockMinutes: number;
  folderLinks: { courseId: number; path: string; exists: boolean }[];
  hiddenCourses: number[];
  passphrase: boolean;
  notify: boolean;
  closeToTray: boolean;
}

export interface UploadProgress { job: string; index: number; count: number; name: string; sent: number; total: number }

export interface OsDrag { phase: "enter" | "over" | "drop" | "leave"; x: number; y: number; files: PickedFile[] }

export interface ApiError { kind: string; message: string; retryAfter: number | null }

// ------------------------------------------------------------- gmail

export interface GmailStatus { connected: boolean; email: string | null; clientId: string | null }
export interface ThreadSummary {
  id: string; subject: string; senders: string[]; snippet: string; lastMs: number;
  unread: boolean; starred: boolean; inInbox: boolean; messageCount: number; hasAttachments: boolean;
}
export interface ThreadPage { items: ThreadSummary[]; next: string | null; estimate: number }
export interface MailAttachment { filename: string; mimeType: string; size: number; attachmentId: string }
export interface MailMessage {
  id: string; fromName: string; fromEmail: string; to: string[]; cc: string[]; replyTo: string | null; dateMs: number;
  text: string | null; html: string | null; attachments: MailAttachment[]; unread: boolean;
  messageIdHeader: string | null; references: string | null;
}
export interface ThreadDetail { id: string; subject: string; messages: MailMessage[]; starred: boolean; inInbox: boolean }
export interface ReplyInfo { threadId: string; inReplyTo: string | null; references: string | null }

// ------------------------------------------------------------- key dates

export type DateKind = "exam" | "quiz" | "deliverable" | "info";
export interface DateSource { kind: string; name: string; url: string | null }
export interface Finding {
  id: string; courseId: number; date: string; time: string | null; endDate: string | null; kind: DateKind; label: string;
  weight: string | null; snippet: string; confidence: "low" | "medium" | "high"; caution: string | null; sources: DateSource[]; inCanvas: string | null;
}
export interface Scanned { courseId: number; kind: string; name: string; ok: boolean; found: number; note: string | null }
export interface ScanResult { findings: Finding[]; scanned: Scanned[]; officeHours: OfficeHours[] }
export interface PinnedDate { id: string; courseId: number; date: string; time: string | null; label: string; kind: DateKind; weight: string | null; source: string; auto?: boolean; url?: string | null }

export interface Appearance {
  theme: "system" | "light" | "dark";
  accent: string;
  courseColors: Record<string, string>;
}

export interface UpdateInfo {
  current: string;
  /** Newer version, or null when up to date. */
  available: string | null;
  notes: string | null;
}

// ------------------------------------------------------------- calendar

export interface CalView { id: string; name: string; color: string; shown: boolean; studydesk: boolean }
export interface PushReport { at: number; written: number; removed: number; failed: number; error: string | null }
export interface CalStatus {
  apple: { email: string; calendars: CalView[]; push: boolean; pushing: boolean; lastPush: PushReport | null } | null;
  links: CalView[];
}
export interface ExtEvent { source: string; title: string; location: string; start: number; end: number; allDay: boolean; color: string; calendar: string }
export interface ExtEvents { events: ExtEvent[]; errors: { calendar: string; message: string }[] }

// ------------------------------------------------------------- my work

export interface CheckItem { text: string; done: boolean; auto: boolean; new: boolean }
export interface RubricCheck { done: boolean; score: number | null }
export interface WorkItem { checklist: CheckItem[]; rubric: Record<string, RubricCheck>; notes: string; hours: number | null; descHash: string; updated: number }
export interface WorkPrefs { autoDates: boolean; estimates: Record<string, number>; kinds: [string, string, number][] }
export interface OfficeHours { id: string; courseId: number; days: number[]; start: string; end: string; location: string | null; who: string | null; snippet: string; source: string }
export interface Change { id: string; at: number; courseId: number; assignmentId: number; kind: "due_moved" | "due_added" | "due_removed" | "new" | "removed" | "graded" | "regraded"; name: string; from: string | null; to: string | null; seen: boolean }
export interface AssignmentGroup { id: number; name: string; position?: number | null; group_weight?: number | null; rules?: { drop_lowest?: number | null; drop_highest?: number | null; never_drop?: number[] | null } | null }
export interface ModuleItem {
  id: number; module_id: number; position?: number | null; title: string; type: string; content_id?: number | null; html_url?: string | null; indent?: number | null;
  completion_requirement?: { type?: string | null; completed?: boolean | null } | null;
  content_details?: { due_at?: string | null; points_possible?: number | null; locked_for_user?: boolean | null } | null;
}
export interface Module { id: number; name: string; position?: number | null; unlock_at?: string | null; state?: string | null; items: ModuleItem[] }
export interface CourseModules { courseId: number; modules: Module[]; note: string | null }
export interface Diagnostics {
  version: string; os: string; arch: string; unlocked: boolean; passphrase: boolean; canvasHost: string | null; coursesHidden: number; foldersLinked: number; foldersMissing: number;
  gmail: boolean; apple: boolean; applePush: boolean; calendarLinks: number; pinned: number; officeHours: number; workItems: number; lastCalendarUpdate: { at: number; written: number; removed: number; failed: number; error: boolean } | null;
}
