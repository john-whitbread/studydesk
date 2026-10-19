import { CalendarPlus, ChevronLeft, ChevronRight, MapPin, RefreshCw, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, listen } from "../lib/api.ts";
import { addDays, addMonths, byDay, dayStart, layoutDay, monthGrid, sameMonth, weekStart, type CalItem } from "../lib/calendar.ts";
import { entries, KIND_LABEL } from "../lib/entries.ts";
import { navigate, reportError, useStore } from "../lib/store.ts";
import { fmtTime } from "../lib/time.ts";
import type { CalStatus, ExtEvent } from "../lib/types.ts";
import { courseColor } from "../lib/util.ts";
import { Spinner, useNow } from "./common.tsx";

type View = "month" | "week" | "list";
const HOUR = 46; // px per hour in the week grid
const LIST_DAYS = 28;

function loadView(): View {
  try {
    const v = localStorage.getItem("studydesk.calview");
    if (v === "month" || v === "week" || v === "list") return v;
  } catch {
    /* default */
  }
  return "week";
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmtMonth = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "long", year: "numeric" });
const fmtDayHead = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

export function CalendarView({ date }: { date?: number }) {
  const dash = useStore((s) => s.dash);
  const pinned = useStore((s) => s.pinned);
  const now = useNow(60_000);
  const [view, setViewRaw] = useState<View>(loadView);
  const [anchor, setAnchor] = useState(() => dayStart(date ?? Date.now()));
  const [status, setStatus] = useState<CalStatus | null>(null);
  const [ext, setExt] = useState<ExtEvent[]>([]);
  const [errors, setErrors] = useState<{ calendar: string; message: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [showDue, setShowDue] = useState(true);
  const [showPins, setShowPins] = useState(true);
  const [narrow, setNarrow] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const setView = (v: View) => {
    setViewRaw(v);
    try {
      localStorage.setItem("studydesk.calview", v);
    } catch {
      /* fine */
    }
  };
  useEffect(() => {
    if (date != null) setAnchor(dayStart(date));
  }, [date]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 680));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The 7-column week is unreadable on a narrow window: show the list instead.
  const shown: View = narrow && view === "week" ? "list" : view;

  const [from, to] = useMemo((): [number, number] => {
    if (shown === "month") {
      const g = monthGrid(anchor);
      return [g[0], addDays(g[41], 1)];
    }
    if (shown === "week") {
      const s = weekStart(anchor);
      return [s, addDays(s, 7)];
    }
    return [dayStart(anchor), addDays(dayStart(anchor), LIST_DAYS)];
  }, [shown, anchor]);

  const loadStatus = () => api.calendarStatus().then(setStatus).catch(() => {});
  useEffect(() => {
    void loadStatus();
    let off: (() => void) | undefined;
    void listen("calendar-push", () => loadStatus()).then((f) => (off = f));
    return () => off?.();
  }, []);

  const fetchExt = (refresh = false) => {
    setLoading(true);
    return api
      .calendarEvents(from, to, refresh)
      .then((r) => {
        setExt(r.events);
        setErrors(r.errors);
      })
      .catch((e) => reportError(e, "Couldn't load your calendars"))
      .finally(() => setLoading(false));
  };
  const hasExternal = !!status?.apple || (status?.links.length ?? 0) > 0;
  useEffect(() => {
    if (status && hasExternal) void fetchExt();
    else setExt([]);
  }, [from, to, status && JSON.stringify([status.apple?.calendars.map((c) => c.shown), status.links.map((l) => l.shown)])]);

  // Studydesk's own calendar in iCloud mirrors what's already shown from Canvas: hide it to avoid doubles.
  const studydeskIds = new Set(status?.apple?.calendars.filter((c) => c.studydesk).map((c) => c.id) ?? []);

  const items = useMemo(() => {
    const out: CalItem[] = [];
    for (const e of entries(dash, pinned, now)) {
      if (e.type === "asg") {
        if (!showDue || e.due == null) continue;
        out.push({ kind: "entry", key: e.key, e, start: e.due, end: e.due, allDay: false, title: e.it.a.name, color: courseColor(e.course) });
      } else {
        if (!showPins) continue;
        const allDay = !e.p.time;
        const start = allDay ? dayStart(e.due) : e.due;
        out.push({ kind: "entry", key: e.key, e, start, end: allDay ? addDays(start, 1) : start + 3600_000, allDay, title: `${KIND_LABEL[e.p.kind] ?? "Note"}: ${e.p.label}`, color: courseColor(e.course) });
      }
    }
    ext.forEach((x, i) => {
      if (studydeskIds.has(x.source)) return;
      out.push({ kind: "ext", key: `x${i}`, x, start: x.start, end: x.end, allDay: x.allDay, title: x.title || "(no title)", color: x.color || "var(--text-3)" });
    });
    return out;
  }, [dash, pinned, now, ext, showDue, showPins, status]);

  const days = useMemo(() => byDay(items, from, to), [items, from, to]);

  const step = (n: number) => setAnchor((a) => (shown === "month" ? addMonths(a, n) : addDays(a, n * (shown === "week" ? 7 : LIST_DAYS))));
  const title = shown === "month" ? fmtMonth(anchor) : shown === "week" ? weekTitle(from) : `${fmtDayHead(from)} – ${new Date(to - 1).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  const toggleSource = (id: string, on: boolean) =>
    api.calendarSetShown(id, on).then(setStatus).catch((e) => reportError(e));

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Calendar</h1>
          <div className="sub">{title}</div>
        </div>
        <div className="actions">
          <div className="row-flex" style={{ gap: 2 }}>
            <button className="icon-btn" onClick={() => step(-1)} title="Previous" aria-label="Previous">
              <ChevronLeft size={17} />
            </button>
            <button className="btn btn-sm" onClick={() => setAnchor(dayStart(Date.now()))}>
              Today
            </button>
            <button className="icon-btn" onClick={() => step(1)} title="Next" aria-label="Next">
              <ChevronRight size={17} />
            </button>
          </div>
          <div className="seg" role="tablist" aria-label="Calendar view">
            {(["month", "week", "list"] as View[]).map((v) => (
              <button key={v} role="tab" aria-selected={shown === v} className={shown === v ? "active" : ""} onClick={() => setView(v)} disabled={v === "week" && narrow} title={v === "week" && narrow ? "Widen the window for the week view" : undefined}>
                {v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          {hasExternal && (
            <button className="icon-btn" onClick={() => fetchExt(true)} title="Reload your calendars" aria-label="Reload your calendars" disabled={loading}>
              {loading ? <Spinner /> : <RefreshCw size={15} />}
            </button>
          )}
        </div>
      </header>

      <div className="cal-legend">
        <button className={`cal-chip${showDue ? " on" : ""}`} onClick={() => setShowDue(!showDue)} aria-pressed={showDue}>
          <span className="cal-swatch course" /> Canvas deadlines
        </button>
        <button className={`cal-chip${showPins ? " on" : ""}`} onClick={() => setShowPins(!showPins)} aria-pressed={showPins}>
          <span className="cal-swatch course" /> Key dates
        </button>
        {status?.apple?.calendars
          .filter((c) => !c.studydesk)
          .map((c) => (
            <button key={c.id} className={`cal-chip${c.shown ? " on" : ""}`} onClick={() => toggleSource(c.id, !c.shown)} aria-pressed={c.shown} title={`Apple Calendar: ${c.name}`}>
              <span className="cal-swatch" style={{ background: c.color || "var(--text-3)" }} /> {c.name}
            </button>
          ))}
        {status?.links.map((l) => (
          <button key={l.id} className={`cal-chip${l.shown ? " on" : ""}`} onClick={() => toggleSource(l.id, !l.shown)} aria-pressed={l.shown}>
            <span className="cal-swatch" style={{ background: l.color }} /> {l.name}
          </button>
        ))}
        {status && !hasExternal && (
          <button className="btn btn-sm" onClick={() => navigate({ view: "settings" })} style={{ marginLeft: "auto" }}>
            <CalendarPlus size={14} /> Connect Apple Calendar
          </button>
        )}
        {status?.apple && (
          <button className="cal-sync small muted" onClick={() => navigate({ view: "settings" })} title="Calendar settings">
            <SettingsIcon size={12} />
            {status.apple.push ? (status.apple.pushing ? "Updating your Apple calendar…" : "Deadlines also in Apple Calendar") : "Apple Calendar"}
          </button>
        )}
      </div>
      {errors.length > 0 && (
        <div className="cal-errors small" role="status">
          {errors.map((e) => (
            <div key={e.calendar}>
              <b>{e.calendar}:</b> {e.message}
            </div>
          ))}
        </div>
      )}

      <div className="content cal-body" ref={bodyRef}>
        {shown === "month" && <Month anchor={anchor} days={days} now={now} onDay={(d) => (setAnchor(d), setView(narrow ? "list" : "week"))} />}
        {shown === "week" && <Week from={from} days={days} now={now} />}
        {shown === "list" && <List from={from} to={to} days={days} now={now} />}
      </div>
    </>
  );
}

function weekTitle(from: number): string {
  const a = new Date(from), b = new Date(addDays(from, 6));
  const mon = (d: Date) => d.toLocaleDateString(undefined, { month: "short" });
  // "Oct 18 – 24, 2026" or "Oct 25 – Nov 1, 2026" or "Dec 27, 2026 – Jan 2, 2027"
  if (a.getFullYear() !== b.getFullYear()) return `${mon(a)} ${a.getDate()}, ${a.getFullYear()} – ${mon(b)} ${b.getDate()}, ${b.getFullYear()}`;
  if (a.getMonth() !== b.getMonth()) return `${mon(a)} ${a.getDate()} – ${mon(b)} ${b.getDate()}, ${b.getFullYear()}`;
  return `${mon(a)} ${a.getDate()} – ${b.getDate()}, ${b.getFullYear()}`;
}

function open(it: CalItem) {
  if (it.kind !== "entry") return;
  if (it.e.type === "asg") navigate({ view: "course", courseId: it.e.it.a.course_id, assignmentId: it.e.it.a.id });
  else navigate({ view: "dates" });
}

function itemLabel(it: CalItem): string {
  const when = it.allDay ? "All day" : it.end > it.start ? `${fmtTime(it.start)} – ${fmtTime(it.end)}` : `Due ${fmtTime(it.start)}`;
  if (it.kind === "ext") return `${it.title}\n${when}${it.x.location ? `\n${it.x.location}` : ""}\n${it.x.calendar}`;
  const course = it.e.course?.course_code ?? "";
  return `${it.title}\n${when}${course ? `\n${course}` : ""}`;
}

function isDone(it: CalItem): boolean {
  return it.kind === "entry" && it.e.type === "asg" && !it.e.it.s.needsAction;
}

function Chip({ it, compact = false, where = false }: { it: CalItem; compact?: boolean; where?: boolean }) {
  const heat = it.kind === "entry" ? it.e.heat : "none";
  const isEntry = it.kind === "entry";
  return (
    <button
      className={`cal-item${it.allDay ? " allday" : ""}${isEntry ? ` entry heat-${heat}` : " xev"}${isDone(it) ? " done" : ""}`}
      style={{ ["--c" as string]: it.color }}
      onClick={() => open(it)}
      title={itemLabel(it)}
      tabIndex={isEntry ? 0 : -1}
    >
      {!it.allDay && <span className="t num">{fmtTime(it.start).replace(/:00(?= )/, "")}</span>}
      <span className="n ellipsis">
        {!compact && isEntry && it.e.type === "asg" && it.e.course ? `${it.e.course.course_code} · ` : ""}
        {it.title}
      </span>
      {where && it.kind === "ext" && it.x.location && (
        <span className="loc ellipsis">
          <MapPin size={10} /> {it.x.location}
        </span>
      )}
    </button>
  );
}

function Month({ anchor, days, now, onDay }: { anchor: number; days: Map<number, CalItem[]>; now: number; onDay: (d: number) => void }) {
  const grid = monthGrid(anchor);
  const today = dayStart(now);
  return (
    <div className="cal-month" role="grid" aria-label={fmtMonth(anchor)}>
      {DOW.map((d) => (
        <div key={d} className="cal-dow" role="columnheader">
          {d}
        </div>
      ))}
      {grid.map((d) => {
        const list = days.get(d) ?? [];
        const extra = Math.max(0, list.length - 4);
        return (
          <div key={d} className={`cal-cell${sameMonth(d, anchor) ? "" : " other"}${d === today ? " today" : ""}`} role="gridcell">
            <button className="cal-date num" onClick={() => onDay(d)} aria-label={fmtDayHead(d)}>
              {new Date(d).getDate()}
            </button>
            <div className="cal-cell-items">
              {list.slice(0, extra ? 3 : 4).map((it) => (
                <Chip key={it.key + d} it={it} compact />
              ))}
              {extra > 0 && (
                <button className="cal-more" onClick={() => onDay(d)}>
                  +{extra + 1} more
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Week({ from, days, now }: { from: number; days: Map<number, CalItem[]>; now: number }) {
  const cols = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const today = dayStart(now);
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Start at 7:00, or earlier if something is on before then.
    let first = 7;
    for (const d of cols) for (const it of days.get(d) ?? []) if (!it.allDay && it.start >= d) first = Math.min(first, new Date(it.start).getHours());
    scrollRef.current?.scrollTo({ top: Math.max(0, first * HOUR - 8) });
  }, [from]);
  const allDay = cols.map((d) => (days.get(d) ?? []).filter((it) => it.allDay));
  const anyAllDay = allDay.some((l) => l.length);
  return (
    <div className="cal-week">
      <div className="cal-week-head">
        <div className="cal-gutter" />
        {cols.map((d) => (
          <div key={d} className={`cal-wday${d === today ? " today" : ""}`}>
            <span className="dn">{DOW[new Date(d).getDay()]}</span>
            <span className="dd num">{new Date(d).getDate()}</span>
          </div>
        ))}
      </div>
      {anyAllDay && (
        <div className="cal-allday">
          <div className="cal-gutter small muted">all-day</div>
          {allDay.map((l, i) => (
            <div key={i} className="cal-allday-col">
              {l.map((it) => (
                <Chip key={it.key} it={it} compact />
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="cal-grid-scroll" ref={scrollRef}>
        <div className="cal-grid" style={{ height: 24 * HOUR }}>
          <div className="cal-gutter">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="cal-hour-label small muted num" style={{ top: h * HOUR }}>
                {h === 0 ? "" : new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" })}
              </div>
            ))}
          </div>
          {cols.map((d) => {
            const timed = (days.get(d) ?? []).filter((it) => !it.allDay);
            const placed = layoutDay(timed.map((it) => ({ it, start: Math.max(it.start, d), end: Math.min(it.end, addDays(d, 1)) })), 22 * 60_000);
            return (
              <div key={d} className={`cal-col${d === today ? " today" : ""}`}>
                {placed.map(({ item: { it, start, end }, lane, lanes }) => {
                  const top = ((start - d) / 3600_000) * HOUR;
                  const h = Math.max(((end - start) / 3600_000) * HOUR, 20);
                  const isDeadline = it.kind === "entry" && end === start;
                  return (
                    <div
                      key={it.key}
                      className={`cal-block${isDeadline ? " deadline" : ""}`}
                      style={{ top, height: isDeadline ? 20 : h, left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` }}
                    >
                      <Chip it={it} where={h >= 40} />
                    </div>
                  );
                })}
                {d === today && <div className="cal-now" style={{ top: ((now - d) / 3600_000) * HOUR }} aria-hidden />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function List({ from, to, days, now }: { from: number; to: number; days: Map<number, CalItem[]>; now: number }) {
  const list: number[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) if (days.get(d)?.length) list.push(d);
  const today = dayStart(now);
  if (!list.length)
    return (
      <div className="empty">
        <strong>Nothing in these {LIST_DAYS} days</strong>
        Deadlines, key dates and your calendars show here.
      </div>
    );
  return (
    <div className="cal-list">
      {list.map((d) => (
        <section key={d} className="panel cal-day">
          <div className={`cal-day-head${d === today ? " today" : ""}`}>
            {d === today ? "Today · " : d === addDays(today, 1) ? "Tomorrow · " : ""}
            {fmtDayHead(d)}
          </div>
          {(days.get(d) ?? []).map((it) => (
            <button key={it.key} className={`cal-row${isDone(it) ? " done" : ""}`} onClick={() => open(it)} style={{ ["--c" as string]: it.color }} tabIndex={it.kind === "entry" ? 0 : -1}>
              <span className="when num">{it.allDay ? "All day" : it.end > it.start ? `${fmtTime(it.start)}` : `Due ${fmtTime(it.start)}`}</span>
              <span className="bar" />
              <span className="what">
                <span className="t ellipsis">{it.title}</span>
                <span className="s ellipsis">
                  {it.kind === "ext"
                    ? [it.x.calendar, it.x.location, it.end > it.start && !it.allDay ? `until ${fmtTime(it.end)}` : ""].filter(Boolean).join(" · ")
                    : [it.e.course?.course_code, it.e.type === "asg" ? (isDone(it) ? "Submitted" : "Canvas") : "Key date"].filter(Boolean).join(" · ")}
                </span>
              </span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
