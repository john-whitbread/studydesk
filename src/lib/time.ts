// Date and time formatting. Canvas sends UTC ISO-8601; everything shown is in
// this computer's time zone via Intl.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

const fWeekdayDay = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const fWeekdayLong = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });
const fFullDate = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const fDayYear = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const fMonthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const fTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** "Tue, Oct 20" (adds the year when it isn't this year). */
export function fmtDay(t: number, now = Date.now()): string {
  return new Date(t).getFullYear() === new Date(now).getFullYear() ? fWeekdayDay.format(t) : fDayYear.format(t);
}
/** "11:59 PM" */
export function fmtTime(t: number): string {
  return fTime.format(t);
}
/** "Tue, Oct 20, 11:59 PM" */
export function fmtDateTime(t: number, now = Date.now()): string {
  return `${fmtDay(t, now)}, ${fmtTime(t)}`;
}
/** "Sunday, October 18" */
export function fmtFullDate(t: number): string {
  return fFullDate.format(t);
}

/** Local midnight of the day containing t. */
export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole calendar days from a to b in local time (DST-safe). */
export function calendarDays(a: number, b: number): number {
  const da = new Date(a);
  const db = new Date(b);
  const ua = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
  const ub = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate());
  return Math.round((ub - ua) / DAY);
}

export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "Today", "Tomorrow", "Yesterday", else "Wednesday, Oct 21". */
export function dayLabel(t: number, now = Date.now()): string {
  const d = calendarDays(now, t);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d === -1) return "Yesterday";
  return d > 0 && d < 7 ? fWeekdayLong.format(t) : fmtDay(t, now);
}

/**
 * Relative time, precise where it matters:
 * under an hour in minutes, under a day in hours (+minutes under 6 h),
 * otherwise in calendar days, then weeks.
 */
export function relative(t: number, now = Date.now()): string {
  const diff = t - now;
  const abs = Math.abs(diff);
  const future = diff >= 0;
  let s: string;
  if (abs < MIN) return future ? "in under a minute" : "just now";
  if (abs < HOUR) {
    s = `${Math.floor(abs / MIN)} min`;
  } else if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    const m = Math.floor((abs % HOUR) / MIN);
    s = h < 6 && m > 0 ? `${h} h ${m} min` : `${h} h`;
  } else {
    const days = Math.abs(calendarDays(now, t));
    if (days < 14) s = days === 1 ? "1 day" : `${days} days`;
    else s = `${Math.round(days / 7)} weeks`;
  }
  return future ? `in ${s}` : `${s} ago`;
}

/** Compact time for lists: "7:12 PM" today, "Yesterday", "Oct 12", or with year. */
export function fmtListTime(t: number, now = Date.now()): string {
  const d = calendarDays(t, now);
  if (d === 0) return fmtTime(t);
  if (d === 1) return "Yesterday";
  if (d < 7 && d > 0) return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(t);
  return new Date(t).getFullYear() === new Date(now).getFullYear() ? fMonthDay.format(t) : fDayYear.format(t);
}

export function fmtSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** 18 -> "18", 18.5 -> "18.5", 18.256 -> "18.26" */
export function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
