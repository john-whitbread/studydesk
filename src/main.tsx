import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { api, listen } from "./lib/api.ts";
import { onOsDrag } from "./lib/drag.ts";
import { boot, getState, lockNow, navigate, onLocked, refreshUnread, reportError, setState, sync } from "./lib/store.ts";
import type { OsDrag, UpdateInfo, UploadProgress } from "./lib/types.ts";
import { announceUpdate } from "./lib/update.ts";
import { throttle } from "./lib/util.ts";
import "./styles.css";
import { applyRememberedAppearance } from "./lib/appearance.ts";

// Before the first frame, so there is no flash of the wrong theme.
applyRememberedAppearance();

// No popups, ever. Links go through the backend to your normal browser.
window.open = () => null;

document.addEventListener(
  "click",
  (e) => {
    const a = (e.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const raw = a.getAttribute("href") ?? "";
    if (!raw || raw.startsWith("#") || raw.startsWith("javascript:")) return;
    const base = getState().dash?.baseUrl;
    let url: URL;
    try {
      url = new URL(raw, base ?? undefined);
    } catch {
      return;
    }
    const sameCanvas = base != null && url.origin === new URL(base).origin;
    (sameCanvas ? api.openInCanvas(url.href) : api.openExternal(url.href)).catch((err) => reportError(err));
  },
  true,
);
document.addEventListener("auxclick", (e) => (e.target as HTMLElement).closest?.("a") && e.preventDefault(), true);

// Browser context menu only where it's useful (text fields and selected text).
document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea") || (window.getSelection()?.toString() ?? "") !== "") return;
  e.preventDefault();
});

document.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  const phase = getState().phase;
  // F5 / Ctrl+R refresh data instead of reloading the page.
  if (e.key === "F5" || (ctrl && e.key.toLowerCase() === "r")) {
    e.preventDefault();
    if (phase === "ready") void sync();
    return;
  }
  if (phase !== "ready") return;
  if (ctrl && e.key.toLowerCase() === "k") {
    e.preventDefault();
    setState({ paletteOpen: !getState().paletteOpen });
  } else if (ctrl && e.key.toLowerCase() === "l") {
    e.preventDefault();
    if (getState().hasPassphrase) void lockNow();
  } else if (ctrl && e.key.toLowerCase() === "n") {
    e.preventDefault();
    if (getState().route.view === "mail") setState({ mailCompose: {} });
    else setState({ compose: {} });
  } else if (e.altKey && e.key === "1") navigate({ view: "today" });
  else if (e.altKey && e.key === "2") navigate({ view: "inbox" });
  else if (e.altKey && e.key === "3") navigate({ view: "mail" });
  else if (e.altKey && e.key === "4") navigate({ view: "dates" });
});

// Activity heartbeat for auto-lock (the backend also watches system idle on Windows).
const beat = throttle(() => {
  if (getState().phase === "ready") api.touch().catch(() => {});
}, 30_000);
["pointerdown", "keydown", "wheel"].forEach((ev) => window.addEventListener(ev, beat, { passive: true }));

// Backend events.
void listen("locked", () => onLocked());
void listen<UpdateInfo>("update-available", (info) => announceUpdate(info));
void listen<{ courseIds: number[] }>("files-changed", ({ courseIds }) =>
  setState((s) => ({ fileVersion: { ...s.fileVersion, ...Object.fromEntries(courseIds.map((id) => [id, (s.fileVersion[id] ?? 0) + 1])) } })),
);
void listen<{ done: number; total: number }>("scan-progress", (p) => setState({ scanning: { done: p.done, total: p.total } }));
void listen<UploadProgress>("upload-progress", (p) => setState((s) => ({ progress: { ...s.progress, [p.job]: p } })));
void listen<OsDrag>("os-drag", (d) => {
  if (getState().phase === "ready") onOsDrag(d.phase, d.x, d.y, d.files);
});

// Keep things fresh without hammering Canvas: every 10 minutes, and when the
// window regains focus if the last update is over 2 minutes old.
setInterval(() => getState().phase === "ready" && void sync(), 10 * 60_000);
setInterval(() => getState().phase === "ready" && void refreshUnread(), 2 * 60_000);
window.addEventListener("focus", () => {
  const d = getState().dash;
  if (getState().phase === "ready" && d && Date.now() - d.syncedAt > 2 * 60_000) void sync();
});

createRoot(document.getElementById("root")!).render(<App />);
void boot();
