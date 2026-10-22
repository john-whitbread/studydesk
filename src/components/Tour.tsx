import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { getState, navigate, setState, useStore, type Route } from "../lib/store.ts";

interface Step {
  title: string;
  body: React.ReactNode;
  /** Where to be while this step shows. */
  route?: Route;
  /** CSS selectors tried in order; the first visible one is highlighted. None = centred card. */
  target?: string[];
}

const K = ({ children }: { children: React.ReactNode }) => <span className="kbd">{children}</span>;

const STEPS: Step[] = [
  {
    title: "Welcome to Studydesk",
    body: (
      <>
        <p>Canvas, your course folders, school email and your calendar in one window, built to show what matters next.</p>
        <p className="muted">This takes about a minute. You can skip it now and replay it any time from Settings.</p>
      </>
    ),
    route: { view: "today" },
  },
  {
    title: "Next up",
    body: <p>The one thing to do next, with a live countdown. Open and submit it in one click, or jump to its course folder.</p>,
    route: { view: "today" },
    target: [".nextup"],
  },
  {
    title: "Deadlines heat up",
    body: (
      <>
        <p>Every deadline gets warmer as it gets closer: blue for later, then amber, orange and red, with a countdown inside 24 hours.</p>
        <p>The bars show hours of work due each day for the next 14 days, with a warning when too much lands at once. Click a day to jump to it.</p>
      </>
    ),
    route: { view: "today" },
    target: [".strip", ".today-grid .panel"],
  },
  {
    title: "Gravity",
    body: <p>Switch to Gravity to see every open deadline on a timeline pulled toward "now": the next few days get the most room, and cards grow bigger and hotter as they approach.</p>,
    route: { view: "today" },
    target: ['.seg button:has(svg.lucide-orbit)', ".today-grid .seg"],
  },
  {
    title: "Submit straight from your files",
    body: (
      <>
        <p>Each course shows its assignments next to its folder on your PC. Studydesk suggests the file that matches, or drag one from the folder (or File Explorer) onto an assignment.</p>
        <p className="muted">You always confirm in a Windows dialog before anything is submitted.</p>
      </>
    ),
    target: [".course-item"],
  },
  {
    title: "Your work, ticked off",
    body: (
      <>
        <p>Each assignment gets a requirements checklist pulled from its instructions, a rubric self-check, your hours estimate and notes. If something isn't ticked when you submit, Studydesk asks first.</p>
        <p className="muted">Notes are saved encrypted on this PC and searchable with Ctrl K.</p>
      </>
    ),
    target: [".course-item"],
  },
  {
    title: "Grades, worked out",
    body: <p>See every course's grade calculated like Canvas does (weights, dropped marks), the range you can still finish in, and exactly what you need on the final to hit your target. Unreleased grades are never counted as 0.</p>,
    target: ['.sidebar [aria-label="Grades"]'],
  },
  {
    title: "Key dates from your outlines",
    body: <p>Studydesk reads each course's calendar, syllabus, outline files and announcements to find exams, quizzes, due dates and office hours. Dates from announcements are added for you (with Undo); pin the rest and they appear on Today with reminders.</p>,
    target: ['.sidebar [aria-label="Key dates"]'],
  },
  {
    title: "Calendar, with Apple Calendar",
    body: <p>Deadlines, key dates and your own calendars in month, week or list view. Connect Apple Calendar in Settings and your deadlines also appear on your iPhone.</p>,
    target: ['.sidebar [aria-label="Calendar"]'],
  },
  {
    title: "Messages and email",
    body: (
      <>
        <p>A faster Canvas inbox, and your school Gmail if you connect it. Keyboard first:</p>
        <p>
          <K>↑</K> <K>↓</K> move · <K>E</K> archive · <K>U</K> unread · <K>S</K> star · <K>R</K> reply · <K>C</K> new
        </p>
      </>
    ),
    target: ['.sidebar [aria-label="Canvas inbox"]'],
  },
  {
    title: "Find anything",
    body: (
      <p>
        Press <K>Ctrl</K> <K>K</K> to jump to any course, assignment, page or note. <K>Alt</K> + <K>1</K>–<K>6</K> switch views, <K>F5</K> refreshes, <K>Ctrl</K> <K>+</K> makes text bigger.
      </p>
    ),
    target: [".sidebar .jump"],
  },
  {
    title: "Make it yours",
    body: <p>In Settings: text size, compact or comfortable layout, light or dark theme, accent and course colours, Windows reminders (including a nudge to start big work early), and start with Windows.</p>,
    target: ['.sidebar [aria-label="Settings"]'],
  },
  {
    title: "You're set",
    body: (
      <>
        <p>Studydesk keeps itself up to date and refreshes from Canvas every 10 minutes.</p>
        <p className="muted">Replay this tour from Settings → Updates.</p>
      </>
    ),
    route: { view: "today" },
  },
];

