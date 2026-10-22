// Grade calculator, following Canvas's own rules so the numbers match:
//
// - Each assignment group is (sum of scores) / (sum of points possible).
// - Weighted courses: total = Σ weight × group% / Σ weight, over groups that
//   have something graded ("current" grade; empty groups don't count against you).
//   Unweighted courses: total = all scores / all points possible.
// - Drop rules (drop lowest / drop highest, never-drop) choose the set that
//   gives the best (or, for drop highest, worst) group percentage, exactly as
//   Canvas does; this matters when assignments are out of different points.
// - Excused work, "doesn't count toward final grade" and ungraded types are left out.
// - A score Canvas hasn't released is unknown, never zero.
// - Extra credit (0-point assignments with a score) adds to the score.
//
// "Final" treats every not-yet-graded assignment as 0 (what Canvas calls the
// final grade); "what-if" scores replace or fill in any assignment.

import type { Assignment } from "./types.ts";

export interface Group {
  id: number;
  name: string;
  group_weight?: number | null;
  rules?: { drop_lowest?: number | null; drop_highest?: number | null; never_drop?: number[] | null } | null;
}

export type WhatIf = Map<number, number>;

export interface Counted {
  id: number;
  name: string;
  score: number | null; // null = not graded (yet)
  possible: number;
  whatIf: boolean;
  dropped: boolean;
}

export interface GroupResult {
  id: number;
  name: string;
  weight: number | null;
  score: number;
  possible: number;
  /** 0–100, or null when nothing in it counts yet. */
  percent: number | null;
  items: Counted[];
}

export interface GradeResult {
  weighted: boolean;
  /** 0–100, or null when nothing is graded. */
  percent: number | null;
  groups: GroupResult[];
  /** Graded but not released to you yet (unknown, excluded). */
  hidden: number;
  /** Counted toward this grade. */
  gradedCount: number;
  ungradedCount: number;
}

interface Row {
  id: number;
  name: string;
  groupId: number;
  score: number | null;
  possible: number;
  whatIf: boolean;
}

/** Assignments that can count at all. */
export function counts(a: Assignment): boolean {
  if (a.omit_from_final_grade) return false;
  if (a.grading_type === "not_graded") return false;
  if (a.submission?.excused) return false;
  return true;
}

/** Released but hidden: graded in Canvas, score withheld from students. */
export function isHidden(a: Assignment): boolean {
  const s = a.submission;
  return !!s && s.workflow_state === "graded" && s.score == null && !s.grade && !s.excused;
}

function rowsOf(list: Assignment[], whatIf: WhatIf, zeroUngraded: boolean): Row[] {
  return list.filter(counts).map((a) => {
    const w = whatIf.get(a.id);
    const actual = a.submission?.score ?? null;
    // A grade that exists but isn't released stays unknown, even in "final".
    const score = w != null ? w : actual != null ? actual : zeroUngraded && !isHidden(a) ? 0 : null;
    return { id: a.id, name: a.name, groupId: a.assignment_group_id ?? 0, score, possible: Math.max(0, a.points_possible ?? 0), whatIf: w != null };
  });
}

const ratio = (rs: { score: number; possible: number }[]) => {
  const s = rs.reduce((a, r) => a + r.score, 0);
  const p = rs.reduce((a, r) => a + r.possible, 0);
  return p > 0 ? s / p : s > 0 ? Infinity : 0;
};

/**
 * Picks `keep` of `pool` (plus the always-kept `fixed`) giving the highest
 * (best=true) or lowest score/possible ratio. Dinkelbach's method: rank by
 * score − q·possible, keep the top, update q, repeat until it settles. This is
 * exact for this problem (it's how Canvas chooses drops too).
 */
export function keepBest<T extends { score: number; possible: number }>(pool: T[], fixed: T[], keep: number, best: boolean): T[] {
  if (keep >= pool.length) return pool.slice();
  if (keep <= 0) return [];
  const sign = best ? 1 : -1;
  // Start from simple percentage order.
  const pct = (r: T) => (r.possible > 0 ? r.score / r.possible : r.score > 0 ? Infinity : 0);
  let chosen = pool.slice().sort((a, b) => sign * (pct(b) - pct(a))).slice(0, keep);
  for (let i = 0; i < 100; i++) {
    const q = ratio([...fixed, ...chosen]);
    if (!Number.isFinite(q)) break;
    const next = pool
      .slice()
      .sort((a, b) => sign * (b.score - q * b.possible - (a.score - q * a.possible)))
      .slice(0, keep);
    const nq = ratio([...fixed, ...next]);
    if (best ? nq <= q + 1e-12 : nq >= q - 1e-12) {
      // No improvement: keep whichever is actually better.
      if (best ? nq > ratio([...fixed, ...chosen]) : nq < ratio([...fixed, ...chosen])) chosen = next;
      break;
    }
    chosen = next;
  }
  return chosen;
}

