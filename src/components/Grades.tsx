// Grades: Canvas-equivalent calculation with weights and drop rules, what-if
// scores, the range you can still finish in, and "what do I need".

import { ChevronDown, ChevronRight, EyeOff, RotateCcw, Target } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { courseGrade, gradeRange, isHidden, LETTERS, letterOf, needOn, needOnAllRemaining, remaining, type Group, type Need, type WhatIf } from "../lib/grades.ts";
import { visibleCourses } from "../lib/derive.ts";
import { navigate, setState, useStore } from "../lib/store.ts";
import { fmtNum } from "../lib/time.ts";
import type { Assignment, Course } from "../lib/types.ts";
import { courseColor, currentScore, plural } from "../lib/util.ts";
import { Empty, Notice, Spinner } from "./common.tsx";

const pct = (p: number | null | undefined, digits = 1) => (p == null ? "–" : `${(Math.round(p * 10 ** digits) / 10 ** digits).toFixed(digits)}%`);

/** Groups for a course, fetched if missing. null = still loading (only matters for weighted courses). */
function useGroups(course: Course): Group[] | null {
  const groups = useStore((s) => s.groups[course.id]);
  useEffect(() => {
    if (groups) return;
    api
      .gradeGroups([course.id])
      .then((g) => setState((s) => ({ groups: { ...s.groups, [course.id]: g[0]?.groups ?? [] } })))
      .catch(() => setState((s) => ({ groups: { ...s.groups, [course.id]: [] } })));
  }, [course.id, groups]);
  return groups ?? null;
}

// ------------------------------------------------------------------ per course

export function CourseGrades({ course, onOpen }: { course: Course; onOpen: (assignmentId: number) => void }) {
  const all = useStore((s) => s.dash?.assignments);
  const list = useMemo(() => (all ?? []).filter((a) => a.course_id === course.id), [all, course.id]);
  const groupsRaw = useGroups(course);
  const weighted = !!course.apply_assignment_group_weights;
  const [whatIf, setWhatIf] = useState<WhatIf>(new Map());
  const [target, setTarget] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(`sd.target.${course.id}`)) || 80;
    } catch {
      return 80;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`sd.target.${course.id}`, String(target));
    } catch {
      /* per-viewer convenience only */
    }
  }, [target, course.id]);

  if (weighted && groupsRaw == null)
    return (
      <div className="panel">
        <Empty title="Loading grade weights…">
          <Spinner />
        </Empty>
      </div>
    );
  const groups = groupsRaw ?? [];
  if (course.hide_final_grades)
    return (
      <div className="panel">
        <Empty title="Grades are hidden in this course">Your instructor has turned off course totals in Canvas, so Studydesk doesn't calculate one either.</Empty>
      </div>
    );

  return <CourseGradesInner course={course} list={list} groups={groups} weighted={weighted} whatIf={whatIf} setWhatIf={setWhatIf} target={target} setTarget={setTarget} onOpen={onOpen} />;
}

