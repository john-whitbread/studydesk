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

const TERM_PREFIX = /^\s*\d{6}\s*[-–—:|]\s*/; // "202609 - "
// Cross-listed sections ("Statics 09.202609.XLIST") and registration numbers ("Thermodynamics - 43421").
const NOISE_SUFFIX = [/\s+\d{1,3}\.\d{6}\.XLIST\b.*$/i, /\s*[-–—]\s*\d{5}\s*$/, /\s*\(\d{5,6}\)\s*$/];
const CODE = /\b([A-Z]{2,5})[\s_-]*(\d{4}[A-Z]?)\b/; // MECE-2230U, MATH 2860U
// The code as it appears in a name, with an optional section ("-001", "(002)") and separators around it.
const CODE_IN_NAME = /\s*[-–—|:(]?\s*\b[A-Z]{2,5}[\s_-]*\d{4}[A-Z]?\b(?:[\s_-]*\(?\d{3}\)?)?\)?\s*[-–—|:)]?\s*/;
const EDGES = /^[\s\-–—|:]+|[\s\-–—|:]+$/g;

function stripNoise(s: string): string {
  let t = s.replace(TERM_PREFIX, "");
  for (const re of NOISE_SUFFIX) t = t.replace(re, "");
  return t.replace(EDGES, "").replace(/\s{2,}/g, " ").trim();
}

/** Canvas names become a short code and a plain title:
 *  "202609 - Differential Equations - MATH-2860U-001" → MATH 2860U · Differential Equations;
 *  "Statics 09.202609.XLIST" (code MECE 2230U) → MECE 2230U · Statics;
 *  "Thermodynamics - 43421" (no code) → Thermodynamics.
 *  Canvas's own name stays in full_name. Mirrors core/src/courses.rs. */
export function tidyCourse<T extends { course_code: string; name: string; full_name?: string }>(c: T): T & { full_name: string } {
  const rawCode = (c.course_code ?? "").trim();
  const rawName = (c.name ?? "").trim();
  const m = CODE.exec(rawCode) ?? CODE.exec(rawName);
  let title = stripNoise(rawName);
  if (m) title = stripNoise(title.replace(CODE_IN_NAME, " "));
  if (!title) title = stripNoise(rawCode) || rawName;
  const code = m ? `${m[1]} ${m[2]}` : stripNoise(rawCode) || title;
  // The backend already tidies and sends Canvas's original as full_name; keep that.
  return { ...c, course_code: code === stripNoise(rawName) ? title : code, name: title, full_name: c.full_name || rawName };
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

/** Short labels for the narrow rail: the course number ("2420"), or "ME2860"
 *  / "MA2860" when two courses share a number. Courses without a code get the
 *  initials of their title ("Nuclear Plant Operation" → NPO; "Thermodynamics" → THER). */
export function railLabels(courses: { id: number; course_code: string; name: string }[]): Map<number, string> {
  const SKIP = new Set(["of", "for", "and", "the", "to", "in", "on", "a", "an", "&"]);
  const base = courses.map((c) => {
    const code = c.course_code || c.name;
    const m = CODE.exec(code);
    const words = (c.name || code).replace(/[^A-Za-z0-9& ]/g, " ").split(/\s+/).filter((w) => w && !SKIP.has(w.toLowerCase()));
    const initials = words.length > 1 ? words.slice(0, 3).map((w) => w[0]).join("").toUpperCase() : (words[0] ?? "?").slice(0, 4).toUpperCase();
    return { id: c.id, num: m ? m[2].replace(/[A-Z]$/, "") : null, letters: m ? m[1].slice(0, 2) : "", initials };
  });
  const seen = new Map<string, number>();
  base.forEach((b) => b.num && seen.set(b.num, (seen.get(b.num) ?? 0) + 1));
  return new Map(base.map((b) => [b.id, b.num ? ((seen.get(b.num) ?? 0) > 1 ? b.letters + b.num : b.num) : b.initials]));
}
