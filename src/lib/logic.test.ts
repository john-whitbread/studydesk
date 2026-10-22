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

import { courseGrade, keepBest, needOn, needOnAllRemaining, worth, type Group } from "./grades.ts";
import type { Assignment as A2 } from "./types.ts";

function ga(id: number, group: number, possible: number, score: number | null, extra: Partial<A2> = {}): A2 {
  return {
    id, course_id: 1, name: `A${id}`, points_possible: possible, submission_types: ["online_upload"], allowed_extensions: [], rubric: [], assignment_group_id: group,
    submission: score == null ? { workflow_state: "unsubmitted", attachments: [], submission_comments: [] } : { score, workflow_state: "graded", attachments: [], submission_comments: [] },
    ...extra,
  } as A2;
}
const close = (a: number | null, b: number, msg = "") => assert.ok(a != null && Math.abs(a - b) < 1e-6, `${msg} expected ${b}, got ${a}`);

test("grades: unweighted current and final", () => {
  const list = [ga(1, 10, 20, 18), ga(2, 10, 10, 7), ga(3, 10, 20, null)];
  const g: Group[] = [{ id: 10, name: "All" }];
  close(courseGrade(list, g, false).percent, (25 / 30) * 100, "current");
  close(courseGrade(list, g, false, new Map(), true).percent, 50, "final: ungraded = 0");
});

test("grades: weighted, empty groups don't count against you, then do once graded", () => {
  const g: Group[] = [{ id: 1, name: "Labs", group_weight: 30 }, { id: 2, name: "Exams", group_weight: 70 }];
  const list = [ga(1, 1, 10, 8), ga(2, 1, 10, 9), ga(3, 2, 100, null)];
  close(courseGrade(list, g, true).percent, 85);
  list[2] = ga(3, 2, 100, 70);
  close(courseGrade(list, g, true).percent, 0.3 * 85 + 0.7 * 70);
});

test("grades: drop lowest picks the best set, not the lowest percentage", () => {
  // 1/2 and 10/20 are both 50%; dropping 10/20 leaves 19/22 = 86.36%, dropping 1/2 leaves 28/40 = 70%.
  const list = [ga(1, 1, 2, 1), ga(2, 1, 20, 10), ga(3, 1, 20, 18)];
  const g: Group[] = [{ id: 1, name: "Quizzes", rules: { drop_lowest: 1 } }];
  const r = courseGrade(list, g, false);
  close(r.percent, (19 / 22) * 100);
  assert.deepEqual(r.groups[0].items.filter((i) => i.dropped).map((i) => i.id), [2]);
  // never_drop on the 10/20 forces dropping the 1/2.
  close(courseGrade(list, [{ ...g[0], rules: { drop_lowest: 1, never_drop: [2] } }], false).percent, 70);
  // Drop highest removes the best.
  close(courseGrade([ga(1, 1, 10, 5), ga(2, 1, 10, 9), ga(3, 1, 10, 10)], [{ id: 1, name: "Q", rules: { drop_highest: 1 } }], false).percent, 70);
  // Never drops everything.
  close(courseGrade([ga(1, 1, 10, 5)], [{ id: 1, name: "Q", rules: { drop_lowest: 3 } }], false).percent, 50);
  // keepBest agrees with brute force on random data.
  for (let t = 0; t < 200; t++) {
    const pool = Array.from({ length: 6 }, () => ({ possible: 1 + Math.floor(Math.random() * 20), score: 0 }));
    pool.forEach((p) => (p.score = Math.round(Math.random() * p.possible * 10) / 10));
    const keep = 1 + Math.floor(Math.random() * 5);
    const got = keepBest(pool, [], keep, true);
    let bestR = -1;
    for (let m = 0; m < 1 << pool.length; m++) {
      const sub = pool.filter((_, i) => m & (1 << i));
      if (sub.length !== keep) continue;
      const p = sub.reduce((a, x) => a + x.possible, 0);
      bestR = Math.max(bestR, sub.reduce((a, x) => a + x.score, 0) / p);
    }
    const gp = got.reduce((a, x) => a + x.possible, 0);
    assert.ok(Math.abs(got.reduce((a, x) => a + x.score, 0) / gp - bestR) < 1e-9, "keepBest is optimal");
  }
});

