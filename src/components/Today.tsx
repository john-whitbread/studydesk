import { BookOpen, CalendarClock, Check, FolderOpen, List, Megaphone, MessageSquare, Orbit, ScanSearch, Target, TriangleAlert, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { DAY, type Item } from "../lib/derive.ts";
import { dropClass } from "../lib/drag.ts";
import { entries, entryNeedsAction, KIND_LABEL, type Entry } from "../lib/entries.ts";
import { heatOf, HEAT_LABEL, HEAT_RANK, type Heat } from "../lib/heat.ts";
import { acceptsUpload, kindLabel } from "../lib/status.ts";
import { loadModules, navigate, reportError, runScan, setState, useStore } from "../lib/store.ts";
import { defaultHours, fmtHours, hoursFor } from "../lib/effort.ts";
import { collisions, loadByDay, type LoadItem } from "../lib/workload.ts";
import { fmtHm, ohSlots } from "../lib/officehours.ts";
import { ChangeChip, useUnseenChanges, WhatChanged } from "./Changes.tsx";
import { isReading, markItem, openItem } from "./Modules.tsx";
import { dayKey, dayLabel, fmtDay, fmtFullDate, fmtListTime, fmtNum, fmtTime, fmtWhen, parse, relative } from "../lib/time.ts";
import type { Conversation, PinnedDate } from "../lib/types.ts";
import { htmlToText } from "../lib/sanitize.ts";
import { courseColor, plural } from "../lib/util.ts";
import { Countdown, Empty, StatusChip, useNow } from "./common.tsx";
import { Gravity } from "./Gravity.tsx";

/** Due time cell: live countdown inside 24 h, heat-coloured relative time otherwise. */
function DueCell({ due, heat, now }: { due: number; heat: Heat; now: number }) {
  const live = due > now && due - now < DAY && heat !== "none";
  return (
    <div className={`lr-due heat-${heat}`}>
      <div>{fmtTime(due)}</div>
      {live ? <Countdown due={due} /> : <div className={`rel${heat !== "none" ? " heat-text" : ""}`}>{relative(due, now)}</div>}
    </div>
  );
}

export function DueRow({ it, now, showCourse = true }: { it: Item; now: number; showCourse?: boolean }) {
  const drag = useStore((s) => s.drag);
  const mine = useStore((s) => s.work[`${it.a.course_id}:${it.a.id}`]);
  const estimates = useStore((s) => s.workPrefs?.estimates);
  const changed = useUnseenChanges().get(it.a.id);
  const hrs = it.s.needsAction && (it.a.points_possible ?? 0) > 0 ? hoursFor(it.a, mine?.hours, estimates ?? {}) : null;
  const ticks = mine?.checklist.length ? `${mine.checklist.filter((c) => c.done).length}/${mine.checklist.length}` : null;
  const key = `asg:${it.a.course_id}:${it.a.id}`;
  const k = kindLabel(it.a);
  const heat = heatOf(it.due, now, it.s.needsAction, it.s.late);
  return (
    <button
      className={`lrow due-row heat-${heat}${!it.s.needsAction ? " done" : ""}${dropClass(key, acceptsUpload(it.a), drag)}`}
      data-drop={key}
      onClick={() => navigate({ view: "course", courseId: it.a.course_id, assignmentId: it.a.id })}
      title={heat !== "none" ? HEAT_LABEL[heat] : undefined}
    >
      <StatusChip s={it.s} />
      <div style={{ minWidth: 0 }}>
        <div className="lr-title ellipsis">
          {it.a.name}
          {changed && <ChangeChip c={changed} />}
        </div>
        <div className="lr-meta">
          {showCourse && it.course && (
            <span className="tag">
              <span className="dot" style={{ background: courseColor(it.course), width: 7, height: 7 }} />
              {it.course.course_code || it.course.name}
            </span>
          )}
          {it.a.points_possible != null && it.a.points_possible > 0 && <span>{fmtNum(it.a.points_possible)} pts</span>}
          {k && <span>{k}</span>}
          {hrs && <span title={hrs.custom ? "Your estimate" : "Typical time for this kind of work. Set your own on the assignment."}>≈ {fmtHours(hrs.hours)}</span>}
          {ticks && it.s.needsAction && <span title="Requirements ticked">✓ {ticks}</span>}
        </div>
      </div>
      {it.due != null ? <DueCell due={it.due} heat={heat} now={now} /> : <div className="lr-due muted">No due date</div>}
    </button>
  );
}

function PinRow({ p, due, heat, course, now }: { p: PinnedDate; due: number; heat: Heat; course: Entry["course"]; now: number }) {
  return (
    <button className={`lrow due-row heat-${heat}`} onClick={() => navigate({ view: "dates" })} title="Key date you pinned">
      <span className={`kind-chip kind-${p.kind}`} style={{ justifySelf: "start" }}>{KIND_LABEL[p.kind]}</span>
      <div style={{ minWidth: 0 }}>
        <div className="lr-title ellipsis">{p.label}</div>
        <div className="lr-meta">
          {course && (
            <span className="tag">
              <span className="dot" style={{ background: courseColor(course), width: 7, height: 7 }} />
              {course.course_code || course.name}
            </span>
          )}
          {p.weight && <span>{p.weight} of grade</span>}
          <span>Key date</span>
        </div>
      </div>
      {p.time ? <DueCell due={due} heat={heat} now={now} /> : <div className={`lr-due heat-${heat}`}><div>All day</div><div className="rel heat-text">{relative(new Date(due).setHours(23, 59), now)}</div></div>}
    </button>
  );
}

function EntryRow({ e, now }: { e: Entry; now: number }) {
  return e.type === "asg" ? <DueRow it={e.it} now={now} /> : <PinRow p={e.p} due={e.due} heat={e.heat} course={e.course} now={now} />;
}

/** The single most pressing thing, with one-click next steps. */
function NextUp({ list, now }: { list: Entry[]; now: number }) {
  const open = list.filter((e) => e.due != null && entryNeedsAction(e, now));
  const ranked = open.sort((a, b) => {
    const lateA = (a.due as number) < now ? 0 : 1;
    const lateB = (b.due as number) < now ? 0 : 1;
    return lateA - lateB || (a.due as number) - (b.due as number);
  });
  const top = ranked[0];
  const next = ranked[1];
  if (!top) return null;
  const due = top.due as number;
  const title = top.type === "asg" ? top.it.a.name : top.p.label;
  const course = top.course;
  const late = due < now;
  return (
    <section className={`nextup heat-${top.heat}`} aria-label="Next up">
      <div style={{ minWidth: 0 }}>
        <div className="eyebrow">
          <Target size={12} style={{ verticalAlign: -1, marginRight: 4 }} />
          {late ? "Overdue, still open" : top.type === "pin" ? `Next up · ${KIND_LABEL[top.p.kind]}` : "Next up"}
        </div>
        <h2 className="ellipsis">{title}</h2>
        <div className="small muted">
          {course?.course_code || course?.name} · {fmtDay(due, now)}
          {top.type === "asg" || top.p.time ? `, ${fmtTime(due)}` : ""}
          {top.type === "asg" && top.it.a.points_possible ? ` · ${fmtNum(top.it.a.points_possible)} pts` : ""}
          {next && (
            <>
              {" "}· then <b>{next.type === "asg" ? next.it.a.name : next.p.label}</b> {relative(next.due as number, now)}
            </>
          )}
        </div>
      </div>
      <div className="big">
        {!late && due - now < DAY ? <Countdown due={due} /> : <span className="cd">{relative(due, now).replace(/^in /, "")}</span>}
        <small>{late ? "past due" : "left"}</small>
      </div>
      <div className="acts">
        {top.type === "asg" ? (
          <button className="btn btn-primary btn-sm" onClick={() => navigate({ view: "course", courseId: top.it.a.course_id, assignmentId: top.it.a.id })}>
            Open and submit
          </button>
        ) : (
          <button className="btn btn-sm" onClick={() => navigate({ view: "dates" })}>
            See key dates
          </button>
        )}
        {course?.folder && (
          <button className="btn btn-sm" onClick={() => api.revealFile({ kind: "linked", courseId: course.id, rel: "" }).catch((e) => reportError(e))}>
            <FolderOpen size={14} /> Course folder
          </button>
        )}
        {course && (
          <button className="btn btn-sm btn-ghost" onClick={() => setState({ compose: { courseId: course.id, subject: `Question about: ${title}`, teachers: true } })}>
            <MessageSquare size={14} /> Ask instructor
          </button>
        )}
      </div>
    </section>
  );
}

/** Open work as hours: your estimates, else typical hours for the kind of work. */
export function useLoadItems(list: Entry[], now: number): LoadItem[] {
  const work = useStore((s) => s.work);
  const estimates = useStore((s) => s.workPrefs?.estimates) ?? {};
  return useMemo(
    () =>
      list
        .filter((e) => e.due != null && entryNeedsAction(e, now) && (e.type === "pin" ? e.p.kind !== "info" : (e.it.a.points_possible ?? 0) > 0))
        .map((e) => {
          if (e.type === "asg") {
            const h = hoursFor(e.it.a, work[`${e.it.a.course_id}:${e.it.a.id}`]?.hours, estimates);
            return { key: e.key, title: e.it.a.name, due: e.due as number, hours: h.hours, exam: h.kind === "exam", open: true };
          }
          const kind = e.p.kind === "exam" ? "exam" : e.p.kind === "quiz" ? "quiz" : "other";
          return { key: e.key, title: e.p.label, due: e.due, hours: defaultHours(kind, estimates), exam: e.p.kind === "exam" || e.p.kind === "quiz", open: true };
        }),
    [list, now, work, estimates],
  );
}

/** 14 days of workload: bar height = hours of work due that day; ! = exam or quiz. */
function Workload({ list, load, now, onPick }: { list: Entry[]; load: LoadItem[]; now: number; onPick: (key: string) => void }) {
  const days = useMemo(() => loadByDay(load, now, 14), [load, now]);
  const warn = useMemo(() => collisions(days, load).filter((c) => c.day < now + 14 * DAY), [days, load, now]);
  const max = Math.max(8, ...days.map((x) => x.hours));
  const week = days.slice(0, 7).reduce((s, d) => s + d.hours, 0);
  return (
    <>
      <div className="strip-head small">
        <span className="dim">
          About <b>{fmtHours(Math.round(week))}</b> of work due in the next 7 days
        </span>
        <span className="strip-key muted">
          <i className="lv lv-light" /> under 4 h <i className="lv lv-busy" /> 4–8 h <i className="lv lv-heavy" /> 8 h+ <b className="exam-key">!</b> exam or quiz
        </span>
      </div>
      <div className="strip" role="list" aria-label="Hours of work due each day, next 14 days">
        {days.map((x, i) => {
          const k = dayKey(x.day);
          const es = list.filter((e) => e.due != null && dayKey(e.due) === k && entryNeedsAction(e, now));
          const exam = x.items.some((it) => it.exam);
          const heat = es.reduce<Heat>((h, e) => (HEAT_RANK[e.heat] > HEAT_RANK[h] ? e.heat : h), "none");
          const label = x.count ? `${fmtDay(x.day, now)}: about ${fmtHours(Math.round(x.hours * 2) / 2)} of work\n${x.items.map((it) => `• ${it.title} (≈ ${fmtHours(it.hours)})`).join("\n")}` : `${fmtDay(x.day, now)}: nothing due`;
          return (
            <button key={k} role="listitem" className={`day heat-${heat} lv-${x.level}${i === 0 ? " today" : ""}`} onClick={() => onPick(k)} title={label} aria-label={label}>
              <span className="hrs num">{x.hours > 0 ? `${Math.round(x.hours)}h` : ""}</span>
              <div className="bar-wrap">
                {exam && <span className="exam-mark">!</span>}
                <div className="bar" style={{ height: `${Math.round((x.hours / max) * 100)}%` }} />
              </div>
              <span className="lbl">{i === 0 ? "Today" : new Intl.DateTimeFormat(undefined, { weekday: "narrow" }).format(x.day) + " " + new Date(x.day).getDate()}</span>
            </button>
          );
        })}
      </div>
      {warn.length > 0 && (
        <div className="collisions" role="note">
          {warn.slice(0, 3).map((c) => (
            <button key={c.day} className="collision" onClick={() => onPick(dayKey(c.day))}>
              <TriangleAlert size={13} />
              <span>
                <b>{dayLabel(c.day, now)}</b>: {c.text}. Start earlier in the week.
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Readings and pages your modules still want you to view or mark done. */
function Readings({ now }: { now: number }) {
  const dash = useStore((s) => s.dash);
  const modules = useStore((s) => s.modules);
  const ids = (dash?.courses ?? []).filter((c) => !c.hidden).map((c) => c.id);
  const key = ids.join(",");
  useEffect(() => {
    if (ids.length) loadModules(ids).catch(() => {});
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = ids.flatMap((id) =>
    (modules[id]?.modules ?? [])
      .filter((m) => m.state !== "locked" && m.state !== "completed")
      .flatMap((m) => m.items.filter(isReading).map((it) => ({ it, courseId: id, module: m.name }))),
  );
  if (!items.length) return null;
  const byId = new Map((dash?.courses ?? []).map((c) => [c.id, c]));
  return (
    <section className="panel">
      <div className="panel-head">
        <BookOpen size={15} />
        <h2>Readings to do</h2>
        <span className="count-pill">{items.length}</span>
      </div>
      {items.slice(0, 6).map(({ it, courseId, module }) => {
        const c = byId.get(courseId);
        const due = parse(it.content_details?.due_at);
        return (
          <div key={`${courseId}:${it.id}`} className="mini-row reading">
            <div className="top">
              <button className="linkish t ellipsis" onClick={() => openItem(it)} title="Open in Canvas">
                {it.title}
              </button>
              <button className="btn btn-xs" onClick={() => markItem(courseId, it)} title={it.completion_requirement?.type === "must_view" ? "Tell Canvas you've viewed it" : "Mark done in Canvas"}>
                <Check size={12} /> {it.completion_requirement?.type === "must_view" ? "Viewed" : "Done"}
              </button>
            </div>
            <div className="preview">
              {c?.course_code || c?.name} · {module}
              {due ? ` · due ${fmtWhen(due, now)}` : ""}
            </div>
          </div>
        );
      })}
      {items.length > 6 && (
        <button className="mini-row" onClick={() => navigate({ view: "course", courseId: items[6].courseId, tab: "modules" })}>
          <span className="small muted">and {items.length - 6} more in Modules</span>
        </button>
      )}
    </section>
  );
}

/** Office hours you've confirmed, today and the next few days. */
function OfficeHoursCard({ now }: { now: number }) {
  const oh = useStore((s) => s.officeHours);
  const dash = useStore((s) => s.dash);
  const slots = useMemo(() => ohSlots(oh.filter((o) => !dash?.courses.find((c) => c.id === o.courseId)?.hidden), now, now + 7 * DAY).slice(0, 4), [oh, now, dash]);
  if (!slots.length) return null;
  return (
    <section className="panel">
      <div className="panel-head">
        <Users size={15} />
        <h2>Office hours</h2>
        <div className="right">
          <button className="btn btn-sm btn-ghost" onClick={() => navigate({ view: "dates" })}>
            Edit
          </button>
        </div>
      </div>
      {slots.map((s) => {
        const c = dash?.courses.find((x) => x.id === s.oh.courseId);
        const live = s.start <= now && now < s.end;
        return (
          <div key={`${s.oh.id}:${s.start}`} className={`mini-row${live ? " unread" : ""}`}>
            <div className="top">
              <span className="t ellipsis">{c?.course_code || c?.name}</span>
              <span className={`when${live ? " text-ok" : ""}`} style={live ? { fontWeight: 700 } : undefined}>
                {live ? `Now, until ${fmtHm(s.oh.end)}` : `${fmtWhen(s.start, now)}–${fmtHm(s.oh.end)}`}
              </span>
            </div>
            <div className="preview">{[s.oh.who, s.oh.location].filter(Boolean).join(" · ") || "Office hours"}</div>
          </div>
        );
      })}
    </section>
  );
}

export function Today() {
  const dash = useStore((s) => s.dash);
  const pinned = useStore((s) => s.pinned);
  const unread = useStore((s) => s.unread);
  const gmail = useStore((s) => s.gmail);
  const mailUnread = useStore((s) => s.mailUnread);
  const scanning = useStore((s) => s.scanning);
  const now = useNow(30_000);
  const [showDone, setShowDone] = useState(true);
  const [mode, setMode] = useState<"list" | "gravity">(() => {
    try {
      return (localStorage.getItem("today-mode") as "list" | "gravity") || "list";
    } catch {
      return "list";
    }
  });
  const [unreadConvs, setUnreadConvs] = useState<Conversation[] | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem("today-mode", mode);
    } catch {
      /* not essential */
    }
  }, [mode]);

  useEffect(() => {
    let live = true;
    api
      .listConversations("unread", null, null)
      .then((p) => live && setUnreadConvs(p.items.slice(0, 5)))
      .catch(() => live && setUnreadConvs([]));
    return () => {
      live = false;
    };
  }, [unread]);

  const all = useMemo(() => entries(dash, pinned, now), [dash, pinned, now]);
  const load = useLoadItems(all, now);

  const { overdue, groups, stats } = useMemo(() => {
    const withDue = all.filter((e) => e.due != null);
    const overdue = withDue
      .filter((e) => e.type === "asg" && e.it.s.late && (e.it.s.needsAction || ((e.it.s.kind === "closed" || e.it.s.kind === "missing") && now - (e.due as number) < 7 * DAY)))
      .sort((a, b) => (a.due as number) - (b.due as number));
    const ahead = withDue
      .filter((e) => !overdue.includes(e))
      .filter((e) => (e.type === "pin" ? entryNeedsAction(e, now) || e.p.kind === "info" : (e.due as number) >= now) && (e.due as number) - now <= 14 * DAY)
      .filter((e) => (e.type === "pin" ? new Date(e.due).setHours(23, 59) >= now : true))
      .sort((a, b) => (a.due as number) - (b.due as number));
    const groups = new Map<string, Entry[]>();
    for (const e of ahead) {
      if (!showDone && e.type === "asg" && !e.it.s.needsAction) continue;
      const k = dayKey(e.due as number);
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    const open = overdue.filter((e) => e.type === "asg" && e.it.s.needsAction).length;
    const act = ahead.filter((e) => entryNeedsAction(e, now) && e.type === "asg");
    const week = act.filter((e) => (e.due as number) - now <= 7 * DAY).length;
    const today = act.filter((e) => dayKey(e.due as number) === dayKey(now)).length;
    return { overdue, groups: [...groups.entries()], stats: { open, week, today } };
  }, [all, now, showDone]);

  const graded = useMemo(
    () =>
      all
        .flatMap((e) => (e.type === "asg" ? [e.it] : []))
        .filter((it) => it.s.kind === "graded" && parse(it.a.submission?.graded_at) != null && now - (parse(it.a.submission?.graded_at) as number) < 14 * DAY)
        .sort((x, y) => (parse(y.a.submission?.graded_at) ?? 0) - (parse(x.a.submission?.graded_at) ?? 0))
        .slice(0, 6),
    [all, now],
  );
  const courseOfCode = (code?: string | null) => dash?.courses.find((c) => `course_${c.id}` === code);
  const anns = (dash?.announcements ?? []).filter((a) => !courseOfCode(a.context_code)?.hidden).slice(0, 6);
  const keyDates = all.filter((e): e is Extract<Entry, { type: "pin" }> => e.type === "pin" && entryNeedsAction(e, now)).sort((a, b) => a.due - b.due).slice(0, 5);

  const jumpTo = (k: string) => {
    if (mode !== "list") setMode("list");
    setTimeout(() => document.getElementById(`day-${k}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  if (!dash) return <TodaySkeleton />;

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Today</h1>
          <div className="sub">{fmtFullDate(now)}</div>
        </div>
        <div className="actions summary">
          <div className={`stat${stats.open ? " danger" : ""}`}>
            <b>{stats.open}</b> overdue
          </div>
          <div className={`stat${stats.today ? " warn" : ""}`}>
            <b>{stats.today}</b> due today
          </div>
          <div className="stat" title="Hours are estimates: yours where you set one, otherwise typical for the kind of work">
            <b>{stats.week}</b> due in 7 days
          </div>
          <div className="stat" title="Unread Canvas messages">
            <b>{unread ?? "–"}</b> Canvas unread
          </div>
          {gmail?.connected && (
            <div className="stat" title="Unread email in your school Gmail inbox">
              <b>{mailUnread ?? "–"}</b> email unread
            </div>
          )}
        </div>
      </header>
      <div className="content pad">
        <NextUp list={all} now={now} />
        <div className="today-grid">
          <section className="panel">
            <div className="panel-head">
              <h2>Next two weeks</h2>
              <div className="right">
                {mode === "list" && (
                  <label className="check small" style={{ marginRight: 8 }}>
                    <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
                    Show submitted
                  </label>
                )}
                <div className="seg" role="tablist" aria-label="View">
                  <button className={mode === "list" ? "active" : ""} onClick={() => setMode("list")} title="List">
                    <List size={13} style={{ verticalAlign: -2 }} /> List
                  </button>
                  <button className={mode === "gravity" ? "active" : ""} onClick={() => setMode("gravity")} title="Deadline gravity">
                    <Orbit size={13} style={{ verticalAlign: -2 }} /> Gravity
                  </button>
                </div>
              </div>
            </div>
            <Workload list={all} load={load} now={now} onPick={jumpTo} />
            {mode === "gravity" ? (
              <Gravity list={all} now={now} />
            ) : (
              <div className="list">
                {overdue.length > 0 && (
                  <>
                    <div className="group-label danger">
                      Past due <span className="muted">{plural(overdue.length, "item")}</span>
                    </div>
                    {overdue.map((e) => (
                      <EntryRow key={e.key} e={e} now={now} />
                    ))}
                  </>
                )}
                {groups.map(([k, list]) => (
                  <div key={k} className="list">
                    <div className="group-label" id={`day-${k}`}>
                      {dayLabel(list[0].due as number, now)}
                      <span className="muted">{plural(list.length, "item")}</span>
                    </div>
                    {list.map((e) => (
                      <EntryRow key={e.key} e={e} now={now} />
                    ))}
                  </div>
                ))}
                {overdue.length === 0 && groups.length === 0 && <Empty title="Nothing due in the next two weeks">{showDone ? "Enjoy it." : "Everything due is already submitted."}</Empty>}
              </div>
            )}
          </section>

          <aside className="side-cards">
            <WhatChanged now={now} />
            <OfficeHoursCard now={now} />
            <Readings now={now} />
            <section className="panel">
              <div className="panel-head">
                <CalendarClock size={15} />
                <h2>Key dates</h2>
                <div className="right">
                  <button className="btn btn-sm btn-ghost" onClick={() => navigate({ view: "dates" })}>
                    All
                  </button>
                </div>
              </div>
              {keyDates.length === 0 ? (
                <div className="panel-body stack" style={{ gap: 8 }}>
                  <div className="small muted">Exams and milestones from your syllabi and course outlines show here once you pin them.</div>
                  <div>
                    <button
                      className="btn btn-sm"
                      disabled={!!scanning}
                      onClick={() => {
                        navigate({ view: "dates" });
                        void runScan();
                      }}
                    >
                      <ScanSearch size={14} /> {scanning ? "Scanning…" : "Scan my courses"}
                    </button>
                  </div>
                </div>
              ) : (
                keyDates.map((e) => (
                  <button key={e.key} className="mini-row" onClick={() => navigate({ view: "dates" })}>
                    <div className="top">
                      <span className={`kind-chip kind-${e.p.kind}`}>{KIND_LABEL[e.p.kind]}</span>
                      <span className="t ellipsis">{e.p.label}</span>
                      <span className={`when heat-${e.heat}`}>
                        <span className="heat-text" style={{ fontWeight: 600 }}>{relative(e.due, now)}</span>
                      </span>
                    </div>
                    <div className="preview">
                      {e.course?.course_code} · {fmtDay(e.due, now)}
                      {e.p.time ? `, ${fmtTime(e.due)}` : ""}
                      {e.p.weight ? ` · ${e.p.weight}` : ""}
                    </div>
                  </button>
                ))
              )}
            </section>

            <section className="panel">
              <div className="panel-head">
                <MessageSquare size={15} />
                <h2>Unread Canvas messages</h2>
                <div className="right">
                  <button className="btn btn-sm btn-ghost" onClick={() => navigate({ view: "inbox" })}>
                    Open inbox
                  </button>
                </div>
              </div>
              {unreadConvs == null ? (
                <div className="panel-body">
                  <div className="skel" style={{ width: "60%" }} />
                </div>
              ) : unreadConvs.length === 0 ? (
                <div className="panel-body muted small">No unread messages.</div>
              ) : (
                unreadConvs.map((c) => (
                  <button key={c.id} className="mini-row unread" onClick={() => navigate({ view: "inbox", conversationId: c.id })}>
                    <div className="top">
                      <span className="t ellipsis">{c.subject || "(no subject)"}</span>
                      <span className="when">{c.last_message_at ? fmtListTime(parse(c.last_message_at) as number, now) : ""}</span>
                    </div>
                    <div className="preview">
                      {c.participants
                        .filter((p) => p.id !== dash.userId)
                        .map((p) => p.name)
                        .join(", ")}{" "}
                      · {c.last_message}
                    </div>
                  </button>
                ))
              )}
            </section>

            <section className="panel">
              <div className="panel-head">
                <Megaphone size={15} />
                <h2>Announcements</h2>
              </div>
              {anns.length === 0 ? (
                <div className="panel-body muted small">No announcements in the last three weeks.</div>
              ) : (
                anns.map((a) => {
                  const c = courseOfCode(a.context_code);
                  return (
                    <button key={a.id} className={`mini-row${a.read_state === "unread" ? " unread" : ""}`} onClick={() => c && navigate({ view: "course", courseId: c.id })}>
                      <div className="top">
                        <span className="t ellipsis">{a.title}</span>
                        <span className="when">{a.posted_at ? fmtListTime(parse(a.posted_at) as number, now) : ""}</span>
                      </div>
                      <div className="preview">
                        {c ? `${c.course_code || c.name} · ` : ""}
                        {htmlToText(a.message).slice(0, 180)}
                      </div>
                    </button>
                  );
                })
              )}
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>Recently graded</h2>
              </div>
              {graded.length === 0 ? (
                <div className="panel-body muted small">No grades released in the last two weeks.</div>
              ) : (
                graded.map((it) => (
                  <button key={it.a.id} className="mini-row" onClick={() => navigate({ view: "course", courseId: it.a.course_id, assignmentId: it.a.id })}>
                    <div className="top">
                      <span className="t ellipsis">{it.a.name}</span>
                      <span className="when text-ok" style={{ fontWeight: 600 }}>
                        {it.s.label}
                      </span>
                    </div>
                    <div className="preview">{it.course?.course_code || it.course?.name}</div>
                  </button>
                ))
              )}
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}

function TodaySkeleton() {
  return (
    <>
      <header className="topbar">
        <h1>Today</h1>
      </header>
      <div className="content pad">
        <div className="panel" style={{ maxWidth: 900 }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} style={{ display: "flex", gap: 12, padding: "14px" }}>
              <div className="skel" style={{ width: 90 }} />
              <div className="skel" style={{ flex: 1, maxWidth: 360 - i * 30 }} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