function groupResult(g: Group, rows: Row[]): GroupResult {
  const graded = rows.filter((r) => r.score != null) as (Row & { score: number })[];
  const never = new Set(g.rules?.never_drop ?? []);
  const fixed = graded.filter((r) => never.has(r.id));
  const pool = graded.filter((r) => !never.has(r.id));
  let dropLow = Math.max(0, g.rules?.drop_lowest ?? 0);
  let dropHigh = Math.max(0, g.rules?.drop_highest ?? 0);
  // Canvas never drops everything: at least one item stays.
  const minKeep = fixed.length > 0 ? 0 : 1;
  dropLow = Math.min(dropLow, Math.max(0, pool.length - minKeep));
  let kept = dropLow > 0 ? keepBest(pool, fixed, pool.length - dropLow, true) : pool;
  dropHigh = Math.min(dropHigh, Math.max(0, kept.length - minKeep));
  if (dropHigh > 0) kept = keepBest(kept, fixed, kept.length - dropHigh, false);
  const keptIds = new Set([...kept, ...fixed].map((r) => r.id));
  const items: Counted[] = rows.map((r) => ({ id: r.id, name: r.name, score: r.score, possible: r.possible, whatIf: r.whatIf, dropped: r.score != null && !keptIds.has(r.id) }));
  const counted = [...kept, ...fixed];
  const score = counted.reduce((a, r) => a + r.score, 0);
  const possible = counted.reduce((a, r) => a + r.possible, 0);
  return {
    id: g.id,
    name: g.name,
    weight: g.group_weight ?? null,
    score,
    possible,
    percent: possible > 0 ? (score / possible) * 100 : null,
    items,
  };
}

/**
 * The course grade. `zeroUngraded` gives Canvas's "final" grade (ungraded = 0);
 * otherwise the "current" grade (graded work only).
 */
export function courseGrade(assignments: Assignment[], groups: Group[], weighted: boolean, whatIf: WhatIf = new Map(), zeroUngraded = false): GradeResult {
  const rows = rowsOf(assignments, whatIf, zeroUngraded);
  const hidden = assignments.filter((a) => counts(a) && isHidden(a) && !whatIf.has(a.id)).length;
  // Assignments in a group we don't know get their own bucket (never silently lost).
  const known = new Map(groups.map((g) => [g.id, g]));
  const allGroups: Group[] = [...groups];
  for (const r of rows) if (!known.has(r.groupId)) {
    const g: Group = { id: r.groupId, name: "Other", group_weight: 0 };
    known.set(r.groupId, g);
    allGroups.push(g);
  }
  const results = allGroups.map((g) => groupResult(g, rows.filter((r) => r.groupId === g.id)));
  let percent: number | null = null;
  if (weighted) {
    const live = results.filter((g) => g.possible > 0 && (g.weight ?? 0) > 0);
    const wsum = live.reduce((a, g) => a + (g.weight ?? 0), 0);
    if (wsum > 0) percent = live.reduce((a, g) => a + (g.weight ?? 0) * (g.score / g.possible) * 100, 0) / wsum;
  } else {
    const s = results.reduce((a, g) => a + g.score, 0);
    const p = results.reduce((a, g) => a + g.possible, 0);
    if (p > 0) percent = (s / p) * 100;
  }
  const gradedCount = rows.filter((r) => r.score != null).length;
  return { weighted, percent, groups: results, hidden, gradedCount, ungradedCount: rows.length - gradedCount };
}

export type Need =
  | { kind: "already"; } // even 0 reaches the target
  | { kind: "need"; points: number; percent: number } // score needed (may exceed 100% = extra credit)
  | { kind: "impossible"; best: number | null }; // not reachable even with 3× full marks

/** Bisection on a non-decreasing f over [0, hi]. */
function solve(f: (x: number) => number | null, target: number, hi: number): number | null {
  let lo = 0;
  let h = hi;
  if ((f(h) ?? -Infinity) < target) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + h) / 2;
    if ((f(mid) ?? -Infinity) >= target) h = mid;
    else lo = mid;
  }
  return h;
}

