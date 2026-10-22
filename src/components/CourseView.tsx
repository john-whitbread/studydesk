import { ChevronDown, ChevronRight, ExternalLink, Megaphone, MessageSquare } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { items } from "../lib/derive.ts";
import { navigate, reportError, setState, useStore, type CourseTab } from "../lib/store.ts";
import { CourseGrades } from "./Grades.tsx";
import { ModulesView } from "./Modules.tsx";
import { fmtDateTime, fmtNum, parse } from "../lib/time.ts";
import type { Announcement, Course } from "../lib/types.ts";
import { courseColor, currentScore } from "../lib/util.ts";
import { AssignmentDetail } from "./AssignmentDetail.tsx";
import { AssignmentList } from "./AssignmentList.tsx";
import { Empty, Html, useNow } from "./common.tsx";
import { FilesPane } from "./FilesPane.tsx";

export function CourseView({ courseId, assignmentId, tab = "work" }: { courseId: number; assignmentId?: number; tab?: CourseTab }) {
  const dash = useStore((s) => s.dash);
  const allPins = useStore((s) => s.pinned);
  const pins = useMemo(() => allPins.filter((p) => p.courseId === courseId), [allPins, courseId]);
  const now = useNow(30_000);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** three: list | detail | files. two: list | (detail or files). one: a single pane at a time. */
  const [cols, setCols] = useState<1 | 2 | 3>(3);
  const [pane, setPane] = useState<"list" | "details" | "files">(assignmentId != null ? "details" : "list");

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = e.contentRect.width;
      setCols(w >= 1420 ? 3 : w >= 760 ? 2 : 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [dash != null, tab]);

  useEffect(() => {
    setPane(assignmentId != null ? "details" : "list");
  }, [assignmentId]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== "Escape" || assignmentId == null || tab !== "work" || t.closest("input, textarea, select, .modal, .palette")) return;
      navigate({ view: "course", courseId });
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [assignmentId, courseId, tab]);

  const course = dash?.courses.find((c) => c.id === courseId);
  const list = useMemo(() => items(dash, now, courseId), [dash, now, courseId]);
  const selected = list.find((i) => i.a.id === assignmentId)?.a ?? null;
  const anns = useMemo(
    () => (dash?.announcements ?? []).filter((a) => a.context_code === `course_${courseId}`).slice(0, 8),
    [dash, courseId],
  );

  if (!dash) return null;
  if (!course) return <Empty title="Course not found">It may have ended or been hidden. Check Settings → Courses.</Empty>;

  const select = (id: number) => {
    navigate({ view: "course", courseId, assignmentId: id, tab: "work" });
    setPane("details"); // also when re-picking the already-selected one
  };
  const close = () => navigate({ view: "course", courseId });
  const setTab = (t: CourseTab) => navigate({ view: "course", courseId, assignmentId: t === "work" ? assignmentId : undefined, tab: t });
  const onPin = () => navigate({ view: "dates" });
  const todoCount = list.filter((i) => i.s.needsAction).length;
  const { score, grade } = currentScore(course);

  const detail = selected && <AssignmentDetail key={selected.id} base={selected} course={course} now={now} onClose={close} />;
  const files = <FilesPane course={course} target={selected} />;

  return (
    <>
      <header className="topbar">
        <div className="course-head">
          <span className="dot" style={{ background: courseColor(course) }} />
          <div style={{ minWidth: 0 }}>
            <h1 className="ellipsis">{course.name}</h1>
            <div className="sub ellipsis">
              {course.course_code}
              {course.term?.name ? ` · ${course.term.name}` : ""}
            </div>
          </div>
        </div>
        <div className="actions">
          {(score != null || grade) && !course.hide_final_grades && (
            <div className="score" title="Current score as computed by Canvas (ungraded work excluded)">
              <b>{score != null ? `${fmtNum(score)}%` : grade}</b>
              <span>Current{grade && score != null ? ` · ${grade}` : ""}</span>
            </div>
          )}
          <button className="btn" onClick={() => setState({ compose: { courseId, teachers: true } })}>
            <MessageSquare size={15} /> Message instructor
          </button>
          <button className="btn" onClick={() => api.openInCanvas(`${dash.baseUrl}courses/${courseId}`).catch((e) => reportError(e))}>
            <ExternalLink size={15} /> Canvas
          </button>
        </div>
      </header>

      <div className="content" style={{ overflow: "hidden" }}>
        <div className="course-body" ref={bodyRef}>
          <div className="seg course-tabs" role="tablist" aria-label="Course sections">
            {(
              [
                ["work", "Work", todoCount || null],
                ["grades", "Grades", score != null && !course.hide_final_grades ? `${fmtNum(score)}%` : null],
                ["modules", "Modules", null],
              ] as [CourseTab, string, string | number | null][]
            ).map(([k, label, n]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
                {label}
                {n != null && <span className="n">{n}</span>}
              </button>
            ))}
          </div>
          {tab === "grades" ? (
            <CourseGrades course={course} onOpen={select} />
          ) : tab === "modules" ? (
            <ModulesView course={course} onOpenAssignment={select} />
          ) : (
          <>
          {anns.length > 0 && <Announcements course={course} anns={anns} now={now} />}
          {cols === 3 ? (
            <div className="cols three">
              <div className="col">
                <AssignmentList list={list} now={now} selectedId={assignmentId} onSelect={select} pins={pins} onPin={onPin} />
              </div>
              <div className="col">{detail ?? <SelectHint />}</div>
              <div className="col">{files}</div>
            </div>
          ) : cols === 2 ? (
            <div className="cols two">
              <div className="col">
                <AssignmentList list={list} now={now} selectedId={assignmentId} onSelect={select} pins={pins} onPin={onPin} />
              </div>
              <div className="col" style={{ gap: 8 }}>
                {selected && (
                  <div className="seg" style={{ alignSelf: "flex-start" }}>
                    <button className={pane !== "files" ? "active" : ""} onClick={() => setPane("details")}>
                      Details
                    </button>
                    <button className={pane === "files" ? "active" : ""} onClick={() => setPane("files")}>
                      Files
                    </button>
                  </div>
                )}
                {selected && pane !== "files" ? detail : files}
              </div>
            </div>
          ) : (
            <div className="cols one">
              <div className="col" style={{ gap: 8 }}>
                <div className="seg" style={{ alignSelf: "flex-start" }} role="tablist">
                  <button className={pane === "list" ? "active" : ""} onClick={() => setPane("list")}>
                    Assignments
                  </button>
                  {selected && (
                    <button className={pane === "details" ? "active" : ""} onClick={() => setPane("details")} title={selected.name}>
                      Details
                    </button>
                  )}
                  <button className={pane === "files" ? "active" : ""} onClick={() => setPane("files")}>
                    Files
                  </button>
                </div>
                {pane === "files" ? files : pane === "details" && selected ? detail : <AssignmentList list={list} now={now} selectedId={assignmentId} onSelect={select} pins={pins} onPin={onPin} />}
              </div>
            </div>
          )}
          </>
          )}
        </div>
      </div>
    </>
  );
}

