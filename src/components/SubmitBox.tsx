import { CircleCheck, CircleX, FilePlus, Plus, Sparkles, TriangleAlert, Upload, X } from "lucide-react";
import { bestMatch, rankFiles } from "../lib/match.ts";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { dropClass } from "../lib/drag.ts";
import { addToDraft, draftKey, flushWork, newJob, reportError, setDraft, setState, toast, useStore } from "../lib/store.ts";
import { unticked, workKey } from "./MyWork.tsx";
import { fmtDateTime, fmtListTime, fmtSize, parse } from "../lib/time.ts";
import type { Assignment, Course, Entry, PickedFile, Preflight, Submission } from "../lib/types.ts";
import { plural } from "../lib/util.ts";
import { FileIcon, Spinner } from "./common.tsx";

type Mode = "files" | "text" | "url";
const MODE_TYPE: Record<Mode, string> = { files: "online_upload", text: "online_text_entry", url: "online_url" };
const MODE_LABEL: Record<Mode, string> = { files: "File upload", text: "Text entry", url: "Website URL" };

export function submitModes(a: Assignment): Mode[] {
  return (Object.keys(MODE_TYPE) as Mode[]).filter((m) => a.submission_types.includes(MODE_TYPE[m]));
}

export function entryToPicked(courseId: number, e: Entry): PickedFile {
  return { ref: { kind: "linked", courseId, rel: e.rel }, name: e.name, size: e.size, ext: e.ext, modifiedMs: e.modifiedMs };
}

