import { BookOpen, CalendarClock, CalendarDays, FileText, Inbox, Lock, PenLine, RefreshCw, Search, Settings } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { items } from "../lib/derive.ts";
import { getState, lockNow, navigate, runScan, setState, sync, useStore } from "../lib/store.ts";
import { fmtDay, relative } from "../lib/time.ts";
import { fuzzyScore } from "../lib/util.ts";
import { StatusChip } from "./common.tsx";

interface Opt {
  id: string;
  group: string;
  label: string;
  hint?: ReactNode;
  icon: ReactNode;
  run: () => void;
  score?: number;
}

export function Palette() {
  const dash = useStore((s) => s.dash);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => setState({ paletteOpen: false });
  const now = Date.now();

  const opts = useMemo<Opt[]>(() => {
    const base: Opt[] = [
      { id: "today", group: "Go to", label: "Today", icon: <CalendarDays size={15} />, run: () => navigate({ view: "today" }) },
      { id: "inbox", group: "Go to", label: "Inbox", icon: <Inbox size={15} />, run: () => navigate({ view: "inbox" }) },
      { id: "dates", group: "Go to", label: "Key dates", icon: <CalendarClock size={15} />, run: () => navigate({ view: "dates" }) },
      { id: "settings", group: "Go to", label: "Settings", icon: <Settings size={15} />, run: () => navigate({ view: "settings" }) },
      ...(dash?.courses ?? [])
        .filter((c) => !c.hidden)
        .map((c) => ({
          id: `c${c.id}`,
          group: "Courses",
          label: `${c.course_code ? `${c.course_code} – ` : ""}${c.name}`,
          icon: <BookOpen size={15} />,
          run: () => navigate({ view: "course", courseId: c.id }),
        })),
      { id: "new", group: "Actions", label: "New message", hint: "Ctrl N", icon: <PenLine size={15} />, run: () => setState({ compose: {}, paletteOpen: false }) },
      { id: "sync", group: "Actions", label: "Refresh from Canvas", hint: "F5", icon: <RefreshCw size={15} />, run: () => (close(), sync()) },
      ...(getState().hasPassphrase ? [{ id: "lock", group: "Actions", label: "Lock Studydesk", hint: "Ctrl L", icon: <Lock size={15} />, run: () => lockNow() }] : []),
      { id: "scan", group: "Actions", label: "Scan courses for key dates", icon: <CalendarClock size={15} />, run: () => (navigate({ view: "dates" }), void runScan()) },
    ];
    const asg: Opt[] = items(dash, now).map((it) => ({
      id: `a${it.a.id}`,
      group: "Assignments",
      label: it.a.name,
      hint: (
        <span className="row-flex" style={{ gap: 8 }}>
          {it.course?.course_code}
          {it.due != null && <span>{fmtDay(it.due, now)} · {relative(it.due, now)}</span>}
          <StatusChip s={it.s} />
        </span>
      ),
      icon: <FileText size={15} />,
      run: () => navigate({ view: "course", courseId: it.a.course_id, assignmentId: it.a.id }),
    }));
    if (!q.trim()) {
      // Without a query: navigation, then the next things that need action.
      const next = items(dash, now)
        .filter((i) => i.s.needsAction && i.due != null)
        .sort((a, b) => (a.due as number) - (b.due as number))
        .slice(0, 6)
        .map((i) => asg.find((o) => o.id === `a${i.a.id}`)!)
        .map((o) => ({ ...o, group: "Needs action" }));
      return [...base.filter((o) => o.group !== "Courses"), ...next, ...base.filter((o) => o.group === "Courses")];
    }
    return [...base, ...asg]
      .map((o) => ({ ...o, score: fuzzyScore(q, o.label) + (o.group === "Go to" ? 5 : 0) }))
      .filter((o) => o.score > 0)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 40);
  }, [dash, q]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".po.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (o?: Opt) => {
    if (!o) return;
    close();
    o.run();
  };

  let lastGroup = "";
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Search and jump">
        <div className="pi">
          <Search size={16} className="muted" />
          <input
            autoFocus
            placeholder="Search courses, assignments, actions…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setActive(Math.min(opts.length - 1, active + 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setActive(Math.max(0, active - 1)));
              else if (e.key === "Enter") (e.preventDefault(), run(opts[active]));
              else if (e.key === "Escape") close();
            }}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="pl" ref={listRef}>
          {opts.length === 0 && <div className="empty">No matches</div>}
          {opts.map((o, i) => {
            const head = o.group !== lastGroup ? <div className="pg">{o.group}</div> : null;
            lastGroup = o.group;
            return (
              <div key={o.id + o.group}>
                {head}
                <button className={`po${i === active ? " active" : ""}`} onMouseMove={() => setActive(i)} onClick={() => run(o)}>
                  <span className="muted">{o.icon}</span>
                  <span className="ellipsis">{o.label}</span>
                  {o.hint && <span className="hint">{o.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