function findTarget(sel: string[] | undefined): HTMLElement | null {
  for (const s of sel ?? []) {
    let el: Element | null = null;
    try {
      el = document.querySelector(s);
    } catch {
      continue; // selector not supported
    }
    if (el instanceof HTMLElement) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
  }
  return null;
}

export function startTour() {
  setState({ tourOpen: true, sideOpen: false });
}

export function Tour() {
  const open = useStore((s) => s.tourOpen);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardSize, setCardSize] = useState({ w: 360, h: 220 });
  const step = STEPS[i];

  const finish = () => {
    setState({ tourOpen: false });
    setI(0);
    api.tourDone().catch(() => {});
  };

  useEffect(() => {
    if (!open) return;
    if (step.route && getState().route.view !== step.route.view) navigate(step.route);
  }, [open, i]);

  // Measure the target after the route renders, and keep it measured.
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const measure = () => {
      const el = findTarget(step.target);
      if (el) el.scrollIntoView({ block: "nearest" });
      setRect(el ? el.getBoundingClientRect() : null);
    };
    const t = window.setTimeout(measure, 120);
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [open, i]);

  useLayoutEffect(() => {
    const c = cardRef.current;
    if (c) setCardSize({ w: c.offsetWidth, h: c.offsetHeight });
  }, [open, i, rect]);

  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), finish());
      else if (e.key === "ArrowRight" || e.key === "Enter") (e.preventDefault(), e.stopPropagation(), i < STEPS.length - 1 ? setI(i + 1) : finish());
      else if (e.key === "ArrowLeft") (e.preventDefault(), e.stopPropagation(), setI(Math.max(0, i - 1)));
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [open, i]);

  useEffect(() => {
    if (open) cardRef.current?.querySelector<HTMLButtonElement>(".tour-next")?.focus();
  }, [open, i]);

  if (!open) return null;

  // Card placement: beside the target if there's room, else below/above, else centred.
  const pad = 8, gap = 14, vw = window.innerWidth, vh = window.innerHeight;
  let pos: React.CSSProperties = { left: (vw - cardSize.w) / 2, top: (vh - cardSize.h) / 2 };
  if (rect) {
    const spaceR = vw - rect.right, spaceB = vh - rect.bottom;
    const clampY = (y: number) => Math.min(Math.max(12, y), vh - cardSize.h - 12);
    const clampX = (x: number) => Math.min(Math.max(12, x), vw - cardSize.w - 12);
    if (spaceR >= cardSize.w + gap + pad + 12) pos = { left: rect.right + pad + gap, top: clampY(rect.top) };
    else if (spaceB >= cardSize.h + gap + pad + 12) pos = { left: clampX(rect.left), top: rect.bottom + pad + gap };
    else if (rect.top >= cardSize.h + gap + pad + 12) pos = { left: clampX(rect.left), top: rect.top - pad - gap - cardSize.h };
  }

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <svg className="tour-dim" width={vw} height={vh} aria-hidden>
        <defs>
          <mask id="tour-mask">
            <rect width={vw} height={vh} fill="white" />
            {rect && <rect x={rect.left - pad} y={rect.top - pad} width={rect.width + pad * 2} height={rect.height + pad * 2} rx={10} fill="black" />}
          </mask>
        </defs>
        <rect width={vw} height={vh} fill="rgba(8, 10, 14, 0.62)" mask="url(#tour-mask)" />
      </svg>
      {rect && <div className="tour-hole" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />}
      <div className="tour-card" ref={cardRef} style={pos}>
        <div className="tour-top">
          <span className="small muted num">
            {i + 1} of {STEPS.length}
          </span>
          <button className="icon-btn sm" onClick={finish} title="Skip tour (Esc)" aria-label="Skip tour">
            <X size={14} />
          </button>
        </div>
        <h2 id="tour-title">{step.title}</h2>
        <div className="tour-body">{step.body}</div>
        <div className="tour-dots" aria-hidden>
          {STEPS.map((_, j) => (
            <span key={j} className={j === i ? "on" : ""} />
          ))}
        </div>
        <div className="tour-foot">
          {i === 0 ? (
            <button className="btn btn-ghost" onClick={finish}>
              Skip tour
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={() => setI(i - 1)}>
              <ArrowLeft size={14} /> Back
            </button>
          )}
          <button className="btn btn-primary tour-next" onClick={() => (i < STEPS.length - 1 ? setI(i + 1) : finish())}>
            {i === 0 ? "Show me" : i < STEPS.length - 1 ? "Next" : "Start using Studydesk"} {i < STEPS.length - 1 && <ArrowRight size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}
