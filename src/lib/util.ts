import type { Course } from "./types.ts";

/** Ranks `text` against `query`: substring > word-start > subsequence. 0 = no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i === 0) return 1000 - t.length;
  if (i > 0) return (/[\s\-_:./(]/.test(t[i - 1]) ? 800 : 600) - i;
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    gaps += found - ti;
    ti = found + 1;
  }
  return Math.max(1, 300 - gaps);
}

/** "MECE 2420U" style short code, falling back to the name. */
export function courseShort(c: Course): string {
  const code = c.course_code?.trim();
  if (code && code.length <= 24) return code;
  return c.name;
}

let colorOverrides: Record<string, string> = {};
/** Your own course colours (Settings → Appearance), by course id. */
export function setCourseColorOverrides(m: Record<string, string>) {
  colorOverrides = { ...m };
}

/** The colour Canvas has for the course, or null. */
export function canvasColor(c: Course | undefined): string | null {
  return c?.color && /^#[0-9a-fA-F]{3,8}$/.test(c.color) ? c.color : null;
}

/** Your colour for the course if you set one, else Canvas's. */
export function courseColor(c: Course | undefined): string {
  const mine = c ? colorOverrides[String(c.id)] : undefined;
  if (mine && /^#[0-9a-f]{6}$/i.test(mine)) return mine;
  return canvasColor(c) ?? "var(--text-3)";
}

export function currentScore(c: Course): { score: number | null; grade: string | null } {
  const e = c.enrollments.find((x) => x.computed_current_score != null || x.computed_current_grade) ?? null;
  return { score: e?.computed_current_score ?? null, grade: e?.computed_current_grade ?? null };
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Throttle to at most one call per `ms`. */
export function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let last = 0;
  return (...a: A) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...a);
    }
  };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** Short labels for the narrow rail: the course number ("2420"); when two
 *  courses share a number, the first two letters of the code are added
 *  ("ME2860", "MA2860"); with no number, initials. */
export function railLabels(courses: { id: number; course_code: string; name: string }[]): Map<number, string> {
  const base = courses.map((c) => {
    const src = c.course_code || c.name;
    const num = src.match(/\d{3,4}/)?.[0];
    const letters = src.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase();
    const words = src.trim().split(/\s+/);
    return { id: c.id, num, letters, initials: ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() };
  });
  const seen = new Map<string, number>();
  base.forEach((b) => b.num && seen.set(b.num, (seen.get(b.num) ?? 0) + 1));
  return new Map(base.map((b) => [b.id, b.num ? ((seen.get(b.num) ?? 0) > 1 ? b.letters + b.num : b.num) : b.initials]));
}
