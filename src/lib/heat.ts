// Deadline heat: the closer something is, the warmer its colour.
//   cool (7+ days) → mild (3–7 d) → warm (1–3 d) → hot (< 24 h) → critical (< 6 h) → overdue
// Done items have no heat. Every heat level also has a text label, so colour
// is never the only signal.

export type Heat = "none" | "cool" | "mild" | "warm" | "hot" | "critical" | "overdue";

const H = 3600_000;

export function heatOf(due: number | null, now: number, needsAction: boolean, late = false): Heat {
  if (!needsAction || due == null) return "none";
  if (late || due < now) return "overdue";
  const left = due - now;
  if (left < 6 * H) return "critical";
  if (left < 24 * H) return "hot";
  if (left < 72 * H) return "warm";
  if (left < 7 * 24 * H) return "mild";
  return "cool";
}

export const HEAT_LABEL: Record<Heat, string> = {
  none: "",
  cool: "More than a week",
  mild: "This week",
  warm: "Within 3 days",
  hot: "Within 24 hours",
  critical: "Within 6 hours",
  overdue: "Overdue",
};

/** Rank for sorting/weighting: higher = more urgent. */
export const HEAT_RANK: Record<Heat, number> = { none: 0, cool: 1, mild: 2, warm: 3, hot: 4, critical: 5, overdue: 6 };

/** "3:42:10" (under 24 h) or "42:10" (under 1 h). Negative → "". */
export function countdown(due: number, now: number): string {
  const ms = due - now;
  if (ms <= 0) return "";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}
