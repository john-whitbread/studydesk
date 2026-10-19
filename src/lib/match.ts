// Which file in your course folder is most likely the one for an assignment?
// "Lab3_Whitbread_final.pdf" ↔ "Lab 3 – Thick-walled cylinders".

const STOP = new Set(["the", "and", "for", "with", "from", "into", "assignment", "submission", "final", "draft", "copy", "version", "new", "old", "my", "your"]);

/** Lower-case tokens; "lab3" → ["lab", "3"], "ps06" → ["ps", "6"]. */
export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, "") // extension
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => (/^\d+$/.test(t) ? String(Number(t)) : t))
    .filter((t) => !STOP.has(t) && (t.length >= 3 || /^\d+$/.test(t) || ["ps", "hw", "a", "q", "lab"].includes(t)));
}

/** Higher is better; ≤ 0 means "no evidence it's this assignment". */
export function matchScore(fileName: string, assignmentName: string): number {
  const f = tokens(fileName);
  const a = tokens(assignmentName);
  if (!f.length || !a.length) return 0;
  const aNums = a.filter((t) => /^\d+$/.test(t));
  const fNums = f.filter((t) => /^\d+$/.test(t));
  let score = 0;
  for (const t of new Set(a)) {
    if (!f.includes(t)) continue;
    score += /^\d+$/.test(t) ? 3 : t.length >= 4 ? 2 : 1;
  }
  // "Lab 3" vs "lab4_report": numbers present on both sides but none shared.
  if (aNums.length && fNums.length && !aNums.some((n) => fNums.includes(n))) score -= 4;
  return score;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/** Sorts candidates by match score, then most recently modified. */
export function rankFiles<T extends { name: string; modifiedMs: number | null }>(files: T[], assignmentName: string): Ranked<T>[] {
  return files
    .map((item) => ({ item, score: matchScore(item.name, assignmentName) }))
    .sort((x, y) => y.score - x.score || (y.item.modifiedMs ?? 0) - (x.item.modifiedMs ?? 0));
}

/** A confident single best match, or null. */
export function bestMatch<T extends { name: string; modifiedMs: number | null }>(files: T[], assignmentName: string): T | null {
  const r = rankFiles(files, assignmentName);
  if (!r.length || r[0].score < 3) return null;
  if (r[1] && r[1].score === r[0].score) {
    // Tie: prefer the newer only if it's clearly newer (an export of the same doc).
    return (r[0].item.modifiedMs ?? 0) > (r[1].item.modifiedMs ?? 0) ? r[0].item : null;
  }
  return r[0].item;
}
