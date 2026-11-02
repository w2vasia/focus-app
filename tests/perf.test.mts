import { EditorSelection, EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { extendedSyntax } from "../src/editor/syntax.ts";
import { tables } from "../src/editor/tables.ts";
import { buildDecorations } from "../src/editor/livePreview.ts";

let failed = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

// M8: a caret move far from any table must not rebuild the tables field on a big document.
const para = "Lorem ipsum dolor sit amet, **consectetur** adipiscing elit. ".repeat(20) + "\n\n";
const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n\n" + para.repeat(1500); // ~1.8 MB
let state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, extensions: extendedSyntax }), tables] });
ensureSyntaxTree(state, doc.length, 20000);
// The finished parse is installed by the next transaction (as the background parser does in the app).
state = state.update({ selection: { anchor: doc.length } }).state;
const before = state.field(tables);
const t0 = performance.now();
for (let i = 0; i < 200; i++) state = state.update({ selection: { anchor: doc.length - 1 - i } }).state;
const ms = performance.now() - t0;
const same = state.field(tables) === before;
check(`caret moves away from tables reuse the field (200 moves in ${ms.toFixed(1)} ms)`, same);

// R3-M7: a select-all on a huge document must not make every live-preview rebuild walk all lines.
const md = markdown({ base: markdownLanguage, extensions: extendedSyntax });
const big = "Some **bold** text and `code` here\n".repeat(200000);
const all = EditorState.create({ doc: big, selection: EditorSelection.single(0, big.length), extensions: md });
ensureSyntaxTree(all, 4000, 5000);
const viewOf = (st: EditorState) => ({ state: st, hasFocus: true, viewport: { from: 0, to: 3000 } }) as any;
const caretState = all.update({ selection: { anchor: 0 } }).state;
const time = (st: EditorState) => {
  buildDecorations(viewOf(st)); // warm-up
  const t = performance.now();
  for (let i = 0; i < 10; i++) buildDecorations(viewOf(st));
  return (performance.now() - t) / 10;
};
const allMs = time(all);
const caretMs = time(caretState);
check(`select-all rebuild costs about a caret rebuild (${allMs.toFixed(1)} ms vs ${caretMs.toFixed(1)} ms)`, allMs < caretMs * 3 + 2, [allMs, caretMs]);

// …and the range check still marks exactly the selected lines as being edited (markers shown).
const hidden = (st: EditorState, focus = true) => {
  const lines = new Set<number>();
  buildDecorations({ state: st, hasFocus: focus, viewport: { from: 0, to: st.doc.length } } as any).between(0, st.doc.length, (f, t, d) => {
    if ((d as any).point && t > f) lines.add(st.doc.lineAt(f).number);
  });
  return [...lines].sort((a, b) => a - b);
};
const five = "**a**\n**b**\n**c**\n**d**\n**e**";
const lineStart = (n: number) => (n - 1) * 6;
const multi = EditorState.create({
  doc: five,
  extensions: [md, EditorState.allowMultipleSelections.of(true)],
  selection: EditorSelection.create([EditorSelection.cursor(lineStart(1) + 2), EditorSelection.cursor(lineStart(1) + 3), EditorSelection.range(lineStart(3) + 4, lineStart(4) + 1)]),
});
ensureSyntaxTree(multi, five.length, 5000);
check("carets on lines 1 and 3–4 leave only lines 2 and 5 concealed", JSON.stringify(hidden(multi)) === "[2,5]", hidden(multi));
check("selection ending at a line start still counts that line", hidden(multi).indexOf(4) < 0);
check("without focus every line is concealed", JSON.stringify(hidden(multi, false)) === "[1,2,3,4,5]", hidden(multi, false));
const allFive = multi.update({ selection: EditorSelection.single(0, five.length) }).state;
check("select-all shows every marker", hidden(allFive).length === 0, hidden(allFive));
const lastLine = multi.update({ selection: { anchor: five.length } }).state;
check("caret at document end activates the last line only", JSON.stringify(hidden(lastLine)) === "[1,2,3,4]", hidden(lastLine));

process.exit(failed);
