// Deadline gravity: every open deadline sits on a timeline pulled toward the
// glowing "now" line. Distance is compressed (square root), so the next few
// days get most of the room; nearer cards grow wider and hotter, and they
// drift left on their own as time passes.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { entryNeedsAction, KIND_LABEL, type Entry } from "../lib/entries.ts";
import { HEAT_LABEL, HEAT_RANK, type Heat } from "../lib/heat.ts";
import { navigate } from "../lib/store.ts";
import { fmtDay, fmtTime, relative } from "../lib/time.ts";
import { courseColor } from "../lib/util.ts";
import { Countdown } from "./common.tsx";

const DAY = 86_400_000;
const HORIZON = 14 * DAY;
const AXIS = 28;
const CARD_H = 50;

interface Placed {
  e: Entry;
  x: number;
  y: number;
  w: number;
}

export function Gravity({ list, now }: { list: Entry[]; now: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(900);
  const H = 560;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const open = useMemo(
    () => list.filter((e) => e.due != null && entryNeedsAction(e, now) && (e.due as number) - now <= HORIZON && (e.due as number) - now > -21 * DAY),
    [list, now],
  );
  const overdue = open.filter((e) => (e.due as number) < now);
  const pastW = overdue.length ? 150 : 0;
  const nowX = pastW + 6;
  const labelW = 96;
  const span = Math.max(200, W - nowX - labelW - 170);
  const xOf = (dt: number) => nowX + Math.sqrt(Math.max(0, dt) / HORIZON) * span;

  const { placed, lanes } = useMemo(() => {
    const courseIds = [...new Set(open.map((e) => e.course?.id ?? 0))].sort((a, b) => {
      const ca = open.find((e) => (e.course?.id ?? 0) === a)?.course?.course_code ?? "";
      const cb = open.find((e) => (e.course?.id ?? 0) === b)?.course?.course_code ?? "";
      return ca.localeCompare(cb);
    });
    const laneH = (H - AXIS - 12) / Math.max(1, courseIds.length);
    const placed: Placed[] = [];
    const lanes = courseIds.map((id, i) => ({ id, top: 6 + i * laneH, h: laneH, course: open.find((e) => (e.course?.id ?? 0) === id)?.course }));
    for (const lane of lanes) {
      const inLane = open.filter((e) => (e.course?.id ?? 0) === lane.id).sort((a, b) => (a.due as number) - (b.due as number));
      const rows = Math.max(1, Math.floor((lane.h - 4) / (CARD_H + 4)));
      const rowEnd: number[] = Array(rows).fill(-Infinity);
      let pastSlot = 0;
      for (const e of inLane) {
        const dt = (e.due as number) - now;
        const urgency = 1 - Math.min(1, Math.max(0, dt) / HORIZON);
        const w = Math.round(150 + 90 * urgency);
        let x = dt < 0 ? 8 : xOf(dt);
        let r = 0;
        if (dt < 0) {
          r = Math.min(rows - 1, pastSlot++);
          x = 8;
        } else {
          // First row where this card doesn't overlap the previous one.
          r = rowEnd.findIndex((end) => x >= end + 6);
          if (r < 0) {
            r = rowEnd.indexOf(Math.min(...rowEnd));
            x = Math.max(x, rowEnd[r] + 6);
          }
          rowEnd[r] = x + w;
        }
        const y = lane.top + 2 + r * Math.min(CARD_H + 4, (lane.h - CARD_H) / Math.max(1, rows - 1) || 0);
        placed.push({ e, x, y, w: dt < 0 ? 134 : w });
      }
    }
    return { placed, lanes };
  }, [open, now, W]); // eslint-disable-line react-hooks/exhaustive-deps

  const ticks: [number, string][] = [
    [DAY, "Tomorrow"],
    [3 * DAY, "3 days"],
    [7 * DAY, "1 week"],
    [14 * DAY, "2 weeks"],
  ];
  const heats: Heat[] = ["critical", "hot", "warm", "mild", "cool"];

  return (
    <div>
      <div className="gravity" ref={ref} style={{ height: H }} aria-label="Deadline gravity">
        {pastW > 0 && <div className="past-zone" style={{ width: pastW }} />}
        {ticks.map(([dt]) => (
          <div key={dt} className="grid-line" style={{ left: xOf(dt) }} />
        ))}
        <div className="now-line" style={{ left: nowX }} />
        <div className="now-tag" style={{ left: nowX }}>NOW</div>
        {lanes.map((l) => (
          <div key={l.id} className="lane-label" style={{ top: l.top, height: l.h, width: labelW, justifyContent: "flex-end" }}>
            <span className="dot" style={{ background: courseColor(l.course), width: 7, height: 7 }} />
            {l.course?.course_code || l.course?.name || "Other"}
          </div>
        ))}
        {placed
          .sort((a, b) => HEAT_RANK[a.e.heat] - HEAT_RANK[b.e.heat])
          .map(({ e, x, y, w }) => {
            const due = e.due as number;
            const title = e.type === "asg" ? e.it.a.name : e.p.label;
            const soon = due - now < DAY && due > now;
            return (
              <button
                key={e.key}
                className={`gcard heat-${e.heat}${e.type === "pin" ? " pin" : ""}`}
                style={{ transform: `translate(${x}px, ${y}px)`, width: w, height: CARD_H }}
                title={`${title}\n${fmtDay(due, now)} ${fmtTime(due)} · ${HEAT_LABEL[e.heat]}`}
                onClick={() =>
                  e.type === "asg" ? navigate({ view: "course", courseId: e.it.a.course_id, assignmentId: e.it.a.id }) : navigate({ view: "dates" })
                }
              >
                <span className="gt">
                  {e.type === "pin" && <span className={`kind-chip kind-${e.p.kind}`} style={{ height: 15, fontSize: 9.5, marginRight: 5 }}>{KIND_LABEL[e.p.kind]}</span>}
                  {title}
                </span>
                <span className="gm">
                  {soon ? <Countdown due={due} /> : <span className="heat-text" style={{ fontWeight: 600 }}>{relative(due, now)}</span>}
                  <span>· {fmtDay(due, now)}</span>
                </span>
              </button>
            );
          })}
        {ticks.map(([dt, label]) => (
          <div key={label} className="tick" style={{ left: xOf(dt) }}>
            {label}
          </div>
        ))}
        {placed.length === 0 && (
          <div className="empty" style={{ position: "absolute", inset: 0 }}>
            <strong>Nothing pulling at you</strong>
            No open deadlines in the next two weeks.
          </div>
        )}
      </div>
      <div className="gravity-legend" style={{ padding: "8px 14px" }}>
        {heats.map((h) => (
          <span key={h} className={`heat-${h}`}>
            <span className="heat-dot" /> {HEAT_LABEL[h]}
          </span>
        ))}
        <span className="heat-overdue">
          <span className="heat-dot" /> Overdue
        </span>
        <span style={{ marginLeft: "auto" }}>Dashed = key date you pinned</span>
      </div>
    </div>
  );
}
