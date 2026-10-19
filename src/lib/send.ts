// Messages are sent after a short undo window: the toast shows "Sending…
// Undo" for 5 seconds before anything leaves your computer.

import { dismissToast, toast } from "./store.ts";

export const UNDO_MS = 5000;

export function sendWithUndo(label: string, send: () => Promise<void>, onUndo: () => void) {
  let cancelled = false;
  const id = toast(`${label} in 5 seconds…`, "info", {
    timeout: UNDO_MS,
    action: {
      label: "Undo",
      run: () => {
        cancelled = true;
        clearTimeout(timer);
        dismissToast(id);
        onUndo();
        toast("Not sent.", "info", { timeout: 2500 });
      },
    },
  });
  const timer = setTimeout(() => {
    if (!cancelled) void send();
  }, UNDO_MS);
}
