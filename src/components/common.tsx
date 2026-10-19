import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Box, CircleAlert, CircleCheck, CircleX, Eye, EyeOff, File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, Folder,
  Info, LoaderCircle, Presentation, TriangleAlert, X,
} from "lucide-react";
import { cleanHtml } from "../lib/sanitize.ts";
import { countdown as countdownText } from "../lib/heat.ts";
import type { AssignmentStatus } from "../lib/status.ts";

export function StatusChip({ s }: { s: AssignmentStatus }) {
  const Icon =
    s.tone === "danger" ? CircleAlert : s.tone === "warn" && s.kind === "due_soon" ? TriangleAlert : s.tone === "ok" ? CircleCheck : null;
  return (
    <span className={`chip tone-${s.tone}`} title={s.label}>
      {Icon && <Icon size={12} strokeWidth={2.4} />}
      <span className="ellipsis">{s.label}</span>
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-label="Loading" />;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <div>{children}</div>}
      {action}
    </div>
  );
}

export function Notice({ tone, children }: { tone: "danger" | "warn" | "ok" | "info" | "neutral"; children: ReactNode }) {
  const Icon = tone === "danger" ? CircleX : tone === "warn" ? TriangleAlert : tone === "ok" ? CircleCheck : Info;
  return (
    <div className={`notice ${tone}`} role={tone === "danger" ? "alert" : undefined}>
      <Icon size={15} />
      <div>{children}</div>
    </div>
  );
}

/** Sanitised Canvas HTML. Long content collapses with "Show more". */
export function Html({ html, clamp = false }: { html?: string | null; clamp?: boolean }) {
  const clean = useMemo(() => cleanHtml(html), [html]);
  const ref = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (clamp && ref.current) setTall(ref.current.scrollHeight > 300);
  }, [clean.html, clamp]);
  if (!clean.html.trim()) return null;
  return (
    <div className="stack" style={{ gap: 6 }}>
      {clean.hasEmbeds && <Notice tone="neutral">This includes images or embedded media. Open it in Canvas to see them.</Notice>}
      <div ref={ref} className={`prose${clamp && tall && !open ? " clamp" : ""}`} dangerouslySetInnerHTML={{ __html: clean.html }} />
      {clamp && tall && (
        <button className="btn btn-sm btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

const ICONS: [RegExp, typeof File][] = [
  [/^(pdf|docx?|odt|rtf|txt|md|tex)$/, FileText],
  [/^(xlsx?|xlsm|csv|ods)$/, FileSpreadsheet],
  [/^(pptx?|odp|key)$/, Presentation],
  [/^(png|jpe?g|gif|bmp|svg|webp|heic|tiff?)$/, FileImage],
  [/^(py|m|mlx|c|h|cpp|hpp|cs|java|js|ts|tsx|jsx|html|css|json|xml|ino|rs|go|ipynb|sh|sql|vhd|v)$/, FileCode],
  [/^(zip|7z|rar|tar|gz|tgz)$/, FileArchive],
  [/^(mp3|wav|m4a|flac|ogg)$/, FileAudio],
  [/^(sldprt|sldasm|slddrw|step|stp|iges|igs|stl|dwg|dxf|ipt|iam|f3d|rvt|3mf|obj)$/, Box],
];

export function FileIcon({ ext, dir, size = 16 }: { ext: string; dir?: boolean; size?: number }) {
  if (dir) return <Folder size={size} className="ficon folder" fill="currentColor" fillOpacity={0.18} />;
  const Icon = ICONS.find(([re]) => re.test(ext))?.[1] ?? File;
  return <Icon size={size} className="ficon" />;
}

export function Modal({ title, onClose, children, footer, width }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function PasswordInput(props: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; id?: string; autoComplete?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw">
      <input
        id={props.id}
        className="input"
        type={show ? "text" : "password"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        autoComplete={props.autoComplete ?? "off"}
        spellCheck={false}
      />
      <button type="button" className="icon-btn" onClick={() => setShow(!show)} aria-label={show ? "Hide" : "Show"} tabIndex={-1}>
        {show ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

/** Re-renders every `ms` so relative times stay correct. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Plain text with http(s) links made clickable (opened in the browser). */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"')\]]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p}>
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** Live countdown ("3:42:10") that ticks every second; for things due within 24 h. */
export function Countdown({ due, className = "" }: { due: number; className?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = countdownText(due, now);
  return s ? <span className={`cd ${className}`} aria-label={`Due in ${s}`}>{s}</span> : null;
}
