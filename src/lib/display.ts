// Text size and density. Per computer (localStorage), applied before the first frame.

import { api } from "./api.ts";

export const SIZES = [0.9, 1, 1.1, 1.25, 1.5];
export type Density = "comfortable" | "compact";

const KEY = "studydesk.display";
interface Display { scale: number; density: Density }

function read(): Display {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Display>;
    return { scale: SIZES.includes(Number(d.scale)) ? Number(d.scale) : 1, density: d.density === "compact" ? "compact" : "comfortable" };
  } catch {
    return { scale: 1, density: "comfortable" };
  }
}
function write(d: Display) {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* only a preference */
  }
}

let current = read();
const subs = new Set<(d: Display) => void>();
export const getDisplay = () => current;
export function onDisplay(f: (d: Display) => void) {
  subs.add(f);
  return () => subs.delete(f);
}

function apply() {
  const root = document.documentElement;
  root.dataset.density = current.density;
  if (import.meta.env.MODE === "mock") {
    // The browser preview has no webview zoom; CSS zoom is close enough.
    (root.style as CSSStyleDeclaration & { zoom: string }).zoom = String(current.scale);
  } else {
    api.setZoom(current.scale).catch(() => {});
  }
  subs.forEach((f) => f(current));
}

export function applyRememberedDisplay() {
  apply();
}

export function setScale(scale: number) {
  current = { ...current, scale: SIZES.includes(scale) ? scale : 1 };
  write(current);
  apply();
}
export function setDensity(density: Density) {
  current = { ...current, density };
  write(current);
  apply();
}
/** Ctrl + / Ctrl − step through the sizes; Ctrl 0 resets. */
export function stepScale(dir: 1 | -1 | 0) {
  if (dir === 0) return setScale(1);
  const i = SIZES.indexOf(current.scale);
  setScale(SIZES[Math.max(0, Math.min(SIZES.length - 1, (i < 0 ? 1 : i) + dir))]);
}
