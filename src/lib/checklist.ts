// Requirements checklist from an assignment description: list items, numbered
// lines and "must include / submit … containing" sentences. Editable by you;
// when the description changes, your ticks follow items that still match.

import type { CheckItem } from "./types.ts";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
function decode(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const text = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

const CUE = /\b(must|should|include|including|contain|containing|submit|attach|upload|provide|show|label|cite|use|answer|complete|required?|be sure|make sure|don't forget|remember to)\b/i;
const NOISE = /^(note|notes|hint|tip|example|e\.g\.|for example|instructions|submission|grading|rubric|due|late|points?)\s*:?\s*$/i;

function clean(s: string): string {
  return s
    .replace(/^\s*(?:[-•*▪◦–]|\(?\d{1,2}[.)]|\(?[a-z][.)]|step\s+\d+[:.)]?)\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/[\s:;,.]+$/, "")
    .trim();
}

/** Candidate requirement lines from an HTML description. */
export function requirementsFrom(html: string | null | undefined): string[] {
  if (!html) return [];
  const out: string[] = [];
  const push = (s: string) => {
    const c = clean(s);
    if (c.length < 3 || c.length > 300 || NOISE.test(c) || !/[a-z]/i.test(c)) return;
    if (!out.some((o) => o.toLowerCase() === c.toLowerCase())) out.push(c);
  };
  // 1. List items (<li>), the strongest signal.
  for (const m of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) push(text(m[1]));
  // 2. Numbered / bulleted lines written as paragraphs or line breaks.
  const lines = decode(
    html
      .replace(/<li\b[^>]*>[\s\S]*?<\/li>/gi, "\n")
      .replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const l of lines) {
    if (/^\s*(?:[-•*▪◦]|\(?\d{1,2}[.)]|\(?[a-h][.)])\s+\S/i.test(l)) push(l);
  }
  // 3. Requirement sentences ("Your report must include a free-body diagram.").
  if (out.length === 0) {
    for (const l of lines) {
      for (const sent of l.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
        if (CUE.test(sent) && sent.length <= 220) push(sent);
      }
    }
  }
  return out.slice(0, 30);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Words in common / words in the shorter: 1 = same item. */
function similarity(a: string, b: string): number {
  const A = new Set(norm(a).split(" ").filter((w) => w.length > 2));
  const B = new Set(norm(b).split(" ").filter((w) => w.length > 2));
  if (!A.size || !B.size) return norm(a) === norm(b) ? 1 : 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / Math.min(A.size, B.size);
}

/**
 * Merges a fresh extraction into your existing checklist. Your own items stay.
 * Auto items that still match keep their tick; auto items no longer in the
 * description are dropped (unless ticked); new ones are flagged `new`.
 */
export function mergeChecklist(existing: CheckItem[], fresh: string[], firstTime: boolean): CheckItem[] {
  const out: CheckItem[] = [];
  const used = new Set<number>();
  for (const f of fresh) {
    let bestI = -1;
    let best = 0;
    existing.forEach((e, i) => {
      if (!e.auto || used.has(i)) return;
      const s = similarity(e.text, f);
      if (s > best) {
        best = s;
        bestI = i;
      }
    });
    if (bestI >= 0 && best >= 0.75) {
      used.add(bestI);
      out.push({ ...existing[bestI], text: f });
    } else {
      out.push({ text: f, done: false, auto: true, new: !firstTime });
    }
  }
  existing.forEach((e, i) => {
    if (!e.auto) out.push(e);
    else if (!used.has(i) && e.done) out.push({ ...e, new: false }); // keep what you ticked
  });
  return out;
}

/** Short hash of the description so changes are noticed. */
export function descHash(html: string | null | undefined): string {
  let h = 2166136261;
  const s = text(html ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
