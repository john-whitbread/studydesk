// Run with: npm test  (Node's built-in test runner, no extra packages)
import test from "node:test";
import assert from "node:assert/strict";
import { calendarDays, dayLabel, fmtNum, fmtSize, relative } from "./time.ts";
import { assignmentStatus } from "./status.ts";
import type { Assignment } from "./types.ts";

// Local-time constructors keep these tests independent of the machine's zone.
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime(); // October 2026
const NOW = at(18, 19, 0); // Sun Oct 18, 7:00 PM
const iso = (t: number) => new Date(t).toISOString();

function asg(over: Partial<Assignment> = {}): Assignment {
  return { id: 1, course_id: 1, name: "Lab", submission_types: ["online_upload"], allowed_extensions: [], rubric: [], ...over };
}

test("relative times", () => {
  assert.equal(relative(NOW + 30_000, NOW), "in under a minute");
  assert.equal(relative(NOW + 42 * 60_000, NOW), "in 42 min");
  assert.equal(relative(NOW + (5 * 60 + 10) * 60_000, NOW), "in 5 h 10 min");
  assert.equal(relative(NOW + 7 * 3600_000, NOW), "in 7 h");
  assert.equal(relative(at(20, 23, 59), NOW), "in 2 days");
  assert.equal(relative(at(17, 23, 59), NOW), "19 h ago");
  assert.equal(relative(at(15, 9), NOW), "3 days ago");
  assert.equal(relative(NOW + 21 * 86400_000, NOW), "in 3 weeks");
});

test("calendar days ignore time of day", () => {
  assert.equal(calendarDays(at(18, 23, 59), at(19, 0, 1)), 1);
  assert.equal(calendarDays(at(18, 0, 1), at(18, 23, 59)), 0);
  // Across the November DST change.
  assert.equal(calendarDays(new Date(2026, 10, 1, 0, 30).getTime(), new Date(2026, 10, 2, 0, 30).getTime()), 1);
});

test("day labels", () => {
  assert.equal(dayLabel(at(18, 23), NOW), "Today");
  assert.equal(dayLabel(at(19, 8), NOW), "Tomorrow");
  assert.equal(dayLabel(at(17, 8), NOW), "Yesterday");
});

test("numbers and sizes", () => {
  assert.equal(fmtNum(18), "18");
  assert.equal(fmtNum(18.256), "18.26");
  assert.equal(fmtSize(2_400_000), "2.4 MB");
  assert.equal(fmtSize(999), "999 B");
});

test("status: to do, due soon, overdue, closed", () => {
  assert.equal(assignmentStatus(asg({ due_at: iso(at(22, 23, 59)) }), NOW).kind, "todo");
  const soon = assignmentStatus(asg({ due_at: iso(NOW + 5 * 3600_000) }), NOW);
  assert.equal(soon.kind, "due_soon");
  assert.equal(soon.label, calendarDaysLabel(NOW + 5 * 3600_000));
  const over = assignmentStatus(asg({ due_at: iso(at(17, 23, 59)) }), NOW);
  assert.deepEqual([over.kind, over.needsAction, over.late], ["overdue", true, true]);
  const closed = assignmentStatus(asg({ due_at: iso(at(16, 23, 59)), lock_at: iso(at(17, 23, 59)) }), NOW);
  assert.deepEqual([closed.kind, closed.needsAction], ["closed", false]);
});

