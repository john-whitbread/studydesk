// One place decides what an assignment's status is. Every view uses this.

import type { Assignment } from "./types.ts";
import { calendarDays, fmtDay, fmtNum, parse } from "./time.ts";

export type Tone = "danger" | "warn" | "ok" | "info" | "neutral";

export type StatusKind =
  | "excused"
  | "graded"
  | "pending_review"
  | "submitted"
  | "submitted_late"
  | "no_submission"
  | "not_open"
  | "missing"
  | "closed"
  | "overdue"
  | "due_soon"
  | "todo";

export interface AssignmentStatus {
  kind: StatusKind;
  label: string;
  tone: Tone;
  /** You still have something to do for it. */
  needsAction: boolean;
  /** It is past due and still unsubmitted (whether or not still open). */
  late: boolean;
}

const OFFLINE_TYPES = new Set(["none", "on_paper", "not_graded", "wiki_page"]);
const SOON_MS = 24 * 3600_000;

export function acceptsOnline(a: Assignment): boolean {
  return a.submission_types.length > 0 && !a.submission_types.every((t) => OFFLINE_TYPES.has(t));
}

export function acceptsUpload(a: Assignment): boolean {
  return a.submission_types.includes("online_upload");
}

export function scoreLabel(a: Assignment): string | null {
  const s = a.submission;
  if (!s) return null;
  if (s.score != null && a.points_possible != null && a.points_possible > 0) return `${fmtNum(s.score)} / ${fmtNum(a.points_possible)}`;
  if (s.grade) return s.grade;
  if (s.score != null) return fmtNum(s.score);
  return null;
}

export function assignmentStatus(a: Assignment, now = Date.now()): AssignmentStatus {
  const s = a.submission ?? null;
  const due = parse(a.due_at);
  const lock = parse(a.lock_at);
  const unlock = parse(a.unlock_at);
  const st = (kind: StatusKind, label: string, tone: Tone, needsAction: boolean, late = false): AssignmentStatus => ({ kind, label, tone, needsAction, late });

  if (s?.excused) return st("excused", "Excused", "neutral", false);

  const graded = s?.workflow_state === "graded" && (s.score != null || !!s.grade);
  if (graded) return st("graded", scoreLabel(a) ?? "Graded", "ok", false);
  if (s?.workflow_state === "pending_review") return st("pending_review", "Pending review", "info", false);

  const submitted = !!s?.submitted_at || s?.workflow_state === "submitted";
  if (submitted) return s?.late ? st("submitted_late", "Submitted late", "warn", false) : st("submitted", "Submitted", "ok", false);

  if (!acceptsOnline(a)) return st("no_submission", "Not online", "neutral", false);

  if (unlock != null && unlock > now) return st("not_open", `Opens ${fmtDay(unlock, now)}`, "neutral", true);

  const closed = (lock != null && lock <= now) || (a.locked_for_user === true && due != null && due < now);
  const pastDue = due != null && due < now;

  if (closed) return st(s?.missing ? "missing" : "closed", s?.missing ? "Missing" : "Closed", "danger", false, pastDue);
  if (s?.missing || pastDue) return st(s?.missing ? "missing" : "overdue", s?.missing ? "Missing" : "Overdue", "danger", true, true);
  if (due != null && due - now < SOON_MS) return st("due_soon", calendarDays(now, due) === 0 ? "Due today" : "Due soon", "warn", true);
  return st("todo", "To do", "neutral", true);
}

export function typeLabel(t: string): string {
  return (
    {
      online_upload: "File upload",
      online_text_entry: "Text entry",
      online_url: "Website URL",
      media_recording: "Media recording",
      student_annotation: "Annotation",
      online_quiz: "Quiz",
      discussion_topic: "Discussion",
      external_tool: "External tool",
      on_paper: "On paper",
      none: "No submission",
      not_graded: "Not graded",
    } as Record<string, string>
  )[t] ?? t;
}

/** Short description of how an assignment is submitted, for list rows. */
export function kindLabel(a: Assignment): string | null {
  if (a.is_quiz_assignment || a.submission_types.includes("online_quiz")) return "Quiz";
  if (a.submission_types.includes("discussion_topic")) return "Discussion";
  if (a.submission_types.includes("external_tool")) return "External tool";
  return null;
}
