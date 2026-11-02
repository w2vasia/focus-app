import { EditorState, EditorSelection } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { extendedSyntax } from "../src/editor/syntax.ts";
import { parseTable, tables, cellChange, restructure, tableOps, serializeTable, modelOf, escapeCell } from "../src/editor/tables.ts";

let failed = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

const exts = [markdown({ base: markdownLanguage, extensions: extendedSyntax }), tables];
function make(doc: string, selection: EditorSelection | { anchor: number; head?: number }) {
  const s = EditorState.create({ doc, selection, extensions: exts });
  ensureSyntaxTree(s, doc.length, 5000);
  return s;
}
const widgets = (s: EditorState) => s.field(tables).decos.size;
/** Widget count of a fresh state with the same doc and selection (what a full rebuild gives). */
const fresh = (s: EditorState) => widgets(make(s.doc.toString(), s.selection));
const move = (s: EditorState, anchor: number, head = anchor) => s.update({ selection: { anchor, head } }).state;

// R2-M7 repro A: select across the whole table (⌘A), then click outside.
const doc = "intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nafter";
let s = make(doc, { anchor: 0 });
check("table rendered with caret outside", widgets(s) === 1, widgets(s));
s = move(s, 0, doc.length);
check("select-all shows table as source", widgets(s) === 0, widgets(s));
s = move(s, doc.length);
check("click outside after select-all renders the table again", widgets(s) === 1 && fresh(s) === 1, [widgets(s), fresh(s)]);

// R2-M7 repro B: caret at the line start of a list / quoted table (where a click on the widget puts it).
for (const [label, src] of [
  ["list", "- | a | b |\n  | - | - |\n  | 1 | 2 |\n\nafter"],
  ["quote", "> | a | b |\n> | - | - |\n> | 1 | 2 |\n\nafter"],
  ["quoted list", "> - | a | b |\n>   | - | - |\n>   | 1 | 2 |\n\nafter"],
] as const) {
  let t = make(src, { anchor: src.length });
  check(`${label} table: rendered when caret is away`, widgets(t) === 1, widgets(t));
  t = move(t, 0);
  check(`${label} table: caret at line start keeps it rendered`, widgets(t) === 1 && fresh(t) === 1, [widgets(t), fresh(t)]);
  t = move(t, 5);
  check(`${label} table: caret inside shows source`, widgets(t) === 0 && fresh(t) === 0, [widgets(t), fresh(t)]);
  t = move(t, src.length);
  check(`${label} table: moving away renders it again`, widgets(t) === 1, widgets(t));
}

// Range that ends exactly at the table's last character / starts at its first.
s = make(doc, { anchor: 0 });
s = move(s, 0, 7);
check("selection touching the table's first char shows source", widgets(s) === fresh(s), [widgets(s), fresh(s)]);
s = move(s, doc.length);
check("…and renders after leaving", widgets(s) === 1, widgets(s));

// Every selection step agrees with a full rebuild.
s = make(doc, { anchor: 0 });
let mismatch: number[] = [];
for (let p = 0; p <= doc.length; p++) {
  s = move(s, p);
  if (widgets(s) !== fresh(s)) mismatch.push(p);
  s = move(s, 0, p);
  if (widgets(s) !== fresh(s)) mismatch.push(-p);
}
check("incremental update always matches a full rebuild", mismatch.length === 0, mismatch);

// M7 / R2-M6: cells of a table inside a list item have no junk "-" column.
let p = parseTable("- | a | b |\n  | - | :-: |\n  | 1 | 2 |");
check("list table: header cells", JSON.stringify(p.head) === '["a","b"]', p.head);
check("list table: alignments", JSON.stringify(p.aligns) === '["","center"]', p.aligns);
check("list table: body", JSON.stringify(p.body) === '[["1","2"]]', p.body);
p = parseTable("> 1. | a | b |\n>    | - | - |\n>    | 1 | 2 |");
check("quoted ordered-list table: header cells", JSON.stringify(p.head) === '["a","b"]', p.head);
p = parseTable("| - | x |\n| - | - |\n| - | - |");
check("dash cells in a plain table are kept", JSON.stringify(p.head) === '["-","x"]' && JSON.stringify(p.body) === '[["-","-"]]', p);

// R3-L2 (c): a pipe after an even run of backslashes is a separator; after an odd run it is text.
p = parseTable("| a \\\\| b |\n| - | - |");
check("`\\\\|` ends the cell (escaped backslash)", JSON.stringify(p.head) === JSON.stringify(["a \\\\", "b"]), p.head);
p = parseTable("| a \\| b | c |\n| - | - |");
check("`\\|` is a literal pipe", JSON.stringify(p.head) === JSON.stringify(["a | b", "c"]), p.head);
p = parseTable("| a \\\\\\| b | c |\n| - | - |");
check("`\\\\\\|` is a backslash plus a literal pipe", p.head.length === 2 && p.head[1] === "c", p.head);
p = parseTable("a | b\n--|--\n1 | 2");
check("rows without outer pipes still split", JSON.stringify(p.head) === '["a","b"]' && JSON.stringify(p.body) === '[["1","2"]]', p);