function CourseGradesInner({
  course, list, groups, weighted, whatIf, setWhatIf, target, setTarget, onOpen,
}: {
  course: Course; list: Assignment[]; groups: Group[]; weighted: boolean; whatIf: WhatIf; setWhatIf: (w: WhatIf) => void; target: number; setTarget: (n: number) => void; onOpen: (id: number) => void;
}) {
  const res = useMemo(() => courseGrade(list, groups, weighted, whatIf), [list, groups, weighted, whatIf]);
  const actual = useMemo(() => (whatIf.size ? courseGrade(list, groups, weighted) : res), [list, groups, weighted, whatIf, res]);
  const range = useMemo(() => gradeRange(list, groups, weighted, whatIf), [list, groups, weighted, whatIf]);
  const left = useMemo(() => remaining(list, whatIf), [list, whatIf]);
  const canvas = currentScore(course).score;
  const [open, setOpen] = useState<Set<number>>(() => new Set(res.groups.map((g) => g.id)));
  const byId = new Map(list.map((a) => [a.id, a]));
  const differs = canvas != null && actual.percent != null && Math.abs(canvas - actual.percent) >= 0.1;
  const weightSum = groups.reduce((s, g) => s + (g.group_weight ?? 0), 0);

  const setScore = (id: number, v: string) => {
    const w = new Map(whatIf);
    const n = Number(v);
    if (v.trim() === "" || !Number.isFinite(n)) w.delete(id);
    else w.set(id, Math.max(0, n));
    setWhatIf(w);
  };

  return (
    <div className="panel">
      <div className="scroll">
        <div className="panel-body stack grades">
          {/* Summary */}
          <div className="grade-summary">
            <div className="gs-main">
              <div className="gs-big num">{pct(res.percent)}</div>
              <div className="small dim">
                {whatIf.size ? "With your what-if scores" : "Current grade"}
                {res.percent != null && <> · {letterOf(res.percent)}</>} · {plural(res.gradedCount, "graded item")}
              </div>
              {canvas != null && !whatIf.size && (
                <div className={`small ${differs ? "text-warn" : "muted"}`}>
                  Canvas shows {pct(canvas, 2)}
                  {differs ? "" : ": matches"}
                </div>
              )}
            </div>
            <RangeBar min={range.min} max={range.max} current={res.percent} target={target} />
          </div>

          {differs && !whatIf.size && (
            <Notice tone="neutral">
              Canvas and Studydesk differ by {fmtNum(Math.round(Math.abs((canvas as number) - (actual.percent as number)) * 100) / 100)} points. This usually means grades
              you can't see yet, excused work, or a setting Canvas doesn't share with students. Canvas's number is the official one.
            </Notice>
          )}
          {res.hidden > 0 && (
            <Notice tone="info">
              {plural(res.hidden, "grade")} {res.hidden === 1 ? "isn't" : "aren't"} released to you yet. {res.hidden === 1 ? "It's" : "They're"} left out of every number here, never counted as 0.
            </Notice>
          )}
          {weighted && weightSum > 0 && Math.abs(weightSum - 100) > 0.5 && (
            <Notice tone="neutral">The group weights add up to {fmtNum(weightSum)}%, so each is scaled to that total (as Canvas does).</Notice>
          )}

          {/* What do I need */}
          <Need course={course} list={list} groups={groups} weighted={weighted} whatIf={whatIf} target={target} setTarget={setTarget} left={left} />

          {/* Groups */}
          <section>
            <div className="mw-head">
              <span className="section-title">{weighted ? "Weighted groups" : "Assignments (total points)"}</span>
              {whatIf.size > 0 && (
                <button className="btn btn-xs" onClick={() => setWhatIf(new Map())}>
                  <RotateCcw size={12} /> Clear {plural(whatIf.size, "what-if")}
                </button>
              )}
            </div>
            <div className="small muted" style={{ marginBottom: 8 }}>
              Type a score into any row to see what it would do. Nothing is sent to Canvas.
            </div>
            <div className="ggroups">
              {res.groups
                .filter((g) => g.items.length > 0 || (g.weight ?? 0) > 0)
                .map((g) => {
                  const isOpen = open.has(g.id);
                  const rules = groups.find((x) => x.id === g.id)?.rules;
                  const ruleText = [rules?.drop_lowest ? `lowest ${rules.drop_lowest} dropped` : "", rules?.drop_highest ? `highest ${rules.drop_highest} dropped` : ""].filter(Boolean).join(", ");
                  const share = weighted && weightSum > 0 && g.weight ? (g.weight / weightSum) * 100 : null;
                  return (
                    <div key={g.id} className="ggroup">
                      <button
                        className="gg-head"
                        aria-expanded={isOpen}
                        onClick={() => {
                          const n = new Set(open);
                          if (isOpen) n.delete(g.id);
                          else n.add(g.id);
                          setOpen(n);
                        }}
                      >
                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <span className="grow ellipsis">
                          <b>{g.name}</b>
                          {share != null && <span className="muted"> · {fmtNum(Math.round(share * 10) / 10)}% of grade</span>}
                          {ruleText && <span className="muted"> · {ruleText}</span>}
                        </span>
                        <span className="gg-bar" aria-hidden>
                          <span style={{ width: `${Math.min(100, g.percent ?? 0)}%` }} />
                        </span>
                        <span className="num gg-pct">{g.percent == null ? <span className="muted">no grades</span> : pct(g.percent)}</span>
                      </button>
                      {isOpen && (
                        <table className="gtable">
                          <tbody>
                            {g.items.map((it) => {
                              const a = byId.get(it.id);
                              const hidden = a ? isHidden(a) : false;
                              const actualScore = a?.submission?.score;
                              return (
                                <tr key={it.id} className={`${it.dropped ? "dropped" : ""}${it.whatIf ? " whatif" : ""}`}>
                                  <td className="gt-name">
                                    <button className="linkish ellipsis" onClick={() => onOpen(it.id)} title={`Open ${it.name}`}>
                                      {it.name}
                                    </button>
                                    {it.dropped && <span className="chip chip-xs">Dropped</span>}
                                    {hidden && !it.whatIf && (
                                      <span className="chip chip-xs tone-info" title="Graded in Canvas but not released to you">
                                        <EyeOff size={10} /> Not released
                                      </span>
                                    )}
                                    {it.whatIf && <span className="chip chip-xs tone-warn">What-if</span>}
                                  </td>
                                  <td className="gt-score">
                                    <label className="sr" htmlFor={`wi-${it.id}`}>Score for {it.name}</label>
                                    <input
                                      id={`wi-${it.id}`}
                                      className="input input-xs num"
                                      type="number"
                                      min={0}
                                      step={0.5}
                                      placeholder={actualScore != null ? fmtNum(actualScore) : hidden ? "?" : "–"}
                                      value={whatIf.has(it.id) ? String(whatIf.get(it.id)) : ""}
                                      onChange={(e) => setScore(it.id, e.target.value)}
                                    />
                                    <span className="muted num"> / {fmtNum(it.possible)}</span>
                                  </td>
                                  <td className="gt-pct num">{it.score != null && it.possible > 0 ? pct((it.score / it.possible) * 100, 0) : ""}</td>
                                </tr>
                              );
                            })}
                            {g.items.length === 0 && (
                              <tr>
                                <td colSpan={3} className="muted small">Nothing in this group yet.</td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      )}
                    </div>
                  );
                })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/** 0–100 bar: the range you can still finish in, your current grade and your target. */
export function RangeBar({ min, max, current, target, compact = false }: { min: number | null; max: number | null; current: number | null; target?: number; compact?: boolean }) {
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const lo = min == null ? null : clamp(min);
  const hi = max == null ? null : clamp(max);
  const label =
    lo != null && hi != null
      ? `You can still finish between ${pct(min)} and ${pct(max)}${current != null ? `; now ${pct(current)}` : ""}${target != null ? `; target ${target}%` : ""}.`
      : "Not enough grades yet.";
  return (
    <div className={`range-bar${compact ? " compact" : ""}`} role="img" aria-label={label} title={label}>
      <div className="rb-track">
        {LETTERS.filter(([l]) => l >= 50 && !compact).map(([l, name]) => (
          <span key={l} className="rb-tick" style={{ left: `${l}%` }}>
            <span>{name}</span>
          </span>
        ))}
        {lo != null && hi != null && <span className="rb-range" style={{ left: `${lo}%`, width: `${Math.max(0.8, hi - lo)}%` }} />}
        {current != null && <span className="rb-now" style={{ left: `${clamp(current)}%` }} />}
        {target != null && <span className="rb-target" style={{ left: `${clamp(target)}%` }} />}
      </div>
      {!compact && lo != null && hi != null && (
        <div className="rb-legend small">
          <span>
            <i className="lg-range" /> Still possible: {pct(min, 0)} – {pct(max, 0)}
          </span>
          {current != null && (
            <span>
              <i className="lg-now" /> Now
            </span>
          )}
          {target != null && (
            <span>
              <i className="lg-target" /> Target
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Need({ course, list, groups, weighted, whatIf, target, setTarget, left }: { course: Course; list: Assignment[]; groups: Group[]; weighted: boolean; whatIf: WhatIf; target: number; setTarget: (n: number) => void; left: Assignment[] }) {
  const biggest = useMemo(() => [...left].sort((a, b) => (b.points_possible ?? 0) - (a.points_possible ?? 0))[0]?.id ?? null, [left]);
  const [pick, setPick] = useState<number | null>(null);
  const on = pick != null && left.some((a) => a.id === pick) ? pick : biggest;
  const onA = list.find((a) => a.id === on);
  const allNeed = useMemo(() => needOnAllRemaining(list, groups, weighted, whatIf, target), [list, groups, weighted, whatIf, target]);
  const oneNeed = useMemo(() => (on != null ? needOn(list, groups, weighted, whatIf, on, target) : null), [list, groups, weighted, whatIf, on, target]);
  const leftPts = left.reduce((s, a) => s + (a.points_possible ?? 0), 0);

  return (
    <section className="need">
      <div className="mw-head">
        <span className="section-title">
          <Target size={12} style={{ verticalAlign: -1 }} /> What do I need?
        </span>
      </div>
      <div className="row-flex" style={{ flexWrap: "wrap" }}>
        <label htmlFor={`target-${course.id}`} className="small dim">To finish with</label>
        <input id={`target-${course.id}`} className="input input-sm num" type="number" min={1} max={150} step={1} style={{ width: 70 }} value={target} onChange={(e) => setTarget(Math.max(1, Math.min(150, Number(e.target.value) || 0)))} />
        <span className="small dim">%</span>
        <div className="seg" aria-label="Letter grade targets">
          {LETTERS.filter(([l]) => l >= 50 && [90, 85, 80, 73, 70, 60, 50].includes(l)).map(([l, n]) => (
            <button key={l} className={target === l ? "active" : ""} onClick={() => setTarget(l)} title={`${n}: ${l}% or higher`}>
              {n}
            </button>
          ))}
        </div>
      </div>
      {left.length === 0 ? (
        <div className="small muted">Nothing left to grade{whatIf.size ? " (counting your what-ifs)" : ""}.</div>
      ) : (
        <div className="need-grid">
          <div className="need-card">
            <div className="small muted">
              On everything left ({plural(left.length, "item")}, {fmtNum(leftPts)} pts)
            </div>
            <NeedText n={allNeed} avg />
          </div>
          <div className="need-card">
            <div className="small muted row-flex" style={{ gap: 6 }}>
              <label htmlFor={`need-on-${course.id}`}>On</label>
              <select id={`need-on-${course.id}`} className="select input-xs" style={{ width: "auto", maxWidth: "100%", flex: 1, minWidth: 0 }} value={on ?? ""} onChange={(e) => setPick(Number(e.target.value))}>
                {left.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({fmtNum(a.points_possible ?? 0)} pts)
                  </option>
                ))}
              </select>
            </div>
            {oneNeed && <NeedText n={oneNeed} possible={onA?.points_possible ?? 0} />}
            <div className="small muted">Other ungraded work is left out unless you type what-if scores below.</div>
          </div>
        </div>
      )}
    </section>
  );
}

function NeedText({ n, avg = false, possible = 0 }: { n: Need; avg?: boolean; possible?: number }) {
  if (n.kind === "already") return <div className="need-big text-ok">Already there. Even 0 keeps you at the target.</div>;
  if (n.kind === "impossible")
    return (
      <div className="need-big text-danger">
        Not reachable{n.best != null ? `: full marks gets you ${pct(n.best)}` : ""}.
      </div>
    );
  const hard = n.percent > 100;
  return (
    <div className={`need-big ${hard ? "text-danger" : n.percent >= 85 ? "text-warn" : ""}`}>
      {avg ? (
        <>
          Average <b className="num">{pct(n.percent)}</b>
        </>
      ) : (
        <>
          <b className="num">{fmtNum(n.points)}</b> / {fmtNum(possible)} <span className="num">({pct(n.percent)})</span>
        </>
      )}
      {hard && <span className="small"> · more than full marks, so only with bonus marks</span>}
    </div>
  );
}

// ------------------------------------------------------------------ overview

export function GradesOverview() {
  const dash = useStore((s) => s.dash);
  const groups = useStore((s) => s.groups);
  const courses = visibleCourses(dash);
  const rows = useMemo(
    () =>
      courses.map((c) => {
        const list = (dash?.assignments ?? []).filter((a) => a.course_id === c.id);
        const weighted = !!c.apply_assignment_group_weights;
        const g = groups[c.id];
        const ready = !weighted || g != null;
        const res = ready ? courseGrade(list, g ?? [], weighted) : null;
        const range = ready ? gradeRange(list, g ?? [], weighted) : null;
        return { c, res, range, canvas: currentScore(c).score, left: remaining(list).length };
      }),
    [courses, dash, groups],
  );

  return (
    <>
      <header className="topbar">
        <h1>Grades</h1>
      </header>
      <div className="content pad">
        <div className="stack" style={{ maxWidth: 980 }}>
          <p className="small dim" style={{ margin: 0 }}>
            Calculated the way Canvas does it (weights, dropped grades, excused work). Grades that aren't released yet are left out, never counted as 0. The bar shows the range you can still finish in.
          </p>
          <div className="panel">
            <div className="list">
              {rows.length === 0 && <Empty title="No courses">Courses you show in Settings appear here.</Empty>}
              {rows.map(({ c, res, range, canvas, left }) => (
                <button key={c.id} className="lrow grade-row" onClick={() => navigate({ view: "course", courseId: c.id, tab: "grades" })}>
                  <span className="dot" style={{ background: courseColor(c) }} />
                  <span style={{ minWidth: 0 }}>
                    <span className="lr-title ellipsis" style={{ display: "block" }}>{c.course_code || c.name}</span>
                    <span className="lr-meta">
                      <span className="ellipsis">{c.name}</span>
                      {res && res.hidden > 0 && <span>{res.hidden} not released</span>}
                      <span>{left} left to grade</span>
                    </span>
                  </span>
                  {c.hide_final_grades ? (
                    <span className="small muted">Hidden by instructor</span>
                  ) : res == null ? (
                    <Spinner />
                  ) : (
                    <>
                      <RangeBar min={range?.min ?? null} max={range?.max ?? null} current={res.percent} compact />
                      <span className="gr-num">
                        <b className="num">{pct(res.percent ?? canvas)}</b>
                        <span className="small muted">{res.percent != null ? letterOf(res.percent) : canvas != null ? "from Canvas" : "no grades yet"}</span>
                        {canvas != null && Math.abs(canvas - (res.percent ?? canvas)) >= 0.1 && <span className="small text-warn" title="Canvas's own number">Canvas {pct(canvas)}</span>}
                      </span>
                    </>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
