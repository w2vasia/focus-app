import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { readFileSync } from "node:fs";
import { extendedSyntax } from "../src/editor/syntax.ts";
import { buildDecorations } from "../src/editor/livePreview.ts";

let failed = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

/** Replace decorations that cross a line break, which CodeMirror refuses from a plugin (C1). */
function crossingReplaces(doc: string) {
  const state = EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, extensions: extendedSyntax }) });
  ensureSyntaxTree(state, doc.length, 5000);
  const view: any = { state, hasFocus: false, viewport: { from: 0, to: doc.length } };
  const bad: string[] = [];
  buildDecorations(view).between(0, doc.length, (from, to, deco) => {
    if ((deco as any).point && to > from && state.doc.lineAt(from).number !== state.doc.lineAt(to).number) bad.push(doc.slice(from, to));
  });
  return bad;
}

check("multi-line image alt is not replaced", crossingReplaces("![a long\nalt](x.png)\n\nnext").length === 0, crossingReplaces("![a long\nalt](x.png)\n\nnext"));
check("multi-line link title is not replaced", crossingReplaces('[a](u "t\nx")\n').length === 0, crossingReplaces('[a](u "t\nx")\n'));
const sheet = readFileSync(new URL("./cheat-sheet.md", import.meta.url), "utf8");
check("cheat sheet: no line-crossing replaces", crossingReplaces(sheet).length === 0, crossingReplaces(sheet));
process.exit(failed);
