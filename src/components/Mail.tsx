import { Archive, ExternalLink, Inbox as InboxIcon, MailOpen, Paperclip, PenLine, RefreshCw, Search, Send, Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { registerDrop } from "../lib/drag.ts";
import { sendWithUndo } from "../lib/send.ts";
import { navigate, refreshGmail, reportError, setState, toast, useStore } from "../lib/store.ts";
import { fmtDateTime, fmtListTime, fmtSize } from "../lib/time.ts";
import type { MailMessage, PickedFile, ThreadDetail, ThreadSummary } from "../lib/types.ts";
import { Empty, Html, Linkified, Spinner, useNow } from "./common.tsx";
import { AttachmentRow } from "./Inbox.tsx";

const VIEWS: [string, string][] = [
  ["inbox", "Inbox"],
  ["unread", "Unread"],
  ["starred", "Starred"],
  ["sent", "Sent"],
  ["all", "All mail"],
];

export function Mail({ threadId }: { threadId?: string }) {
  const gmail = useStore((s) => s.gmail);
  const dash = useStore((s) => s.dash);
  const now = useNow(60_000);
  const [view, setView] = useState("inbox");
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [list, setList] = useState<ThreadSummary[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setList(null);
    setError(null);
    api
      .gmailThreads(view, applied, null)
      .then((p) => {
        setList(p.items);
        setNext(p.next);
      })
      .catch((e) => {
        setList([]);
        setError(e.message);
      });
  }, [view, applied]);

  useEffect(() => {
    if (gmail?.connected) load();
  }, [load, gmail?.connected]);

  const patch = (id: string, p: Partial<ThreadSummary>) => setList((l) => l?.map((t) => (t.id === id ? { ...t, ...p } : t)) ?? l);

  useEffect(() => {
    if (!threadId) return setThread(null);
    let live = true;
    setLoadingThread(true);
    api
      .gmailThread(threadId)
      .then((t) => {
        if (!live) return;
        setThread(t);
        if (t.messages.some((m) => m.unread)) {
          patch(t.id, { unread: false });
          api.gmailModify(t.id, "read").then(refreshGmail).catch(() => {});
        }
      })
      .catch((e) => reportError(e, "Couldn't open the email"))
      .finally(() => live && setLoadingThread(false));
    return () => {
      live = false;
    };
  }, [threadId]);

  const shown = list ?? [];
  const idx = shown.findIndex((t) => t.id === threadId);
  const open = (id: string) => navigate({ view: "mail", threadId: id });

  const act = useMemo(
    () => ({
      star: (t: { id: string; starred: boolean }) => {
        patch(t.id, { starred: !t.starred });
        setThread((x) => (x && x.id === t.id ? { ...x, starred: !t.starred } : x));
        api.gmailModify(t.id, t.starred ? "unstar" : "star").catch((e) => reportError(e));
      },
      unread: (t: { id: string }) => {
        patch(t.id, { unread: true });
        navigate({ view: "mail" });
        api.gmailModify(t.id, "unread").then(refreshGmail).catch((e) => reportError(e));
      },
      archive: (t: { id: string; inInbox: boolean }) => {
        const after = shown[idx + 1] ?? shown[idx - 1];
        if (view === "inbox" || view === "unread") setList((l) => l?.filter((x) => x.id !== t.id) ?? l);
        else patch(t.id, { inInbox: !t.inInbox });
        navigate(after && after.id !== t.id ? { view: "mail", threadId: after.id } : { view: "mail" });
        api
          .gmailModify(t.id, t.inInbox ? "archive" : "inbox")
          .then(() => toast(t.inInbox ? "Archived." : "Moved to inbox.", "ok", { timeout: 2500 }))
          .catch((e) => reportError(e));
      },
    }),
    [shown, idx, view],
  );

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.ctrlKey || e.altKey || e.metaKey || t.closest("input, textarea, select, .modal, .palette")) return;
      const cur = shown[idx];
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        const n = shown[Math.min(shown.length - 1, idx + 1)];
        if (n) open(n.id);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        const n = shown[Math.max(0, idx - 1)];
        if (n) open(n.id);
      } else if (e.key === "e" && cur) act.archive(cur);
      else if (e.key === "u" && cur) act.unread(cur);
      else if (e.key === "s" && cur) act.star(cur);
      else if (e.key === "r" && cur) (e.preventDefault(), document.getElementById("mail-reply")?.focus());
      else if (e.key === "c") (e.preventDefault(), setState({ mailCompose: {} }));
      else if (e.key === "/") (e.preventDefault(), document.getElementById("mail-search")?.focus());
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  useEffect(() => {
    listRef.current?.querySelector(".conv.selected")?.scrollIntoView({ block: "nearest" });
  }, [threadId]);

  if (!gmail?.connected) {
    return (
      <>
        <header className="topbar">
          <h1>Email</h1>
        </header>
        <div className="content">
          <Empty
            title="School email isn't connected"
            action={
              <button className="btn btn-primary" onClick={() => navigate({ view: "settings" })}>
                Set it up in Settings
              </button>
            }
          >
            Connect your school Gmail to read and answer it next to Canvas.
          </Empty>
        </div>
      </>
    );
  }

  const courses = (dash?.courses ?? []).filter((c) => !c.hidden);

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Email</h1>
          <div className="sub">{gmail.email} · ↑ ↓ move · E archive · U unread · S star · R reply · C new · / search</div>
        </div>
        <div className="actions">
          <button className="icon-btn" onClick={load} title="Refresh">
            <RefreshCw size={15} />
          </button>
          <button className="btn btn-primary" onClick={() => setState({ mailCompose: {} })}>
            <PenLine size={15} /> New email
          </button>
        </div>
      </header>
      <div className="content" style={{ overflow: "hidden" }}>
        <div className="inbox">
          <div className="inbox-list">
            <div className="toolbar">
              <div className="seg">
                {VIEWS.map(([k, l]) => (
                  <button key={k} className={view === k ? "active" : ""} onClick={() => setView(k)}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <form
              className="toolbar"
              onSubmit={(e) => {
                e.preventDefault();
                setApplied(query.trim());
              }}
            >
              <select
                className="select"
                style={{ width: 130, flex: "none" }}
                value=""
                onChange={(e) => {
                  const q = e.target.value ? `"${e.target.value}"` : "";
                  setQuery(q);
                  setApplied(q);
                }}
                aria-label="Filter by course"
                title="Search mail that mentions a course code"
              >
                <option value="">Course…</option>
                {courses.filter((c) => c.course_code).map((c) => (
                  <option key={c.id} value={c.course_code}>
                    {c.course_code}
                  </option>
                ))}
              </select>
              <div className="search">
                <Search size={14} />
                <input id="mail-search" className="input" placeholder="Search Gmail (Enter)" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              {applied && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => (setQuery(""), setApplied(""))}>
                  Clear
                </button>
              )}
            </form>
            <div className="scroll" ref={listRef}>
              {error ? (
                <Empty title="Couldn't load email">{error}</Empty>
              ) : list == null ? (
                <div className="empty">
                  <Spinner />
                </div>
              ) : shown.length === 0 ? (
                <Empty title={applied ? "No matches" : "Nothing here"} />
              ) : (
                <>
                  {shown.map((t) => (
                    <button key={t.id} className={`conv${t.unread ? " unread" : ""}${t.id === threadId ? " selected" : ""}`} onClick={() => open(t.id)}>
                      <span className="ud">{t.unread && <span className="unread-dot" />}</span>
                      <span style={{ minWidth: 0 }}>
                        <span className="l1">
                          <span className="who ellipsis">{t.senders.join(", ") || "(unknown)"}</span>
                          {t.messageCount > 1 && <span className="small muted">{t.messageCount}</span>}
                          <span className="when">{fmtListTime(t.lastMs, now)}</span>
                        </span>
                        <span className="subj ellipsis" style={{ display: "block" }}>{t.subject || "(no subject)"}</span>
                        <span className="prev ellipsis" style={{ display: "block" }}>{t.snippet}</span>
                        {(t.hasAttachments || t.starred) && (
                          <span className="l4">
                            {t.hasAttachments && <Paperclip size={12} className="muted" />}
                            {t.starred && <Star size={12} className="text-warn" fill="currentColor" />}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                  {next && (
                    <div style={{ padding: 10, textAlign: "center" }}>
                      <button
                        className="btn btn-sm"
                        disabled={more}
                        onClick={() => {
                          setMore(true);
                          api
                            .gmailThreads(view, applied, next)
                            .then((p) => {
                              setList((l) => [...(l ?? []), ...p.items.filter((x) => !(l ?? []).some((y) => y.id === x.id))]);
                              setNext(p.next);
                            })
                            .catch((e) => reportError(e))
                            .finally(() => setMore(false));
                        }}
                      >
                        {more && <Spinner />} Load older
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
          {thread ? (
            <MailThread key={thread.id} t={thread} me={gmail.email ?? ""} now={now} act={act} onSent={() => api.gmailThread(thread.id).then(setThread).catch(() => {})} />
          ) : (
            <div className="thread">{loadingThread ? <div className="empty"><Spinner /></div> : <Empty title="Select an email">Or press C to write one.</Empty>}</div>
          )}
        </div>
      </div>
    </>
  );
}

function MailThread({
  t,
  me,
  now,
  act,
  onSent,
}: {
  t: ThreadDetail;
  me: string;
  now: number;
  act: { star: (t: { id: string; starred: boolean }) => void; unread: (t: { id: string }) => void; archive: (t: { id: string; inInbox: boolean }) => void };
  onSent: () => void;
}) {
  const last = t.messages[t.messages.length - 1];
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(t.messages.filter((m, i) => m.unread || i === t.messages.length - 1).map((m) => m.id)));
  const [all, setAll] = useState(false);
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [sending, setSending] = useState(false);
  const drag = useStore((s) => s.drag);
  const msgsRef = useRef<HTMLDivElement>(null);
  const meLower = me.toLowerCase();

  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight });
  }, [t.messages.length]);
  useEffect(() => registerDrop("mailreply", (_p, f) => setFiles((cur) => [...cur, ...f])), []);

  const emailOf = (a: string) => (a.match(/<([^>]+)>/)?.[1] ?? a).trim().toLowerCase();
  // Reply goes to the last message's sender (or Reply-To); if you sent it, back to its recipients.
  const lastFromMe = last.fromEmail.toLowerCase() === meLower;
  const replyTo = lastFromMe ? last.to : [last.replyTo || (last.fromName && last.fromName !== last.fromEmail ? `${last.fromName} <${last.fromEmail}>` : last.fromEmail)];
  const others = [...last.to, ...last.cc].filter((a) => emailOf(a) !== meLower && !replyTo.some((r) => emailOf(r) === emailOf(a)));
  const to = replyTo;
  const cc = all ? others : [];
  const subject = /^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`;

  const send = () => {
    if (!body.trim() || sending) return;
    setSending(true);
    const refs = [last.references, last.messageIdHeader].filter(Boolean).join(" ") || null;
    sendWithUndo(
      "Sending email",
      async () => {
        try {
          await api.gmailSend(to, cc, subject, body, files.map((f) => f.ref), { threadId: t.id, inReplyTo: last.messageIdHeader, references: refs });
          setBody("");
          setFiles([]);
          toast("Email sent.", "ok", { timeout: 2500 });
          onSent();
        } catch (e) {
          reportError(e, "Email not sent");
        } finally {
          setSending(false);
        }
      },
      () => setSending(false),
    );
  };

  return (
    <div className="thread">
      <div className="thread-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="selectable">{t.subject || "(no subject)"}</h2>
          <div className="small muted">{t.messages.length === 1 ? "1 message" : `${t.messages.length} messages`}</div>
        </div>
        <button className={`icon-btn${t.starred ? " on" : ""}`} onClick={() => act.star(t)} title="Star (S)">
          <Star size={16} fill={t.starred ? "currentColor" : "none"} />
        </button>
        <button className="icon-btn" onClick={() => act.unread(t)} title="Mark unread (U)">
          <MailOpen size={16} />
        </button>
        <button className="icon-btn" onClick={() => act.archive(t)} title={t.inInbox ? "Archive (E)" : "Move to inbox (E)"}>
          {t.inInbox ? <Archive size={16} /> : <InboxIcon size={16} />}
        </button>
        <button className="icon-btn" title="Open in Gmail" onClick={() => api.openExternal(`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(me)}#all/${t.id}`).catch((e) => reportError(e))}>
          <ExternalLink size={16} />
        </button>
      </div>
      <div className="msgs" ref={msgsRef}>
        {t.messages.map((m) => (
          <MailMsg key={m.id} m={m} mine={m.fromEmail.toLowerCase() === meLower} open={expanded.has(m.id)} toggle={() => setExpanded((s) => { const n = new Set(s); n.has(m.id) ? n.delete(m.id) : n.add(m.id); return n; })} now={now} />
        ))}
      </div>
      <div className="composer" data-drop="mailreply" style={drag?.over === "mailreply" ? { background: "var(--accent-soft)" } : undefined}>
        <div className="row-flex small">
          <span className="muted">To:</span>
          <span className="ellipsis grow">{to.join(", ")}{cc.length ? ` · Cc: ${cc.join(", ")}` : ""}</span>
          {others.length > 0 && (
            <label className="check">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Reply all (+{others.length})
            </label>
          )}
        </div>
        <textarea
          id="mail-reply"
          className="textarea"
          rows={3}
          placeholder="Write a reply…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={sending}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) (e.preventDefault(), send());
          }}
        />
        <AttachmentRow files={files} setFiles={setFiles} disabled={sending} />
        <div className="row-flex">
          <span className="small muted">Ctrl+Enter to send · 5 seconds to undo</span>
          <button className="btn btn-primary" style={{ marginLeft: "auto" }} onClick={send} disabled={!body.trim() || sending}>
            {sending ? <Spinner /> : <Send size={14} />} Send
          </button>
        </div>
      </div>
    </div>
  );
}

