import { EditorView, ViewUpdate } from "@codemirror/view";
import { activeFormats } from "../editor/commands";
import { icon } from "./icons";

type Item = { id: string; label: string; key: string } | "|";

const ITEMS: Item[] = [
  { id: "bold", label: "Bold", key: "⌘B" },
  { id: "italic", label: "Italic", key: "⌘I" },
  { id: "strike", label: "Strikethrough", key: "⇧⌘X" },
  { id: "highlight", label: "Highlight", key: "⇧⌘H" },
  "|",
  { id: "subscript", label: "Subscript", key: "⌃⌘-" },
  { id: "superscript", label: "Superscript", key: "⌃⌘=" },
  "|",
  { id: "code", label: "Inline code", key: "⌘E" },
  { id: "link", label: "Link", key: "⌘K" },
];

const GAP_PX = 8;
const EDGE_PX = 8;

/** Inline formatting bubble that rises above a text selection. */
export class SelectionBubble {
  private el = document.createElement("div");
  private buttons = new Map<string, HTMLButtonElement>();
  private pointerDown = false;

  constructor(private view: () => EditorView, onCommand: (id: string) => void) {
    this.el.id = "bubble";
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", "Format selection");
    this.el.hidden = true;
    for (const item of ITEMS) {
      if (item === "|") {
        this.el.insertAdjacentHTML("beforeend", '<span class="sep" role="separator" aria-orientation="vertical"></span>');
        continue;
      }
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.innerHTML = icon(item.id);
      btn.title = `${item.label} ${item.key}`;
      btn.setAttribute("aria-label", item.label);
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
      btn.addEventListener("click", () => {
        onCommand(item.id);
        this.sync();
      });
      this.el.appendChild(btn);
      this.buttons.set(item.id, btn);
    }
    document.body.appendChild(this.el);

    // Wait for the drag to finish before showing, so the bubble doesn't chase the mouse.
    document.addEventListener("mousedown", (e) => {
      if (!this.el.contains(e.target as Node)) {
        this.pointerDown = true;
        this.hide();
      }
    });
    document.addEventListener("mouseup", () => {
      if (!this.pointerDown) return;
      this.pointerDown = false;
      requestAnimationFrame(() => this.sync());
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.el.hidden) {
        this.hide();
        e.stopPropagation();
      }
    }, true);
  }

  /** Feed every editor update here. */
  update(u: ViewUpdate) {
    if (u.selectionSet || u.docChanged || u.focusChanged || u.geometryChanged) {
      if (!this.pointerDown) this.sync();
    }
  }

  reposition() {
    if (!this.el.hidden) this.sync();
  }

  hide() {
    this.el.hidden = true;
  }

  private sync() {
    const view = this.view();
    const sel = view.state.selection.main;
    const focused = view.hasFocus || this.el.contains(document.activeElement);
    if (sel.empty || !focused) return this.hide();

    // Clip to the rendered viewport: coordsAtPos is null for text CodeMirror hasn't drawn.
    const { from: vpFrom, to: vpTo } = view.viewport;
    const start = view.coordsAtPos(Math.max(sel.from, vpFrom), 1);
    const end = view.coordsAtPos(Math.min(sel.to, vpTo), -1);
    if (!start || !end) return this.hide();
    const scroller = view.scrollDOM.getBoundingClientRect();
    // Hide when the selection is covered (e.g. by the sidebar overlay in a narrow window). Probe a
    // point of the selection that is on screen: the start may be scrolled above the viewport.
    const probe = start.bottom > scroller.top ? start : end;
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
    const under = document.elementFromPoint(
      clamp(probe.left + 1, scroller.left + 1, scroller.right - 1),
      clamp((probe.top + probe.bottom) / 2, scroller.top + 1, scroller.bottom - 1),
    );
    if (!under || !(view.dom.contains(under) || this.el.contains(under) || under.closest("#toolbar"))) return this.hide();

    for (const [id, btn] of this.buttons) btn.setAttribute("aria-pressed", String(activeFormats(view.state).has(id)));
    const wasHidden = this.el.hidden;
    this.el.hidden = false;
    if (wasHidden) {
      this.el.classList.remove("rise");
      void this.el.offsetWidth; // restart the entrance animation
      this.el.classList.add("rise");
    }

    const { width, height } = this.el.getBoundingClientRect();
    // Single-line selection: centre over it; multi-line: anchor at the start.
    const anchor = start.top === end.top ? (start.left + end.right) / 2 : start.left + width / 2;
    const left = Math.min(Math.max(anchor - width / 2, scroller.left + EDGE_PX), scroller.right - width - EDGE_PX);
    // Room above ends at the scroller edge, or below the pinned formatting bar when it's showing.
    const toolbar = document.querySelector<HTMLElement>("#toolbar.visible");
    const ceiling = Math.max(scroller.top, toolbar ? toolbar.getBoundingClientRect().bottom : -Infinity) + EDGE_PX;
    let top = start.top - height - GAP_PX;
    // Drop below when there's no room above (start scrolled off, under the formatting bar) or when the
    // bubble would sit on a heading, e.g. the title right above the first line of text.
    if (top < ceiling || this.headingAbove(view, sel.from, top)) top = end.bottom + GAP_PX;
    // Selection taller than the window (both ends off screen): pin to the top of the visible text.
    if (top + height > scroller.bottom && start.top < scroller.bottom && end.bottom > scroller.top) top = ceiling;
    if (top > scroller.bottom || end.bottom < scroller.top || start.top > scroller.bottom) return this.hide();
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  /** Whether a heading line lies between `top` (the bubble's top edge) and the line holding `pos`. */
  private headingAbove(view: EditorView, pos: number, top: number): boolean {
    const { node } = view.domAtPos(pos);
    let line = (node instanceof Element ? node : node.parentElement)?.closest(".cm-line")?.previousElementSibling;
    for (; line; line = line.previousElementSibling) {
      const rect = line.getBoundingClientRect();
      if (rect.bottom <= top) return false;
      if (/\bcm-h[1-6]\b/.test(line.className)) return true;
    }
    return false;
  }
}
