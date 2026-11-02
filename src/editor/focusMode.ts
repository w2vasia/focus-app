import { EditorState, Extension, Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

export type FocusUnit = "paragraph" | "sentence";
export interface FocusConfig {
  enabled: boolean;
  unit: FocusUnit;
  typewriter: boolean;
}

export const setFocusConfig = StateEffect.define<Partial<FocusConfig>>();

export const focusConfig = StateField.define<FocusConfig>({
  create: () => ({ enabled: false, unit: "paragraph", typewriter: false }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocusConfig)) value = { ...value, ...e.value };
    return value;
  },
});

/** Contiguous run of non-blank lines around `pos`. */
function paragraphAt(state: EditorState, pos: number) {
  const doc = state.doc;
  let first = doc.lineAt(pos);
  let last = first;
  if (!first.text.trim()) return { from: first.from, to: first.to };
  while (first.number > 1 && doc.line(first.number - 1).text.trim()) first = doc.line(first.number - 1);
  while (last.number < doc.lines && doc.line(last.number + 1).text.trim()) last = doc.line(last.number + 1);
  return { from: first.from, to: last.to };
}

const SENTENCE_END = /[.!?…]+["'”’)\]]*(?=\s|$)|\n/g;

/** Sentence containing `pos`, bounded by the paragraph. */
function sentenceAt(state: EditorState, pos: number) {
  const para = paragraphAt(state, pos);
  const text = state.sliceDoc(para.from, para.to);
  const offset = pos - para.from;
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(SENTENCE_END)) {
    const stop = m.index! + m[0].length;
    if (stop < offset) start = stop;
    else {
      end = stop;
      break;
    }
  }
  while (start < end && /\s/.test(text[start])) start++;
  return { from: para.from + start, to: para.from + end };
}

const dimLine = Decoration.line({ class: "cm-dim" });
const dimText = Decoration.mark({ class: "cm-dim" });

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const cfg = state.field(focusConfig);
  if (!cfg.enabled) return Decoration.none;
  const head = state.selection.main.head;
  const para = paragraphAt(state, head);
  const active = cfg.unit === "sentence" ? sentenceAt(state, head) : para;
  const decos: Range<Decoration>[] = [];
  const { from, to } = view.viewport;
  for (let pos = from; pos <= to; ) {
    const line = state.doc.lineAt(pos);
    if (line.to < para.from || line.from > para.to) decos.push(dimLine.range(line.from));
    pos = line.to + 1;
  }
  if (active.from > para.from) decos.push(dimText.range(para.from, active.from));
  if (active.to < para.to) decos.push(dimText.range(active.to, para.to));
  return Decoration.set(decos, true);
}

const focusPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      const cfgChanged = u.startState.field(focusConfig) !== u.state.field(focusConfig);
      if (cfgChanged || u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

/** One pending re-centre per view, so bursts of updates scroll once per frame. */
const pendingScroll = new WeakMap<EditorView, number>();
/** Views whose primary mouse button is down (a click or drag selection in progress). */
const held = new WeakSet<EditorView>();
/** Views that got a pointer selection while the button was held: re-centre on release. */
const pointerMoved = new WeakSet<EditorView>();

function recentre(view: EditorView) {
  const doc = view.state.doc;
  cancelAnimationFrame(pendingScroll.get(view) ?? 0);
  pendingScroll.set(
    view,
    requestAnimationFrame(() => {
      // Every update reschedules this, so a different doc here means the document was swapped
      // (another file opened via setState): don't scroll the new file to the old caret.
      if (view.state.doc !== doc) return;
      const head = view.state.selection.main.head;
      view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) });
    }),
  );
}

/** Keeps the caret line vertically centered while typing or moving (exported for tests). */
export function typewriterUpdate(u: ViewUpdate) {
  const cfg = u.state.field(focusConfig);
  const toggledOn = cfg.typewriter && !u.startState.field(focusConfig).typewriter;
  if (!cfg.typewriter || !(u.docChanged || u.selectionSet || toggledOn)) return;
  // While the button is held (click or drag-select) the page must not chase the pointer;
  // the release re-centres once (see `setPointerHeld`).
  if (!toggledOn && held.has(u.view) && u.transactions.some((tr) => tr.isUserEvent("select.pointer"))) {
    pointerMoved.add(u.view);
    return;
  }
  recentre(u.view);
}

/** Mouse button state for typewriter mode; releasing after a pointer selection re-centres once. */
export function setPointerHeld(view: EditorView, down: boolean) {
  if (down) {
    held.add(view);
    pointerMoved.delete(view);
    return;
  }
  held.delete(view);
  const moved = pointerMoved.has(view);
  pointerMoved.delete(view);
  if (moved && view.state.field(focusConfig).typewriter) recentre(view);
}

const typewriter = EditorView.updateListener.of(typewriterUpdate);

const pointerTracking = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0) return false;
    setPointerHeld(view, true);
    // The release can happen outside the editor; CodeMirror's own selection listener sits on the
    // document, so listening on the window runs after it has applied the final selection.
    const win = view.dom.ownerDocument.defaultView ?? window;
    win.addEventListener("mouseup", () => setPointerHeld(view, false), { once: true });
    return false;
  },
});

const typewriterClass = EditorView.editorAttributes.compute([focusConfig], (state) => {
  const cfg = state.field(focusConfig);
  return { class: [cfg.typewriter && "cm-typewriter", cfg.enabled && "cm-focus"].filter(Boolean).join(" ") };
});

export function focusMode(initial: Partial<FocusConfig>): Extension {
  return [focusConfig.init(() => ({ enabled: false, unit: "paragraph", typewriter: false, ...initial })), focusPlugin, typewriter, pointerTracking, typewriterClass];
}
