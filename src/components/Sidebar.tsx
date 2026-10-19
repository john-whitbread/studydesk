import { CalendarClock, CalendarDays, Inbox, Lock, Mail, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, Settings, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { actionCounts, items, visibleCourses } from "../lib/derive.ts";
import { lockNow, navigate, setState, sync, useStore } from "../lib/store.ts";
import { relative } from "../lib/time.ts";
import { courseColor, railLabels } from "../lib/util.ts";
import { pinDue } from "../lib/entries.ts";
import { useNow } from "./common.tsx";

export function Sidebar() {
  const dash = useStore((s) => s.dash);
  const route = useStore((s) => s.route);
  const unread = useStore((s) => s.unread);
  const syncing = useStore((s) => s.syncing);
  const syncError = useStore((s) => s.syncError);
  const gmail = useStore((s) => s.gmail);
  const mailUnread = useStore((s) => s.mailUnread);
  const hasPassphrase = useStore((s) => s.hasPassphrase);
  const pinned = useStore((s) => s.pinned);
  const now = useNow(30_000);
  const sideOpen = useStore((s) => s.sideOpen);
  const go = (r: Parameters<typeof navigate>[0]) => {
    navigate(r);
    if (sideOpen) setState({ sideOpen: false });
  };

  const courses = visibleCourses(dash);
  const rail = useMemo(() => railLabels(courses), [courses]);
  const counts = useMemo(() => {
    const all = items(dash, now);
    const per = new Map<number, ReturnType<typeof actionCounts>>();
    for (const c of courses) per.set(c.id, actionCounts(all.filter((i) => i.a.course_id === c.id), now));
    return { all: actionCounts(all, now), per };
  }, [dash, now, courses]);

  const total = counts.all.overdue + counts.all.soon;
  const pinnedSoon = pinned.filter((p) => {
    const t = pinDue(p);
    return t >= now - 12 * 3600_000 && t - now <= 7 * 86_400_000 && p.kind !== "info";
  }).length;

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="side-top">
        <button
          className="icon-btn rail-toggle"
          onClick={() => setState({ sideOpen: !sideOpen })}
          title={sideOpen ? "Collapse sidebar" : "Expand sidebar"}
          aria-label={sideOpen ? "Collapse sidebar" : "Expand sidebar"}
          aria-expanded={sideOpen}
        >
          {sideOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
        </button>
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </span>
          Studydesk
        </div>
        <button className="jump" onClick={() => setState({ paletteOpen: true, sideOpen: false })} title="Search (Ctrl K)">
          <Search size={14} />
          <span className="grow ellipsis nl">Search…</span>
          <span className="kbd">Ctrl K</span>
        </button>
      </div>

      <div className="side-scroll">
        <button className={`nav-item${route.view === "today" ? " active" : ""}`} onClick={() => go({ view: "today" })} aria-label="Today" data-tip="Today">
          <CalendarDays size={16} />
          <span className="nl">Today</span>
          {total > 0 && (
            <span className={`count${counts.all.overdue ? " hot" : ""}`} title={`${counts.all.overdue} overdue, ${counts.all.soon} due in the next 7 days`}>
              {total}
            </span>
          )}
        </button>
        <button className={`nav-item${route.view === "dates" ? " active" : ""}`} onClick={() => go({ view: "dates" })} aria-label="Key dates" data-tip="Key dates">
          <CalendarClock size={16} />
          <span className="nl">Key dates</span>
          {pinnedSoon > 0 && <span className="count" title="Pinned key dates in the next 7 days">{pinnedSoon}</span>}
        </button>
        <button className={`nav-item${route.view === "inbox" ? " active" : ""}`} onClick={() => go({ view: "inbox" })} aria-label="Canvas inbox" data-tip="Canvas inbox">
          <Inbox size={16} />
          <span className="nl">Canvas inbox</span>
          {!!unread && <span className="count badge" title={`${unread} unread`}>{unread > 999 ? "999+" : unread}</span>}
        </button>
        <button className={`nav-item${route.view === "mail" ? " active" : ""}`} onClick={() => go({ view: "mail" })} aria-label="Email" data-tip="Email">
          <Mail size={16} />
          <span className="nl">Email</span>
          {gmail?.connected ? (
            !!mailUnread && <span className="count badge" title={`${mailUnread} unread`}>{mailUnread > 999 ? "999+" : mailUnread}</span>
          ) : (
            <span className="count" style={{ fontWeight: 400 }}>Set up</span>
          )}
        </button>

        <div className="side-label">Courses</div>
        {!dash && syncing && [0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ margin: "12px 8px", width: `${70 - i * 8}%` }} />)}
        {courses.map((c) => {
          const n = counts.per.get(c.id) ?? { overdue: 0, soon: 0 };
          const active = route.view === "course" && route.courseId === c.id;
          return (
            <button key={c.id} className={`nav-item course-item${active ? " active" : ""}`} onClick={() => go({ view: "course", courseId: c.id })} title={c.full_name || c.name}>
              <span className="dot" style={{ background: courseColor(c) }} />
              <span className="ci-rail" aria-hidden>{rail.get(c.id)}</span>
              <span className="ci-text">
                <span className="ci-code ellipsis">{c.course_code || c.name}</span>
                {c.course_code && c.course_code !== c.name && <span className="ci-name ellipsis">{c.name}</span>}
              </span>
              {n.overdue + n.soon > 0 && (
                <span className={`count${n.overdue ? " hot" : ""}`} title={`${n.overdue} overdue, ${n.soon} due in the next 7 days`}>
                  {n.overdue + n.soon}
                </span>
              )}
            </button>
          );
        })}
        {dash && courses.length === 0 && <div className="muted small" style={{ padding: "4px 8px" }}>No current courses.</div>}
      </div>

      <div className="side-foot">
        <button className={`nav-item sync-line${syncError ? " err" : ""}`} onClick={() => sync()} title="Refresh from Canvas (F5)" disabled={syncing}>
          {syncError ? <TriangleAlert size={14} /> : <RefreshCw size={14} className={syncing ? "spin" : ""} />}
          <span className="ellipsis nl">{syncing ? "Updating…" : syncError ? "Couldn't update. Retry" : dash ? `Updated ${relative(dash.syncedAt, now)}` : "Not updated yet"}</span>
        </button>
        <button className={`nav-item${route.view === "settings" ? " active" : ""}`} onClick={() => go({ view: "settings" })} aria-label="Settings" data-tip="Settings">
          <Settings size={16} />
          <span className="nl">Settings</span>
        </button>
        {hasPassphrase && (
        <button className="nav-item" onClick={() => lockNow()} title="Lock (Ctrl+L)">
          <Lock size={16} />
          <span className="nl">Lock</span>
          <span className="count">
            <span className="kbd">Ctrl L</span>
          </span>
        </button>
        )}
      </div>
    </nav>
  );
}
