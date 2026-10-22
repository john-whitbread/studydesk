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

import { railLabels } from "./util.ts";

test("rail labels are short and unique", () => {
  const l = railLabels([
    { id: 1, course_code: "MECE 2420U", name: "Solid Mechanics II" },
    { id: 2, course_code: "MECE 2860U", name: "Fluid Mechanics" },
    { id: 3, course_code: "MATH 2860U", name: "Differential Equations" },
    { id: 4, course_code: "", name: "Career Seminar" },
  ]);
  assert.equal(l.get(1), "2420");
  assert.equal(l.get(2), "ME2860");
  assert.equal(l.get(3), "MA2860");
  assert.equal(l.get(4), "CS");
});

import { ACCENTS, COURSE_SWATCHES, SURFACES, contrast, resolveMode } from "./appearance.ts";

test("contrast maths matches WCAG reference values", () => {
  assert.equal(Math.round(contrast("#000000", "#ffffff") * 10) / 10, 21);
  assert.equal(Math.round(contrast("#777777", "#ffffff") * 100) / 100, 4.48);
});

test("every accent preset is readable in light and dark mode (WCAG AA)", () => {
  for (const a of ACCENTS) {
    for (const mode of ["light", "dark"] as const) {
      const t = a[mode];
      const where = `${a.id}/${mode}`;
      assert.ok(contrast(t.text, t.accent) >= 4.5, `${where}: button text ${contrast(t.text, t.accent).toFixed(2)}`);
      assert.ok(contrast(t.text, t.hover) >= 4.5, `${where}: hovered button text`);
      for (const bg of SURFACES[mode]) assert.ok(contrast(t.accent, bg) >= 4.5, `${where}: accent text on ${bg} ${contrast(t.accent, bg).toFixed(2)}`);
      assert.ok(contrast(t.accent, t.soft) >= 4.5, `${where}: accent on its soft tint ${contrast(t.accent, t.soft).toFixed(2)}`);
    }
  }
});

test("course swatches stand out from the panels in both modes (WCAG 3:1 for graphics)", () => {
  for (const c of COURSE_SWATCHES)
    for (const mode of ["light", "dark"] as const)
      for (const bg of SURFACES[mode]) assert.ok(contrast(c, bg) >= 3, `${c} on ${bg}: ${contrast(c, bg).toFixed(2)}`);
});

test("theme resolution", () => {
  assert.equal(resolveMode("system", true), "dark");
  assert.equal(resolveMode("system", false), "light");
  assert.equal(resolveMode("light", true), "light");
});

import { tidyCourse } from "./util.ts";

