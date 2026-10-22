// Workload by hours: what's due each day and where it collides.

import { dayStart } from "./calendar.ts";

export interface LoadItem {
  key: string;
  title: string;
  due: number;
  hours: number;
  /** Exams and quizzes from key dates. */
  exam?: boolean;
  /** Still needs doing. */
  open: boolean;
}

export interface DayLoad {
  day: number;
  hours: number;
  count: number;
  items: LoadItem[];
  level: "none" | "light" | "busy" | "heavy";
}

/** Hours of open work due on each of `days` days from `from`. */
export function loadByDay(items: LoadItem[], from: number, days: number): DayLoad[] {
  const out: DayLoad[] = [];
  const first = dayStart(from);
  for (let i = 0; i < days; i++) {
    const d = new Date(first);
    d.setDate(d.getDate() + i);
    const day = d.getTime();
    const next = new Date(day);
    next.setDate(next.getDate() + 1);
    const due = items.filter((it) => it.open && it.due >= day && it.due < next.getTime());
    const hours = due.reduce((a, it) => a + it.hours, 0);
    out.push({ day, hours, count: due.length, items: due, level: hours >= 8 ? "heavy" : hours >= 4 ? "busy" : hours > 0 ? "light" : "none" });
  }
  return out;
}

export interface Collision {
  day: number;
  text: string;
}

/** Days worth a warning: 3+ things or 8+ hours due, or an exam within 48 h of 4+ h of other work. */
export function collisions(load: DayLoad[], items: LoadItem[]): Collision[] {
  const out: Collision[] = [];
  for (const d of load) {
    if (d.count >= 3 || d.hours >= 8) out.push({ day: d.day, text: `${d.count} due, about ${Math.round(d.hours)} h of work` });
  }
  for (const ex of items.filter((i) => i.exam && i.open)) {
    const near = items.filter((i) => !i.exam && i.open && Math.abs(i.due - ex.due) <= 48 * 3600_000);
    const h = near.reduce((a, i) => a + i.hours, 0);
    if (h >= 4 && !out.some((c) => c.day === dayStart(ex.due))) out.push({ day: dayStart(ex.due), text: `${ex.title} within 48 h of ${Math.round(h)} h of other work` });
  }
  return out.sort((a, b) => a.day - b.day);
}