function SelectHint() {
  return (
    <div className="panel">
      <Empty title="Select an assignment">Its due date, rules, feedback and submit box appear here. Use ↑ ↓ in the list to move quickly.</Empty>
    </div>
  );
}

function Announcements({ course, anns, now }: { course: Course; anns: Announcement[]; now: number }) {
  const unread = anns.filter((a) => a.read_state === "unread").length;
  const [open, setOpen] = useState(unread > 0);
  const [expanded, setExpanded] = useState<number | null>(null);

  const toggle = (a: Announcement) => {
    setExpanded(expanded === a.id ? null : a.id);
    if (a.read_state === "unread") {
      api.markAnnouncementRead(course.id, a.id).catch(() => {});
      setState((s) => ({
        dash: s.dash ? { ...s.dash, announcements: s.dash.announcements.map((x) => (x.id === a.id ? { ...x, read_state: "read" } : x)) } : s.dash,
      }));
    }
  };

  return (
    <section className="panel ann-strip">
      <button className="ann-btn" onClick={() => setOpen(!open)} aria-expanded={open} style={{ minHeight: 40 }}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <Megaphone size={15} />
        <b>Announcements</b>
        <span className="muted small">
          {anns.length} in the last 3 weeks{unread ? ` · ${unread} unread` : ""}
        </span>
      </button>
      {open && (
        <div style={{ maxHeight: 280, overflowY: "auto", borderTop: "1px solid var(--border)" }}>
          {anns.map((a) => (
            <div key={a.id} className="ann-item">
              <button className={`ann-btn${a.read_state === "unread" ? " unread" : ""}`} onClick={() => toggle(a)} aria-expanded={expanded === a.id}>
                {a.read_state === "unread" ? <span className="unread-dot" /> : <span style={{ width: 8 }} />}
                <span className="t grow ellipsis">{a.title}</span>
                <span className="small muted">
                  {a.author?.display_name ? `${a.author.display_name} · ` : ""}
                  {a.posted_at ? fmtDateTime(parse(a.posted_at) as number, now) : ""}
                </span>
              </button>
              {expanded === a.id && (
                <div className="ann-body">
                  <Html html={a.message} clamp />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
