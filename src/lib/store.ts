// App state: one small store, read with useStore(selector).

import { useSyncExternalStore } from "react";
import { api } from "./api.ts";
import type { ApiError, Dashboard, PickedFile, PinnedDate, Profile, ScanResult, UploadProgress } from "./types.ts";

export type Route =
  | { view: "today" }
  | { view: "course"; courseId: number; assignmentId?: number }
  | { view: "inbox"; conversationId?: number }
  | { view: "mail"; threadId?: string }
  | { view: "settings" }
  | { view: "dates" };

export interface Toast {
  id: number;
  tone: "info" | "ok" | "error";
  text: string;
  action?: { label: string; run: () => void };
  /** ms; 0 = stays until dismissed */
  timeout: number;
}

export interface ComposeInit {
  courseId?: number;
  subject?: string;
  teachers?: boolean;
}

export interface MailComposeInit {
  to?: string[];
  subject?: string;
}

export interface DragState {
  source: "internal" | "os";
  files: PickedFile[];
  x: number;
  y: number;
  /** data-drop key under the pointer */
  over: string | null;
}

export interface State {
  phase: "boot" | "setup" | "locked" | "ready";
  /** A passphrase is set (so locking means something). */
  hasPassphrase: boolean;
  pinned: PinnedDate[];
  scan: ScanResult | null;
  scanning: { done: number; total: number } | null;
  celebrate: number;
  profile: Profile | null;
  dash: Dashboard | null;
  syncing: boolean;
  syncError: string | null;
  route: Route;
  history: Route[];
  toasts: Toast[];
  /** Bumped when a linked folder changes on disk. */
  fileVersion: Record<number, number>;
  unread: number | null;
  paletteOpen: boolean;
  compose: ComposeInit | null;
  mailCompose: MailComposeInit | null;
  gmail: { connected: boolean; email: string | null } | null;
  mailUnread: number | null;
  progress: Record<string, UploadProgress>;
  drag: DragState | null;
  /** Files staged for submission, keyed "courseId:assignmentId". */
  drafts: Record<string, PickedFile[]>;
}

const initial: State = {
  phase: "boot",
  hasPassphrase: false,
  pinned: [],
  scan: null,
  scanning: null,
  celebrate: 0,
  profile: null,
  dash: null,
  syncing: false,
  syncError: null,
  route: { view: "today" },
  history: [],
  toasts: [],
  fileVersion: {},
  unread: null,
  paletteOpen: false,
  compose: null,
  mailCompose: null,
  gmail: null,
  mailUnread: null,
  progress: {},
  drag: null,
  drafts: {},
};

let state: State = initial;
const subs = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  subs.forEach((f) => f());
}

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => sel(state),
  );
}

// ----------------------------------------------------------------- actions

let toastSeq = 1;
export function toast(text: string, tone: Toast["tone"] = "info", opts: Partial<Pick<Toast, "action" | "timeout">> = {}): number {
  const id = toastSeq++;
  const timeout = opts.timeout ?? (tone === "error" ? 0 : 4000);
  setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, tone, text, action: opts.action, timeout }] }));
  if (timeout > 0) setTimeout(() => dismissToast(id), timeout);
  return id;
}
export function dismissToast(id: number) {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function navigate(route: Route) {
  setState((s) => ({ route, history: [...s.history.slice(-30), s.route], paletteOpen: false }));
}
export function back() {
  setState((s) => (s.history.length ? { route: s.history[s.history.length - 1], history: s.history.slice(0, -1) } : {}));
}

/** Central error handling: locked -> lock screen; bad token -> say so. */
export function reportError(e: unknown, prefix?: string) {
  const err = e as ApiError;
  if (err?.kind === "locked") {
    onLocked();
    return;
  }
  if (err?.kind === "cancelled") return;
  const text = prefix ? `${prefix}: ${err?.message ?? String(e)}` : err?.message ?? String(e);
  toast(text, "error", err?.kind === "unauthorized" ? { action: { label: "Settings", run: () => navigate({ view: "settings" }) } } : {});
}

export function onLocked() {
  // Drop everything that came from Canvas.
  state = { ...initial, phase: "locked", hasPassphrase: true, toasts: [] };
  subs.forEach((f) => f());
}

export async function boot() {
  try {
    const st = await api.appStatus();
    if (!st.vaultExists) setState({ phase: "setup" });
    else if (!st.unlocked) setState({ phase: "locked", hasPassphrase: true });
    else {
      setState({ phase: "ready", hasPassphrase: st.passphrase });
      await sync();
    }
  } catch (e) {
    reportError(e);
  }
}

export async function afterUnlock(profile: Profile) {
  const st = await api.appStatus().catch(() => null);
  setState({ phase: "ready", profile, route: { view: "today" }, hasPassphrase: st?.passphrase ?? true });
  await sync();
}

let syncing: Promise<void> | null = null;
export function sync(): Promise<void> {
  if (syncing) return syncing;
  setState({ syncing: true, syncError: null });
  syncing = (async () => {
    try {
      const dash = await api.syncAll();
      setState({ dash, unread: dash.unreadCount, syncError: null });
      api.datesPinned().then((pinned) => setState({ pinned })).catch(() => {});
      void refreshGmail();
    } catch (e) {
      const err = e as ApiError;
      if (err.kind === "locked") onLocked();
      else {
        setState({ syncError: err.message });
        if (err.kind === "unauthorized") reportError(e);
      }
    } finally {
      setState({ syncing: false });
      syncing = null;
    }
  })();
  return syncing;
}

export async function refreshGmail() {
  try {
    const g = await api.gmailStatus();
    setState({ gmail: { connected: g.connected, email: g.email } });
    if (g.connected) setState({ mailUnread: await api.gmailUnread() });
    else setState({ mailUnread: null });
  } catch {
    /* Gmail is optional; errors show in the Email view */
  }
}

export async function refreshUnread() {
  try {
    setState({ unread: await api.unreadCount() });
  } catch {
    /* non-critical */
  }
}

export async function lockNow() {
  try {
    await api.lock();
  } finally {
    onLocked();
  }
}

export const draftKey = (courseId: number, assignmentId: number) => `${courseId}:${assignmentId}`;

export function addToDraft(courseId: number, assignmentId: number, files: PickedFile[]) {
  const k = draftKey(courseId, assignmentId);
  setState((s) => {
    const cur = s.drafts[k] ?? [];
    const same = (a: PickedFile, b: PickedFile) => JSON.stringify(a.ref) === JSON.stringify(b.ref);
    const merged = [...cur, ...files.filter((f) => !cur.some((c) => same(c, f)))];
    return { drafts: { ...s.drafts, [k]: merged } };
  });
}
export function setDraft(courseId: number, assignmentId: number, files: PickedFile[]) {
  setState((s) => ({ drafts: { ...s.drafts, [draftKey(courseId, assignmentId)]: files } }));
}

let jobSeq = 1;
export const newJob = () => `job-${Date.now()}-${jobSeq++}`;

export async function runScan(courseIds: number[] | null = null) {
  if (getState().scanning) return;
  setState({ scanning: { done: 0, total: 0 } });
  try {
    const scan = await api.datesScan(courseIds);
    setState({ scan });
  } catch (e) {
    reportError(e, "Scan failed");
  } finally {
    setState({ scanning: null });
  }
}
