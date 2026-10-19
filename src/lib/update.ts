import { api } from "./api.ts";
import { reportError, toast } from "./store.ts";
import type { UpdateInfo } from "./types.ts";

let installing = false;

/** Downloads, verifies and installs the waiting update; Studydesk then restarts. */
export async function installUpdate() {
  if (installing) return;
  installing = true;
  toast("Downloading the update… Studydesk will restart by itself.", "info", { timeout: 0 });
  try {
    await api.updateInstall();
  } catch (e) {
    installing = false;
    reportError(e, "Couldn't update");
  }
}

const announced = new Set<string>();
export function announceUpdate(info: UpdateInfo) {
  const v = info.available;
  if (!v || announced.has(v)) return;
  announced.add(v);
  toast(`Studydesk ${v} is available (you have ${info.current}).`, "info", {
    timeout: 0,
    action: { label: "Restart to update", run: () => void installUpdate() },
  });
}
