import { CalendarPlus, ExternalLink, Link2, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, listen } from "../lib/api.ts";
import { reportError, toast } from "../lib/store.ts";
import { relative } from "../lib/time.ts";
import type { ApiError, CalStatus } from "../lib/types.ts";
import { Notice, PasswordInput, Spinner, useNow } from "./common.tsx";

/** Settings → Calendars: Apple (iCloud) two-way, plus read-only links. */
export function CalendarSettings() {
  const [st, setSt] = useState<CalStatus | null>(null);
  const now = useNow(30_000);
  const load = () => api.calendarStatus().then(setSt).catch(() => {});
  useEffect(() => {
    void load();
    let off: (() => void) | undefined;
    void listen("calendar-push", () => load()).then((f) => (off = f));
    return () => off?.();
  }, []);
  if (!st) return null;
  const a = st.apple;

  return (
    <section className="panel" id="calendars">
      <div className="panel-head">
        <h2>Calendars</h2>
        <span className="small muted">Shown in the Calendar tab</span>
      </div>

      <div className="set-row">
        <div className="k">Apple Calendar</div>
        {a ? (
          <div className="stack" style={{ gap: 10 }}>
            <div className="small">
              Connected as <b>{a.email}</b>
            </div>
            <div className="stack" style={{ gap: 4 }}>
              <div className="small muted">Show in Studydesk:</div>
              {a.calendars
                .filter((c) => !c.studydesk)
                .map((c) => (
                  <label key={c.id} className="check">
                    <input type="checkbox" checked={c.shown} onChange={(e) => api.calendarSetShown(c.id, e.target.checked).then(setSt).catch((er) => reportError(er))} />
                    <span className="cal-swatch" style={{ background: c.color || "var(--text-3)" }} />
                    {c.name}
                  </label>
                ))}
              {a.calendars.filter((c) => !c.studydesk).length === 0 && <div className="small muted">No event calendars found in iCloud.</div>}
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <label className="check">
                <input type="checkbox" checked={a.push} onChange={(e) => api.calendarSetPush(e.target.checked).then(setSt).catch((er) => reportError(er))} />
                Put Canvas deadlines and key dates in Apple Calendar
              </label>
              <div className="small muted" style={{ paddingLeft: 23 }}>
                Studydesk keeps them in a calendar called <b>Studydesk</b> in iCloud, so they're on your iPhone and Mac. It updates after every Canvas refresh. Your other calendars are never changed.
              </div>
              {a.push && (
                <div className="row-flex small" style={{ paddingLeft: 23 }}>
                  {a.pushing ? (
                    <>
                      <Spinner /> Updating…
                    </>
                  ) : a.lastPush ? (
                    a.lastPush.error ? (
                      <span className="text-danger">Last update had a problem: {a.lastPush.error}</span>
                    ) : (
                      <span className="muted">
                        Updated {relative(a.lastPush.at, now)}
                        {a.lastPush.written + a.lastPush.removed > 0 ? ` · ${a.lastPush.written + a.lastPush.removed} change${a.lastPush.written + a.lastPush.removed === 1 ? "" : "s"}` : " · nothing changed"}
                      </span>
                    )
                  ) : (
                    <span className="muted">Not updated yet.</span>
                  )}
                  <button className="btn btn-sm btn-ghost" disabled={a.pushing} onClick={() => api.calendarPushNow().then(() => setTimeout(load, 300)).catch((er) => reportError(er))}>
                    <RefreshCw size={13} /> Update now
                  </button>
                </div>
              )}
            </div>
            <Disconnect hasStudydesk={a.calendars.some((c) => c.studydesk)} onDone={setSt} />
          </div>
        ) : (
          <ConnectApple onDone={setSt} />
        )}
      </div>

      <div className="set-row">
        <div className="k">Other calendars</div>
        <div className="stack" style={{ gap: 8 }}>
          {st.links.map((l) => (
            <div key={l.id} className="row-flex">
              <span className="cal-swatch" style={{ background: l.color }} />
              <span className="grow ellipsis">{l.name}</span>
              <button className="btn btn-sm btn-ghost btn-danger" onClick={() => api.calendarRemoveLink(l.id).then(setSt).catch((er) => reportError(er))}>
                <Trash2 size={13} /> Remove
              </button>
            </div>
          ))}
          <AddLink onDone={setSt} />
        </div>
      </div>
    </section>
  );
}

