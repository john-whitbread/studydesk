// Assignments and pinned key dates on one timeline.

import { items, type Item } from "./derive.ts";
import { heatOf, type Heat } from "./heat.ts";
import type { Course, Dashboard, PinnedDate } from "./types.ts";

export type Entry =
  | { type: "asg"; key: string; it: Item; due: number | null; heat: Heat; course: Course | undefined }
  | { type: "pin"; key: string; p: PinnedDate; due: number; heat: Heat; course: Course | undefined };

/** Local timestamp of a pinned date; date-only pins count as 9:00 for ordering. */
export function pinDue(p: PinnedDate): number {
  const [y, m, d] = p.date.split("-").map(Number);
  const [hh, mm] = (p.time ?? "09:00").split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
}

export function entries(dash: Dashboard | null, pinned: PinnedDate[], now: number): Entry[] {
  const byId = new Map((dash?.courses ?? []).map((c) => [c.id, c]));
  const out: Entry[] = items(dash, now).map((it) => ({
    type: "asg",
    key: `a${it.a.id}`,
    it,
    due: it.due,
    heat: heatOf(it.due, now, it.s.needsAction, it.s.late),
    course: it.course,
  }));
  for (const p of pinned) {
    const c = byId.get(p.courseId);
    if (c?.hidden) continue;
    const due = pinDue(p);
    // A date-only pin stays "today" until the day ends.
    const endOfDay = new Date(due).setHours(23, 59, 59, 999);
    const active = (p.time ? due : endOfDay) >= now;
    out.push({ type: "pin", key: `p${p.id}`, p, due, heat: p.kind === "info" ? "none" : heatOf(due, now, active, false), course: c });
  }
  return out;
}

export function entryNeedsAction(e: Entry, now: number): boolean {
  return e.type === "asg" ? e.it.s.needsAction : e.p.kind !== "info" && e.due >= now - 12 * 3600_000;
}

export const KIND_LABEL: Record<string, string> = { exam: "Exam", quiz: "Quiz", deliverable: "Due", info: "Note" };
