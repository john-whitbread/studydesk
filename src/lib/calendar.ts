// Calendar tab: dates, grouping and overlap layout. Pure, tested in logic.test.ts.

import type { Entry } from "./entries.ts";
import type { ExtEvent } from "./types.ts";

export const DAY = 86_400_000;

export type CalItem =
  | { kind: "entry"; key: string; e: Entry; start: number; end: number; allDay: boolean; title: string; color: string }
  | { kind: "ext"; key: string; x: ExtEvent; start: number; end: number; allDay: boolean; title: string; color: string };

/** Local midnight of the day containing t. */
export function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Adds calendar days (DST-safe: works on dates, not milliseconds). */
export function addDays(t: number, n: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function addMonths(t: number, n: number): number {
  const d = new Date(t);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  // Clamp: Jan 31 + 1 month = Feb 28/29.
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d.getTime();
}

/** Sunday-start week containing t (as Canada's and Apple's default). */
export function weekStart(t: number, startsOn = 0): number {
  const d = new Date(dayStart(t));
  const back = (d.getDay() - startsOn + 7) % 7;
  return addDays(d.getTime(), -back);
}

/** The 6×7 days shown for the month containing t. */
export function monthGrid(t: number, startsOn = 0): number[] {
  const d = new Date(t);
  const first = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const s = weekStart(first, startsOn);
  return Array.from({ length: 42 }, (_, i) => addDays(s, i));
}

export function sameMonth(a: number, b: number): boolean {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth();
}

/** Days [from, to) the item covers. Zero-length items land on their start day. */
function daysOf(it: { start: number; end: number; allDay: boolean }): number[] {
  const first = dayStart(it.start);
  const lastMoment = it.end > it.start ? it.end - 1 : it.start;
  const out: number[] = [];
  for (let d = first; d <= lastMoment && out.length < 62; d = addDays(d, 1)) out.push(d);
  return out.length ? out : [first];
}

/** Items per local day (midnight ms), all-day first, then by time. */
export function byDay(list: CalItem[], from: number, to: number): Map<number, CalItem[]> {
  const m = new Map<number, CalItem[]>();
  for (const it of list) {
    for (const d of daysOf(it)) {
      if (d < from || d >= to) continue;
      (m.get(d) ?? m.set(d, []).get(d)!).push(it);
    }
  }
  for (const v of m.values()) v.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.title.localeCompare(b.title));
  return m;
}

export interface Placed<T> {
  item: T;
  lane: number;
  lanes: number;
}

/** Side-by-side lanes for overlapping timed events (each cluster of overlaps shares a lane count). */
export function layoutDay<T extends { start: number; end: number }>(list: T[], minLen = 20 * 60_000): Placed<T>[] {
  const sorted = [...list].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Placed<T>[] = [];
  let cluster: Placed<T>[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const n = laneEnds.length;
    for (const p of cluster) p.lanes = n;
    cluster = [];
    laneEnds = [];
  };
  for (const item of sorted) {
    const end = Math.max(item.end, item.start + minLen);
    if (item.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((e) => e <= item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else laneEnds[lane] = end;
    const p = { item, lane, lanes: 1 };
    cluster.push(p);
    out.push(p);
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();
  return out;
}
