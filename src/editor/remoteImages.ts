/**
 * Remote (http/https) images load only after a click, so opening a document can't reveal the
 * reader to a tracking pixel. A click allows that URL for the rest of the session.
 */
import { StateEffect } from "@codemirror/state";

const allowed = new Set<string>();

export const isRemote = (src: string) => /^https?:\/\//i.test(src);
/** The CSP only allows `img-src https:`; plain-http images would just show as broken. */
export const canLoadRemote = (src: string) => /^https:\/\//i.test(src);
export const remoteAllowed = (src: string) => allowed.has(src);
export const allowRemote = (src: string) => {
  if (canLoadRemote(src)) allowed.add(src);
};

/** Dispatched after URLs were allowed, so the live preview redraws every copy of them. */
export const remoteImagesAllowed = StateEffect.define<null>();

const hostOf = (src: string) => {
  try {
    return new URL(src).host;
  } catch {
    return src;
  }
};

/** A "Load image" placeholder. Interaction is wired by the caller (editor widget or preview). */
export function remotePlaceholder(src: string, alt: string): HTMLButtonElement {
  const loadable = canLoadRemote(src);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = loadable ? "remote-image" : "remote-image insecure";
  btn.dataset.src = src;
  btn.title = loadable ? `Load ${src}` : `Insecure (http) images can't be loaded: ${src}`;
  // Nothing to load for http: keep it out of the tab order and inert to clicks.
  if (!loadable) btn.disabled = true;
  const label = document.createElement("span");
  label.className = "ri-label";
  label.textContent = alt || "Image";
  const host = document.createElement("span");
  host.className = "ri-host";
  host.textContent = loadable ? `Load image · ${hostOf(src)}` : `Insecure image (http) can't be loaded · ${hostOf(src)}`;
  btn.append(label, host);
  return btn;
}