test("grades: excused, omitted, hidden and extra credit", () => {
  const g: Group[] = [{ id: 1, name: "All" }];
  const excused = ga(2, 1, 50, null, { submission: { excused: true, attachments: [], submission_comments: [] } });
  const omitted = ga(3, 1, 50, 0, { omit_from_final_grade: true });
  const hidden = ga(4, 1, 50, null, { submission: { workflow_state: "graded", score: null, attachments: [], submission_comments: [] } });
  const bonus = ga(5, 1, 0, 2);
  const r = courseGrade([ga(1, 1, 20, 16), excused, omitted, hidden, bonus], g, false);
  close(r.percent, (18 / 20) * 100);
  assert.equal(r.hidden, 1);
  close(courseGrade([ga(1, 1, 20, 16), hidden], g, false, new Map(), true).percent, 80, "hidden stays unknown in final");
});

test("grades: what-if and what do I need", () => {
  const g: Group[] = [{ id: 1, name: "All" }];
  const list = [ga(1, 1, 50, 40), ga(2, 1, 50, null)];
  close(courseGrade(list, g, false, new Map([[2, 45]])).percent, 85);
  const n = needOn(list, g, false, new Map(), 2, 85);
  assert.equal(n.kind, "need");
  if (n.kind === "need") close(n.points, 45);
  const n50 = needOn(list, g, false, new Map(), 2, 50);
  assert.ok(n50.kind === "need" && Math.abs(n50.points - 10) < 1e-6, "40 + x = 50 of 100");
  assert.equal(needOn([ga(1, 1, 50, 50), ga(2, 1, 50, null)], g, false, new Map(), 2, 50).kind, "already");
  const imp = needOn(list, g, false, new Map(), 2, 200);
  assert.equal(imp.kind, "impossible");
  // Same % on everything left: 40/50 done, two 25-pt items left, target 70% → (40 + 50r)/100 = 0.7 → r = 60%.
  const three = [ga(1, 1, 50, 40), ga(2, 1, 25, null), ga(3, 1, 25, null)];
  const all = needOnAllRemaining(three, g, false, new Map(), 70);
  assert.ok(all.kind === "need" && Math.abs(all.percent - 60) < 0.01, JSON.stringify(all));
  // Weighted: a 10-pt lab in a 30% group of 20 pts = 15% of the course.
  const wg: Group[] = [{ id: 1, name: "Labs", group_weight: 30 }, { id: 2, name: "Exams", group_weight: 70 }];
  close(worth(ga(1, 1, 10, null), [ga(1, 1, 10, null), ga(2, 1, 10, null), ga(3, 2, 100, null)], wg, true), 15);
  close(worth(ga(1, 1, 10, null), [ga(1, 1, 10, null), ga(2, 1, 30, null)], g, false), 25);
});

import { kindOf, defaultHours } from "./effort.ts";
import { requirementsFrom, mergeChecklist, descHash } from "./checklist.ts";
import { loadByDay, collisions } from "./workload.ts";

test("effort kinds match the Rust side", () => {
  const k = (n: string) => kindOf(n, ["online_upload"], false);
  assert.equal(k("Lab 3 – Thick-walled cylinders"), "lab");
  assert.equal(k("Problem Set 6 – Torsion"), "problem_set");
  assert.equal(k("PS6"), "problem_set");
  assert.equal(k("Final project report"), "project");
  assert.equal(k("Reflection – CANDU site visit"), "short");
  assert.equal(k("Midterm exam"), "exam");
  assert.equal(k("Collaboration"), "other");
  assert.equal(kindOf("Week 7", ["online_quiz"], false), "quiz");
  assert.equal(defaultHours("lab"), 4);
  assert.equal(defaultHours("lab", { lab: 6 }), 6);
});