/** Score needed on one assignment (others as they are, plus what-ifs) to reach `target` %. */
export function needOn(assignments: Assignment[], groups: Group[], weighted: boolean, whatIf: WhatIf, assignmentId: number, target: number): Need {
  const a = assignments.find((x) => x.id === assignmentId);
  const possible = Math.max(0, a?.points_possible ?? 0);
  const f = (x: number) => {
    const w = new Map(whatIf);
    w.set(assignmentId, x);
    return courseGrade(assignments, groups, weighted, w).percent;
  };
  if ((f(0) ?? -Infinity) >= target - 1e-9) return { kind: "already" };
  const hi = Math.max(possible * 3, 1);
  const x = solve(f, target - 1e-9, hi);
  if (x == null) return { kind: "impossible", best: f(possible) };
  const points = Math.ceil(x * 100 - 1e-6) / 100;
  return { kind: "need", points, percent: possible > 0 ? (points / possible) * 100 : 0 };
}

/** The same % on every remaining (ungraded, counting) assignment needed to reach `target`. */
export function needOnAllRemaining(assignments: Assignment[], groups: Group[], weighted: boolean, whatIf: WhatIf, target: number): Need {
  const remaining = assignments.filter((a) => counts(a) && a.submission?.score == null && !whatIf.has(a.id) && !isHidden(a) && (a.points_possible ?? 0) > 0);
  if (!remaining.length) return { kind: "impossible", best: courseGrade(assignments, groups, weighted, whatIf).percent };
  const f = (r: number) => {
    const w = new Map(whatIf);
    for (const a of remaining) w.set(a.id, r * (a.points_possible ?? 0));
    return courseGrade(assignments, groups, weighted, w).percent;
  };
  if ((f(0) ?? -Infinity) >= target - 1e-9) return { kind: "already" };
  const r = solve(f, target - 1e-9, 3);
  if (r == null) return { kind: "impossible", best: f(1) };
  return { kind: "need", points: 0, percent: Math.ceil(r * 10000 - 1e-6) / 100 };
}

/** How much one assignment is worth in the final grade, as a % of the course (null if unknown). */
export function worth(a: Assignment, assignments: Assignment[], groups: Group[], weighted: boolean): number | null {
  if (!counts(a) || !(a.points_possible && a.points_possible > 0)) return null;
  const gid = a.assignment_group_id ?? 0;
  const inGroup = assignments.filter((x) => counts(x) && (x.assignment_group_id ?? 0) === gid);
  const groupPoints = inGroup.reduce((s, x) => s + Math.max(0, x.points_possible ?? 0), 0);
  if (weighted) {
    const g = groups.find((x) => x.id === gid);
    const wsum = groups.reduce((s, x) => s + (x.group_weight ?? 0), 0);
    if (!g || !g.group_weight || !groupPoints || !wsum) return null;
    return ((g.group_weight / wsum) * 100 * a.points_possible) / groupPoints;
  }
  const total = assignments.filter(counts).reduce((s, x) => s + Math.max(0, x.points_possible ?? 0), 0);
  return total > 0 ? (a.points_possible / total) * 100 : null;
}

/** Assignments still to be graded that count (what "remaining" means everywhere). */
export function remaining(assignments: Assignment[], whatIf: WhatIf = new Map()): Assignment[] {
  return assignments.filter((a) => counts(a) && a.submission?.score == null && !whatIf.has(a.id) && !isHidden(a) && (a.points_possible ?? 0) > 0);
}

/** Lowest (everything left = 0) and highest (everything left = full marks) possible grade. */
export function gradeRange(assignments: Assignment[], groups: Group[], weighted: boolean, whatIf: WhatIf = new Map()): { min: number | null; max: number | null } {
  const min = courseGrade(assignments, groups, weighted, whatIf, true).percent;
  const full = new Map(whatIf);
  for (const a of remaining(assignments, whatIf)) full.set(a.id, a.points_possible ?? 0);
  const max = courseGrade(assignments, groups, weighted, full, true).percent;
  return { min, max };
}

/** Ontario Tech letter grades (lower bound, letter). */
export const LETTERS: [number, string][] = [
  [90, "A+"], [85, "A"], [80, "A-"], [77, "B+"], [73, "B"], [70, "B-"], [67, "C+"], [60, "C"], [50, "D"], [0, "F"],
];
export function letterOf(p: number | null): string | null {
  if (p == null) return null;
  return LETTERS.find(([lo]) => p >= lo - 1e-9)?.[1] ?? "F";
}
