// Office hours: found in syllabi, home pages and announcements, confirmed by you.
// Confirmed ones show on Today, the calendar and each assignment.

import { Check, Pencil, Plus, Trash2, Users, X } from "lucide-react";
import { useState } from "react";
import { DAY_NAMES, fmtHm, ohDays } from "../lib/officehours.ts";
import { removeOfficeHours, saveOfficeHours, setState, useStore } from "../lib/store.ts";
import type { OfficeHours } from "../lib/types.ts";
import { courseColor, plural } from "../lib/util.ts";
import { api } from "../lib/api.ts";

function Editor({ initial, courses, onDone }: { initial: OfficeHours; courses: { id: number; label: string }[]; onDone: () => void }) {
  const [o, setO] = useState(initial);
  const [busy, setBusy] = useState(false);
  const valid = o.days.length > 0 && /^\d{2}:\d{2}$/.test(o.start) && /^\d{2}:\d{2}$/.test(o.end) && o.end > o.start;
  const save = async () => {
    setBusy(true);
    const ok = await saveOfficeHours({ ...o, id: o.id || `oh${Date.now().toString(36)}`, location: o.location?.trim() || null, who: o.who?.trim() || null });
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <div className="oh-edit">
      <div className="field">
        <span className="small dim" id="oh-days-l">Days</span>
        <div className="seg" role="group" aria-labelledby="oh-days-l">
          {DAY_NAMES.map((d, i) => (
            <button
              key={d}
              aria-pressed={o.days.includes(i)}
              className={o.days.includes(i) ? "active" : ""}
              onClick={() => setO({ ...o, days: o.days.includes(i) ? o.days.filter((x) => x !== i) : [...o.days, i].sort() })}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      <div className="row-flex" style={{ flexWrap: "wrap" }}>
        <label className="field">
          <span className="small dim">From</span>
          <input className="input input-sm" type="time" value={o.start} onChange={(e) => setO({ ...o, start: e.target.value })} />
        </label>
        <label className="field">
          <span className="small dim">To</span>
          <input className="input input-sm" type="time" value={o.end} onChange={(e) => setO({ ...o, end: e.target.value })} />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 120 }}>
          <span className="small dim">Where</span>
          <input className="input input-sm" value={o.location ?? ""} placeholder="Room or Online" maxLength={80} onChange={(e) => setO({ ...o, location: e.target.value })} />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 120 }}>
          <span className="small dim">Who</span>
          <input className="input input-sm" value={o.who ?? ""} placeholder="Instructor or TA" maxLength={80} onChange={(e) => setO({ ...o, who: e.target.value })} />
        </label>
        {courses.length > 1 && (
          <label className="field">
            <span className="small dim">Course</span>
            <select className="select input-sm" value={o.courseId} onChange={(e) => setO({ ...o, courseId: Number(e.target.value) })}>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="row-flex">
        <button className="btn btn-sm btn-primary" disabled={!valid || busy} onClick={save}>
          <Check size={13} /> Save
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onDone}>
          Cancel
        </button>
        {!valid && <span className="small muted">Pick at least one day and an end time after the start.</span>}
      </div>
    </div>
  );
}

export function OfficeHoursPanel() {
  const list = useStore((s) => s.officeHours);
  const scan = useStore((s) => s.scan);
  const dash = useStore((s) => s.dash);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const courses = (dash?.courses ?? []).filter((c) => !c.hidden).map((c) => ({ id: c.id, label: c.course_code || c.name }));
  const courseOf = (id: number) => dash?.courses.find((c) => c.id === id);
  const suggestions = (scan?.officeHours ?? []).filter((s) => !list.some((o) => o.id === s.id) && !courseOf(s.courseId)?.hidden);

  const ignore = async (id: string) => {
    // Removing an unsaved suggestion records it as dismissed, so it isn't suggested again.
    await api.officeHoursRemove(id).catch(() => {});
    setState((s) => (s.scan ? { scan: { ...s.scan, officeHours: s.scan.officeHours.filter((x) => x.id !== id) } } : {}));
  };

  const row = (o: OfficeHours, suggestion: boolean) => {
    const c = courseOf(o.courseId);
    return (
      <div key={o.id}>
        <div className={`oh-row${suggestion ? " suggestion" : ""}`}>
          <span className="dot" style={{ background: courseColor(c) }} />
          <div style={{ minWidth: 0 }}>
            <div className="row-flex" style={{ flexWrap: "wrap", gap: "2px 8px" }}>
              <b>{c?.course_code || c?.name}</b>
              <span>
                {ohDays(o)} · {fmtHm(o.start)}–{fmtHm(o.end)}
              </span>
            </div>
            <div className="small muted ellipsis">
              {[o.who, o.location].filter(Boolean).join(" · ")}
              {suggestion && <> · from {o.source}</>}
            </div>
            {suggestion && o.snippet && <div className="quote selectable">“{o.snippet}”</div>}
          </div>
          <div className="row-flex" style={{ gap: 4 }}>
            {suggestion ? (
              <>
                <button className="btn btn-sm btn-primary" onClick={() => saveOfficeHours(o)}>
                  <Plus size={13} /> Add
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setEditId(editId === o.id ? null : o.id)}>
                  Edit first
                </button>
                <button className="icon-btn sm" onClick={() => ignore(o.id)} aria-label="Ignore this suggestion" title="Ignore">
                  <X size={14} />
                </button>
              </>
            ) : (
              <>
                <button className="icon-btn sm" onClick={() => setEditId(editId === o.id ? null : o.id)} aria-label="Edit office hours" title="Edit">
                  <Pencil size={13} />
                </button>
                <button className="icon-btn sm" onClick={() => removeOfficeHours(o.id)} aria-label="Remove office hours" title="Remove">
                  <Trash2 size={13} />
                </button>
              </>
            )}
          </div>
        </div>
        {editId === o.id && <Editor initial={o} courses={courses} onDone={() => setEditId(null)} />}
      </div>
    );
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <Users size={15} />
        <h2>Office hours</h2>
        <span className="small muted">On Today, the calendar and each assignment</span>
        <div className="right">
          <button className="btn btn-sm" onClick={() => setAdding(true)} disabled={!courses.length}>
            <Plus size={13} /> Add
          </button>
        </div>
      </div>
      {adding && (
        <Editor
          initial={{ id: "", courseId: courses[0]?.id ?? 0, days: [], start: "14:00", end: "15:00", location: null, who: null, snippet: "", source: "Added by you" }}
          courses={courses}
          onDone={() => setAdding(false)}
        />
      )}
      {list.length === 0 && !adding && suggestions.length === 0 && (
        <div className="panel-body small muted">None yet. The scan looks for office hours in syllabi, course pages and announcements, or add them by hand.</div>
      )}
      {list.map((o) => row(o, false))}
      {suggestions.length > 0 && (
        <>
          <div className="group-label" style={{ position: "static" }}>
            Found by the scan <span className="muted">{plural(suggestions.length, "suggestion")}, nothing is added until you say so</span>
          </div>
          {suggestions.map((o) => row(o, true))}
        </>
      )}
    </section>
  );
}
