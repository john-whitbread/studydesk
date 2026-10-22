// Weekly office hours → concrete times.

import type { OfficeHours } from "./types.ts";

export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface OhSlot {
  oh: OfficeHours;
  start: number;
  end: number;
}

function at(day: Date, hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(day);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
}

/** Every slot between `from` and `to` (ms), sorted. */
export function ohSlots(list: OfficeHours[], from: number, to: number): OhSlot[] {
  const out: OhSlot[] = [];
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  for (; d.getTime() < to; d.setDate(d.getDate() + 1)) {
    const wd = (d.getDay() + 6) % 7; // 0 = Monday
    for (const oh of list) {
      if (!oh.days.includes(wd)) continue;
      const start = at(d, oh.start);
      const end = at(d, oh.end);
      if (end > from && start < to) out.push({ oh, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The next (or current) slot within two weeks. */
export function nextOh(list: OfficeHours[], now: number): OhSlot | null {
  return ohSlots(list, now, now + 15 * 86_400_000)[0] ?? null;
}

export function ohDays(oh: OfficeHours): string {
  return oh.days.map((d) => DAY_NAMES[d] ?? "?").join(", ");
}

/** "14:00" → "2:00 pm" in the user's locale style. */
export function fmtHm(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(2000, 0, 1, h || 0, m || 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