function ConnectApple({ onDone }: { onDone: (s: CalStatus) => void }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const connect = () => {
    setBusy(true);
    setErr(null);
    api
      .calendarConnectApple(email, pw)
      .then((s) => {
        setPw("");
        onDone(s);
        toast("Apple Calendar connected. Your deadlines are being added to a Studydesk calendar.", "ok");
      })
      .catch((e: ApiError) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="small muted">See your Apple calendars next to your deadlines, and get your Canvas deadlines on your iPhone.</div>
      <ol className="steps small">
        <li className="step">
          <div>
            Go to{" "}
            <button className="linklike" onClick={() => api.openExternal("https://account.apple.com/account/manage").catch((e) => reportError(e))}>
              account.apple.com <ExternalLink size={11} />
            </button>{" "}
            → <b>Sign-In and Security</b> → <b>App-Specific Passwords</b> → <b>+</b>, and name it <b>Studydesk</b>.
          </div>
        </li>
        <li className="step">
          <div>
            Apple shows a password like <span className="kbd">abcd-efgh-ijkl-mnop</span>. Copy it. It only works for calendars and contacts, and you can revoke it there any time.
          </div>
        </li>
        <li className="step">
          <div className="stack" style={{ gap: 8 }}>
            <div>Enter your Apple ID email and that password:</div>
            <input className="input" type="email" placeholder="you@icloud.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Apple ID email" />
            <PasswordInput id="apple-app-pw" value={pw} onChange={setPw} placeholder="xxxx-xxxx-xxxx-xxxx" autoComplete="off" />
            {err && <Notice tone="danger">{err}</Notice>}
            <div>
              <button className="btn btn-primary" disabled={busy || !email.trim() || !pw.trim()} onClick={connect}>
                {busy ? <Spinner /> : <CalendarPlus size={15} />} Connect Apple Calendar
              </button>
            </div>
            <div className="small muted">Use the app-specific password, never your Apple ID password. It is stored encrypted on this PC and sent only to Apple (icloud.com).</div>
          </div>
        </li>
      </ol>
    </div>
  );
}

function Disconnect({ hasStudydesk, onDone }: { hasStudydesk: boolean; onDone: (s: CalStatus) => void }) {
  const [open, setOpen] = useState(false);
  const [remove, setRemove] = useState(true);
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <div>
        <button className="btn btn-sm" onClick={() => setOpen(true)}>
          Disconnect…
        </button>
      </div>
    );
  return (
    <div className="stack" style={{ gap: 8, padding: 10, border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
      {hasStudydesk && (
        <label className="check">
          <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} />
          Also delete the Studydesk calendar from iCloud
        </label>
      )}
      <div className="small muted">Your own calendars are not touched either way. Revoke the app-specific password at account.apple.com if you won't use it again.</div>
      <div className="row-flex">
        <button
          className="btn btn-sm btn-danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api
              .calendarDisconnectApple(hasStudydesk && remove)
              .then((s) => (onDone(s), toast("Apple Calendar disconnected.", "ok")))
              .catch((e) => reportError(e))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <Spinner /> : null} Disconnect
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function AddLink({ onDone }: { onDone: (s: CalStatus) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!open)
    return (
      <div>
        <button className="btn btn-sm" onClick={() => setOpen(true)}>
          <Link2 size={13} /> Add a calendar link…
        </button>
        <div className="small muted" style={{ marginTop: 4 }}>Google Calendar, Outlook or any calendar with an iCal link. Read-only.</div>
      </div>
    );
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="small muted">
        <b>Google Calendar:</b> on a computer, Settings → click the calendar → <b>Integrate calendar</b> → copy <b>Secret address in iCal format</b>. Keep that link private: anyone with it can see the calendar.
      </div>
      <input className="input" placeholder="Name, e.g. Google – Personal" value={name} onChange={(e) => setName(e.target.value)} aria-label="Calendar name" />
      <input className="input" placeholder="https://… or webcal://…" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} aria-label="Calendar link" />
      {err && <Notice tone="danger">{err}</Notice>}
      <div className="row-flex">
        <button
          className="btn btn-sm btn-primary"
          disabled={busy || !name.trim() || !url.trim()}
          onClick={() => {
            setBusy(true);
            setErr(null);
            api
              .calendarAddLink(name, url)
              .then((s) => (onDone(s), setOpen(false), setName(""), setUrl("")))
              .catch((e: ApiError) => setErr(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <Spinner /> : null} Add
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