export function SubmitBox({ a, course, onSubmitted }: { a: Assignment; course: Course; onSubmitted: (s: Submission) => void }) {
  const modes = submitModes(a);
  const [mode, setMode] = useState<Mode>(modes[0]);
  const key = draftKey(a.course_id, a.id);
  const draft = useStore((s) => s.drafts[key]) ?? [];
  const drag = useStore((s) => s.drag);
  const fileVersion = useStore((s) => s.fileVersion[a.course_id] ?? 0);
  const [suggest, setSuggest] = useState<Entry[] | null>(null);
  const [pf, setPf] = useState<Preflight | null>(null);
  const [pfError, setPfError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [comment, setComment] = useState("");
  const [showComment, setShowComment] = useState(false);
  const [job, setJob] = useState<string | null>(null);
  const progress = useStore((s) => (job ? s.progress[job] : undefined));
  const work = useStore((s) => s.work[workKey(a.course_id, a.id)]);
  const left = unticked(a, work);
  const [confirming, setConfirming] = useState(false);

  const allowed = a.allowed_extensions.map((e) => e.replace(/^\./, "").toLowerCase());
  const refsKey = JSON.stringify(draft.map((d) => d.ref));

  useEffect(() => setMode(modes[0]), [a.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Suggested files: most recently modified in the linked folder, filtered to allowed types.
  useEffect(() => {
    if (!course.folder || mode !== "files") return setSuggest(null);
    let live = true;
    api
      .recentFiles(course.id, allowed, 25)
      .then((r) => live && setSuggest(r))
      .catch(() => live && setSuggest([]));
    return () => {
      live = false;
    };
  }, [course.id, course.folder, mode, fileVersion, a.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-flight runs in the backend against a fresh copy of the assignment.
  useEffect(() => {
    let live = true;
    setChecking(true);
    const t = setTimeout(() => {
      api
        .preflight(a.course_id, a.id, mode, mode === "files" ? draft.map((d) => d.ref) : [])
        .then((r) => {
          if (!live) return;
          setPf(r);
          setPfError(null);
        })
        .catch((e) => {
          if (!live) return;
          setPf(null);
          setPfError(e.message);
        })
        .finally(() => live && setChecking(false));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [a.id, a.course_id, mode, refsKey, a.submission?.attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const staged = new Set(draft.map((d) => JSON.stringify(d.ref)));
  // Best name match first ("Lab3_Whitbread.pdf" for "Lab 3 – …"), then newest.
  const { suggestions, best } = useMemo(() => {
    const avail = (suggest ?? []).filter((e) => !staged.has(JSON.stringify({ kind: "linked", courseId: course.id, rel: e.rel })));
    const ranked = rankFiles(avail, a.name);
    const best = bestMatch(avail, a.name);
    return { suggestions: ranked.slice(0, 5).map((r) => ({ e: r.item, score: r.score })), best };
  }, [suggest, refsKey, a.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = job != null;
  const blocked = !pf || pf.problems.length > 0 || checking;
  const ready =
    !busy && !blocked && (mode === "files" ? draft.length > 0 : mode === "text" ? text.trim().length > 0 : /^https?:\/\/\S+\.\S+/.test(url.trim()));

  async function submit(force = false) {
    // Warn (never block) when your own checklist isn't finished.
    if (!force && left.left > 0) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    flushWork();
    const j = newJob();
    setJob(j);
    try {
      const s =
        mode === "files"
          ? await api.submitFiles(a.course_id, a.id, draft.map((d) => d.ref), comment.trim() || null, j)
          : mode === "text"
            ? await api.submitText(a.course_id, a.id, text)
            : await api.submitUrl(a.course_id, a.id, url.trim());
      setDraft(a.course_id, a.id, []);
      setText("");
      setUrl("");
      setComment("");
      toast(`Submitted “${a.name}”${s.attempt ? ` (attempt ${s.attempt})` : ""}.`, "ok", { timeout: 6000 });
      setState({ celebrate: Date.now() });
      onSubmitted(s);
    } catch (e) {
      reportError(e, "Not submitted");
    } finally {
      setJob(null);
    }
  }

  const overall = progress ? Math.min(1, (progress.index + (progress.total ? progress.sent / progress.total : 1)) / progress.count) : 0;
  const dropKey = `submit:${a.course_id}:${a.id}`;

  return (
    <div className={`submit-box${mode === "files" ? dropClass(dropKey, true, drag) : ""}`} data-drop={mode === "files" ? dropKey : undefined}>
      <div className="row-flex">
        <b>Submit</b>
        {modes.length > 1 && (
          <div className="seg" style={{ marginLeft: "auto" }}>
            {modes.map((m) => (
              <button key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)} disabled={busy}>
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        )}
      </div>

      {mode === "files" && (
        <>
          {draft.length > 0 ? (
            <div className="stack" style={{ gap: 6 }}>
              {draft.map((f) => {
                const bad = (allowed.length > 0 && !allowed.includes(f.ext)) || f.size === 0;
                return (
                  <div key={JSON.stringify(f.ref)} className={`file-chip${bad ? " bad" : ""}`}>
                    <FileIcon ext={f.ext} />
                    <span className="grow ellipsis" title={f.name}>{f.name}</span>
                    <span className="small muted num">{fmtSize(f.size)}</span>
                    {f.modifiedMs != null && <span className="small muted">{fmtListTime(f.modifiedMs)}</span>}
                    <button
                      className="icon-btn sm"
                      aria-label={`Remove ${f.name}`}
                      disabled={busy}
                      onClick={() => setDraft(a.course_id, a.id, draft.filter((d) => d !== f))}
                    >
                      <X size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="small muted">
              Drag files here from the course folder or File Explorer, pick a suggestion, or choose a file.
              {allowed.length > 0 && <> Accepted: {allowed.map((x) => `.${x}`).join(", ")}.</>}
            </div>
          )}

          {best && draft.length === 0 && (
            <button className="btn" style={{ justifyContent: "flex-start", height: "auto", padding: "8px 10px" }} onClick={() => addToDraft(a.course_id, a.id, [entryToPicked(course.id, best)])} disabled={busy} title={best.rel}>
              <Sparkles size={15} className="text-ok" />
              <span style={{ textAlign: "left", minWidth: 0 }}>
                <span className="small muted" style={{ display: "block" }}>Looks like the one</span>
                <b className="ellipsis" style={{ display: "block" }}>{best.name}</b>
              </span>
              <span className="small muted" style={{ marginLeft: "auto" }}>{best.modifiedMs ? `saved ${fmtListTime(best.modifiedMs)}` : ""}</span>
            </button>
          )}

          {suggestions.length > 0 && (
            <div>
              <div className="section-title">Course folder, best match first</div>
              <div className="suggest">
                {suggestions.map(({ e, score }) => (
                  <button key={e.rel} onClick={() => addToDraft(a.course_id, a.id, [entryToPicked(course.id, e)])} disabled={busy} title={e.rel}>
                    <FileIcon ext={e.ext} />
                    <span className="grow ellipsis">{e.rel}</span>
                    {score >= 3 && <span className="chip tone-ok" style={{ height: 18 }}>match</span>}
                    <span className="small muted">{e.modifiedMs ? fmtListTime(e.modifiedMs) : ""}</span>
                    <Plus size={14} className="muted" />
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="row-flex">
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                api
                  .pickFiles(course.folder ? course.id : undefined)
                  .then((f) => f.length && addToDraft(a.course_id, a.id, f))
                  .catch((e) => reportError(e))
              }
            >
              <FilePlus size={14} /> Choose file…
            </button>
            {!showComment ? (
              <button className="btn btn-sm btn-ghost" onClick={() => setShowComment(true)} disabled={busy}>
                Add a comment
              </button>
            ) : null}
          </div>
          {showComment && (
            <textarea className="textarea" rows={2} placeholder="Comment for your instructor (optional)" value={comment} onChange={(e) => setComment(e.target.value)} disabled={busy} />
          )}
        </>
      )}

      {mode === "text" && (
        <textarea className="textarea" rows={8} placeholder="Type or paste your answer" value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
      )}
      {mode === "url" && <input className="input" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} spellCheck={false} />}

      <Checks pf={pf} error={pfError} checking={checking} mode={mode} count={draft.length} />

      {busy && progress && (
        <div className="stack" style={{ gap: 4 }}>
          <div className="progress">
            <div style={{ width: `${Math.round(overall * 100)}%` }} />
          </div>
          <div className="small muted num">
            Uploading {progress.name} ({progress.index + 1} of {progress.count}) · {fmtSize(progress.sent)} of {fmtSize(progress.total)}
          </div>
        </div>
      )}

      {confirming && left.left > 0 && (
        <div className="notice warn" role="alert">
          <TriangleAlert size={15} />
          <div className="grow">
            <b>
              {left.left} of {left.total} {left.what} not ticked.
            </b>{" "}
            Submit anyway?
            <div className="row-flex" style={{ marginTop: 6 }}>
              <button className="btn btn-sm btn-primary" onClick={() => submit(true)} disabled={!ready}>
                Submit anyway
              </button>
              <button className="btn btn-sm" onClick={() => setConfirming(false)} autoFocus>
                Go back and check
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="row-flex">
        <button className="btn btn-primary" disabled={!ready} onClick={() => submit()}>
          {busy ? <Spinner /> : <Upload size={15} />}
          {busy ? "Submitting…" : mode === "files" ? (draft.length > 1 ? `Submit ${draft.length} files` : "Submit file") : mode === "text" ? "Submit text" : "Submit link"}
        </button>
        <span className="small muted">
          {left.total > 0 && <>{left.total - left.left} of {left.total} ticked · </>}
          You'll confirm in a Windows dialog first.
        </span>
      </div>
    </div>
  );
}

function Checks({ pf, error, checking, mode, count }: { pf: Preflight | null; error: string | null; checking: boolean; mode: Mode; count: number }) {
  if (error)
    return (
      <div className="checks">
        <div className="text-danger">
          <CircleX size={14} /> {error}
        </div>
      </div>
    );
  if (!pf) return <div className="checks muted small">{checking ? "Checking with Canvas…" : ""}</div>;
  // "Choose at least one file" is shown as the empty-state hint instead.
  const problems = pf.problems.filter((p) => !(mode === "files" && count === 0 && p.startsWith("Choose at least one")));
  return (
    <div className="checks" aria-live="polite">
      {problems.map((p) => (
        <div key={p} className="text-danger">
          <CircleX size={14} /> <span>{p}</span>
        </div>
      ))}
      {pf.warnings.map((w) => (
        <div key={w} className="text-warn">
          <TriangleAlert size={14} /> <span>{w}</span>
        </div>
      ))}
      {problems.length === 0 && (mode !== "files" || count > 0) && (
        <div className="text-ok">
          <CircleCheck size={14} />
          <span>
            Ready{mode === "files" ? `: ${plural(count, "file")}` : ""} · attempt {pf.next_attempt}
            {pf.allowed_attempts ? ` of ${pf.allowed_attempts}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

export function Receipt({ s }: { s: Submission }) {
  const t = parse(s.submitted_at);
  return (
    <div className="notice ok">
      <CircleCheck size={15} />
      <div>
        Submitted{t ? ` ${fmtDateTime(t)}` : ""}
        {s.attempt ? ` · attempt ${s.attempt}` : ""}
        {s.late ? " · marked late" : ""}
      </div>
    </div>
  );
}
