import { CalendarClock, FolderOpen, List, Megaphone, MessageSquare, Orbit, ScanSearch, Target } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { DAY, type Item } from "../lib/derive.ts";
import { dropClass } from "../lib/drag.ts";
import { entries, entryNeedsAction, KIND_LABEL, type Entry } from "../lib/entries.ts";
import { heatOf, HEAT_LABEL, HEAT_RANK, type Heat } from "../lib/heat.ts";
import { acceptsUpload, kindLabel } from "../lib/status.ts";
import { navigate, reportError, runScan, setState, useStore } from "../lib/store.ts";
import { dayKey, dayLabel, fmtDay, fmtFullDate, fmtListTime, fmtNum, fmtTime, parse, relative } from "../lib/time.ts";
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
        <div className="lr-title ellipsis">{it.a.name}</div>
        <div className="lr-meta">
          {showCourse && it.course && (
            <span className="tag">
              <span className="dot" style={{ background: courseColor(it.course), width: 7, height: 7 }} />
              {it.course.course_code || it.course.name}
            </span>
          )}
          {it.a.points_possible != null && it.a.points_possible > 0 && <span>{fmtNum(it.a.points_possible)} pts</span>}
          {k && <span>{k}</span>}
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

/** 14 days of workload: bar height = points still to do; ! = exam or quiz. */
function Workload({ list, now, onPick }: { list: Entry[]; now: number; onPick: (key: string) => void }) {
  const days = Array.from({ length: 14 }, (_, i) => new Date(new Date(now).setHours(0, 0, 0, 0) + i * DAY + 3600_000).setHours(0, 0, 0, 0));
  const data = days.map((d) => {
    const k = dayKey(d);
    const es = list.filter((e) => e.due != null && dayKey(e.due) === k && entryNeedsAction(e, now));
    const pts = es.reduce((s, e) => s + (e.type === "asg" ? e.it.a.points_possible || 5 : e.p.kind === "exam" ? 30 : e.p.kind === "quiz" ? 10 : 5), 0);
    const exam = es.some((e) => e.type === "pin" && (e.p.kind === "exam" || e.p.kind === "quiz"));
    const heat = es.reduce<Heat>((h, e) => (HEAT_RANK[e.heat] > HEAT_RANK[h] ? e.heat : h), "none");
    return { d, k, es, pts, exam, heat };
  });
  const max = Math.max(20, ...data.map((x) => x.pts));
  return (
    <div className="strip" role="list" aria-label="Workload, next 14 days">
      {data.map((x, i) => (
        <button
          key={x.k}
          role="listitem"
          className={`day heat-${x.heat}${i === 0 ? " today" : ""}`}
          onClick={() => onPick(x.k)}
          title={x.es.length ? `${fmtDay(x.d, now)}\n${x.es.map((e) => `• ${e.type === "asg" ? e.it.a.name : `${KIND_LABEL[e.p.kind]}: ${e.p.label}`}`).join("\n")}` : `${fmtDay(x.d, now)}: nothing due`}
        >
          <div className="bar-wrap">
            {x.exam && <span className="exam-mark">!</span>}
            <div className="bar" style={{ height: `${Math.round((x.pts / max) * 100)}%` }} />
          </div>
          <span className="lbl">{i === 0 ? "Today" : new Intl.DateTimeFormat(undefined, { weekday: "narrow" }).format(x.d) + " " + new Date(x.d).getDate()}</span>
        </button>
      ))}
    </div>
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
          <div className="stat">
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
            <Workload list={all} now={now} onPick={jumpTo} />
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