// Editing in place: a single cell changes only that cell's text.
const ext = (s: EditorState) => s.field(tables).extents[0];
const apply = (s: EditorState, spec: any) => {
  const n = s.update(spec).state;
  ensureSyntaxTree(n, n.doc.length, 5000);
  return n;
};
let e = make("| a | b |\n| - | - |\n| 1 | 2 |", { anchor: 0 });
let n = apply(e, { changes: cellChange(e, ext(e), 2 - 1, 1, "two") });
check("cell edit: body cell", n.doc.toString() === "| a | b |\n| - | - |\n| 1 | two |", n.doc.toString());
n = apply(e, { changes: cellChange(e, ext(e), 0, 0, "x|y") });
check("cell edit: header cell, pipe escaped", n.doc.toString().startsWith("| x\\|y | b |") && JSON.stringify(parseTable(n.doc.toString()).head) === '["x|y","b"]', n.doc.toString());
n = apply(e, { changes: cellChange(e, ext(e), 1, 0, "") });
check("cell edit: cleared cell keeps the table", n.field(tables).extents.length === 1 && JSON.stringify(parseTable(n.doc.toString()).body) === '[["","2"]]', n.doc.toString());
e = make("| a | b | c |\n| - | - | - |\n| 1 |", { anchor: 0 });
n = apply(e, { changes: cellChange(e, ext(e), 1, 2, "z") });
check("cell edit: short row gets the missing cells", JSON.stringify(parseTable(n.doc.toString()).body) === '[["1","","z"]]', n.doc.toString());
check("escapeCell: trailing backslash can't eat the pipe", escapeCell("a\\") === "a\\ ", escapeCell("a\\"));

// Rows and columns.
e = make("intro\n\n| a | b |\n| :- | -: |\n| 1 | 2 |\n\nafter", { anchor: 0 });
const grid = (s: EditorState) => modelOf(s.sliceDoc(ext(s).from, ext(s).to));
n = apply(e, restructure(e, ext(e), tableOps.insertRow(1)));
check("insert row above first body row", JSON.stringify(grid(n).rows) === '[["a","b"],["",""],["1","2"]]', grid(n));
check("…keeps alignment and surrounding text", JSON.stringify(grid(n).aligns) === '["left","right"]' && n.doc.toString().startsWith("intro\n\n|") && n.doc.toString().endsWith("|\n\nafter"), n.doc.toString());
n = apply(e, restructure(e, ext(e), tableOps.insertRow(2)));
check("insert row at end", JSON.stringify(grid(n).rows) === '[["a","b"],["1","2"],["",""]]', grid(n));
n = apply(e, restructure(e, ext(e), tableOps.insertRow(0)));
check("insert row never goes above the header", JSON.stringify(grid(n).rows[0]) === '["a","b"]', grid(n));
n = apply(e, restructure(e, ext(e), tableOps.deleteRow(1)));
check("delete body row", JSON.stringify(grid(n).rows) === '[["a","b"]]' && n.field(tables).extents.length === 1, n.doc.toString());
n = apply(e, restructure(e, ext(e), tableOps.deleteRow(0)));
check("header row can't be deleted", JSON.stringify(grid(n).rows) === '[["a","b"],["1","2"]]', grid(n));
n = apply(e, restructure(e, ext(e), tableOps.insertCol(1)));
check("insert column in the middle", JSON.stringify(grid(n).rows) === '[["a","","b"],["1","","2"]]' && JSON.stringify(grid(n).aligns) === '["left","","right"]', grid(n));
n = apply(e, restructure(e, ext(e), tableOps.insertCol(2)));
check("insert column at end", JSON.stringify(grid(n).rows) === '[["a","b",""],["1","2",""]]', grid(n));
n = apply(e, restructure(e, ext(e), tableOps.deleteCol(0)));
check("delete column", JSON.stringify(grid(n).rows) === '[["b"],["2"]]' && JSON.stringify(grid(n).aligns) === '["right"]', grid(n));
n = apply(n, restructure(n, ext(n), tableOps.deleteCol(0)));
check("last column can't be deleted", JSON.stringify(grid(n).rows) === '[["b"],["2"]]', grid(n));

// Container prefixes survive a rewrite.
for (const [label, src, want] of [
  ["quote", "> | a | b |\n> | - | - |\n> | 1 | 2 |", /^> \| a +\| b +\|\n> \|[-| ]+\|\n> \| 1 +\| 2 +\|\n> \| +\| +\|$/],
  ["list", "- | a | b |\n  | - | - |\n  | 1 | 2 |", /^- \| a +\| b +\|\n  \|[-| ]+\|\n  \| 1 +\| 2 +\|\n  \| +\| +\|$/],
] as const) {
  const q = make(src, { anchor: 0 });
  const r = apply(q, restructure(q, ext(q), tableOps.insertRow(2)));
  check(`${label} table: rows added keep the container prefix`, want.test(r.doc.toString()) && r.field(tables).extents.length === 1, r.doc.toString());
}
check("serialize pads columns", serializeTable({ rows: [["Name", "x"], ["a", "longer"]], aligns: ["", "center"] }) === "| Name | x      |\n| ---- | :----: |\n| a    | longer |",
  serializeTable({ rows: [["Name", "x"], ["a", "longer"]], aligns: ["", "center"] }));

process.exit(failed);
