import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { byDue, type Item } from "../lib/derive.ts";
import { dropClass } from "../lib/drag.ts";
import { acceptsUpload, kindLabel, scoreLabel } from "../lib/status.ts";
import { useStore } from "../lib/store.ts";
import { fmtDay, fmtNum, fmtTime, relative } from "../lib/time.ts";
import { fuzzyScore } from "../lib/util.ts";
import { Countdown, Empty, StatusChip } from "./common.tsx";
import { heatOf } from "../lib/heat.ts";

type Filter = "upcoming" | "past" | "undated" | "all";

export function AssignmentList({ list, now, selectedId, onSelect }: { list: Item[]; now: number; selectedId?: number; onSelect: (id: number) => void }) {
  const drag = useStore((s) => s.drag);
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
        {shown.length === 0 ? (
          <Empty title={q ? "No matches" : filter === "upcoming" ? "Nothing upcoming" : "Nothing here"}>
            {filter === "upcoming" && !q ? "No upcoming or overdue assignments in this course." : null}
          </Empty>
        ) : (
          <div className="list">
            {shown.map((it) => {
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
