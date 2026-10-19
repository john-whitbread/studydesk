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

export function courseColor(c: Course | undefined): string {
  return c?.color && /^#[0-9a-fA-F]{3,8}$/.test(c.color) ? c.color : "var(--text-3)";
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
