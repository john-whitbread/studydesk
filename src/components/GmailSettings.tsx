import { Mail } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { refreshGmail, reportError, toast } from "../lib/store.ts";
import type { ApiError, GmailStatus } from "../lib/types.ts";
import { Notice, PasswordInput, Spinner } from "./common.tsx";

export function GmailSettings() {
  const [st, setSt] = useState<GmailStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.gmailStatus().then((s) => {
    setSt(s);
    if (s.clientId) setClientId(s.clientId);
  }).catch((e) => reportError(e));
  useEffect(() => {
    load();
  }, []);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const email = await api.gmailConnect(clientId, secret, hint.trim() || null);
      setSecret("");
      setOpen(false);
      toast(`Connected ${email}.`, "ok");
      await load();
      await refreshGmail();
    } catch (x) {
      const a = x as ApiError;
      if (a.kind !== "cancelled") setErr(a.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <Mail size={15} />
        <h2>School email (Gmail)</h2>
        <span className="small muted">Optional</span>
      </div>
      {!st ? (
        <div className="panel-body">
          <Spinner />
        </div>
      ) : st.connected ? (
        <div className="set-row">
          <div className="k">Connected</div>
          <div className="stack" style={{ gap: 8 }}>
            <div>{st.email}</div>
            <div className="small muted">Studydesk can read, label, archive and send mail. It can't permanently delete anything. Revoke any time here or at myaccount.google.com.</div>
            <div>
              <button
                className="btn"
                onClick={() =>
                  api
                    .gmailDisconnect()
                    .then(() => (load(), refreshGmail(), toast("Gmail disconnected and access revoked.", "ok")))
                    .catch((e) => reportError(e))
                }
              >
                Disconnect
              </button>
            </div>
          </div>
        </div>
      ) : !open ? (
        <div className="set-row">
          <div className="k">Not connected</div>
          <div className="stack" style={{ gap: 8 }}>
            <div className="small muted">
              Read and answer your school email next to Canvas. Needs a one-time Google Cloud client (steps in the README, about 10 minutes). Sign-in happens on Google's own page in your browser.
            </div>
            <div>
              <button className="btn" onClick={() => setOpen(true)}>
                Connect Gmail…
              </button>
            </div>
          </div>
        </div>
      ) : (
        <form className="panel-body stack" onSubmit={connect} style={{ maxWidth: 560 }}>
          <div className="field">
            <label htmlFor="g-id">OAuth client ID</label>
            <input id="g-id" className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="…apps.googleusercontent.com" spellCheck={false} />
          </div>
          <div className="field">
            <label htmlFor="g-secret">Client secret</label>
            <PasswordInput id="g-secret" value={secret} onChange={setSecret} placeholder="GOCSPX-…" />
            <div className="help">From the same Desktop app client in Google Cloud. Stored only in the encrypted vault.</div>
          </div>
          <div className="field">
            <label htmlFor="g-hint">School email (optional)</label>
            <input id="g-hint" className="input" value={hint} onChange={(e) => setHint(e.target.value)} placeholder="you@ontariotechu.net" spellCheck={false} />
            <div className="help">Pre-selects the right Google account on the sign-in page.</div>
          </div>
          {busy && (
            <Notice tone="info">
              Finish signing in in your browser. If Google shows "Access blocked", your school doesn't allow this app; cancel here.
            </Notice>
          )}
          {err && <Notice tone="danger">{err}</Notice>}
          <div className="row-flex">
            {busy ? (
              <button type="button" className="btn" onClick={() => api.gmailCancelConnect()}>
                <Spinner /> Cancel sign-in
              </button>
            ) : (
              <button className="btn btn-primary" disabled={!clientId.trim() || !secret.trim()}>
                Sign in with Google
              </button>
            )}
            {!busy && (
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
