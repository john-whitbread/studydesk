// "What changed since you last looked": due dates moved, new or removed
// work, grades posted. Found by comparing each refresh with the last one.

import { ArrowRight, CalendarX, CheckCheck, FilePlus, FileX, GraduationCap, History } from "lucide-react";
import { markChangesSeen, navigate, useStore } from "../lib/store.ts";
import { fmtListTime, fmtWhen, parse } from "../lib/time.ts";
import type { Change } from "../lib/types.ts";
import { courseColor } from "../lib/util.ts";

export const CHANGE_LABEL: Record<Change["kind"], string> = {
  due_moved: "Due date moved",
  due_added: "Due date added",
  due_removed: "Due date removed",
  new: "New",
  removed: "Removed",
  graded: "Graded",
  regraded: "Grade changed",
};
const SHORT: Record<Change["kind"], string> = { due_moved: "Moved", due_added: "Dated", due_removed: "Undated", new: "New", removed: "Removed", graded: "Graded", regraded: "Regraded" };
const TONE: Record<Change["kind"], string> = { due_moved: "tone-warn", due_added: "tone-info", due_removed: "tone-warn", new: "tone-info", removed: "", graded: "tone-ok", regraded: "tone-ok" };
const ICON = { due_moved: History, due_added: History, due_removed: CalendarX, new: FilePlus, removed: FileX, graded: GraduationCap, regraded: GraduationCap };

const when = (iso: string | null, now: number) => {
  const t = parse(iso);
  return t == null ? "no date" : fmtWhen(t, now);
};

/** One line describing the change ("Thu 5:00 PM → Fri 5:00 PM", "13.5 points"). */
export function changeDetail(c: Change, now: number): string {
  switch (c.kind) {
    case "due_moved":
      return `${when(c.from, now)} → ${when(c.to, now)}`;
    case "due_added":
      return `Now due ${when(c.to, now)}`;
    case "due_removed":
      return `Was due ${when(c.from, now)}`;
    case "new":
      return c.to ? `Due ${when(c.to, now)}` : "No due date";
    case "removed":
      return "No longer in Canvas";
    case "graded":
      return c.to ? `Score: ${c.to}` : "Grade posted";
    case "regraded":
      return `${c.from ?? "?"} → ${c.to ?? "?"}`;
  }
}

/** Small chip for a row whose assignment changed and you haven't looked yet. */
export function ChangeChip({ c }: { c: Change }) {
  return (
    <span className={`chip chip-xs ${TONE[c.kind]}`} title={`${CHANGE_LABEL[c.kind]}: ${changeDetail(c, Date.now())}`}>
      {SHORT[c.kind]}
    </span>
  );
}

/** Unseen changes by assignment id (newest first). */
export function useUnseenChanges(): Map<number, Change> {
  const changes = useStore((s) => s.dash?.changes);
  const m = new Map<number, Change>();
  for (const c of changes ?? []) if (!c.seen && !m.has(c.assignmentId)) m.set(c.assignmentId, c);
  return m;
}

export function WhatChanged({ now }: { now: number }) {
  const dash = useStore((s) => s.dash);
  const all = (dash?.changes ?? []).filter((c) => !dash?.courses.find((x) => x.id === c.courseId)?.hidden);
  const unseen = all.filter((c) => !c.seen);
  const shown = (unseen.length ? unseen : all).slice(0, 6);
  if (all.length === 0) return null;
  return (
    <section className="panel">
      <div className="panel-head">
        <History size={15} />
        <h2>What changed</h2>
        {unseen.length > 0 && <span className="count-pill">{unseen.length}</span>}
        <div className="right">
          {unseen.length > 0 && (
            <button className="btn btn-sm btn-ghost" onClick={() => markChangesSeen()} title="Mark all as seen">
              <CheckCheck size={14} /> Seen
            </button>
          )}
        </div>
      </div>
      {unseen.length === 0 && <div className="panel-body small muted" style={{ paddingBottom: 4 }}>Nothing new since you last looked. Recent changes:</div>}
      {shown.map((c) => {
        const course = dash?.courses.find((x) => x.id === c.courseId);
        const Icon = ICON[c.kind];
        const exists = c.kind !== "removed" && dash?.assignments.some((a) => a.id === c.assignmentId);
        return (
          <button
            key={c.id}
            className={`mini-row${c.seen ? "" : " unread"}`}
            onClick={() => {
              if (!c.seen) void markChangesSeen([c.id]);
              if (exists) navigate({ view: "course", courseId: c.courseId, assignmentId: c.assignmentId });
            }}
          >
            <div className="top">
              <span className={`chip chip-xs ${TONE[c.kind]}`} style={{ marginLeft: 0 }}>
                <Icon size={10} /> {CHANGE_LABEL[c.kind]}
              </span>
              <span className="when">{fmtListTime(c.at, now)}</span>
            </div>
            <div className="t ellipsis">{c.name}</div>
            <div className="preview">
              {course && (
                <>
                  <span className="dot" style={{ background: courseColor(course), width: 7, height: 7, display: "inline-block", marginRight: 4 }} />
                  {course.course_code || course.name} ·{" "}
                </>
              )}
              {c.kind === "due_moved" ? (
                <>
                  {when(c.from, now)} <ArrowRight size={11} style={{ verticalAlign: -1 }} aria-label="to" /> <b>{when(c.to, now)}</b>
                </>
              ) : (
                changeDetail(c, now)
              )}
            </div>
          </button>
        );
      })}
    </section>
  );
}
