import { Check, Monitor, Moon, Palette, Sun, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { ACCENTS, COURSE_SWATCHES, resolveMode, type Theme } from "../lib/appearance.ts";
import { visibleCourses } from "../lib/derive.ts";
import { applyLook, reportError, useStore } from "../lib/store.ts";
import type { Course } from "../lib/types.ts";
import { canvasColor, courseColor } from "../lib/util.ts";

const THEMES: [Theme, string, typeof Sun][] = [
  ["system", "System", Monitor],
  ["light", "Light", Sun],
  ["dark", "Dark", Moon],
];

function useSystemDark(): boolean {
  const q = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const [dark, setDark] = useState(q?.matches ?? false);
  useEffect(() => {
    if (!q) return;
    const on = () => setDark(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return dark;
}

export function AppearanceSettings() {
  const look = useStore((s) => s.look);
  const dash = useStore((s) => s.dash);
  const systemDark = useSystemDark();
  const [open, setOpen] = useState<number | null>(null);
  const timers = useRef(new Map<number, number>());
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);
  if (!look) return null;
  const mode = resolveMode(look.theme, systemDark);
  const courses = visibleCourses(dash);

  const set = (theme: Theme | null, accent: string | null) => {
    // Show it at once; the saved value comes back from the vault.
    applyLook({ ...look, theme: theme ?? look.theme, accent: accent ?? look.accent });
    api.setAppearance(theme, accent).then(applyLook).catch((e) => reportError(e, "Couldn't save the appearance"));
  };
  /** Previews at once; saves right away, or 400 ms after the last change while dragging the custom picker. */
  const setColor = (c: Course, color: string | null, debounce = false) => {
    const courseColors = { ...look.courseColors };
    if (color) courseColors[String(c.id)] = color.toLowerCase();
    else delete courseColors[String(c.id)];
    applyLook({ ...look, courseColors });
    clearTimeout(timers.current.get(c.id));
    const save = () => api.setCourseColor(c.id, color).then(applyLook).catch((e) => reportError(e, "Couldn't save the course colour"));
    if (debounce) timers.current.set(c.id, window.setTimeout(save, 400));
    else void save();
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Appearance</h2>
      </div>

      <div className="set-row">
        <div className="k">Theme</div>
        <div className="stack" style={{ gap: 6 }}>
          <div className="seg" role="radiogroup" aria-label="Theme" style={{ alignSelf: "flex-start" }}>
            {THEMES.map(([id, label, Icon]) => (
              <button key={id} role="radio" aria-checked={look.theme === id} className={look.theme === id ? "active" : ""} onClick={() => set(id, null)}>
                <Icon size={13} style={{ marginRight: 5, verticalAlign: -2 }} />
                {label}
              </button>
            ))}
          </div>
          <div className="small muted">{look.theme === "system" ? `Follows Windows (currently ${mode}).` : `Always ${mode}, whatever Windows uses.`}</div>
        </div>
      </div>

      <div className="set-row">
        <div className="k">Accent colour</div>
        <div className="stack" style={{ gap: 6 }}>
          <div className="swatches" role="radiogroup" aria-label="Accent colour">
            {ACCENTS.map((a) => {
              const t = a[mode];
              const on = look.accent === a.id;
              return (
                <button
                  key={a.id}
                  role="radio"
                  aria-checked={on}
                  aria-label={a.label}
                  title={a.label}
                  className={`swatch${on ? " on" : ""}`}
                  style={{ background: t.accent, color: t.text }}
                  onClick={() => set(null, a.id)}
                >
                  {on && <Check size={14} strokeWidth={3} />}
                </button>
              );
            })}
          </div>
          <div className="small muted">
            {ACCENTS.find((a) => a.id === look.accent)?.label ?? "Blue"}. Used for buttons, links, badges and selection. Each one has a light and a dark version, so it stays readable in both themes.
          </div>
        </div>
      </div>

      <div className="set-row">
        <div className="k">Course colours</div>
        <div className="stack" style={{ gap: 0 }}>
          {courses.length === 0 && <div className="small muted" style={{ paddingTop: 6 }}>No current courses.</div>}
          {courses.map((c) => {
            const mine = look.courseColors[String(c.id)];
            const canvas = canvasColor(c);
            const isOpen = open === c.id;
            return (
              <div key={c.id} className="cc-row">
                <div className="row-flex">
                  <button
                    className="swatch sm"
                    style={{ background: courseColor(c) }}
                    onClick={() => setOpen(isOpen ? null : c.id)}
                    aria-expanded={isOpen}
                    aria-label={`Change colour for ${c.course_code || c.name}`}
                    title="Change colour"
                  />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ellipsis" style={{ fontWeight: 600 }}>{c.course_code || c.name}</div>
                    <div className="small muted ellipsis">{mine ? "Your colour" : canvas ? "Canvas colour" : "No colour set in Canvas"}</div>
                  </div>
                  {mine && (
                    <button className="btn btn-sm btn-ghost" onClick={() => setColor(c, null)} title={canvas ? `Back to ${canvas}` : "Remove your colour"}>
                      <Undo2 size={13} /> Use Canvas colour
                    </button>
                  )}
                  <button className="btn btn-sm" onClick={() => setOpen(isOpen ? null : c.id)} aria-expanded={isOpen}>
                    <Palette size={13} /> {isOpen ? "Done" : "Change"}
                  </button>
                </div>
                {isOpen && (
                  <div className="cc-pick">
                    <div className="swatches" role="radiogroup" aria-label={`Colour for ${c.course_code || c.name}`}>
                      {COURSE_SWATCHES.map((hex) => {
                        const on = courseColor(c).toLowerCase() === hex;
                        return (
                          <button key={hex} role="radio" aria-checked={on} aria-label={hex} title={hex} className={`swatch sm${on ? " on" : ""}`} style={{ background: hex, color: "#fff" }} onClick={() => setColor(c, hex)}>
                            {on && <Check size={12} strokeWidth={3} />}
                          </button>
                        );
                      })}
                    </div>
                    <label className="btn btn-sm cc-custom">
                      Custom…
                      <input type="color" value={/^#[0-9a-f]{6}$/i.test(courseColor(c)) ? courseColor(c) : "#2563eb"} onChange={(e) => setColor(c, e.target.value, true)} aria-label="Custom colour" />
                    </label>
                  </div>
                )}
              </div>
            );
          })}
          <div className="small muted" style={{ paddingTop: 8 }}>Your colours are used everywhere in Studydesk. They don't change anything in Canvas.</div>
        </div>
      </div>
    </section>
  );
}
