import { Download, FolderSearch, KeyRound, Link, Lock, RefreshCw, Unlink } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { lockNow, reportError, setState, sync, toast, useStore } from "../lib/store.ts";
import type { ApiError, Settings as S, UpdateInfo } from "../lib/types.ts";
import { installUpdate } from "../lib/update.ts";
import { courseColor } from "../lib/util.ts";
import { Notice, PasswordInput, Spinner } from "./common.tsx";
import { linkFolder } from "./FilesPane.tsx";
import { AppearanceSettings } from "./AppearanceSettings.tsx";
import { GmailSettings } from "./GmailSettings.tsx";

const LOCK_OPTIONS = [5, 10, 15, 30, 60];

export function Settings() {
  const dash = useStore((s) => s.dash);
  const [s, setS] = useState<S | null>(null);
  const reload = () => api.getSettings().then(setS).catch((e) => reportError(e));
  useEffect(() => {
    reload();
  }, [dash]);

  if (!s)
    return (
      <div className="empty">
        <Spinner />
      </div>
    );

  const links = new Map(s.folderLinks.map((l) => [l.courseId, l]));
  const hidden = new Set(s.hiddenCourses);

  return (
    <>
      <header className="topbar">
        <h1>Settings</h1>
      </header>
      <div className="content pad">
        <div className="settings">
          <section className="panel">
            <div className="panel-head">
              <h2>Canvas account</h2>
            </div>
            <div className="set-row">
              <div className="k">Signed in as</div>
              <div style={{ paddingTop: 6 }}>{s.userName}</div>
            </div>
            <div className="set-row">
              <div className="k">Canvas address</div>
              <div style={{ paddingTop: 6 }} className="path">{s.baseUrl}</div>
            </div>
            <ReplaceToken />
          </section>

          <AppearanceSettings />

          <GmailSettings />

          <Security s={s} reload={reload} />

          <section className="panel">
            <div className="panel-head">
              <h2>Courses and folders</h2>
            </div>
            <table className="ctable">
              <thead>
                <tr>
                  <th>Course</th>
                  <th>Linked folder</th>
                  <th style={{ width: 90 }}>Show</th>
                </tr>
              </thead>
              <tbody>
                {(dash?.courses ?? []).map((c) => {
                  const l = links.get(c.id);
                  return (
                    <tr key={c.id}>
                      <td>
                        <div className="row-flex">
                          <span className="dot" style={{ background: courseColor(c) }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600 }}>{c.course_code || c.name}</div>
                            <div className="small muted ellipsis">{c.name}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="row-flex" style={{ flexWrap: "wrap" }}>
                          {l ? (
                            <>
                              <span className="path grow">{l.path}</span>
                              {!l.exists && <span className="chip tone-danger">Missing</span>}
                              <button className="icon-btn" title="Show in File Explorer" onClick={() => api.revealFile({ kind: "linked", courseId: c.id, rel: "" }).catch((e) => reportError(e))}>
                                <FolderSearch size={14} />
                              </button>
                              <button className="btn btn-sm" onClick={() => linkFolder(c).then(reload)}>
                                Change
                              </button>
                              <button
                                className="btn btn-sm btn-ghost"
                                onClick={() =>
                                  api
                                    .unlinkFolder(c.id)
                                    .then(() => {
                                      setState((st) => ({ dash: st.dash ? { ...st.dash, courses: st.dash.courses.map((x) => (x.id === c.id ? { ...x, folder: null } : x)) } : st.dash }));
                                      reload();
                                    })
                                    .catch((e) => reportError(e))
                                }
                              >
                                <Unlink size={13} /> Unlink
                              </button>
                            </>
                          ) : (
                            <button className="btn btn-sm" onClick={() => linkFolder(c).then(reload)}>
                              <Link size={13} /> Link folder…
                            </button>
                          )}
                        </div>
                      </td>
                      <td>
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={!hidden.has(c.id)}
                            onChange={(e) =>
                              api
                                .setCourseHidden(c.id, !e.target.checked)
                                .then(() => sync())
                                .catch((er) => reportError(er))
                            }
                          />
                          <span className="small">Sidebar</span>
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <Updates />

          <section className="panel">
            <div className="panel-head">
              <h2>Erase</h2>
            </div>
            <div className="set-row">
              <div className="k">Erase Studydesk data</div>
              <div className="stack" style={{ gap: 6 }}>
                <div className="small muted">Deletes the encrypted vault (tokens, folder links, settings) from this computer. Your files and Canvas are untouched.</div>
                <div>
                  <button
                    className="btn btn-danger"
                    onClick={() =>
                      api
                        .resetApp()
                        .then((ok) => ok && setState({ phase: "setup", dash: null }))
                        .catch((e) => reportError(e))
                    }
                  >
                    Erase…
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function Updates() {
  const [version, setVersion] = useState<string | null>(null);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.appVersion().then(setVersion).catch(() => {});
  }, []);
  const check = () => {
    setBusy(true);
    setErr(null);
    api
      .updateCheck()
      .then(setInfo)
      .catch((e: ApiError) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Updates</h2>
      </div>
      <div className="set-row">
        <div className="k">Version {version ?? "…"}</div>
        <div className="stack" style={{ gap: 6 }}>
          <div className="small muted">
            Studydesk checks GitHub for updates when it opens and every 6 hours. Updates are signed; anything not signed by the Studydesk key is refused.
          </div>
          {info && !info.available && <div className="small">You're up to date.</div>}
          {info?.available && (
            <div className="stack" style={{ gap: 4 }}>
              <div className="small">
                <strong>Studydesk {info.available}</strong> is available.
              </div>
              {info.notes && <div className="small muted" style={{ whiteSpace: "pre-wrap" }}>{info.notes}</div>}
            </div>
          )}
          {err && <Notice tone="danger">{err}</Notice>}
          <div className="row-flex">
            {info?.available ? (
              <button className="btn btn-primary" onClick={() => void installUpdate()}>
                <Download size={14} /> Restart to update
              </button>
            ) : (
              <button className="btn" disabled={busy} onClick={check}>
                {busy ? <Spinner /> : <RefreshCw size={14} />} Check for updates
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ReplaceToken() {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="set-row">
      <div className="k">Access token</div>
      {!open ? (
        <div className="stack" style={{ gap: 6 }}>
          <div className="small muted">Stored encrypted. Replace it when it expires or if you delete it in Canvas.</div>
          <div>
            <button className="btn" onClick={() => setOpen(true)}>
              <KeyRound size={14} /> Replace token…
            </button>
          </div>
        </div>
      ) : (
        <form
          className="stack"
          style={{ gap: 8, maxWidth: 420 }}
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(null);
            try {
              await api.replaceToken(token);
              setToken("");
              setOpen(false);
              toast("Token replaced.", "ok");
              sync();
            } catch (x) {
              setErr((x as ApiError).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <PasswordInput value={token} onChange={setToken} placeholder="Paste the new token" autoFocus />
          {err && <Notice tone="danger">{err}</Notice>}
          <div className="row-flex">
            <button className="btn btn-primary" disabled={!token.trim() || busy}>
              {busy && <Spinner />} Save
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => (setOpen(false), setToken(""))}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Toggle({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="set-row">
      <div className="k">{label}</div>
      <div className="stack" style={{ gap: 4 }}>
        <label className="check" style={{ paddingTop: 6 }}>
          <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
          {checked ? "On" : "Off"}
        </label>
        <div className="small muted">{help}</div>
      </div>
    </div>
  );
}

function Security({ s, reload }: { s: S; reload: () => void }) {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  useEffect(() => {
    api.autostartGet().then(setAutostart).catch(() => setAutostart(null));
  }, []);
  const pref = (p: { notify?: boolean; closeToTray?: boolean }) => api.setPrefs(p).then(reload).catch((e) => reportError(e));
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Security and behaviour</h2>
      </div>
      <div className="set-row">
        <div className="k">Protection</div>
        <div className="stack" style={{ gap: 4, paddingTop: 6 }}>
          <div>
            Encrypted and tied to your Windows account{s.passphrase ? ", plus your passphrase" : ""}.
          </div>
          <div className="small muted">All connections use HTTPS with certificate checks (TLS 1.2 or newer). Your Canvas and Google sign-ins are only ever sent to Canvas and Google.</div>
        </div>
      </div>
      <PassphraseRow has={s.passphrase} onChanged={reload} />
      {s.passphrase && (
        <div className="set-row">
          <div className="k">Lock automatically</div>
          <div className="stack" style={{ gap: 6 }}>
            <select
              className="select"
              style={{ width: 240 }}
              value={s.autoLockMinutes}
              onChange={(e) =>
                api
                  .setAutoLock(Number(e.target.value))
                  .then(reload)
                  .catch((er) => reportError(er))
              }
            >
              <option value={0}>Never</option>
              {[...new Set([...LOCK_OPTIONS, s.autoLockMinutes])].filter((m) => m > 0).sort((a, b) => a - b).map((m) => (
                <option key={m} value={m}>
                  After {m} minutes idle
                </option>
              ))}
            </select>
            <div className="small muted">Idle means no keyboard or mouse input anywhere on the computer.</div>
            <div>
              <button className="btn btn-sm" onClick={() => lockNow()}>
                <Lock size={13} /> Lock now
              </button>
            </div>
          </div>
        </div>
      )}
      <Toggle
        label="Deadline reminders"
        help="A Windows notification 24 hours and 2 hours before anything you haven't submitted, and before pinned key dates."
        checked={s.notify}
        onChange={(v) => pref({ notify: v })}
      />
      <Toggle
        label="Keep running when closed"
        help="Closing the window keeps Studydesk in the system tray so reminders still arrive. Quit from the tray icon."
        checked={s.closeToTray}
        onChange={(v) => pref({ closeToTray: v })}
      />
      {autostart != null && (
        <Toggle
          label="Start with Windows"
          help="Opens quietly in the tray when you sign in to Windows."
          checked={autostart}
          onChange={(v) =>
            api
              .autostartSet(v)
              .then(() => setAutostart(v))
              .catch((e) => reportError(e))
          }
        />
      )}
    </section>
  );
}

function PassphraseRow({ has, onChanged }: { has: boolean; onChanged: () => void }) {
  const [mode, setMode] = useState<null | "set" | "change" | "remove">(null);
  const [cur, setCur] = useState("");
  const [n1, setN1] = useState("");
  const [n2, setN2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const needNew = mode === "set" || mode === "change";
  const ok = (!has || cur) && (!needNew || ([...n1].length >= 8 && n1 === n2));
  const reset = () => {
    setMode(null);
    setCur("");
    setN1("");
    setN2("");
    setErr(null);
  };
  return (
    <div className="set-row">
      <div className="k">Passphrase</div>
      {!mode ? (
        <div className="stack" style={{ gap: 6 }}>
          <div style={{ paddingTop: 6 }}>{has ? "On: asked when Studydesk opens." : "Off: Studydesk opens straight away when you're signed in to Windows."}</div>
          <div className="row-flex">
            {has ? (
              <>
                <button className="btn btn-sm" onClick={() => setMode("change")}>
                  Change…
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setMode("remove")}>
                  Turn off…
                </button>
              </>
            ) : (
              <button className="btn btn-sm" onClick={() => setMode("set")}>
                Add a passphrase…
              </button>
            )}
          </div>
        </div>
      ) : (
        <form
          className="stack"
          style={{ gap: 8, maxWidth: 420 }}
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(null);
            try {
              await api.changePassphrase(has ? cur : null, needNew ? n1 : null);
              setState({ hasPassphrase: needNew });
              toast(mode === "remove" ? "Passphrase turned off." : mode === "set" ? "Passphrase added." : "Passphrase changed.", "ok");
              reset();
              onChanged();
            } catch (x) {
              setErr((x as ApiError).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {has && <PasswordInput value={cur} onChange={setCur} placeholder="Current passphrase" autoFocus autoComplete="current-password" />}
          {needNew && (
            <>
              <PasswordInput value={n1} onChange={setN1} placeholder="New passphrase (8+ characters)" autoComplete="new-password" autoFocus={!has} />
              <PasswordInput value={n2} onChange={setN2} placeholder="New passphrase again" autoComplete="new-password" />
              {n2 && n1 !== n2 && <div className="small text-danger">The passphrases don't match.</div>}
            </>
          )}
          {mode === "remove" && <div className="small muted">Your data stays encrypted and tied to your Windows account.</div>}
          {err && <Notice tone="danger">{err}</Notice>}
          <div className="row-flex">
            <button className="btn btn-primary" disabled={!ok || busy}>
              {busy && <Spinner />} {mode === "remove" ? "Turn off" : "Save"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={reset}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
