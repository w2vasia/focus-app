import { EditorState, TransactionSpec } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { insertTable, moveCell } from "../src/editor/commands.ts";

/** Minimal stand-in for EditorView: enough for commands that read state and dispatch. */
function fakeView(doc: string, cursor: number) {
  const view: any = {
    state: EditorState.create({ doc, selection: { anchor: cursor }, extensions: markdown({ base: markdownLanguage }) }),
    dispatch(spec: TransactionSpec) {
      view.state = view.state.update(spec).state;
      ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    },
    focus() {},
  };
  ensureSyntaxTree(view.state, doc.length, 5000);
  return view;
}
const sel = (v: any) => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
let failed = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

// Insert
const v = fakeView("Intro", 5);
insertTable(v);
check("inserts table after paragraph", v.state.doc.toString().startsWith("Intro\n\n| Column 1 |"), v.state.doc.toString());
check("selects first header", sel(v) === "Column 1", sel(v));

// Tab through header → skips delimiter row → body
moveCell(1)(v); check("tab → Column 2", sel(v) === "Column 2", sel(v));
moveCell(1)(v); moveCell(1)(v);
const l = v.state.doc.lineAt(v.state.selection.main.head);
check("tab past header skips delimiter, lands row 1", l.number === 5 && !l.text.includes("-"), l.text);
moveCell(-1)(v); check("shift-tab back to Column 3", sel(v) === "Column 3", sel(v));

// Tab past last cell appends row
const t = fakeView("| a | b |\n| - | - |\n| 1 | 2 |", 26); // caret in last cell ("2")
moveCell(1)(t);
check("tab in last cell adds a row", t.state.doc.lines === 4 && t.state.doc.line(4).text.split("|").length === 4, t.state.doc.toString());

// H5: GFM tables without outer pipes
const np = fakeView("a | b\n--|--\n1 | 2", 0);
moveCell(1)(np);
check("no outer pipes: tab moves to next cell", sel(np) === "b", sel(np));
moveCell(1)(np); moveCell(1)(np);
check("no outer pipes: tab past header lands in body", sel(np) === "2", sel(np));
const np2 = fakeView("a | b\n--|--\n1 | 2", 17);
moveCell(1)(np2);
check("no outer pipes: tab in last cell adds a row without throwing", np2.state.doc.lines === 4, np2.state.doc.toString());

// M7: tables inside blockquotes
const q = fakeView("> | a | b |\n> | - | - |\n> | 1 | 2 |", 4);
moveCell(1)(q);
check("quoted table: tab moves to next cell", sel(q) === "b", sel(q));
moveCell(1)(q);
check("quoted table: skips '>' and delimiter row", sel(q) === "1", sel(q));

// M7 / R2-M6: tables inside list items
const caretAfter = (doc: string, marker: string) => doc.indexOf(marker) + marker.length - 1;
const li = "- | a | b |\n  | - | - |\n  | 1 | 2 |";
let lv = fakeView(li, 4); // in "a"
moveCell(1)(lv);
check("list table: tab moves to next cell", sel(lv) === "b", sel(lv));
moveCell(-1)(lv);
check("list table: shift-tab goes to 'a', not the bullet", sel(lv) === "a", sel(lv));
moveCell(-1)(lv);
check("list table: shift-tab in first cell stays in table", sel(lv) === "a", sel(lv));
lv = fakeView(li, caretAfter(li, "2 |") - 2);
moveCell(1)(lv);
check("list table: appended row keeps list indentation and outer pipes", lv.state.doc.line(4).text === "  |   |   |", lv.state.doc.line(4).text);
check("list table: caret in first new cell", lv.state.doc.lineAt(lv.state.selection.main.head).number === 4 && lv.state.selection.main.head - lv.state.doc.line(4).from === 4, lv.state.selection.main.head);
moveCell(-1)(lv);
check("list table: appended row parses as part of the table", sel(lv) === "2", sel(lv));

