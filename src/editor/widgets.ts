import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { EditorView, WidgetType } from "@codemirror/view";
import { allowRemote, canLoadRemote, isRemote, remoteAllowed, remoteImagesAllowed, remotePlaceholder } from "./remoteImages";

/**
 * Where a click on an image placeholder puts the caret: the start of the image's URL (`![a](|http…)`),
 * or just inside `![` if the source isn't on the image's first line. `from` is the image's start.
 */
export function imageSourcePos(state: EditorState, from: number): number {
  for (let n: any = syntaxTree(state).resolveInner(from, 1); n; n = n.parent) {
    if (n.name !== "Image") continue;
    const url = n.getChild("URL");
    // Same line only: a caret on another line would leave this placeholder rendered.
    if (url && state.doc.lineAt(url.from).number === state.doc.lineAt(from).number) return url.from;
    break;
  }
  return Math.min(from + 2, state.doc.lineAt(from).to);
}

export class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-bullet";
    el.textContent = "•";
    return el;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  // Position isn't part of equality, so edits elsewhere don't recreate every checkbox.
  eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task-box";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      // Look up where the "[ ]" marker is now; the state char sits right after "[".
      const pos = view.posAtDOM(box);
      const mark = view.state.sliceDoc(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(mark)) return;
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: mark[1] === " " ? "x" : " " } });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

export class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-rule";
    return el;
  }
}

export class ImageWidget extends WidgetType {
  /** Whether the image itself is shown (local, or a remote URL the user allowed) vs. a placeholder. */
  readonly shown: boolean;
  constructor(readonly src: string, readonly alt: string) {
    super();
    this.shown = !isRemote(src) || remoteAllowed(src);
  }
  // `shown` is part of equality: allowing a URL must redraw every placeholder of it.
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt && other.shown === this.shown;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-image";
    if (!this.shown && !canLoadRemote(this.src)) {
      // http can never load (CSP), but the placeholder still has to be editable: a click drops the
      // caret into the image's source, which reveals the markdown (a disabled button eats clicks).
      const btn = remotePlaceholder(this.src, this.alt);
      btn.disabled = false;
      btn.tabIndex = -1;
      btn.setAttribute("aria-disabled", "true");
      btn.title = `Insecure (http) images can't be loaded. Click to edit the source: ${this.src}`;
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        view.dispatch({ selection: { anchor: imageSourcePos(view.state, view.posAtDOM(wrap)) } });
        view.focus();
      });
      btn.addEventListener("click", (e) => e.preventDefault());
      wrap.appendChild(btn);
      return wrap;
    }
    if (!this.shown) {
      const btn = remotePlaceholder(this.src, this.alt);
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        allowRemote(this.src);
        // Rebuilds the live preview, which swaps this and any other copy of the URL for the image.
        view.dispatch({ effects: remoteImagesAllowed.of(null) });
      });
      wrap.appendChild(btn);
      return wrap;
    }
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.onerror = () => {
      wrap.classList.add("broken");
      wrap.textContent = this.alt || "image not found";
    };
    wrap.appendChild(img);
    return wrap;
  }
  // Placeholders take their own clicks ("Load image", or caret-into-source for http).
  ignoreEvent(e: Event) {
    return (e.target as HTMLElement).closest?.(".remote-image") !== null;
  }
}

/** Inline text replacement, e.g. an emoji glyph or a footnote marker. */
export class TextWidget extends WidgetType {
  constructor(readonly text: string, readonly cls: string) {
    super();
  }
  eq(other: TextWidget) {
    return other.text === this.text && other.cls === this.cls;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.cls;
    el.textContent = this.text;
    return el;
  }
}
