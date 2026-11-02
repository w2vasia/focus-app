import { EditorState, Transaction, TransactionSpec } from "@codemirror/state";
import * as focus from "../src/editor/focusMode.ts";

let failed = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

// Run animation frames synchronously.
(globalThis as any).requestAnimationFrame = (fn: () => void) => (fn(), 1);
(globalThis as any).cancelAnimationFrame = () => {};

const { focusConfig, setFocusConfig } = focus;
const typewriterUpdate = (focus as any).typewriterUpdate as ((u: any) => void) | undefined;
const setPointerHeld = (focus as any).setPointerHeld as ((v: any, down: boolean) => void) | undefined;

let scrolls = 0;
const view: any = {
  state: EditorState.create({ doc: "one\ntwo\nthree\nfour", extensions: focusConfig }),
  dispatch(spec: TransactionSpec) {
    if (spec.effects) scrolls++;
    else view.state = view.state.update(spec).state;
  },
};
view.state = view.state.update({ effects: setFocusConfig.of({ typewriter: true }) }).state;

/** Apply a selection change and feed the resulting update to the typewriter listener. */
function select(anchor: number, userEvent: string) {
  const tr: Transaction = view.state.update({ selection: { anchor }, userEvent });
  const startState = view.state;
  view.state = tr.state;
  typewriterUpdate!({ view, state: tr.state, startState, docChanged: false, selectionSet: true, transactions: [tr] });
}

check("typewriter hooks are exported", typeof typewriterUpdate === "function" && typeof setPointerHeld === "function");
if (typewriterUpdate && setPointerHeld) {
  scrolls = 0;
  select(5, "select");
  check("keyboard move re-centres", scrolls === 1, scrolls);

  // A plain click: mousedown selects (select.pointer) with the button held, then mouseup.
  scrolls = 0;
  setPointerHeld(view, true);
  select(9, "select.pointer");
  check("no re-centre while the button is held", scrolls === 0, scrolls);
  setPointerHeld(view, false);
  check("click re-centres once on release", scrolls === 1, scrolls);

  // A drag: many pointer selections while held, one re-centre on release.
  scrolls = 0;
  setPointerHeld(view, true);
  for (const p of [1, 2, 3, 4, 10]) select(p, "select.pointer");
  check("no re-centre during a drag", scrolls === 0, scrolls);
  setPointerHeld(view, false);
  check("drag re-centres once on release", scrolls === 1, scrolls);

  // Mouse down/up without a selection change (e.g. scrollbar) doesn't scroll.
  scrolls = 0;
  setPointerHeld(view, true);
  setPointerHeld(view, false);
  check("press without selecting doesn't re-centre", scrolls === 0, scrolls);

  // A pointer selection without the button held (e.g. a programmatic pointer event) re-centres.
  scrolls = 0;
  select(2, "select.pointer");
  check("pointer selection without a held button re-centres", scrolls === 1, scrolls);
}

process.exit(failed);