test("status: submitted, late, graded, excused", () => {
  const sub = (s: object) => asg({ due_at: iso(at(17, 23, 59)), submission: { attachments: [], submission_comments: [], ...s } });
  assert.equal(assignmentStatus(sub({ submitted_at: iso(at(17, 20)), workflow_state: "submitted" }), NOW).kind, "submitted");
  assert.equal(assignmentStatus(sub({ submitted_at: iso(at(18, 1)), workflow_state: "submitted", late: true }), NOW).label, "Submitted late");
  const g = assignmentStatus(asg({ points_possible: 20, submission: { workflow_state: "graded", score: 18.5, attachments: [], submission_comments: [] } }), NOW);
  assert.deepEqual([g.kind, g.label], ["graded", "18.5 / 20"]);
  assert.equal(assignmentStatus(sub({ excused: true }), NOW).kind, "excused");
  // Graded workflow without a visible score (not posted yet) is still "submitted".
  assert.equal(assignmentStatus(sub({ workflow_state: "graded", submitted_at: iso(at(17, 1)) }), NOW).kind, "submitted");
});

test("status: missing flag, not open, offline", () => {
  const m = assignmentStatus(asg({ due_at: iso(at(17, 23, 59)), submission: { missing: true, attachments: [], submission_comments: [] } }), NOW);
  assert.deepEqual([m.kind, m.tone], ["missing", "danger"]);
  assert.equal(assignmentStatus(asg({ unlock_at: iso(at(20, 9)), due_at: iso(at(25, 23, 59)) }), NOW).kind, "not_open");
  assert.equal(assignmentStatus(asg({ submission_types: ["on_paper"], due_at: iso(at(17, 9)) }), NOW).kind, "no_submission");
  assert.equal(assignmentStatus(asg({ submission_types: [] }), NOW).kind, "no_submission");
});

function calendarDaysLabel(t: number) {
  return calendarDays(NOW, t) === 0 ? "Due today" : "Due soon";
}

// ------------------------------------------------------------ heat + match
import { countdown, heatOf } from "./heat.ts";
import { bestMatch, matchScore, tokens } from "./match.ts";

test("heat levels", () => {
  const h = 3600_000;
  assert.equal(heatOf(NOW + 8 * 24 * h, NOW, true), "cool");
  assert.equal(heatOf(NOW + 5 * 24 * h, NOW, true), "mild");
  assert.equal(heatOf(NOW + 48 * h, NOW, true), "warm");
  assert.equal(heatOf(NOW + 10 * h, NOW, true), "hot");
  assert.equal(heatOf(NOW + 2 * h, NOW, true), "critical");
  assert.equal(heatOf(NOW - 1, NOW, true), "overdue");
  assert.equal(heatOf(NOW + 2 * h, NOW, false), "none");
  assert.equal(countdown(NOW + (3 * 3600 + 42 * 60 + 10) * 1000, NOW), "3:42:10");
  assert.equal(countdown(NOW + 65_000, NOW), "1:05");
  assert.equal(countdown(NOW - 1, NOW), "");
});

test("file matching", () => {
  assert.deepEqual(tokens("Lab3_Whitbread_FINAL.pdf"), ["lab", "3", "whitbread"]);
  assert.deepEqual(tokens("PS06 torsion.docx"), ["ps", "6", "torsion"]);
  assert.ok(matchScore("Lab3_Whitbread.pdf", "Lab 3 – Thick-walled cylinders") >= 4);
  assert.ok(matchScore("lab4_report.pdf", "Lab 3 – Thick-walled cylinders") < 0);
  assert.ok(matchScore("Formula sheet.pdf", "Lab 3 – Thick-walled cylinders") <= 0);
  const files = [
    { name: "Formula sheet.pdf", modifiedMs: 5 },
    { name: "Lab3_Whitbread.pdf", modifiedMs: 2 },
    { name: "Lab 2 report.pdf", modifiedMs: 9 },
  ];
  assert.equal(bestMatch(files, "Lab 3 – Thick-walled cylinders")?.name, "Lab3_Whitbread.pdf");
  assert.equal(bestMatch(files, "Problem Set 6 – Torsion"), null);
  assert.equal(bestMatch([{ name: "PS6_torsion.pdf", modifiedMs: 1 }], "Problem Set 6 – Torsion of non-circular shafts")?.name, "PS6_torsion.pdf");
});
