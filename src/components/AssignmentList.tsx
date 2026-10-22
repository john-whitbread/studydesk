import { CalendarClock, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { byDue, type Item } from "../lib/derive.ts";
import { dropClass } from "../lib/drag.ts";
import { acceptsUpload, kindLabel, scoreLabel } from "../lib/status.ts";
import { useStore } from "../lib/store.ts";
import { fmtDay, fmtNum, fmtTime, relative } from "../lib/time.ts";
import { fuzzyScore } from "../lib/util.ts";
import { Countdown, Empty, StatusChip } from "./common.tsx";
import { heatOf } from "../lib/heat.ts";
import { KIND_LABEL, pinDue } from "../lib/entries.ts";
import { fmtHours, hoursFor } from "../lib/effort.ts";
import type { PinnedDate } from "../lib/types.ts";

type Filter = "upcoming" | "past" | "undated" | "all";

type Row = { t: "a"; it: Item } | { t: "p"; p: PinnedDate; due: number };

export function AssignmentList({ list, now, selectedId, onSelect, pins = [], onPin }: { list: Item[]; now: number; selectedId?: number; onSelect: (id: number) => void; pins?: PinnedDate[]; onPin?: (p: PinnedDate) => void }) {
  const drag = useStore((s) => s.drag);
  const work = useStore((s) => s.work);
  const estimates = useStore((s) => s.workPrefs?.estimates);
  const [filter, setFilter] = useState<Filter>("upcoming");
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const buckets = useMemo(() => {
    const isUpcoming = (i: Item) => i.due != null && (i.due >= now || (i.s.needsAction && i.s.late));
    const upcoming = list.filter(isUpcoming).sort(byDue);
    const past = list.filter((i) => i.due != null && !isUpcoming(i)).sort((a, b) => (b.due as number) - (a.due as number));
    const undated = list.filter((i) => i.due == null).sort((a, b) => a.a.name.localeCompare(b.a.name));
    const all = [...list.filter((i) => i.due != null).sort(byDue), ...undated];
    return { upcoming, past, undated, all };
  }, [list, now]);

  // When the selected assignment isn't in the current filter, switch to one that has it.
  useEffect(() => {
    if (selectedId == null) return;
    if (buckets[filter].some((i) => i.a.id === selectedId)) return;
    const f = (["upcoming", "past", "undated"] as Filter[]).find((k) => buckets[k].some((i) => i.a.id === selectedId));
    if (f) setFilter(f);
  }, [selectedId, buckets]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const base = buckets[filter];
    if (!q.trim()) return base;
    return base.map((i) => ({ i, s: fuzzyScore(q, i.a.name) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.i);
  }, [buckets, filter, q]);

  // Key dates (from the syllabus, announcements or added by you) sit in date order with assignments.
  const rows: Row[] = useMemo(() => {
    const asg: Row[] = shown.map((it) => ({ t: "a", it }));
    if (q.trim() || (filter !== "upcoming" && filter !== "all")) return asg;
    const ps = pins
      .map((p) => ({ t: "p" as const, p, due: pinDue(p) }))
      .filter((r) => filter === "all" || r.due >= now - 12 * 3600_000);
    if (!ps.length) return asg;
    const due = (r: Row) => (r.t === "p" ? r.due : r.it.due ?? Infinity);
    return [...asg, ...ps].sort((a, b) => due(a) - due(b));
  }, [shown, pins, filter, q, now]);

  useEffect(() => {
    ref.current?.querySelector(".lrow.selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const idx = shown.findIndex((i) => i.a.id === selectedId);
    const next = e.key === "ArrowDown" ? Math.min(shown.length - 1, idx + 1) : Math.max(0, idx - 1);
    if (shown[next]) onSelect(shown[next].a.id);
  };

  const tabs: [Filter, string][] = [
    ["upcoming", "Upcoming"],
    ["past", "Past"],
    ["undated", "No date"],
    ["all", "All"],
  ];

  return (
    <div className="panel">
      <div className="toolbar">
        <div className="seg" role="tablist">
          {tabs.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? "active" : ""} onClick={() => setFilter(k)}>
              {label}
              <span className="n">{buckets[k].length}</span>
            </button>
          ))}
        </div>
        <div className="search">
          <Search size={14} />
          <input className="input" placeholder="Filter assignments" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="scroll" ref={ref} tabIndex={0} onKeyDown={onKey} aria-label="Assignments">
        {rows.length === 0 ? (
          <Empty title={q ? "No matches" : filter === "upcoming" ? "Nothing upcoming" : "Nothing here"}>
            {filter === "upcoming" && !q ? "No upcoming or overdue assignments in this course." : null}
          </Empty>
        ) : (
          <div className="list">
            {rows.map((row) => {
              if (row.t === "p") {
                const p = row.p;
                return (
                  <button key={`p${p.id}`} className={`lrow asg-row date-row heat-${p.kind === "info" ? "none" : heatOf(row.due, now, row.due >= now, false)}`} onClick={() => onPin?.(p)} title={p.source ? `From: ${p.source}` : undefined}>
                    <span className={`chip ${p.kind === "exam" ? "tone-danger" : p.kind === "quiz" ? "tone-warn" : "tone-info"}`}>
                      <CalendarClock size={12} /> {KIND_LABEL[p.kind] ?? "Date"}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="lr-title ellipsis">{p.label}</div>
                      <div className="lr-meta">
                        {p.weight && <span>{p.weight}</span>}
                        <span className="ellipsis">{p.auto ? "From an announcement" : p.source || "Key date"}</span>
                      </div>
                    </div>
                    <div className="lr-due">
                      <div>{fmtDay(row.due, now)}</div>
                      <div className="rel">{p.time ? `${fmtTime(row.due)} · ` : ""}{relative(row.due, now)}</div>
                    </div>
                  </button>
                );
              }
              const it = row.it;
              const key = `asg:${it.a.course_id}:${it.a.id}`;
              const k = kindLabel(it.a);
              const score = it.s.kind !== "graded" ? scoreLabel(it.a) : null;
              return (
                <button
                  key={it.a.id}
                  className={`lrow asg-row heat-${heatOf(it.due, now, it.s.needsAction, it.s.late)}${it.a.id === selectedId ? " selected" : ""}${!it.s.needsAction ? " done" : ""}${dropClass(key, acceptsUpload(it.a), drag)}`}
                  data-drop={key}
                  onClick={() => onSelect(it.a.id)}
                  aria-current={it.a.id === selectedId}
                >
                  <StatusChip s={it.s} />
                  <div style={{ minWidth: 0 }}>
                    <div className="lr-title ellipsis" title={it.a.name}>{it.a.name}</div>
                    <div className="lr-meta">
                      {it.a.points_possible != null && it.a.points_possible > 0 && <span>{fmtNum(it.a.points_possible)} pts</span>}
                      {k && <span>{k}</span>}
                      {score && <span>{score}</span>}
                      {it.s.needsAction && (it.a.points_possible ?? 0) > 0 && (() => {
                        const h = hoursFor(it.a, work[`${it.a.course_id}:${it.a.id}`]?.hours, estimates ?? {});
                        return <span title={h.custom ? "Your estimate" : "Typical time for this kind of work"}>≈ {fmtHours(h.hours)}</span>;
                      })()}
                    </div>
                  </div>
                  {it.due != null ? (
                    <div className="lr-due">
                      <div>{fmtDay(it.due, now)}</div>
                      <div className={`rel${it.s.needsAction ? " heat-text" : ""}`}>
                        {fmtTime(it.due)} ·{" "}
                        {it.s.needsAction && it.due > now && it.due - now < 86_400_000 ? <Countdown due={it.due} /> : relative(it.due, now)}
                      </div>
                    </div>
                  ) : (
                    <div className="lr-due muted">No date</div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
