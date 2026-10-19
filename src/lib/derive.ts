// Derived views of the dashboard, shared by the sidebar, Today and courses.

import { assignmentStatus, type AssignmentStatus } from "./status.ts";
import { parse } from "./time.ts";
import type { Assignment, Course, Dashboard } from "./types.ts";

export const DAY = 86_400_000;

export interface Item {
  a: Assignment;
  s: AssignmentStatus;
  due: number | null;
  course: Course | undefined;
}

export function visibleCourses(d: Dashboard | null): Course[] {
  return (d?.courses ?? []).filter((c) => !c.hidden);
}

export function courseById(d: Dashboard | null): Map<number, Course> {
  return new Map((d?.courses ?? []).map((c) => [c.id, c]));
}

export function items(d: Dashboard | null, now: number, courseId?: number): Item[] {
  if (!d) return [];
  const byId = courseById(d);
  return d.assignments
    .filter((a) => (courseId == null ? !byId.get(a.course_id)?.hidden : a.course_id === courseId))
    .map((a) => ({ a, s: assignmentStatus(a, now), due: parse(a.due_at), course: byId.get(a.course_id) }));
}

/** Needs action and is overdue, or due within the next `days`. */
export function actionCounts(list: Item[], now: number, days = 7) {
  let overdue = 0;
  let soon = 0;
  for (const it of list) {
    if (!it.s.needsAction || it.due == null) continue;
    if (it.s.late) overdue++;
    else if (it.due - now <= days * DAY) soon++;
  }
  return { overdue, soon };
}

export function byDue(a: Item, b: Item): number {
  return (a.due ?? Infinity) - (b.due ?? Infinity) || a.a.name.localeCompare(b.a.name);
}
