import { Lock, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { afterUnlock, setState } from "../lib/store.ts";
import type { ApiError } from "../lib/types.ts";
import { Notice, PasswordInput, Spinner } from "./common.tsx";

function Mark() {
  return (
    <span className="brand-mark" style={{ width: 36, height: 36, borderRadius: 9 }} aria-hidden>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    </span>
  );
}

export function Setup() {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = pass2.length > 0 && pass !== pass2;
  const tooShort = pass.length > 0 && [...pass].length < 8;
  const [usePass, setUsePass] = useState(false);
  const ready = url.trim() && token.trim() && (!usePass || ([...pass].length >= 8 && pass === pass2)) && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.setup(url, token, usePass ? pass : null);
      setToken("");
      setPass("");
      setPass2("");
      await afterUnlock(p);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="gate-card wide" onSubmit={submit}>
        <div className="row-flex" style={{ gap: 12 }}>
          <Mark />
          <div>
            <h1>Set up Studydesk</h1>
            <div className="small muted">Connect your Canvas account. This takes about two minutes.</div>
          </div>
        </div>
        <div className="steps">
          <div className="step">
            <div className="field">
              <label htmlFor="s-url">Canvas address</label>
              <input id="s-url" className="input" placeholder="school.instructure.com" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus spellCheck={false} />
              <div className="help">The address in your browser when you're signed in to Canvas. Only this site will ever receive your token.</div>
            </div>
          </div>
          <div className="step">
            <div className="field">
              <label htmlFor="s-token">Access token</label>
              <PasswordInput id="s-token" value={token} onChange={setToken} placeholder="Paste the token" />
              <div className="help">
                In Canvas: Account → Settings → <b>+ New Access Token</b>. Purpose "Studydesk"; set an expiry date (e.g. end of term). Copy it straight into this box, not into email or chat.
                If the button isn't there, your school has turned student tokens off.
              </div>
            </div>
          </div>
          <div className="step">
            <div className="stack" style={{ gap: 10 }}>
              <div className="field">
                <label>Protection</label>
                <div className="help" style={{ fontSize: 12.5 }}>
                  Your token is encrypted and tied to your Windows account: only you, signed in to Windows, can open it. Studydesk opens straight away, no extra password.
                </div>
                <label className="check" style={{ marginTop: 4 }}>
                  <input type="checkbox" checked={usePass} onChange={(e) => setUsePass(e.target.checked)} />
                  Also require a passphrase to open Studydesk (optional)
                </label>
              </div>
              {usePass && (
                <>
                  <div className="field">
                    <label htmlFor="s-pass">Passphrase</label>
                    <PasswordInput id="s-pass" value={pass} onChange={setPass} autoComplete="new-password" />
                    <div className={`help${tooShort ? " text-danger" : ""}`}>At least 8 characters. It can't be recovered; if you forget it, you erase Studydesk's data and set up again.</div>
                  </div>
                  <div className="field">
                    <label htmlFor="s-pass2">Type it again</label>
                    <PasswordInput id="s-pass2" value={pass2} onChange={setPass2} autoComplete="new-password" />
                    {mismatch && <div className="help text-danger">The passphrases don't match.</div>}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        <button className="btn btn-primary btn-block" style={{ height: 38 }} disabled={!ready}>
          {busy ? <Spinner /> : <ShieldCheck size={16} />} {busy ? "Checking with Canvas…" : "Connect"}
        </button>
      </form>
    </div>
  );
}

export function LockScreen({ initialRetry = 0 }: { initialRetry?: number }) {
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(initialRetry);

  useEffect(() => {
    api.appStatus().then((s) => setWait(s.retryAfter)).catch(() => {});
  }, []);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setInterval(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearInterval(t);
  }, [wait > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pass || busy || wait > 0) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.unlock(pass);
      setPass("");
      await afterUnlock(p);
    } catch (err) {
      const x = err as ApiError;
      setPass("");
      if (x.kind === "throttled" && x.retryAfter) setWait(x.retryAfter);
      setError(x.message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    try {
      if (await api.resetApp()) setState({ phase: "setup" });
    } catch (e) {
      setError((e as ApiError).message);
    }
  };

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <div className="row-flex" style={{ gap: 12 }}>
          <Mark />
          <div>
            <h1>Studydesk is locked</h1>
            <div className="small muted">Enter your passphrase to continue.</div>
          </div>
        </div>
        <PasswordInput value={pass} onChange={setPass} autoFocus autoComplete="current-password" placeholder="Passphrase" />
        {error && <Notice tone="danger">{wait > 0 ? `${error.replace(/\d+ seconds/, `${wait} seconds`)}` : error}</Notice>}
        <button className="btn btn-primary btn-block" style={{ height: 38 }} disabled={!pass || busy || wait > 0}>
          {busy ? <Spinner /> : <Lock size={15} />} {busy ? "Unlocking…" : wait > 0 ? `Wait ${wait} s` : "Unlock"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={reset} style={{ alignSelf: "center" }}>
          Forgot it? Erase and set up again
        </button>
      </form>
    </div>
  );
}
