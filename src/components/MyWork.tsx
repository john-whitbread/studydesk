// "My work" on an assignment: requirements checklist, rubric self-check,
// hours estimate and notes. Everything is saved in the vault (encrypted).

import { Clock, ListChecks, Plus, RotateCcw, StickyNote, Target, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { descHash, mergeChecklist, requirementsFrom } from "../lib/checklist.ts";
import { fmtHours, hoursFor, KINDS } from "../lib/effort.ts";
import { worth } from "../lib/grades.ts";
import { fmtHm, nextOh } from "../lib/officehours.ts";
import { putWork, useStore } from "../lib/store.ts";
import { fmtNum, fmtWhen } from "../lib/time.ts";
import type { Assignment, CheckItem, Course, WorkItem } from "../lib/types.ts";

export const MAX_NOTES = 20_000;
export const workKey = (courseId: number, assignmentId: number) => `${courseId}:${assignmentId}`;
export const emptyWork = (): WorkItem => ({ checklist: [], rubric: {}, notes: "", hours: null, descHash: "", updated: 0 });

/** What's left before submitting: unticked requirements and rubric criteria you started checking. */
export function unticked(a: Assignment, w: WorkItem | undefined): { left: number; total: number; what: string } {
  if (!w) return { left: 0, total: 0, what: "" };
  const cl = w.checklist;
  const usedRubric = Object.keys(w.rubric).length > 0 && a.rubric.length > 0;
  const total = cl.length + (usedRubric ? a.rubric.length : 0);
  const left = cl.filter((c) => !c.done).length + (usedRubric ? a.rubric.filter((r) => !w.rubric[r.id]?.done).length : 0);
  const what = usedRubric && cl.length ? "requirements and rubric criteria" : usedRubric ? "rubric criteria" : "requirements";
  return { left, total, what };
}

export function MyWork({ a, course, now, described }: { a: Assignment; course: Course; now: number; described: boolean }) {
  const key = workKey(a.course_id, a.id);
  const stored = useStore((s) => s.work[key]);
  const prefs = useStore((s) => s.workPrefs);
  const groups = useStore((s) => s.groups[course.id]);
  const all = useStore((s) => s.dash?.assignments);
  const officeHours = useStore((s) => s.officeHours);
  const w = stored ?? emptyWork();
  const save = (patch: Partial<WorkItem>, delay?: number) => putWork(key, { ...w, ...patch }, delay);

  // Build / refresh the checklist from the instructions once both are loaded.
  useEffect(() => {
    if (!described || !prefs) return;
    const h = descHash(a.description);
    if (stored && stored.descHash === h) return;
    const fresh = requirementsFrom(a.description);
    if (!stored && fresh.length === 0) return; // nothing to save yet
    const first = !stored || stored.descHash === "";
    const checklist = mergeChecklist(stored?.checklist ?? [], fresh, first);
    putWork(key, { ...(stored ?? emptyWork()), checklist, descHash: h }, 0);
  }, [described, prefs, a.description, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const hrs = hoursFor(a, w.hours, prefs?.estimates ?? {});
  const kindLabel = KINDS.find((k) => k[0] === hrs.kind)?.[1] ?? "Other";
  const pct = useMemo(() => {
    const list = (all ?? []).filter((x) => x.course_id === course.id);
    return worth(a, list.length ? list : [a], groups ?? [], !!course.apply_assignment_group_weights);
  }, [a, all, groups, course.id, course.apply_assignment_group_weights]);
  const oh = useMemo(() => nextOh(officeHours.filter((o) => o.courseId === course.id), now), [officeHours, course.id, now]);
  const done = w.checklist.filter((c) => c.done).length;
  const fresh = w.checklist.filter((c) => c.new).length;

  return (
    <section className="mywork" aria-label="My work">
      <div className="mw-summary">
        <HoursChip est={hrs.hours} custom={hrs.custom} kind={kindLabel} onChange={(h) => save({ hours: h }, 0)} />
        {pct != null && (
          <span className="mw-fact" title="How much of your course grade this is worth">
            <Target size={14} /> {pct >= 10 ? Math.round(pct) : fmtNum(Math.round(pct * 10) / 10)}% of the course
          </span>
        )}
        {w.checklist.length > 0 && (
          <span className="mw-fact" title="Requirements ticked">
            <ListChecks size={14} /> {done} of {w.checklist.length} done
          </span>
        )}
        {oh && (
          <span className="mw-fact" title={[oh.oh.who, oh.oh.location].filter(Boolean).join(" · ")}>
            <Users size={14} /> Office hours {oh.start <= now ? "now" : fmtWhen(oh.start, now)}
            {oh.start <= now ? ` until ${fmtHm(oh.oh.end)}` : ""}
          </span>
        )}
      </div>

      <Checklist
        items={w.checklist}
        freshCount={fresh}
        onChange={(checklist) => save({ checklist }, 300)}
        onRescan={() => {
          const checklist = mergeChecklist(w.checklist, requirementsFrom(a.description), false).map((c) => ({ ...c, new: false }));
          save({ checklist, descHash: descHash(a.description) }, 0);
        }}
        canRescan={described && !!a.description}
      />

      {a.rubric.length > 0 && <RubricCheck a={a} w={w} onChange={(rubric) => save({ rubric }, 300)} />}

      <Notes value={w.notes} onChange={(notes) => save({ notes })} />
    </section>
  );
}

function HoursChip({ est, custom, kind, onChange }: { est: number; custom: boolean; kind: string; onChange: (h: number | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (editing)
    return (
      <form
        className="mw-fact"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(draft);
          onChange(Number.isFinite(n) && n > 0 ? Math.min(200, Math.round(n * 4) / 4) : null);
          setEditing(false);
        }}
      >
        <Clock size={14} />
        <label className="sr" htmlFor="mw-hours">Hours this will take</label>
        <input id="mw-hours" className="input input-xs num" type="number" min={0.25} max={200} step={0.5} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={(e) => e.currentTarget.form?.requestSubmit()} onKeyDown={(e) => e.key === "Escape" && setEditing(false)} style={{ width: 64 }} />
        <span className="small muted">hours</span>
      </form>
    );
  return (
    <span className="mw-fact">
      <button className="linkish" onClick={() => { setDraft(String(est)); setEditing(true); }} title={custom ? "Your estimate. Click to change." : `Typical for: ${kind}. Click to set your own.`}>
        <Clock size={14} /> About {fmtHours(est)}
        {!custom && <span className="muted"> · estimate</span>}
      </button>
      {custom && (
        <button className="icon-btn xs" onClick={() => onChange(null)} aria-label="Use the default estimate" title="Use the default estimate">
          <RotateCcw size={12} />
        </button>
      )}
    </span>
  );
}

function Checklist({ items, freshCount, onChange, onRescan, canRescan }: { items: CheckItem[]; freshCount: number; onChange: (c: CheckItem[]) => void; onRescan: () => void; canRescan: boolean }) {
  const [adding, setAdding] = useState("");
  const [edit, setEdit] = useState<number | null>(null);
  const set = (i: number, patch: Partial<CheckItem>) => onChange(items.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const done = items.filter((c) => c.done).length;
  return (
    <div className="mw-block">
      <div className="mw-head">
        <span className="section-title">Requirements</span>
        {items.length > 0 && (
          <div className="mini-bar" role="progressbar" aria-label="Requirements done" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done}>
            <div style={{ width: `${(done / items.length) * 100}%` }} />
          </div>
        )}
        {canRescan && (
          <button className="btn btn-xs btn-ghost" onClick={onRescan} title="Read the instructions again for requirements">
            <RotateCcw size={12} /> Re-read
          </button>
        )}
      </div>
      {freshCount > 0 && (
        <div className="notice info">
          <span>
            The instructions changed: <b>{freshCount} new</b> {freshCount === 1 ? "item is" : "items are"} marked below.
          </span>
          <button className="btn btn-xs" style={{ marginLeft: "auto" }} onClick={() => onChange(items.map((c) => ({ ...c, new: false })))}>
            Got it
          </button>
        </div>
      )}
      {items.length === 0 && <div className="small muted">No list found in the instructions. Add your own below.</div>}
      <ul className="checklist">
        {items.map((c, i) => (
          <li key={i} className={c.done ? "done" : ""}>
            <input type="checkbox" id={`ck-${i}`} checked={c.done} onChange={(e) => set(i, { done: e.target.checked, new: false })} />
            {edit === i ? (
              <input
                className="input input-xs grow"
                autoFocus
                defaultValue={c.text}
                aria-label="Edit requirement"
                maxLength={300}
                onBlur={(e) => {
                  const t = e.target.value.trim();
                  setEdit(null);
                  if (t && t !== c.text) set(i, { text: t, auto: false });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEdit(null);
                }}
              />
            ) : (
              <label htmlFor={`ck-${i}`} className="grow selectable" onDoubleClick={() => setEdit(i)}>
                {c.text}
                {c.new && <span className="chip tone-info chip-xs">New</span>}
              </label>
            )}
            <button className="icon-btn xs hover-only" onClick={() => setEdit(i)} aria-label={`Edit: ${c.text}`} title="Edit">
              ✎
            </button>
            <button className="icon-btn xs hover-only" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`Remove: ${c.text}`} title="Remove">
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="row-flex"
        onSubmit={(e) => {
          e.preventDefault();
          const t = adding.trim();
          if (!t || items.length >= 60) return;
          onChange([...items, { text: t.slice(0, 300), done: false, auto: false, new: false }]);
          setAdding("");
        }}
      >
        <label className="sr" htmlFor="ck-add">Add a requirement</label>
        <input id="ck-add" className="input input-sm grow" placeholder="Add your own item" value={adding} onChange={(e) => setAdding(e.target.value)} maxLength={300} />
        <button className="btn btn-sm" disabled={!adding.trim()}>
          <Plus size={14} /> Add
        </button>
      </form>
    </div>
  );
}

function RubricCheck({ a, w, onChange }: { a: Assignment; w: WorkItem; onChange: (r: WorkItem["rubric"]) => void }) {
  const total = a.rubric.reduce((s, r) => s + (r.points ?? 0), 0);
  const scored = a.rubric.filter((r) => w.rubric[r.id]?.score != null);
  const self = scored.reduce((s, r) => s + (w.rubric[r.id]?.score ?? 0), 0);
  const selfMax = scored.reduce((s, r) => s + (r.points ?? 0), 0);
  const set = (id: string, patch: Partial<{ done: boolean; score: number | null }>) => {
    const cur = w.rubric[id] ?? { done: false, score: null };
    onChange({ ...w.rubric, [id]: { ...cur, ...patch } });
  };
  return (
    <div className="mw-block">
      <div className="mw-head">
        <span className="section-title">Rubric self-check</span>
        {scored.length > 0 && (
          <span className="small dim num" title="Your own estimate from the scores you entered">
            You'd give yourself {fmtNum(self)} / {fmtNum(selfMax)}
            {selfMax > 0 ? ` (${Math.round((self / selfMax) * 100)}%)` : ""}
            {selfMax < total ? <span className="muted"> · {scored.length} of {a.rubric.length} scored</span> : null}
          </span>
        )}
      </div>
      <ul className="checklist rubric-check">
        {a.rubric.map((r) => {
          const c = w.rubric[r.id];
          const top = r.ratings[0]?.description;
          return (
            <li key={r.id} className={c?.done ? "done" : ""}>
              <input type="checkbox" id={`rb-${r.id}`} checked={!!c?.done} onChange={(e) => set(r.id, { done: e.target.checked })} />
              <label htmlFor={`rb-${r.id}`} className="grow">
                <span>{r.description}</span>
                {(r.long_description || top) && <span className="small muted" style={{ display: "block" }}>{r.long_description || `Full marks: ${top}`}</span>}
              </label>
              <span className="row-flex" style={{ gap: 4, flex: "none" }}>
                <label className="sr" htmlFor={`rbs-${r.id}`}>Your score for {r.description}</label>
                <input
                  id={`rbs-${r.id}`}
                  className="input input-xs num"
                  type="number"
                  min={0}
                  max={r.points ?? undefined}
                  step={0.5}
                  placeholder="–"
                  style={{ width: 52 }}
                  value={c?.score ?? ""}
                  onChange={(e) => {
                    const v = e.target.value === "" ? null : Math.max(0, Math.min(Number(e.target.value), r.points ?? Infinity));
                    set(r.id, { score: v != null && Number.isFinite(v) ? v : null });
                  }}
                />
                <span className="small muted num">/ {fmtNum(r.points ?? 0)}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Notes({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [saved, setSaved] = useState(true);
  const focused = useRef(false);
  // Follows outside changes (another assignment, a reload) unless you're typing.
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  useEffect(() => {
    if (saved) return;
    const t = setTimeout(() => setSaved(true), 800);
    return () => clearTimeout(t);
  }, [saved, text]);
  const near = text.length > MAX_NOTES * 0.9;
  return (
    <div className="mw-block">
      <div className="mw-head">
        <label className="section-title" htmlFor="mw-notes">
          <StickyNote size={12} style={{ verticalAlign: -1 }} /> Notes
        </label>
        <span className={`small num ${near ? "text-warn" : "muted"}`} aria-live="polite">
          {saved ? (text ? "Saved" : "") : "Saving…"}
          {near ? ` · ${text.length.toLocaleString()} / ${MAX_NOTES.toLocaleString()}` : ""}
        </span>
      </div>
      <textarea
        id="mw-notes"
        className="textarea"
        rows={4}
        maxLength={MAX_NOTES}
        placeholder="Your notes: what the TA said, where you left off, formulas to remember. Searchable with Ctrl K."
        value={text}
        onFocus={() => (focused.current = true)}
        onBlur={() => (focused.current = false)}
        onChange={(e) => {
          const v = e.target.value.slice(0, MAX_NOTES);
          setText(v);
          setSaved(false);
          onChange(v);
        }}
      />
    </div>
  );
}
