// Canvas modules: readings, pages and files as things to tick off.

import { BookOpen, Check, CircleCheck, ExternalLink, File, FileText, Link2, ListChecks, MessageSquare, PenLine, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { loadModules, reportError, setState, useStore } from "../lib/store.ts";
import { fmtWhen, parse } from "../lib/time.ts";
import type { Course, Module, ModuleItem } from "../lib/types.ts";
import { Empty, Spinner } from "./common.tsx";

const ICON: Record<string, typeof File> = { Page: FileText, File: File, ExternalUrl: Link2, ExternalTool: Link2, Assignment: PenLine, Quiz: ListChecks, Discussion: MessageSquare };
const REQ: Record<string, string> = { must_view: "View", must_mark_done: "Mark done", must_submit: "Submit", must_contribute: "Post", min_score: "Score" };

/** Items you can finish from Studydesk: readings, pages, files, links. */
export function isReading(it: ModuleItem): boolean {
  return ["Page", "File", "ExternalUrl", "ExternalTool"].includes(it.type) && !!it.completion_requirement && !it.completion_requirement.completed;
}

export function markItem(courseId: number, it: ModuleItem) {
  const view = it.completion_requirement?.type !== "must_mark_done";
  const flip = (done: boolean) =>
    setState((s) => {
      const cm = s.modules[courseId];
      if (!cm) return {};
      const modules = cm.modules.map((m) =>
        m.id !== it.module_id ? m : { ...m, items: m.items.map((x) => (x.id === it.id && x.completion_requirement ? { ...x, completion_requirement: { ...x.completion_requirement, completed: done } } : x)) },
      );
      return { modules: { ...s.modules, [courseId]: { ...cm, modules } } };
    });
  flip(true);
  return api.moduleItemComplete(courseId, it.module_id, it.id, view).catch((e) => {
    flip(false);
    reportError(e, "Couldn't update Canvas");
  });
}

export function openItem(it: ModuleItem) {
  if (it.html_url) api.openInCanvas(it.html_url).catch((e) => reportError(e));
}

export function ModulesView({ course, onOpenAssignment }: { course: Course; onOpenAssignment: (id: number) => void }) {
  const cm = useStore((s) => s.modules[course.id]);
  const [busy, setBusy] = useState(false);
  const [showDone, setShowDone] = useState(false);

  const load = (force = false) => {
    setBusy(true);
    loadModules([course.id], force)
      .catch((e) => reportError(e, "Couldn't load modules"))
      .finally(() => setBusy(false));
  };
  useEffect(() => load(), [course.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cm)
    return (
      <div className="panel">
        <Empty title="Loading modules…">{busy ? <Spinner /> : null}</Empty>
      </div>
    );

  const mods = [...cm.modules].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const todo = mods.reduce((n, m) => n + m.items.filter((i) => i.completion_requirement && !i.completion_requirement.completed).length, 0);

  return (
    <div className="panel">
      <div className="toolbar">
        <span className="small dim">{cm.note ?? (todo ? `${todo} to do across ${mods.length} modules` : "All module requirements done")}</span>
        <label className="check small" style={{ marginLeft: "auto" }}>
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show finished modules
        </label>
        <button className="icon-btn sm" onClick={() => load(true)} disabled={busy} aria-label="Refresh modules" title="Refresh modules">
          <RefreshCw size={14} className={busy ? "spin" : ""} />
        </button>
      </div>
      <div className="scroll">
        {mods.length === 0 ? (
          <Empty title="No modules">{cm.note ?? "This course doesn't use modules."}</Empty>
        ) : (
          <div className="modules">
            {mods
              .filter((m) => showDone || m.state !== "completed" || m.items.some((i) => i.completion_requirement && !i.completion_requirement.completed))
              .map((m) => (
                <ModuleBlock key={m.id} m={m} course={course} onOpenAssignment={onOpenAssignment} />
              ))}
            {!showDone && mods.every((m) => m.state === "completed") && <Empty title="All caught up">Every module is finished. Tick “Show finished modules” to look back.</Empty>}
          </div>
        )}
      </div>
    </div>
  );
}

function ModuleBlock({ m, course, onOpenAssignment }: { m: Module; course: Course; onOpenAssignment: (id: number) => void }) {
  const req = m.items.filter((i) => i.completion_requirement);
  const done = req.filter((i) => i.completion_requirement?.completed).length;
  const unlock = parse(m.unlock_at);
  return (
    <section className="module">
      <div className="mod-head">
        <BookOpen size={15} className="muted" />
        <b className="grow">{m.name}</b>
        {m.state === "locked" && <span className="chip chip-xs">Locked{unlock ? ` until ${fmtWhen(unlock)}` : ""}</span>}
        {req.length > 0 && (
          <>
            <div className="mini-bar" aria-hidden>
              <div style={{ width: `${(done / req.length) * 100}%` }} />
            </div>
            <span className="small muted num">
              {done}/{req.length}
            </span>
          </>
        )}
      </div>
      <ul className="mod-items">
        {m.items.map((it) => {
          if (it.type === "SubHeader")
            return (
              <li key={it.id} className="mod-sub">
                {it.title}
              </li>
            );
          const Icon = ICON[it.type] ?? File;
          const r = it.completion_requirement;
          const due = parse(it.content_details?.due_at);
          const isAsg = (it.type === "Assignment" || it.type === "Quiz") && it.content_id != null;
          return (
            <li key={it.id} className={`mod-item${r?.completed ? " done" : ""}`} style={{ paddingLeft: 10 + (it.indent ?? 0) * 16 }}>
              {r ? r.completed ? <CircleCheck size={15} className="text-ok" aria-label="Done" /> : <span className="ring" aria-label="To do" /> : <span style={{ width: 15 }} />}
              <Icon size={14} className="muted" />
              <button className="linkish grow ellipsis" title={it.title} onClick={() => (isAsg && it.type === "Assignment" ? onOpenAssignment(it.content_id as number) : openItem(it))}>
                {it.title}
              </button>
              {due != null && <span className="small muted">due {fmtWhen(due)}</span>}
              {r && !r.completed && r.type !== "must_view" && r.type !== "must_mark_done" && <span className="small muted">{REQ[r.type ?? ""] ?? ""}</span>}
              {r && !r.completed && (r.type === "must_view" || r.type === "must_mark_done") && (
                <button className="btn btn-xs" onClick={() => markItem(course.id, it)} title={r.type === "must_view" ? "Tell Canvas you've viewed it" : "Mark done in Canvas"}>
                  <Check size={12} /> {r.type === "must_view" ? "Viewed" : "Done"}
                </button>
              )}
              {it.html_url && !isAsg && (
                <button className="icon-btn xs" onClick={() => openItem(it)} aria-label={`Open ${it.title} in Canvas`} title="Open in Canvas">
                  <ExternalLink size={12} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
