import { Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { registerDrop } from "../lib/drag.ts";
import { UNDO_MS } from "../lib/send.ts";
import { navigate, newJob, reportError, setState, toast, useStore, type ComposeInit } from "../lib/store.ts";
import type { PickedFile, Recipient } from "../lib/types.ts";
import { Modal, Notice, Spinner } from "./common.tsx";
import { AttachmentRow } from "./Inbox.tsx";

export function Compose({ init }: { init: ComposeInit }) {
  const dash = useStore((s) => s.dash);
  const courses = (dash?.courses ?? []).filter((c) => !c.hidden);
  const [courseId, setCourseId] = useState<number | null>(init.courseId ?? null);
  const [to, setTo] = useState<Recipient[]>([]);
  const [teachers, setTeachers] = useState<Recipient[] | null>(null);
  const [tas, setTas] = useState<Recipient[] | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Recipient[]>([]);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const [subject, setSubject] = useState(init.subject ?? "");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [separate, setSeparate] = useState(false);
  const [sending, setSending] = useState(false);
  const autoAdded = useRef(false);

  const close = () => setState({ compose: null });
  const add = (r: Recipient) => setTo((cur) => (cur.some((x) => x.id === r.id) ? cur : [...cur, r]));

  // Instructors and TAs for one-click addressing.
  useEffect(() => {
    if (courseId == null) return;
    setTeachers(null);
    setTas(null);
    let live = true;
    api.searchRecipients(courseId, "", "teachers").then((r) => {
      if (!live) return;
      setTeachers(r);
      if (init.teachers && !autoAdded.current && init.courseId === courseId) {
        autoAdded.current = true;
        r.forEach(add);
      }
    }).catch(() => live && setTeachers([]));
    api.searchRecipients(courseId, "", "tas").then((r) => live && setTas(r)).catch(() => live && setTas([]));
    return () => {
      live = false;
    };
  }, [courseId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (courseId == null || q.trim().length < 2) return setResults([]);
    let live = true;
    setSearching(true);
    const t = setTimeout(() => {
      api
        .searchRecipients(courseId, q, null)
        .then((r) => {
          if (!live) return;
          setResults(r.slice(0, 12));
          setActive(0);
        })
        .catch(() => live && setResults([]))
        .finally(() => live && setSearching(false));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, courseId]);

  useEffect(() => registerDrop("compose", (_p, f) => setFiles((cur) => [...cur, ...f])), []);

  const problems = [
    courseId == null && "Choose a course",
    to.length === 0 && "Add a recipient",
    !subject.trim() && "Add a subject",
    !body.trim() && "Write a message",
  ].filter(Boolean) as string[];

  // Undo window runs inside the dialog, so cancelling keeps everything typed.
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const stopTimer = () => {
    if (timer.current != null) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stopTimer, []);

  const doSend = async () => {
    if (courseId == null) return;
    setSending(true);
    setError(null);
    try {
      const res = await api.sendMessage(courseId, to.map((r) => r.id), subject.trim(), body, !separate, files.map((f) => f.ref), newJob());
      const first = res[0];
      close();
      toast("Message sent.", "ok", first ? { action: { label: "Open", run: () => navigate({ view: "inbox", conversationId: first.id }) }, timeout: 6000 } : {});
    } catch (e) {
      const err = e as { kind?: string; message?: string };
      if (err.kind === "locked") reportError(e);
      else setError(err.message ?? "Message not sent.");
    } finally {
      setSending(false);
    }
  };

  const send = () => {
    if (problems.length || sending || countdown != null || courseId == null) return;
    let n = Math.round(UNDO_MS / 1000);
    setCountdown(n);
    timer.current = window.setInterval(() => {
      n -= 1;
      if (n <= 0) {
        stopTimer();
        setCountdown(null);
        void doSend();
      } else setCountdown(n);
    }, 1000);
  };
  const undo = () => {
    stopTimer();
    setCountdown(null);
  };

  const quick = (label: string, list: Recipient[] | null) =>
    list && list.length > 0 ? (
      <button className="btn btn-sm" onClick={() => list.forEach(add)} title={list.map((r) => r.name).join(", ")}>
        + {label} ({list.length})
      </button>
    ) : null;

  return (
    <Modal
      title="New message"
      onClose={close}
      width={680}
      footer={
        <>
          {countdown != null ? (
            <>
              <span className="small" style={{ marginRight: "auto" }}>
                Sending in {countdown} s…
              </span>
              <button className="btn btn-primary" onClick={undo} autoFocus>
                Undo
              </button>
            </>
          ) : (
            <>
              <span className="small muted" style={{ marginRight: "auto" }}>
                {problems.length ? problems.join(" · ") : "Ctrl+Enter to send · 5 seconds to undo"}
              </span>
              <button className="btn" onClick={close} disabled={sending}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={send} disabled={problems.length > 0 || sending}>
                {sending ? <Spinner /> : <Send size={14} />} {sending ? "Sending…" : "Send"}
              </button>
            </>
          )}
        </>
      }
    >
      <div
        className="stack"
        data-drop="compose"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            send();
          }
        }}
      >
        <div className="field">
          <label htmlFor="c-course">Course</label>
          <select
            id="c-course"
            className="select"
            value={courseId ?? ""}
            onChange={(e) => {
              setCourseId(e.target.value ? Number(e.target.value) : null);
              setTo([]);
            }}
          >
            <option value="">Choose a course…</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.course_code ? `${c.course_code} – ${c.name}` : c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="c-to">To</label>
          <div style={{ position: "relative" }}>
            <div className="rcp-box">
              {to.map((r) => (
                <span key={r.id} className="rcp-chip">
                  {r.full_name || r.name}
                  <button className="icon-btn sm" onClick={() => setTo(to.filter((x) => x.id !== r.id))} aria-label={`Remove ${r.name}`}>
                    <X size={12} />
                  </button>
                </span>
              ))}
              <input
                id="c-to"
                placeholder={courseId == null ? "Choose a course first" : to.length ? "Add someone else…" : "Type a name"}
                disabled={courseId == null}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") (e.preventDefault(), setActive(Math.min(results.length - 1, active + 1)));
                  else if (e.key === "ArrowUp") (e.preventDefault(), setActive(Math.max(0, active - 1)));
                  else if (e.key === "Enter" && results[active] && !e.ctrlKey) {
                    e.preventDefault();
                    add(results[active]);
                    setQ("");
                  } else if (e.key === "Backspace" && !q && to.length) setTo(to.slice(0, -1));
                }}
                autoComplete="off"
              />
              {searching && <Spinner size={13} />}
            </div>
            {results.length > 0 && q.trim().length >= 2 && (
              <div className="dropdown" role="listbox">
                {results.map((r, i) => (
                  <button
                    key={r.id}
                    className={i === active ? "active" : ""}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      add(r);
                      setQ("");
                    }}
                  >
                    {r.full_name || r.name}
                    {to.some((x) => x.id === r.id) && <span className="muted small">added</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          {courseId != null && (
            <div className="row-flex" style={{ flexWrap: "wrap" }}>
              {teachers == null ? <span className="small muted">Loading instructors…</span> : quick("Instructors", teachers)}
              {quick("TAs", tas)}
            </div>
          )}
          {to.length > 1 && (
            <label className="check small">
              <input type="checkbox" checked={separate} onChange={(e) => setSeparate(e.target.checked)} />
              Send a separate copy to each person (instead of one group conversation)
            </label>
          )}
        </div>

        <div className="field">
          <label htmlFor="c-subj">Subject</label>
          <input id="c-subj" className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={255} />
        </div>
        <div className="field">
          <label htmlFor="c-body">Message</label>
          <textarea id="c-body" className="textarea" rows={8} value={body} onChange={(e) => setBody(e.target.value)} autoFocus={!!init.subject} />
        </div>
        <AttachmentRow files={files} setFiles={setFiles} disabled={sending || countdown != null} />
        {error && <Notice tone="danger">Not sent: {error}</Notice>}
        {courseId != null && teachers?.length === 0 && tas?.length === 0 && (
          <Notice tone="neutral">This course doesn't list instructors for messaging. Search by name instead.</Notice>
        )}
      </div>
    </Modal>
  );
}