test("course names: term prefix and section numbers are removed", () => {
  const t = (course_code: string, name: string) => {
    const c = tidyCourse({ course_code, name });
    return [c.course_code, c.name];
  };
  assert.deepEqual(t("202609 - Differential Equations - MATH-2860U-001", "202609 - Differential Equations - MATH-2860U-001"), ["MATH 2860U", "Differential Equations"]);
  assert.deepEqual(t("202609 - Statics - MECE-2230U-002", "202609 - Statics - MECE-2230U-002"), ["MECE 2230U", "Statics"]);
  assert.deepEqual(t("MECE-2230U", "202609 - Statics"), ["MECE 2230U", "Statics"]);
  assert.deepEqual(t("202609 - Nuclear Plant Operation (NUCL 2020U)", "202609 - Nuclear Plant Operation (NUCL 2020U)"), ["NUCL 2020U", "Nuclear Plant Operation"]);
  assert.deepEqual(t("MECE 2420U", "Solid Mechanics II"), ["MECE 2420U", "Solid Mechanics II"]);
  // Ontario Tech cross-listed sections and registration numbers.
  assert.deepEqual(t("MATH 2860U", "Differential Equations for Eng 46.202609.XLIST"), ["MATH 2860U", "Differential Equations for Eng"]);
  assert.deepEqual(t("MECE 2230U", "Statics 09.202609.XLIST"), ["MECE 2230U", "Statics"]);
  assert.deepEqual(t("Nuclear Plant Operation - 44162", "Nuclear Plant Operation - 44162"), ["Nuclear Plant Operation", "Nuclear Plant Operation"]);
  assert.deepEqual(t("Structure & Prop. of Materials - 43380", "Structure & Prop. of Materials - 43380"), ["Structure & Prop. of Materials", "Structure & Prop. of Materials"]);
  assert.deepEqual(t("FEAS - Upper Year Academic Advising", "FEAS - Upper Year Academic Advising"), ["FEAS - Upper Year Academic Advising", "FEAS - Upper Year Academic Advising"]);
  // Not a course code: kept as is.
  assert.deepEqual(t("AI-Students", "Academic Integrity Modules for Students"), ["AI-Students", "Academic Integrity Modules for Students"]);
  assert.deepEqual(t("202609 - Prof Competencies", "202609 - Prof Competencies"), ["Prof Competencies", "Prof Competencies"]);
  assert.equal(tidyCourse({ course_code: "x", name: "202609 - Statics - MECE-2230U" }).full_name, "202609 - Statics - MECE-2230U");
  // Rail labels after tidying no longer all read "2026".
  const r = railLabels([
    tidyCourse({ id: 1, course_code: "202609 - Statics - MECE-2230U", name: "202609 - Statics - MECE-2230U" }),
    tidyCourse({ id: 2, course_code: "202609 - Thermodynamics - MECE-2320U", name: "202609 - Thermodynamics - MECE-2320U" }),
  ]);
  assert.deepEqual([r.get(1), r.get(2)], ["2230", "2320"]);
  const r2 = railLabels(
    [
      { id: 1, course_code: "Nuclear Plant Operation - 44162", name: "Nuclear Plant Operation - 44162" },
      { id: 2, course_code: "Thermodynamics - 43421", name: "Thermodynamics - 43421" },
      { id: 3, course_code: "MATH 2860U", name: "Differential Equations for Eng 46.202609.XLIST" },
    ].map(tidyCourse),
  );
  assert.deepEqual([r2.get(1), r2.get(2), r2.get(3)], ["NPO", "THER", "2860"]);
});

import { addDays, addMonths, byDay, dayStart, layoutDay, monthGrid, weekStart, type CalItem } from "./calendar.ts";

test("calendar dates: weeks, months, DST-safe days", () => {
  const wed = new Date(2026, 9, 21, 15, 30).getTime(); // Wed Oct 21 2026
  assert.equal(new Date(weekStart(wed)).getDay(), 0);
  assert.equal(new Date(weekStart(wed)).getDate(), 18);
  const g = monthGrid(wed);
  assert.equal(g.length, 42);
  assert.equal(new Date(g[0]).getDate(), 27, "Sun Sep 27 starts the October 2026 grid");
  // Adding days across the November DST change keeps local midnight.
  const d = addDays(dayStart(new Date(2026, 9, 31).getTime()), 2);
  assert.equal(new Date(d).getHours(), 0);
  assert.equal(new Date(d).getDate(), 2);
  assert.equal(new Date(addMonths(new Date(2026, 0, 31).getTime(), 1)).getDate(), 28);
});

test("calendar grouping and overlap lanes", () => {
  const at = (h: number, m = 0, day = 21) => new Date(2026, 9, day, h, m).getTime();
  const mk = (key: string, start: number, end: number, allDay = false): CalItem =>
    ({ kind: "ext", key, x: {} as never, start, end, allDay, title: key, color: "#000" });
  const items = [
    mk("lecture", at(10), at(11, 20)),
    mk("lab", at(11), at(13)),
    mk("trip", dayStart(at(0, 0, 20)), dayStart(at(0, 0, 23)), true), // Tue-Thu all day
    mk("deadline", at(23, 59), at(23, 59)), // zero length
  ];
  const m = byDay(items, dayStart(at(0, 0, 18)), dayStart(at(0, 0, 25)));
  assert.deepEqual(m.get(dayStart(at(0)))?.map((i) => i.key), ["trip", "lecture", "lab", "deadline"]);
  assert.equal(m.get(dayStart(at(0, 0, 23))), undefined, "all-day end is exclusive");
  assert.ok(m.get(dayStart(at(0, 0, 20)))?.some((i) => i.key === "trip"));
  const lanes = layoutDay([{ start: at(10), end: at(11, 20) }, { start: at(11), end: at(13) }, { start: at(14), end: at(15) }]);
  assert.deepEqual(lanes.map((p) => [p.lane, p.lanes]), [[0, 2], [1, 2], [0, 1]]);
});