let lq = fakeView("> | a | b |\n> | - | - |\n> | 1 | 2 |", 33);
moveCell(1)(lq);
check("quoted table: appended row keeps '> ' prefix", lq.state.doc.line(4).text === "> |   |   |", lq.state.doc.toString());
const qli = "> - | a | b |\n>   | - | - |\n>   | 1 | 2 |";
lq = fakeView(qli, qli.length - 2);
moveCell(1)(lq);
check("quoted list table: appended row is '>   |   |   |'", lq.state.doc.line(4).text === ">   |   |   |", lq.state.doc.toString());
moveCell(-1)(lq);
check("quoted list table: shift-tab from new row lands in '2'", sel(lq) === "2", sel(lq));
const ol = "1. | a | b |\n   | - | - |\n   | 1 | 2 |";
lq = fakeView(ol, ol.length - 2);
moveCell(1)(lq);
check("ordered list table: appended row indented 3", lq.state.doc.line(4).text === "   |   |   |", lq.state.doc.toString());
moveCell(-1)(lq);
check("ordered list table: appended row parses as part of the table", sel(lq) === "2", sel(lq));
const np3 = fakeView("- a | b\n  --|--\n  1 | 2", 22);
moveCell(1)(np3);
check("list table without outer pipes: appended row is canonical", np3.state.doc.line(4).text === "  |   |   |", np3.state.doc.toString());

// R2-L5: body rows made of dashes are data, not the delimiter row
const dash = "| a | b |\n| - | - |\n| - | - |\n| x | y |";
const dv = fakeView(dash, 6); // in "b"
moveCell(1)(dv);
const dl = dv.state.doc.lineAt(dv.state.selection.main.head).number;
check("tab from header lands in the dash body row", dl === 3 && sel(dv) === "-", [dl, sel(dv)]);
moveCell(1)(dv); moveCell(1)(dv);
check("tab continues to next row", sel(dv) === "x", sel(dv));
moveCell(-1)(dv); moveCell(-1)(dv);
check("shift-tab back into the dash row", dv.state.doc.lineAt(dv.state.selection.main.head).number === 3, dv.state.doc.lineAt(dv.state.selection.main.head).number);

// R3-M3: a table inside a list item but not on the marker line; the new row copies the last row's prefix
/** The appended row (last line) must belong to the same Table node as the header (so comrak keeps the list). */
const sameTable = (v: any) => {
  let tables = 0, end = -1;
  syntaxTree(v.state).iterate({ enter: (n) => { if (n.name === "Table") { tables++; end = n.to; } } });
  return tables === 1 && end === v.state.doc.length;
};
const appendCases: [string, string, string][] = [
  ["indented list table", "- item\n\n  | a | b |\n  | - | - |\n  | 1 | 2 |", "  |   |   |"],
  ["nested list table", "- a\n  - b\n\n    | a | b |\n    | - | - |\n    | 1 | 2 |", "    |   |   |"],
  ["quoted list table", "> - item\n>\n>   | a | b |\n>   | - | - |\n>   | 1 | 2 |", ">   |   |   |"],
  ["ordered list table off the marker line", "1. item\n\n   | a | b |\n   | - | - |\n   | 1 | 2 |", "   |   |   |"],
];
for (const [name, doc, row] of appendCases) {
  const av = fakeView(doc, doc.length - 2);
  moveCell(1)(av);
  const lastLine = av.state.doc.line(av.state.doc.lines);
  check(`${name}: appended row keeps prefix`, lastLine.text === row, av.state.doc.toString());
  check(`${name}: appended row parses as part of the table`, sameTable(av));
  check(`${name}: caret in the new first cell`, av.state.selection.main.head === lastLine.from + row.indexOf("|") + 2, av.state.selection.main.head);
}
// insertTable continues the list item / quote it is inserted from
const il = fakeView("- item", 6);
insertTable(il);
check("insert table in list item: rows indented", il.state.doc.toString().startsWith("- item\n\n  | Column 1 |") && il.state.doc.line(4).text.startsWith("  | -"), il.state.doc.toString());
check("insert table in list item: selects first header", sel(il) === "Column 1", sel(il));
check("insert table in list item: parses as a table", sameTable(fakeView(il.state.doc.toString().trimEnd(), 0)));
const iq = fakeView("> quote", 7);
insertTable(iq);
check("insert table in quote: '>' separator and '> ' rows", iq.state.doc.toString().startsWith("> quote\n>\n> | Column 1 |"), iq.state.doc.toString());
check("insert table in quote: selects first header", sel(iq) === "Column 1", sel(iq));

