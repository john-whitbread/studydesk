// Theme, accent colour and per-course colours. Pure helpers (tested in
// logic.test.ts) plus applyAppearance, which writes them onto <html>.

export type Theme = "system" | "light" | "dark";
export type Mode = "light" | "dark";

export interface AccentTokens {
  accent: string;
  hover: string;
  /** Text drawn on top of the accent (primary buttons, badges). */
  text: string;
  /** Tinted background for selections and drop targets. */
  soft: string;
}

export interface AccentPreset {
  id: string;
  label: string;
  light: AccentTokens;
  dark: AccentTokens;
}

/** Backgrounds the accent is drawn on, per mode (styles.css --panel / --bg). */
export const SURFACES: Record<Mode, string[]> = {
  light: ["#ffffff", "#f4f5f7", "#f8f9fb"],
  dark: ["#171a1e", "#0f1114", "#1c2025"],
};

// Light variants are dark enough for white text and for links on white;
// dark variants are light enough for links on the dark panels and for the
// near-black text used on dark-mode buttons. logic.test.ts checks every pair
// against WCAG AA (4.5:1).
export const ACCENTS: AccentPreset[] = [
  {
    id: "blue",
    label: "Blue",
    light: { accent: "#1d4ed8", hover: "#1a43bd", text: "#ffffff", soft: "#e8eefc" },
    dark: { accent: "#6f9cff", hover: "#8bb0ff", text: "#0b1530", soft: "#1d2a45" },
  },
  {
    id: "indigo",
    label: "Indigo",
    light: { accent: "#4338ca", hover: "#3730a3", text: "#ffffff", soft: "#ecebfb" },
    dark: { accent: "#a5b4fc", hover: "#c7d2fe", text: "#14143a", soft: "#24244a" },
  },
  {
    id: "violet",
    label: "Violet",
    light: { accent: "#6d28d9", hover: "#5b21b6", text: "#ffffff", soft: "#f1eafc" },
    dark: { accent: "#c4b5fd", hover: "#ddd6fe", text: "#1e1238", soft: "#2c2247" },
  },
  {
    id: "pink",
    label: "Pink",
    light: { accent: "#be185d", hover: "#9d174d", text: "#ffffff", soft: "#fce8f1" },
    dark: { accent: "#f9a8d4", hover: "#fbcfe8", text: "#3a0f24", soft: "#3d1f30" },
  },
  {
    id: "orange",
    label: "Orange",
    light: { accent: "#b93f0b", hover: "#9a3412", text: "#ffffff", soft: "#fdeee5" },
    dark: { accent: "#fdba74", hover: "#fed7aa", text: "#331700", soft: "#3b2615" },
  },
  {
    id: "green",
    label: "Green",
    light: { accent: "#15803d", hover: "#166534", text: "#ffffff", soft: "#edf7f0" },
    dark: { accent: "#86efac", hover: "#bbf7d0", text: "#0a2814", soft: "#16301f" },
  },
  {
    id: "teal",
    label: "Teal",
    light: { accent: "#0f766e", hover: "#115e59", text: "#ffffff", soft: "#e3f3f1" },
    dark: { accent: "#5eead4", hover: "#99f6e4", text: "#052722", soft: "#123230" },
  },
  {
    id: "graphite",
    label: "Graphite",
    light: { accent: "#374151", hover: "#1f2937", text: "#ffffff", soft: "#eceef1" },
    dark: { accent: "#d1d5db", hover: "#e5e7eb", text: "#15181c", soft: "#2a2f36" },
  },
];

export function accentPreset(id: string): AccentPreset {
  return ACCENTS.find((a) => a.id === id) ?? ACCENTS[0];
}

/** Swatches offered for course colours: readable as dots and stripes in both themes. */
export const COURSE_SWATCHES = [
  "#e11d48", "#ea580c", "#ba6605", "#55890b", "#138e40", "#0d9488",
  "#0891b2", "#2563eb", "#736bea", "#925bf0", "#c026d3", "#db2777",
  "#78716c", "#687c99",
];

// ------------------------------------------------------------- contrast

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? [...h].map((c) => c + c).join("") : h, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG 2 contrast ratio, 1–21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

export const isHex = (s: string): boolean => /^#[0-9a-f]{6}$/i.test(s);

// ------------------------------------------------------------- applying

export function resolveMode(theme: Theme, systemDark: boolean): Mode {
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}

let current: { theme: Theme; accent: string } = { theme: "system", accent: "blue" };
const media = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

/** Writes theme and accent onto <html>. Safe to call repeatedly. */
export function applyAppearance(theme: Theme, accent: string) {
  current = { theme, accent };
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  const t = accentPreset(accent)[resolveMode(theme, media?.matches ?? false)];
  root.style.setProperty("--accent", t.accent);
  root.style.setProperty("--accent-hover", t.hover);
  root.style.setProperty("--accent-text", t.text);
  root.style.setProperty("--accent-soft", t.soft);
  root.style.setProperty("--selected", t.soft);
  root.style.setProperty("--focus", t.accent);
  // Remember for the next launch so the first frame (and the lock screen,
  // before the vault is open) already has the right colours. Not sensitive.
  try {
    localStorage.setItem("studydesk.look", JSON.stringify(current));
  } catch {
    /* storage unavailable: defaults apply until unlock */
  }
}

/** Applies the last-used look before anything renders. */
export function applyRememberedAppearance() {
  try {
    const v = JSON.parse(localStorage.getItem("studydesk.look") ?? "null");
    if (v && ["system", "light", "dark"].includes(v.theme) && typeof v.accent === "string") return applyAppearance(v.theme, v.accent);
  } catch {
    /* ignore */
  }
  applyAppearance("system", "blue");
}

// Following Windows: re-pick the accent variant when the system theme flips.
media?.addEventListener("change", () => {
  if (current.theme === "system") applyAppearance(current.theme, current.accent);
});