test("checklist from descriptions", () => {
  assert.deepEqual(
    requirementsFrom("<p>Submit one PDF containing:</p><ol><li>Free-body diagram and assumptions</li><li>Radial and hoop stress plots</li><li>FEA comparison, with % difference</li></ol>"),
    ["Free-body diagram and assumptions", "Radial and hoop stress plots", "FEA comparison, with % difference"],
  );
  assert.deepEqual(requirementsFrom("<p>1. Title page<br>2. Abstract (150 words)<br>3) Results</p>"), ["Title page", "Abstract (150 words)", "Results"]);
  assert.deepEqual(requirementsFrom("<p>Your report must include a free-body diagram. Late penalty is 10%. Make sure units are labelled on every plot.</p>"), [
    "Your report must include a free-body diagram",
    "Make sure units are labelled on every plot",
  ]);
  assert.deepEqual(requirementsFrom("<p>Read chapter 4.</p>"), []);
  // Description edited: tick follows the item, new item flagged, your own item kept.
  const before = [
    { text: "Free-body diagram", done: true, auto: true, new: false },
    { text: "Stress plots", done: false, auto: true, new: false },
    { text: "Ask TA about units", done: false, auto: false, new: false },
  ];
  const after = mergeChecklist(before, ["Free-body diagram (labelled)", "Stress plots", "Error analysis"], false);
  assert.deepEqual(after.map((i) => [i.text, i.done, i.new]), [
    ["Free-body diagram (labelled)", true, false],
    ["Stress plots", false, false],
    ["Error analysis", false, true],
    ["Ask TA about units", false, false],
  ]);
  assert.notEqual(descHash("<p>a</p>"), descHash("<p>b</p>"));
  assert.equal(descHash("<p>a</p>"), descHash("<div>a</div>"));
});

test("workload by hours and collisions", () => {
  const day = (d: number, h = 23) => new Date(2026, 9, d, h, 59).getTime();
  const items = [
    { key: "a", title: "Lab 3", due: day(22), hours: 4, open: true },
    { key: "b", title: "PS 6", due: day(22, 17), hours: 3, open: true },
    { key: "c", title: "Reflection", due: day(22, 9), hours: 1, open: true },
    { key: "d", title: "Done thing", due: day(22), hours: 9, open: false },
    { key: "e", title: "Midterm", due: day(24, 10), hours: 8, open: true, exam: true },
    { key: "f", title: "Report", due: day(23), hours: 8, open: true },
  ];
  const load = loadByDay(items, new Date(2026, 9, 21).getTime(), 5);
  assert.deepEqual(load.map((d) => [d.hours, d.count, d.level]), [[0, 0, "none"], [8, 3, "heavy"], [8, 1, "heavy"], [8, 1, "heavy"], [0, 0, "none"]]);
  const c = collisions(load, items);
  assert.equal(c.length, 3);
  assert.match(c[0].text, /3 due, about 8 h/);
});

test("grade range and remaining", async () => {
  const { gradeRange, remaining, letterOf } = await import("./grades.ts");
  const A = (id: number, score: number | null, pts: number): import("./types.ts").Assignment => ({
    id, course_id: 1, name: `a${id}`, submission_types: [], allowed_extensions: [], rubric: [], points_possible: pts,
    submission: score == null ? null : { score, workflow_state: "graded", attachments: [], submission_comments: [] },
  });
  const list = [A(1, 40, 50), A(2, null, 50)];
  assert.deepEqual(remaining(list).map((a) => a.id), [2]);
  const r = gradeRange(list, [], false);
  assert.equal(r.min, 40);
  assert.equal(r.max, 90);
  assert.equal(letterOf(84.99), "A-");
  assert.equal(letterOf(85), "A");
  assert.equal(letterOf(49.5), "F");
});