// R4-L5 (a): a thematic break is no list item: the table must not become an indented code block
const tableNodes = (v: any) => { const out: string[] = []; syntaxTree(v.state).iterate({ enter: (n) => { if (n.name === "Table" || n.name === "CodeBlock" || n.name === "Blockquote" || n.name === "HorizontalRule") out.push(n.name); } }); return out; };
for (const hr of ["* * *", "- - -", "___", "  ***"]) {
  const hv = fakeView(hr, hr.length);
  insertTable(hv);
  const doc = hv.state.doc.toString();
  check(`insert table after \`${hr}\`: unindented rows`, doc.startsWith(hr + "\n\n| Column 1 |"), doc);
  check(`insert table after \`${hr}\`: rule + table, no code block`, JSON.stringify(tableNodes(hv)) === '["HorizontalRule","Table"]', tableNodes(hv));
  check(`insert table after \`${hr}\`: selects first header`, sel(hv) === "Column 1", sel(hv));
}
// R4-L5 (b): a blank `>` line gives `> |` rows, and a following quote line stays in the same quote
const bq = fakeView("> a\n>\n> b", 5); // caret on the blank `>` line
insertTable(bq);
check("insert table on a blank `>` line: `> |` rows", bq.state.doc.toString() === "> a\n>\n> | Column 1 | Column 2 | Column 3 |\n> | -------- | -------- | -------- |\n> |          |          |          |\n> |          |          |          |\n>\n> b", bq.state.doc.toString());
check("…one quote holding a table", JSON.stringify(tableNodes(bq)) === '["Blockquote","Table"]', tableNodes(bq));
check("…selects first header", sel(bq) === "Column 1", sel(bq));
const bq2 = fakeView(">", 1);
insertTable(bq2);
check("insert table on a lone `>`: `> |` rows", bq2.state.doc.toString().startsWith(">\n> | Column 1 |") && JSON.stringify(tableNodes(bq2)) === '["Blockquote","Table"]', [bq2.state.doc.toString(), tableNodes(bq2)]);
const qa = fakeView("> a\n> b", 3); // end of `> a`
insertTable(qa);
check("insert table between quote lines keeps one quote", qa.state.doc.toString().endsWith("> |          |          |          |\n>\n> b") && JSON.stringify(tableNodes(qa)) === '["Blockquote","Table"]', [qa.state.doc.toString(), tableNodes(qa)]);
check("…selects first header", sel(qa) === "Column 1", sel(qa));
const pa = fakeView("a\nb", 1); // plain paragraphs keep a plain blank line after
insertTable(pa);
check("insert table between plain lines: plain blank line after", pa.state.doc.toString().endsWith("|          |          |          |\n\nb"), pa.state.doc.toString());

// R3-L2 (c): `\\|` is an escaped backslash followed by a real separator
const esc = "| a\\\\| b |\n| - | - |\n| 1 | 2 |"; // | a\\| b |
const ev = fakeView(esc, 3);
moveCell(1)(ev);
check("Tab after `\\\\|` moves to the next cell", sel(ev) === "b", sel(ev));
const ev2 = fakeView("| a\\| b | c |\n| - | - |\n| 1 | 2 |", 3);
moveCell(1)(ev2);
check("Tab past `\\|` (escaped pipe) skips to the real next cell", sel(ev2) === "c", sel(ev2));

// Outside a table, Tab falls through to normal indent
check("tab outside table not handled", moveCell(1)(fakeView("plain text", 3)) === false);
process.exit(failed);
