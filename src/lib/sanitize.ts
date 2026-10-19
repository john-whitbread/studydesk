// HTML from Canvas (assignment descriptions, announcements, lock notes) is
// written by instructors and rendered only after strict sanitising. Even if
// something slipped through, the page's Content Security Policy blocks inline
// scripts and every network request.

import DOMPurify from "dompurify";

const purify = DOMPurify(window);

purify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.removeAttribute("target");
    node.setAttribute("rel", "noreferrer noopener");
  }
});

const CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "iframe", "frame", "form", "input", "button", "select", "textarea", "video", "audio", "source", "track", "object", "embed", "svg", "math", "link", "meta", "base", "picture"],
  FORBID_ATTR: ["style", "class", "id", "src", "srcset", "srcdoc", "background", "poster", "formaction", "action", "name"],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

export interface CleanHtml {
  html: string;
  /** Images, video or embedded tools that can only be viewed in Canvas. */
  hasEmbeds: boolean;
}

export function cleanHtml(raw: string | null | undefined): CleanHtml {
  if (!raw) return { html: "", hasEmbeds: false };
  // DOMParser documents are inert: no scripts run, no images load.
  const inert = new DOMParser().parseFromString(raw, "text/html");
  const hasEmbeds = inert.querySelector("img, iframe, video, audio, object, embed") != null;
  return { html: purify.sanitize(raw, CONFIG) as string, hasEmbeds };
}

/** Plain text of an HTML snippet (for previews). */
export function htmlToText(raw: string | null | undefined): string {
  if (!raw) return "";
  const doc = new DOMParser().parseFromString(raw, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}
