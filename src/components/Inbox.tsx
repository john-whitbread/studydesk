import { Archive, ArrowLeft, MailOpen, Paperclip, PenLine, RefreshCw, Search, Send, Star, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { registerDrop } from "../lib/drag.ts";
import { sendWithUndo } from "../lib/send.ts";
import { navigate, newJob, refreshUnread, reportError, setState, toast, useStore } from "../lib/store.ts";
import { fmtDateTime, fmtListTime, fmtSize, parse } from "../lib/time.ts";
import type { Conversation, PickedFile } from "../lib/types.ts";
import { fuzzyScore, plural } from "../lib/util.ts";
import { Empty, FileIcon, Linkified, Spinner, useNow } from "./common.tsx";

const SCOPES: [string, string][] = [
  ["inbox", "Inbox"],
  ["unread", "Unread"],
  ["starred", "Starred"],
  ["sent", "Sent"],
  ["archived", "Archived"],
];

export function Inbox({ conversationId }: { conversationId?: number }) {
  const dash = useStore((s) => s.dash);
  const me = dash?.userId ?? -1;
  const now = useNow(60_000);
  const [scope, setScope] = useState("inbox");
  const [courseFilter, setCourseFilter] = useState<number | null>(null);
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [q, setQ] = useState("");
  const [thread, setThread] = useState<Conversation | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setConvs(null);
    api
      .listConversations(scope, courseFilter, null)
      .then((p) => {
        setConvs(p.items);
        setNext(p.next);
      })
      .catch((e) => {
        setConvs([]);
        reportError(e, "Couldn't load messages");
      });
  }, [scope, courseFilter]);

  useEffect(load, [load]);

  const patch = (id: number, p: Partial<Conversation>) => {
    setConvs((cs) => cs?.map((c) => (c.id === id ? { ...c, ...p } : c)) ?? cs);
    setThread((t) => (t && t.id === id ? { ...t, ...p } : t));
  };

  useEffect(() => {
    if (conversationId == null) return setThread(null);
    let live = true;
    setThreadLoading(true);
    api
      .getConversation(conversationId)
      .then((c) => {
        if (!live) return;
        setThread(c);
        patch(c.id, { workflow_state: c.workflow_state === "unread" ? "read" : c.workflow_state });
        refreshUnread();
      })
      .catch((e) => reportError(e, "Couldn't open the conversation"))
      .finally(() => live && setThreadLoading(false));
    return () => {
      live = false;
    };
  }, [conversationId]);

  const shown = useMemo(() => {
    const list = convs ?? [];
    if (!q.trim()) return list;
    const hay = (c: Conversation) => `${c.subject ?? ""} ${c.last_message ?? ""} ${c.participants.map((p) => p.name).join(" ")} ${c.context_name ?? ""}`;
    return list.filter((c) => fuzzyScore(q, hay(c)) > 0);
  }, [convs, q]);

  const open = (id: number) => navigate({ view: "inbox", conversationId: id });
  const idx = shown.findIndex((c) => c.id === conversationId);

  const act = {
    star: async (c: Conversation) => {
      patch(c.id, { starred: !c.starred });
      api.updateConversation(c.id, null, !c.starred).catch((e) => (patch(c.id, { starred: c.starred }), reportError(e)));
    },
    unread: async (c: Conversation) => {
      patch(c.id, { workflow_state: "unread" });
      navigate({ view: "inbox" });
      api.updateConversation(c.id, "unread", null).then(refreshUnread).catch((e) => reportError(e));
    },
    archive: async (c: Conversation) => {
      const after = shown[idx + 1] ?? shown[idx - 1];
      if (scope !== "archived") setConvs((cs) => cs?.filter((x) => x.id !== c.id) ?? cs);
      navigate(after && after.id !== c.id ? { view: "inbox", conversationId: after.id } : { view: "inbox" });
      api
        .updateConversation(c.id, c.workflow_state === "archived" ? "read" : "archived", null)
        .then(() => toast(c.workflow_state === "archived" ? "Moved to inbox." : "Archived.", "ok", { timeout: 2500 }))
        .catch((e) => reportError(e));
    },
  };

  // Keyboard: ↑/↓ or j/k move, e archive, u unread, s star, r reply, c compose.
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
      else if (e.key === "r" && cur) {
        e.preventDefault();
        document.getElementById("reply-box")?.focus();
      } else if (e.key === "c") {
        e.preventDefault();
        setState({ compose: { courseId: courseFilter ?? undefined } });
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  useEffect(() => {
    listRef.current?.querySelector(".conv.selected")?.scrollIntoView({ block: "nearest" });
  }, [conversationId]);

  const courses = (dash?.courses ?? []).filter((c) => !c.hidden);
  const names = (c: Conversation) => {
    const others = c.participants.filter((p) => p.id !== me).map((p) => p.name);
    return others.length ? others.join(", ") : "Only you";
  };

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Canvas inbox</h1>
          <div className="sub">Canvas conversations · ↑ ↓ to move · E archive · U unread · S star · R reply · C new</div>
        </div>
        <div className="actions">
          <button className="icon-btn" onClick={load} title="Refresh" aria-label="Refresh">
            <RefreshCw size={15} />
          </button>
          <button className="btn btn-primary" onClick={() => setState({ compose: { courseId: courseFilter ?? undefined } })}>
            <PenLine size={15} /> New message
          </button>
        </div>
      </header>
      <div className="content" style={{ overflow: "hidden" }}>
        <div className={`inbox${conversationId != null ? " has-sel" : ""}`}>
          <div className="inbox-list">
            <div className="toolbar">
              <div className="seg">
                {SCOPES.map(([k, l]) => (
                  <button key={k} className={scope === k ? "active" : ""} onClick={() => setScope(k)}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <div className="toolbar">
              <select className="select" style={{ width: 150, flex: "none" }} value={courseFilter ?? ""} onChange={(e) => setCourseFilter(e.target.value ? Number(e.target.value) : null)} aria-label="Course">
                <option value="">All courses</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.course_code || c.name}
                  </option>
                ))}
              </select>
              <div className="search">
                <Search size={14} />
                <input className="input" placeholder="Filter loaded messages" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            </div>
            <div className="scroll" ref={listRef}>
              {convs == null ? (
                <div className="empty">
                  <Spinner />
                </div>
              ) : shown.length === 0 ? (
                <Empty title={q ? "No matches" : "No messages here"} />
              ) : (
                <>
                  {shown.map((c) => (
                    <button key={c.id} className={`conv${c.workflow_state === "unread" ? " unread" : ""}${c.id === conversationId ? " selected" : ""}`} onClick={() => open(c.id)}>
                      <span className="ud">{c.workflow_state === "unread" && <span className="unread-dot" />}</span>
                      <span style={{ minWidth: 0 }}>
                        <span className="l1">
                          <span className="who ellipsis">{names(c)}</span>
                          {c.message_count > 1 && <span className="small muted">{c.message_count}</span>}
                          <span className="when">{c.last_message_at ? fmtListTime(parse(c.last_message_at) as number, now) : ""}</span>
                        </span>
                        <span className="subj ellipsis" style={{ display: "block" }}>{c.subject || "(no subject)"}</span>
                        <span className="prev ellipsis" style={{ display: "block" }}>{c.last_message}</span>
                        <span className="l4">
                          {c.context_name && <span className="tag">{c.context_name}</span>}
                          {c.properties.includes("attachments") && <Paperclip size={12} className="muted" />}
                          {c.starred && <Star size={12} className="text-warn" fill="currentColor" />}
                        </span>
                      </span>
                    </button>
                  ))}
                  {next && (
                    <div style={{ padding: 10, textAlign: "center" }}>
                      <button
                        className="btn btn-sm"
                        disabled={loadingMore}
                        onClick={() => {
                          setLoadingMore(true);
                          api
                            .listConversations(scope, courseFilter, next)
                            .then((p) => {
                              setConvs((cs) => [...(cs ?? []), ...p.items.filter((x) => !(cs ?? []).some((y) => y.id === x.id))]);
                              setNext(p.next);
                            })
                            .catch((e) => reportError(e))
                            .finally(() => setLoadingMore(false));
                        }}
                      >
                        {loadingMore ? <Spinner /> : null} Load older messages
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {thread ? (
            <Thread
              key={thread.id}
              c={thread}
              me={me}
              now={now}
              actions={act}
              onReplied={(c) => {
                setThread(c);
                patch(c.id, { last_message: c.last_message, last_message_at: c.last_message_at, message_count: c.message_count });
              }}
            />
          ) : (
            <div className="thread">{threadLoading ? <div className="empty"><Spinner /></div> : <Empty title="Select a conversation">Or press C to write a new message.</Empty>}</div>
          )}
        </div>
      </div>
    </>
  );
}

function Thread({
  c,
  me,
  now,
  actions,
  onReplied,
}: {
  c: Conversation;
  me: number;
  now: number;
  actions: { star: (c: Conversation) => void; unread: (c: Conversation) => void; archive: (c: Conversation) => void };
  onReplied: (c: Conversation) => void;
}) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [sending, setSending] = useState(false);
  const msgsRef = useRef<HTMLDivElement>(null);
  const drag = useStore((s) => s.drag);
  const people = new Map(c.participants.map((p) => [p.id, p.full_name || p.name]));
  const msgs = [...c.messages].reverse();

  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight });
  }, [c.messages.length]);

  useEffect(() => registerDrop("reply", (_p, f) => setFiles((cur) => [...cur, ...f.filter((x) => !cur.some((y) => JSON.stringify(y.ref) === JSON.stringify(x.ref)))])), []);

  const send = () => {
    if (!body.trim() || sending) return;
    const text = body;
    const att = files;
    setSending(true);
    sendWithUndo(
      "Sending reply",
      async () => {
        try {
          const updated = await api.sendReply(c.id, text, att.map((f) => f.ref), newJob());
          setBody("");
          setFiles([]);
          // add_message returns the conversation with only the new message; merge newest-first, no duplicates.
          const seen = new Set<number>();
          const messages = [...updated.messages, ...c.messages].filter((m) => !seen.has(m.id) && (seen.add(m.id), true));
          onReplied({ ...c, ...updated, participants: c.participants, messages, message_count: messages.length });
          toast("Reply sent.", "ok", { timeout: 2500 });
        } catch (e) {
          reportError(e, "Reply not sent");
        } finally {
          setSending(false);
        }
      },
      () => setSending(false),
    );
  };

  const others = c.participants.filter((p) => p.id !== me);

  return (
    <div className="thread">
      <div className="thread-head">
        <button className="icon-btn back-btn" onClick={() => navigate({ view: "inbox" })} title="Back to messages" aria-label="Back to messages">
          <ArrowLeft size={16} />
        </button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="selectable">{c.subject || "(no subject)"}</h2>
          <div className="small muted">
            {others.map((p) => p.full_name || p.name).join(", ") || "Only you"}
            {c.context_name ? ` · ${c.context_name}` : ""} · {plural(c.message_count, "message")}
          </div>
        </div>
        <button className={`icon-btn${c.starred ? " on" : ""}`} onClick={() => actions.star(c)} title="Star (S)">
          <Star size={16} fill={c.starred ? "currentColor" : "none"} />
        </button>
        <button className="icon-btn" onClick={() => actions.unread(c)} title="Mark unread (U)" aria-label="Mark unread (U)">
          <MailOpen size={16} />
        </button>
        <button className="icon-btn" onClick={() => actions.archive(c)} title={c.workflow_state === "archived" ? "Move to inbox (E)" : "Archive (E)"} aria-label={c.workflow_state === "archived" ? "Move to inbox (E)" : "Archive (E)"}>
          <Archive size={16} />
        </button>
      </div>
      <div className="msgs" ref={msgsRef}>
        {msgs.map((m) => {
          const mine = m.author_id === me;
          return (
            <div key={m.id} className={`msg${mine ? " mine" : ""}`}>
              <div className="mh">
                <b>{mine ? "You" : people.get(m.author_id) ?? "Unknown"}</b>
                <span className="muted">{m.created_at ? fmtDateTime(parse(m.created_at) as number, now) : ""}</span>
              </div>
              <div className="msg-body">
                <Linkified text={m.body} />
              </div>
              {m.attachments.length > 0 && (
                <div className="atts">
                  {m.attachments.map((f) => (
                    <button key={f.id} className="att" title="Download in your browser" onClick={() => f.url && api.openExternal(f.url).catch((e) => reportError(e))}>
                      <Paperclip size={13} />
                      <span className="ellipsis">{f.display_name || f.filename}</span>
                      {f.size ? <span className="muted">{fmtSize(f.size)}</span> : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className={`composer${drag ? (drag.over === "reply" ? " drop-ok" : "") : ""}`} data-drop="reply" style={drag?.over === "reply" ? { background: "var(--accent-soft)" } : undefined}>
        <textarea
          id="reply-box"
          className="textarea"
          placeholder={`Reply to ${others.map((p) => p.name).join(", ") || "conversation"}…`}
          value={body}
          rows={3}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
          disabled={sending}
        />
        <AttachmentRow files={files} setFiles={setFiles} disabled={sending} />
        <div className="row-flex">
          <span className="small muted">Ctrl+Enter to send · you'll have 5 seconds to undo</span>
          <button className="btn btn-primary" style={{ marginLeft: "auto" }} onClick={send} disabled={!body.trim() || sending}>
            {sending ? <Spinner /> : <Send size={14} />} Send reply
          </button>
        </div>
      </div>
    </div>
  );
}

export function AttachmentRow({ files, setFiles, disabled }: { files: PickedFile[]; setFiles: (f: PickedFile[]) => void; disabled?: boolean }) {
  return (
    <div className="atts" style={{ marginTop: 0, alignItems: "center" }}>
      {files.map((f) => (
        <span key={JSON.stringify(f.ref)} className="att" style={{ cursor: "default" }}>
          <FileIcon ext={f.ext} size={13} />
          <span className="ellipsis">{f.name}</span>
          <span className="muted">{fmtSize(f.size)}</span>
          <button className="icon-btn sm" onClick={() => setFiles(files.filter((x) => x !== f))} aria-label={`Remove ${f.name}`} disabled={disabled}>
            <X size={12} />
          </button>
        </span>
      ))}
      <button
        className="btn btn-sm btn-ghost"
        disabled={disabled}
        onClick={() =>
          api
            .pickFiles()
            .then((f) => f.length && setFiles([...files, ...f]))
            .catch((e) => reportError(e))
        }
      >
        <Paperclip size={13} /> Attach
      </button>
    </div>
  );
}
