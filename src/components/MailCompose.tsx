import { Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { registerDrop } from "../lib/drag.ts";
import { UNDO_MS } from "../lib/send.ts";
import { reportError, setState, toast, type MailComposeInit } from "../lib/store.ts";
import type { PickedFile } from "../lib/types.ts";
import { Modal, Notice, Spinner } from "./common.tsx";
import { AttachmentRow } from "./Inbox.tsx";

const split = (s: string) => s.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
const looksLikeEmail = (a: string) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test((a.match(/<([^>]+)>/)?.[1] ?? a).trim());

export function MailCompose({ init }: { init: MailComposeInit }) {
  const [to, setTo] = useState((init.to ?? []).join(", "));
  const [cc, setCc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState(init.subject ?? "");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const close = () => setState({ mailCompose: null });

  useEffect(() => registerDrop("mailcompose", (_p, f) => setFiles((cur) => [...cur, ...f])), []);
  useEffect(() => () => {
    if (timer.current != null) clearInterval(timer.current);
  }, []);

  const bad = [...split(to), ...split(cc)].filter((a) => !looksLikeEmail(a));
  const problems = [split(to).length === 0 && "Add a recipient", bad.length > 0 && `Check: ${bad.join(", ")}`, !subject.trim() && "Add a subject", !body.trim() && "Write a message"].filter(
    Boolean,
  ) as string[];

  const doSend = async () => {
    setSending(true);
    setError(null);
    try {
      await api.gmailSend(split(to), split(cc), subject, body, files.map((f) => f.ref), null);
      close();
      toast("Email sent.", "ok");
    } catch (e) {
      const x = e as { kind?: string; message?: string };
      if (x.kind === "locked") reportError(e);
      else setError(x.message ?? "Not sent.");
    } finally {
      setSending(false);
    }
  };

  const send = () => {
    if (problems.length || sending || countdown != null) return;
    let n = Math.round(UNDO_MS / 1000);
    setCountdown(n);
    timer.current = window.setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(timer.current!);
        timer.current = null;
        setCountdown(null);
        void doSend();
      } else setCountdown(n);
    }, 1000);
  };
  const undo = () => {
    if (timer.current != null) clearInterval(timer.current);
    timer.current = null;
    setCountdown(null);
  };

  return (
    <Modal
      title="New email"
      onClose={close}
      width={680}
      footer={
        countdown != null ? (
          <>
            <span className="small" style={{ marginRight: "auto" }}>Sending in {countdown} s…</span>
            <button className="btn btn-primary" onClick={undo} autoFocus>
              Undo
            </button>
          </>
        ) : (
          <>
            <span className="small muted" style={{ marginRight: "auto" }}>{problems.length ? problems.join(" · ") : "Ctrl+Enter to send · 5 seconds to undo"}</span>
            <button className="btn" onClick={close} disabled={sending}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={send} disabled={problems.length > 0 || sending}>
              {sending ? <Spinner /> : <Send size={14} />} {sending ? "Sending…" : "Send"}
            </button>
          </>
        )
      }
    >
      <div className="stack" data-drop="mailcompose" onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && (e.preventDefault(), send())}>
        <div className="field">
          <label htmlFor="m-to">To</label>
          <div className="row-flex">
            <input id="m-to" className="input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@ontariotechu.ca, …" autoFocus={!init.to?.length} spellCheck={false} />
            {!showCc && (
              <button className="btn btn-sm btn-ghost" onClick={() => setShowCc(true)}>
                Cc
              </button>
            )}
          </div>
        </div>
        {showCc && (
          <div className="field">
            <label htmlFor="m-cc">Cc</label>
            <input id="m-cc" className="input" value={cc} onChange={(e) => setCc(e.target.value)} spellCheck={false} />
          </div>
        )}
        <div className="field">
          <label htmlFor="m-subj">Subject</label>
          <input id="m-subj" className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="m-body">Message</label>
          <textarea id="m-body" className="textarea" rows={9} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
        <AttachmentRow files={files} setFiles={setFiles} disabled={sending || countdown != null} />
        {error && <Notice tone="danger">Not sent: {error}</Notice>}
      </div>
    </Modal>
  );
}