function MailMsg({ m, mine, open, toggle, now }: { m: MailMessage; mine: boolean; open: boolean; toggle: () => void; now: number }) {
  return (
    <div className={`msg${mine ? " mine" : ""}`} style={{ maxWidth: 900 }}>
      <button className="mh" onClick={toggle} style={{ all: "unset", display: "flex", gap: 8, alignItems: "baseline", cursor: "pointer", width: "100%" }}>
        <b>{mine ? "You" : m.fromName}</b>
        {!mine && m.fromName !== m.fromEmail && <span className="small muted ellipsis">{m.fromEmail}</span>}
        <span className="small muted" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>{fmtDateTime(m.dateMs, now)}</span>
      </button>
      {open ? (
        <>
          <div className="small muted" style={{ margin: "2px 0 8px" }}>
            To {m.to.join(", ")}
            {m.cc.length ? ` · Cc ${m.cc.join(", ")}` : ""}
          </div>
          {m.text ? (
            <div className="msg-body">
              <Linkified text={m.text} />
            </div>
          ) : m.html ? (
            <Html html={m.html} clamp />
          ) : (
            <div className="muted small">(no text)</div>
          )}
          {m.attachments.length > 0 && (
            <div className="atts">
              {m.attachments.map((a) => (
                <button
                  key={a.attachmentId}
                  className="att"
                  title="Save to your computer"
                  onClick={() =>
                    api
                      .gmailSaveAttachment(m.id, a.attachmentId, a.filename)
                      .then((p) => p && toast(`Saved to ${p}`, "ok"))
                      .catch((e) => reportError(e))
                  }
                >
                  <Paperclip size={13} />
                  <span className="ellipsis">{a.filename}</span>
                  <span className="muted">{fmtSize(a.size)}</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="small muted ellipsis">{(m.text ?? "").replace(/\s+/g, " ").slice(0, 160)}</div>
      )}
    </div>
  );
}
