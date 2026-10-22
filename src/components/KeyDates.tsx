// Key dates: what the scanner found in your courses, and what you pinned.
// Nothing found by the scanner counts until you pin it.

import { Check, ChevronDown, ChevronRight, CircleAlert, ExternalLink, Megaphone, Pencil, Pin, PinOff, Plus, ScanSearch, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { KIND_LABEL, pinDue } from "../lib/entries.ts";
import { heatOf } from "../lib/heat.ts";
import { reportError, runScan, setState, setWorkPrefs, toast, useStore } from "../lib/store.ts";
import { OfficeHoursPanel } from "./OfficeHoursPanel.tsx";
import { fmtDay, fmtTime, relative } from "../lib/time.ts";
import type { DateKind, Finding, PinnedDate } from "../lib/types.ts";
import { courseColor, plural } from "../lib/util.ts";
import { Empty, Notice, Spinner, useNow } from "./common.tsx";

const KINDS: DateKind[] = ["exam", "quiz", "deliverable", "info"];
const parseLocal = (d: string, t: string | null) => pinDue({ id: "", courseId: 0, date: d, time: t, label: "", kind: "info", weight: null, source: "" });

function When({ date, time, endDate, now }: { date: string; time: string | null; endDate?: string | null; now: number }) {
  const t = parseLocal(date, time);
  return (
    <div className="when">
      <b>{fmtDay(t, now)}</b>
      <span className="small muted">
        {endDate ? `to ${fmtDay(parseLocal(endDate, null), now)}` : time ? fmtTime(t) : "Time not stated"}
      </span>
      <div className="small muted">{relative(time ? t : new Date(t).setHours(23, 59), now)}</div>
    </div>
  );
}

/** Inline editor used both to pin a finding (pre-filled) and to add a date by hand. */
function PinEditor({ initial, courses, onDone }: { initial: PinnedDate; courses: { id: number; label: string }[]; onDone: () => void }) {
  const [p, setP] = useState<PinnedDate>(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const pinned = await api.datesPin(p);
      setState({ pinned });
      toast(`Pinned “${p.label}”. You'll be reminded 24 h and 2 h before.`, "ok");
      onDone();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pin-edit" onKeyDown={(e) => e.key === "Enter" && !busy && save()}>
      <div className="field">
        <label>Date</label>
        <input className="input" type="date" value={p.date} onChange={(e) => setP({ ...p, date: e.target.value })} />
      </div>
      <div className="field">
        <label>Time</label>
        <input className="input" type="time" value={p.time ?? ""} onChange={(e) => setP({ ...p, time: e.target.value || null })} />
      </div>
      <div className="field">
        <label>Type</label>
        <select className="select" value={p.kind} onChange={(e) => setP({ ...p, kind: e.target.value as DateKind })}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k === "deliverable" ? "Deliverable / due" : KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Name</label>
        <div className="row-flex">
          <input className="input" value={p.label} onChange={(e) => setP({ ...p, label: e.target.value })} autoFocus />
          {courses.length > 1 && (
            <select className="select" style={{ width: 130, flex: "none" }} value={p.courseId} onChange={(e) => setP({ ...p, courseId: Number(e.target.value) })}>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          <button className="btn btn-primary" onClick={save} disabled={busy || !p.label.trim() || !p.date}>
            {busy ? <Spinner /> : <Check size={14} />} Pin
          </button>
          <button className="icon-btn" onClick={onDone} aria-label="Cancel">
            <X size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

function FindingRow({ f, now, courses, pinnedIds }: { f: Finding; now: number; courses: { id: number; label: string }[]; pinnedIds: Set<string> }) {
  const [editing, setEditing] = useState(false);
  const scan = useStore((s) => s.scan);
  const dash = useStore((s) => s.dash);
  const pinned = pinnedIds.has(f.id);
  const heat = heatOf(parseLocal(f.date, f.time), now, true);
  const dismiss = async () => {
    try {
      await api.datesDismiss(f.id);
      if (scan) setState({ scan: { ...scan, findings: scan.findings.filter((x) => x.id !== f.id) } });
    } catch (e) {
      reportError(e);
    }
  };
  return (
    <>
      <div className={`finding heat-${heat}`} style={{ boxShadow: "inset 3px 0 0 var(--heat)" }}>
        <When date={f.date} time={f.time} endDate={f.endDate} now={now} />
        <div style={{ minWidth: 0 }}>
          <div className="row-flex" style={{ flexWrap: "wrap" }}>
            <span className={`kind-chip kind-${f.kind}`}>{KIND_LABEL[f.kind]}</span>
            <b className="selectable">{f.label}</b>
            {f.weight && <span className="chip">{f.weight}</span>}
            <span className={`conf conf-${f.confidence}`} title="How sure the scanner is">
              {f.confidence === "high" ? "Exact (calendar)" : f.confidence === "medium" ? "Found in text" : "Check this"}
            </span>
          </div>
          {f.caution && (
            <div className="small text-warn" style={{ marginTop: 4 }}>
              <CircleAlert size={12} style={{ verticalAlign: -2 }} /> {f.caution}
            </div>
          )}
          {f.snippet && <div className="quote selectable">“{f.snippet}”</div>}
          <div className="srcs">
            Found in:
            {f.sources.map((s, i) => (
              <span key={i}>
                {s.url ? (
                  <button onClick={() => api.openInCanvas(s.url!).catch((e) => reportError(e))} title="Open in Canvas">
                    {s.name} <ExternalLink size={10} style={{ verticalAlign: -1 }} />
                  </button>
                ) : (
                  s.name
                )}
                {i < f.sources.length - 1 ? "," : ""}
              </span>
            ))}
          </div>
        </div>
        <div className="acts">
          {pinned ? (
            <span className="chip tone-ok">
              <Check size={12} /> Pinned
            </span>
          ) : (
            <>
              <button className="btn btn-sm btn-primary" onClick={() => setEditing(true)}>
                <Pin size={13} /> Pin
              </button>
              <button className="btn btn-sm btn-ghost" onClick={dismiss} title="Don't show this again">
                Ignore
              </button>
            </>
          )}
        </div>
      </div>
      {editing && (
        <PinEditor
          initial={{ id: f.id, courseId: f.courseId, date: f.date, time: f.time, label: f.label, kind: f.kind, weight: f.weight, source: f.sources.map((s) => s.name).join(", ") }}
          courses={courses.length ? courses : [{ id: f.courseId, label: dash?.courses.find((c) => c.id === f.courseId)?.course_code ?? "" }]}
          onDone={() => setEditing(false)}
        />
      )}
    </>
  );
}

export function KeyDates() {
  const dash = useStore((s) => s.dash);
  const pinned = useStore((s) => s.pinned);
  const scan = useStore((s) => s.scan);
  const scanning = useStore((s) => s.scanning);
  const autoDates = useStore((s) => s.workPrefs?.autoDates ?? true);
  const now = useNow(60_000);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [showCovered, setShowCovered] = useState(false);
  const [showReport, setShowReport] = useState(false);

  useEffect(() => {
    if (!scan && !scanning) void runScan();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const courses = (dash?.courses ?? []).filter((c) => !c.hidden).map((c) => ({ id: c.id, label: c.course_code || c.name }));
  const courseOf = (id: number) => dash?.courses.find((c) => c.id === id);
  const pinnedIds = new Set(pinned.map((p) => p.id));
  const upcomingPins = pinned.filter((p) => new Date(parseLocal(p.date, p.time)).setHours(23, 59) >= now);
  const pastPins = pinned.length - upcomingPins.length;

  const { fresh, covered, byCourse } = useMemo(() => {
    const all = scan?.findings ?? [];
    const covered = all.filter((f) => f.inCanvas);
    const fresh = all.filter((f) => !f.inCanvas);
    const byCourse = new Map<number, Finding[]>();
    for (const f of fresh) byCourse.set(f.courseId, [...(byCourse.get(f.courseId) ?? []), f]);
    return { fresh, covered, byCourse };
  }, [scan]);

  const unpin = async (id: string) => {
    try {
      setState({ pinned: await api.datesUnpin(id) });
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Key dates</h1>
          <div className="sub">Exams, quizzes and milestones from your course calendars, syllabi and outlines</div>
        </div>
        <div className="actions">
          {scanning ? (
            <div className="scan-bar small">
              <Spinner /> Scanning {scanning.total ? `${scanning.done} of ${plural(scanning.total, "course")}` : "courses"}…
              {scanning.total > 0 && (
                <div className="progress">
                  <div style={{ width: `${(scanning.done / scanning.total) * 100}%` }} />
                </div>
              )}
            </div>
          ) : (
            <button className="btn" onClick={() => runScan()}>
              <ScanSearch size={15} /> Scan again
            </button>
          )}
          <button className="btn btn-primary" onClick={() => setAdding(true)} disabled={courses.length === 0}>
            <Plus size={15} /> Add a date
          </button>
        </div>
      </header>
      <div className="content pad">
        <div className="stack" style={{ maxWidth: 1100, gap: 16 }}>
          <section className="panel">
            <div className="panel-head">
              <Pin size={15} />
              <h2>Pinned</h2>
              <span className="small muted">Shown on Today, in the course and in Gravity, with reminders 24 h and 2 h before</span>
            </div>
            <label className="check small auto-toggle">
              <input type="checkbox" checked={autoDates} onChange={(e) => setWorkPrefs(e.target.checked, null)} />
              <span>
                <b style={{ display: "block" }}>Add dates from announcements automatically</b>
                <span className="muted" style={{ display: "block" }}>Checked on every refresh. You get a notice with Undo, and a date you remove never comes back.</span>
              </span>
            </label>
            {adding && (
              <PinEditor
                initial={{ id: "", courseId: courses[0]?.id ?? 0, date: new Date(now + 7 * 864e5).toISOString().slice(0, 10), time: null, label: "", kind: "exam", weight: null, source: "Added by you" }}
                courses={courses}
                onDone={() => setAdding(false)}
              />
            )}
            {upcomingPins.length === 0 && !adding ? (
              <div className="panel-body muted small">Nothing pinned yet. Pin dates from the scan results below, or add one by hand.</div>
            ) : (
              upcomingPins.map((p) => {
                const c = courseOf(p.courseId);
                const due = parseLocal(p.date, p.time);
                return (
                  <div key={p.id}>
                    <div className={`lrow pin-row heat-${heatOf(due, now, true)}`} style={{ display: "grid" }}>
                      <When date={p.date} time={p.time} now={now} />
                      <div style={{ minWidth: 0 }}>
                        <div className="row-flex">
                          <span className={`kind-chip kind-${p.kind}`}>{KIND_LABEL[p.kind]}</span>
                          <b className="ellipsis">{p.label}</b>
                          {p.weight && <span className="chip">{p.weight}</span>}
                        </div>
                        <div className="lr-meta" style={{ marginTop: 3 }}>
                          {c && (
                            <span className="tag">
                              <span className="dot" style={{ background: courseColor(c), width: 7, height: 7 }} />
                              {c.course_code || c.name}
                            </span>
                          )}
                          {p.auto ? (
                            <span className="chip chip-xs tone-info" style={{ marginLeft: 0 }} title={p.source}>
                              <Megaphone size={10} /> From an announcement
                            </span>
                          ) : null}
                          {p.url ? (
                            <button className="linkish ellipsis" onClick={() => api.openInCanvas(p.url as string).catch((e) => reportError(e))} title="Open the source in Canvas">
                              {p.auto ? p.source.replace(/^Announcement: /, "") : `From ${p.source || "you"}`} <ExternalLink size={10} />
                            </button>
                          ) : (
                            <span className="ellipsis">{p.auto ? p.source.replace(/^Announcement: /, "") : `From ${p.source || "you"}`}</span>
                          )}
                        </div>
                      </div>
                      <div className="row-flex">
                        <button className="icon-btn" title="Edit" aria-label={`Edit ${p.label}`} onClick={() => setEditId(editId === p.id ? null : p.id)}>
                          <Pencil size={14} />
                        </button>
                        <button className="icon-btn" title="Unpin" aria-label={`Unpin ${p.label}`} onClick={() => unpin(p.id)}>
                          <PinOff size={14} />
                        </button>
                      </div>
                    </div>
                    {editId === p.id && <PinEditor initial={p} courses={courses} onDone={() => setEditId(null)} />}
                  </div>
                );
              })
            )}
            {pastPins > 0 && <div className="panel-body small muted">{plural(pastPins, "past date")} hidden.</div>}
          </section>

          <OfficeHoursPanel />

          <section className="panel">
            <div className="panel-head">
              <ScanSearch size={15} />
              <h2>Found in your courses</h2>
              {scan && <span className="small muted">{plural(fresh.length, "new date")}</span>}
              <div className="right">
                {scan && (
                  <button className="btn btn-sm btn-ghost" onClick={() => api.datesRestoreDismissed().then(() => toast("Ignored dates will show again on the next scan.", "info")).catch((e) => reportError(e))}>
                    Restore ignored
                  </button>
                )}
              </div>
            </div>
            {!scan ? (
              <div className="empty">
                <Spinner />
                Reading course calendars, syllabi and outlines…
              </div>
            ) : fresh.length === 0 ? (
              <Empty title="No new dates found">Everything found is already a Canvas assignment, pinned, or ignored. Add anything missing by hand.</Empty>
            ) : (
              [...byCourse.entries()].map(([cid, list]) => {
                const c = courseOf(cid);
                return (
                  <div key={cid}>
                    <div className="group-label" style={{ position: "static" }}>
                      <span className="dot" style={{ background: courseColor(c), width: 8, height: 8 }} />
                      {c?.course_code || c?.name}
                      <span className="muted">{c?.name}</span>
                    </div>
                    {list.map((f) => (
                      <FindingRow key={f.id} f={f} now={now} courses={courses} pinnedIds={pinnedIds} />
                    ))}
                  </div>
                );
              })
            )}
            {covered.length > 0 && (
              <>
                <button className="ann-btn" onClick={() => setShowCovered(!showCovered)} style={{ borderTop: "1px solid var(--border)" }}>
                  {showCovered ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className="small">
                    {plural(covered.length, "date")} already in Canvas as assignments (hidden so you don't see them twice)
                  </span>
                </button>
                {showCovered &&
                  covered.map((f) => (
                    <div key={f.id} className="finding" style={{ opacity: 0.7 }}>
                      <When date={f.date} time={f.time} now={now} />
                      <div className="small">
                        <b>{f.label}</b>
                        <div className="muted">Canvas assignment: {f.inCanvas}</div>
                      </div>
                      <div />
                    </div>
                  ))}
              </>
            )}
          </section>

          {scan && (
            <section className="panel">
              <button className="ann-btn" onClick={() => setShowReport(!showReport)}>
                {showReport ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <b className="small">What was scanned</b>
                <span className="small muted">
                  {scan.scanned.filter((s) => s.ok).length} sources read · {scan.scanned.filter((s) => !s.ok).length} unavailable
                </span>
              </button>
              {showReport && (
                <table className="ctable">
                  <tbody>
                    {scan.scanned.map((s, i) => (
                      <tr key={i}>
                        <td style={{ width: 110 }}>{courseOf(s.courseId)?.course_code}</td>
                        <td>{s.name}</td>
                        <td className="small" style={{ width: 260 }}>
                          {s.ok ? <span className="text-ok">{plural(s.found, "date")} found</span> : <span className="muted">{s.note}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="panel-body small muted" style={{ borderTop: "1px solid var(--border)" }}>
                Files are read straight from Canvas into memory and never saved. Scanned PDFs with no text layer, and dates written only as "TBA", can't be detected.
              </div>
            </section>
          )}
          {scan && scan.scanned.length === 0 && <Notice tone="neutral">No courses to scan.</Notice>}
        </div>
      </div>
    </>
  );
}
