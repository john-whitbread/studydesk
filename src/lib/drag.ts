// Dragging files onto assignments, the submit box or a message. Uses pointer
// events (not HTML5 drag-and-drop) so it behaves the same inside the app and
// for files dragged in from File Explorer.

import { getState, setState, toast } from "./store.ts";
import type { PickedFile } from "./types.ts";

type Handler = (parts: string[], files: PickedFile[]) => void;
const handlers = new Map<string, Handler>();

/** `prefix` matches the first part of a `data-drop="prefix:..."` key. */
export function registerDrop(prefix: string, h: Handler): () => void {
  handlers.set(prefix, h);
  return () => {
    if (handlers.get(prefix) === h) handlers.delete(prefix);
  };
}

export function dropKeyAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest("[data-drop]");
  return el?.getAttribute("data-drop") ?? null;
}

export function performDrop(key: string | null, files: PickedFile[]): boolean {
  if (!key || files.length === 0) return false;
  const parts = key.split(":");
  const h = handlers.get(parts[0]);
  if (!h) return false;
  h(parts.slice(1), files);
  return true;
}

export function beginFileDrag(e: React.PointerEvent, files: () => PickedFile[]) {
  if (e.button !== 0) return;
  const sx = e.clientX;
  const sy = e.clientY;
  let started = false;
  let list: PickedFile[] = [];
  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      started = true;
      list = files();
      document.body.style.cursor = "grabbing";
    }
    setState({ drag: { source: "internal", files: list, x: ev.clientX, y: ev.clientY, over: dropKeyAt(ev.clientX, ev.clientY) } });
  };
  const end = (ev: PointerEvent | null) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", esc);
    document.body.style.cursor = "";
    if (!started) return;
    setState({ drag: null });
    if (ev) performDrop(dropKeyAt(ev.clientX, ev.clientY), list);
  };
  const up = (ev: PointerEvent) => end(ev);
  const esc = (ev: KeyboardEvent) => ev.key === "Escape" && end(null);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", esc);
}

/** Events from the backend for drags that start in File Explorer. */
export function onOsDrag(phase: string, px: number, py: number, files: PickedFile[]) {
  const dpr = window.devicePixelRatio || 1;
  const x = px / dpr;
  const y = py / dpr;
  if (phase === "leave") return setState({ drag: null });
  if (phase === "enter" || phase === "over") {
    const prev = getState().drag;
    return setState({ drag: { source: "os", files: prev?.files ?? [], x, y, over: dropKeyAt(x, y) } });
  }
  if (phase === "drop") {
    setState({ drag: null });
    if (files.length === 0) return toast("Only files can be dropped here, not folders.", "info");
    if (!performDrop(dropKeyAt(x, y), files)) toast("Drop files onto an assignment, the submit box, or a message to attach them.", "info");
  }
}

/** Class for a drop target given whether it accepts the drag. */
export function dropClass(key: string, accepts: boolean, drag: { over: string | null } | null): string {
  if (!drag) return "";
  if (!accepts) return " drop-no";
  return drag.over === key ? " drop-ok" : "";
}
