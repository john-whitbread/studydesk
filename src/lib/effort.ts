// How much work something is, in hours. Mirrors src-tauri/core/src/effort.rs.

import type { Assignment } from "./types.ts";

export const KINDS: [string, string, number][] = [
  ["exam", "Exam prep", 8],
  ["project", "Project / report", 8],
  ["lab", "Lab", 4],
  ["problem_set", "Problem set", 3],
  ["essay", "Essay / writing", 5],
  ["quiz", "Quiz", 1],
  ["short", "Short task (reflection, post)", 1],
  ["other", "Other", 2],
];

function has(n: string, words: string[]): boolean {
  return words.some((w) => {
    let i = n.indexOf(w);
    while (i >= 0) {
      const before = n[i - 1];
      const after = n[i + w.length];
      if (!(before && /[\p{L}\p{N}]/u.test(before)) && !(after && /\p{L}/u.test(after))) return true;
      i = n.indexOf(w, i + 1);
    }
    return false;
  });
}

export function kindOf(name: string, types: string[], isQuiz: boolean): string {
  const n = name.toLowerCase();
  if (isQuiz || types.includes("online_quiz") || has(n, ["quiz", "test"])) return "quiz";
  if (has(n, ["midterm", "final exam", "exam"])) return "exam";
  if (has(n, ["project", "report", "design", "proposal", "presentation", "poster", "capstone", "milestone"])) return "project";
  if (has(n, ["lab", "laboratory", "experiment"])) return "lab";
  if (has(n, ["essay", "paper", "case study", "literature review", "memo"])) return "essay";
  if (has(n, ["problem set", "ps", "pset", "homework", "hw", "assignment", "webwork", "tutorial", "exercise", "worksheet"])) return "problem_set";
  if (has(n, ["reflection", "discussion", "post", "response", "survey", "check-in", "attendance", "participation"]) || types.includes("discussion_topic")) return "short";
  return "other";
}

export function defaultHours(kind: string, mine: Record<string, number> = {}): number {
  const m = mine[kind];
  if (m != null && Number.isFinite(m) && m > 0) return m;
  return KINDS.find((k) => k[0] === kind)?.[2] ?? 2;
}

/** Hours for an assignment: your estimate, else the default for its kind. */
export function hoursFor(a: Assignment, mine: number | null | undefined, defaults: Record<string, number> = {}): { hours: number; kind: string; custom: boolean } {
  const kind = kindOf(a.name, a.submission_types, !!a.is_quiz_assignment);
  if (mine != null && mine > 0) return { hours: mine, kind, custom: true };
  return { hours: defaultHours(kind, defaults), kind, custom: false };
}

export function fmtHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} min`;
  return Number.isInteger(h) ? `${h} h` : `${h.toFixed(1)} h`;
}
