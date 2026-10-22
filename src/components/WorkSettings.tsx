// Settings: how Studydesk estimates work, announcement dates, and the
// diagnostics report (no secrets, ever).

import { ClipboardCopy, FileDown, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { fmtHours, KINDS, kindOf } from "../lib/effort.ts";
import { errorLog, reportError, setWorkPrefs, toast, useStore } from "../lib/store.ts";
import { copyText } from "../lib/util.ts";

export function WorkSettings() {
  const prefs = useStore((s) => s.workPrefs);
  const work = useStore((s) => s.work);
  const dash = useStore((s) => s.dash);
  const [draft, setDraft] = useState<Record<string, string>>({});

  // What you actually set on assignments, averaged per kind: "learning" from you.
  const learned = useMemo(() => {
    const sums: Record<string, { n: number; h: number }> = {};
    for (const a of dash?.assignments ?? []) {
      const h = work[`${a.course_id}:${a.id}`]?.hours;
      if (h == null || h <= 0) continue;
      const k = kindOf(a.name, a.submission_types, !!a.is_quiz_assignment);
      sums[k] = { n: (sums[k]?.n ?? 0) + 1, h: (sums[k]?.h ?? 0) + h };
    }
    return Object.fromEntries(Object.entries(sums).filter(([, v]) => v.n >= 2).map(([k, v]) => [k, Math.round((v.h / v.n) * 2) / 2]));
  }, [dash, work]);

  if (!prefs) return null;
  const est = prefs.estimates;
  const save = (kind: string, v: number | null) => {
    const next = { ...est };
    if (v == null) delete next[kind];
    else next[kind] = v;
    void setWorkPrefs(null, next);
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Workload and dates</h2>
      </div>
      <div className="set-row">
        <div className="k">Announcement dates</div>
        <div className="stack" style={{ gap: 4 }}>
          <label className="check" style={{ paddingTop: 6 }}>
            <input type="checkbox" checked={prefs.autoDates} onChange={(e) => setWorkPrefs(e.target.checked, null)} />
            Add quizzes, tests and deadlines from announcements to Key dates automatically
          </label>
          <div className="small muted">Checked on every refresh. You get a notice with Undo, and a date you remove never comes back. Off: they still show up in the scan for you to pin.</div>
        </div>
      </div>
      <div className="set-row">
        <div className="k">Typical hours</div>
        <div className="stack" style={{ gap: 6 }}>
          <div className="small muted">Used for the workload bars, clash warnings and “start soon” reminders when you haven't set hours on an assignment. Set your own on any assignment, under My work.</div>
          <table className="est-table">
            <tbody>
              {KINDS.map(([k, label, def]) => {
                const mine = est[k];
                const l = learned[k];
                return (
                  <tr key={k}>
                    <td>
                      <label htmlFor={`est-${k}`}>{label}</label>
                    </td>
                    <td>
                      <input
                        id={`est-${k}`}
                        className="input input-sm num"
                        type="number"
                        min={0.25}
                        max={100}
                        step={0.5}
                        style={{ width: 80 }}
                        placeholder={String(def)}
                        value={draft[k] ?? (mine != null ? String(mine) : "")}
                        onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                        onBlur={() => {
                          const raw = draft[k];
                          if (raw == null) return;
                          const n = Number(raw);
                          save(k, raw.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : Math.min(100, Math.round(n * 4) / 4));
                          const { [k]: _, ...rest } = draft;
                          setDraft(rest);
                        }}
                      />{" "}
                      <span className="small muted">h{mine == null ? " (default)" : ""}</span>
                    </td>
                    <td className="small">
                      {l != null && l !== (mine ?? def) && (
                        <button className="btn btn-xs" onClick={() => save(k, l)} title="The average of the hours you set on these">
                          <Sparkles size={12} /> You usually say {fmtHours(l)}. Use it
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function DiagnosticsSettings() {
  const dash = useStore((s) => s.dash);
  const scan = useStore((s) => s.scan);
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const build = async () => {
    setBusy(true);
    try {
      const d = await api.diagnosticsInfo();
      const lines = [
        "Studydesk diagnostics",
        `Made: ${new Date().toISOString()}`,
        "No passwords, tokens, email addresses, links or notes. Error messages may name an assignment or file.",
        "",
        ...Object.entries(d).map(([k, v]) => `${k}: ${typeof v === "object" && v ? JSON.stringify(v) : String(v)}`),
        "",
        `courses shown: ${(dash?.courses ?? []).filter((c) => !c.hidden).length}`,
        `assignments: ${dash?.assignments.length ?? 0}`,
        `last refresh: ${dash ? new Date(dash.syncedAt).toISOString() : "never"}`,
        `refresh notices: ${dash?.notices.length ?? 0}`,
        `scan sources: ${scan ? `${scan.scanned.filter((s) => s.ok).length} read, ${scan.scanned.filter((s) => !s.ok).length} unavailable` : "not run"}`,
        `screen: ${window.screen.width}x${window.screen.height} @${window.devicePixelRatio}x, window ${window.innerWidth}x${window.innerHeight}`,
        "",
        "Recent errors (this session):",
        ...(errorLog.length ? errorLog.map((e) => `  ${new Date(e.at).toISOString()}  ${e.text}`) : ["  none"]),
      ];
      setText(lines.join("\n"));
    } catch (e) {
      reportError(e, "Couldn't build the report");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Help and diagnostics</h2>
      </div>
      <div className="set-row">
        <div className="k">Diagnostics report</div>
        <div className="stack" style={{ gap: 8 }}>
          <div className="small muted">
            If something isn't working, this report helps whoever is helping you. It lists the app version, Windows version, what's connected (yes or no) and this session's error messages. It never includes passwords, tokens, email addresses, links or notes. Error messages can mention an assignment or file name, so read it before you share it.
          </div>
          <div className="row-flex" style={{ flexWrap: "wrap" }}>
            <button className="btn btn-sm" onClick={build} disabled={busy}>
              {text ? "Rebuild report" : "Make report"}
            </button>
            {text && (
              <>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    api
                      .diagnosticsSave(text)
                      .then((p) => p && toast(`Saved to ${p}`, "ok"))
                      .catch((e) => reportError(e))
                  }
                >
                  <FileDown size={13} /> Save as file…
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => copyText(text).then((ok) => toast(ok ? "Copied." : "Couldn't copy.", ok ? "ok" : "error"))}>
                  <ClipboardCopy size={13} /> Copy
                </button>
              </>
            )}
          </div>
          {text && <pre className="diag selectable" tabIndex={0} aria-label="Diagnostics report">{text}</pre>}
        </div>
      </div>
    </section>
  );
}
