import { EditorState, StateField, TransactionSpec } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { get as emoji } from "node-emoji";
import { icon } from "../ui/icons";

export type Align = "left" | "center" | "right" | "";

/** Leading blockquote markers (`> `, `>> `) of a table row. */
export const QUOTE_PREFIX = /^\s*(?:>\s?)+/;
/**
 * Container prefix of a table's *first* line: quote markers and list markers (`- `, `1. `), in any
 * nesting. Only the header line can carry a list marker; later rows are indented continuation lines.
 */
export const HEADER_PREFIX = /^(?:\s*(?:>\s?|(?:[-*+]|\d{1,9}[.)])\s+))+/;

/** Container prefix (quote/list markers, indentation before them) of a table row. */
export const rowPrefix = (text: string, first: boolean) => (first ? HEADER_PREFIX : QUOTE_PREFIX).exec(text)?.[0] ?? "";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Just enough inline markdown for table cells. */
export function renderInline(text: string): string {
  const code: string[] = [];
  let html = escapeHtml(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`);
  html = html
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>")
    .replace(/(^|\W)_(?!\s)(.+?)_(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/==(.+?)==/g, "<mark>$1</mark>")
    .replace(/~([^~\s]+)~/g, "<sub>$1</sub>")
    .replace(/\^([^^\s]+)\^/g, "<sup>$1</sup>")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '<span class="cm-link">$1</span>')
    .replace(/:([\w+-]+):/g, (m, name) => emoji(name) ?? m);
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${code[+i]}</code>`);
}

/** Whether the `|` at `i` is a cell separator: escaped only by an odd run of backslashes (`\\|` is not). */
export function isSeparator(text: string, i: number): boolean {
  let n = 0;
  while (i - n - 1 >= 0 && text[i - n - 1] === "\\") n++;
  return n % 2 === 0;
}

/** Split a table row on unescaped pipes, dropping the optional outer pipes. */
export function cells(line: string): string[] {
  const row = line.trim();
  const pipes: number[] = [];
  for (let i = 0; i < row.length; i++) if (row[i] === "|" && isSeparator(row, i)) pipes.push(i);
  if (pipes[0] !== 0) pipes.unshift(-1);
  if (pipes[pipes.length - 1] !== row.length - 1 || pipes.length < 2) pipes.push(row.length);
  const out: string[] = [];
  // GFM: inside a cell `\|` is a literal pipe; other escapes are left to the inline renderer.
  for (let i = 0; i + 1 < pipes.length; i++) out.push(row.slice(pipes[i] + 1, pipes[i + 1]).trim().replace(/\\\|/g, "|"));
  return out;
}

/**
 * [from, to) of each cell's inner text on a table row (between unescaped pipes). `first` marks the
 * table's header line, the only one that can carry a list marker (`- | a | b |`).
 */
export function tableCells(text: string, offset: number, first: boolean): { from: number; to: number }[] {
  // Quoted/list rows start with "> " / "- "; cells begin after that prefix.
  const prefix = rowPrefix(text, first).length;
  const pipes: number[] = [];
  for (let i = prefix; i < text.length; i++) if (text[i] === "|" && isSeparator(text, i)) pipes.push(i);
  // GFM allows rows without outer pipes (`a | b`): treat the line edges as virtual pipes.
  const rest = text.slice(prefix).search(/\S/);
  const firstChar = rest < 0 ? -1 : prefix + rest;
  const lastChar = text.trimEnd().length - 1;
  if (firstChar >= 0 && pipes[0] !== firstChar) pipes.unshift(firstChar - 1);
  if (lastChar >= 0 && pipes[pipes.length - 1] !== lastChar) pipes.push(lastChar + 1);
  const out = [];
  for (let i = 0; i + 1 < pipes.length; i++) {
    const raw = text.slice(pipes[i] + 1, pipes[i + 1]);
    const lead = raw.length - raw.trimStart().length;
    const inner = raw.trim();
    const from = offset + pipes[i] + 1 + (inner ? lead : Math.min(1, raw.length));
    out.push({ from, to: from + inner.length });
  }
  return out;
}

function alignment(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : "";
}

/** Header cells, column alignments and body rows of a table's source lines. */
export function parseTable(source: string) {
  // Quoted tables carry "> " on every row, list tables a "- " on the first; drop them before splitting cells.
  const lines = source.split("\n").map((l, i) => l.slice(rowPrefix(l, i === 0).length));
  const head = cells(lines[0]);
  const aligns = cells(lines[1] ?? "").map(alignment);
  const body = lines.slice(2).filter((l) => l.trim()).map(cells);
  return { head, aligns, body };
}

// ---------------------------------------------------------------- model ↔ source

/** A table as a grid: `rows[0]` is the header; every row has exactly one cell per column. */
export interface TableModel {
  rows: string[][];
  aligns: Align[];
}

export function modelOf(source: string): TableModel {
  const { head, aligns, body } = parseTable(source);
  // GFM: the header fixes the column count; short rows are padded, extra cells dropped.
  const fit = <T>(r: T[], fill: T) => head.map((_, i) => r[i] ?? fill);
  return { rows: [head, ...body.map((r) => fit(r, ""))], aligns: fit(aligns, "" as Align) };
}

/** Cell text as markdown source: pipes escaped so they stay in the cell, no line breaks. */
export function escapeCell(text: string): string {
  let out = text.replace(/[\r\n]+/g, " ").replace(/(\\*)\|/g, (_, bs: string) => bs + (bs.length % 2 ? "\\\\|" : "\\|"));
  // A trailing backslash would escape the closing pipe.
  if (/(?:^|[^\\])(?:\\\\)*\\$/.test(out)) out += " ";
  return out;
}

const DELIMITER: Record<Align, (w: number) => string> = {
  "": (w) => "-".repeat(w),
  left: (w) => ":" + "-".repeat(w - 1),
  center: (w) => ":" + "-".repeat(w - 2) + ":",
  right: (w) => "-".repeat(w - 1) + ":",
};

/** Canonical source for a table: outer pipes, columns padded to line up. */
export function serializeTable(m: TableModel, firstPrefix = "", prefix = ""): string {
  const rows = m.rows.map((r) => r.map(escapeCell));
  const widths = m.aligns.map((_, c) => Math.max(3, ...rows.map((r) => r[c].length)));
  const line = (cs: string[]) => "| " + cs.map((t, c) => t.padEnd(widths[c])).join(" | ") + " |";
  const lines = [line(rows[0]), line(m.aligns.map((a, c) => DELIMITER[a](widths[c]))), ...rows.slice(1).map(line)];
  return lines.map((l, i) => (i ? prefix : firstPrefix) + l).join("\n");
}

/** A table's extent extended to whole lines (so a list marker / quote prefix belongs to it). */
export interface Extent {
  from: number;
  to: number;
}

/** Container prefixes to keep when rewriting a table: the header line's, and the other rows'. */
function prefixes(state: EditorState, e: Extent): [string, string] {
  const head = state.doc.lineAt(e.from);
  const p = rowPrefix(head.text, true);
  const first = p + /^[ \t]*/.exec(head.text.slice(p.length))![0];
  // The delimiter row is always a continuation line: its indentation / quote markers fit new rows.
  const second = head.number < state.doc.lines ? state.doc.line(head.number + 1).text : "";
  return [first, /^(?:[ \t]*>)*[ \t]*/.exec(second)![0]];
}

/** Change that sets cell (r, c) — r 0 is the header — of the table at `e` to `text`, touching only that cell. */
export function cellChange(state: EditorState, e: Extent, r: number, c: number, text: string) {
  const line = state.doc.line(state.doc.lineAt(e.from).number + (r === 0 ? 0 : r + 1));
  const ranges = tableCells(line.text, line.from, r === 0);
  const insert = escapeCell(text);
  if (ranges[c]) return { from: ranges[c].from, to: ranges[c].to, insert };
  // A short row (fewer cells than the header): append the missing cells.
  const trimmed = line.text.trimEnd();
  const closed = trimmed.endsWith("|") && isSeparator(trimmed, trimmed.length - 1);
  const fill = (closed ? "" : " |") + "   |".repeat(c - ranges.length) + ` ${insert} |`;
  return { from: line.from + trimmed.length, to: line.to, insert: fill };
}

/** Rewrite the table at `e` after `edit` changed its grid (rows / columns added or removed). */
export function restructure(state: EditorState, e: Extent, edit: (m: TableModel) => void): TransactionSpec {
  const m = modelOf(state.sliceDoc(e.from, e.to));
  edit(m);
  const [first, rest] = prefixes(state, e);
  return { changes: { from: e.from, to: e.to, insert: serializeTable(m, first, rest) }, userEvent: "input.table" };
}

export const tableOps = {
  insertRow: (at: number) => (m: TableModel) => void m.rows.splice(Math.max(1, at), 0, m.aligns.map(() => "")),
  deleteRow: (r: number) => (m: TableModel) => void (r > 0 && m.rows.splice(r, 1)),
  insertCol: (at: number) => (m: TableModel) => {
    m.rows.forEach((row) => row.splice(at, 0, ""));
    m.aligns.splice(at, 0, "");
  },
  deleteCol: (c: number) => (m: TableModel) => {
    if (m.aligns.length < 2) return;
    m.rows.forEach((row) => row.splice(c, 1));
    m.aligns.splice(c, 1);
  },
};

// ---------------------------------------------------------------- editable widget

/** Source text of each cell element (what it shows while focused). */
const rawText = new WeakMap<HTMLElement, string>();
/** Text each unfocused cell currently shows rendered (absent while it shows raw source). */
const rendered = new WeakMap<HTMLElement, string>();

interface WrapState {
  model: TableModel;
  /** Last focused cell, the target of toolbar actions. */
  cur: [number, number] | null;
}
const wrapState = new WeakMap<HTMLElement, WrapState>();

const TOOLS: ([string, string, string] | "|")[] = [
  ["row-above", "Insert row above", "⌥⌘↑"],
  ["row-below", "Insert row below", "⌥⌘↓"],
  ["col-left", "Insert column left", "⌥⌘←"],
  ["col-right", "Insert column right", "⌥⌘→"],
  "|",
  ["row-delete", "Delete row", "⌥⌘⌫"],
  ["col-delete", "Delete column", "⇧⌥⌘⌫"],
  "|",
  ["code", "Edit as Markdown", ""],
  ["trash", "Delete table", ""],
];

const toolsHtml = TOOLS.map((t) =>
  t === "|"
    ? '<span class="sep" role="separator" aria-orientation="vertical"></span>'
    : `<button type="button" class="btn" tabindex="-1" data-act="${t[0]}" title="${t[1]}${t[2] ? " " + t[2] : ""}" aria-label="${t[1]}">${icon(t[0])}</button>`,
).join("");

const cellOf = (t: EventTarget | null) => (t instanceof HTMLElement ? t.closest<HTMLElement>("td[data-r], th[data-r]") : null);
const pos = (cell: HTMLElement): [number, number] => [+cell.dataset.r!, +cell.dataset.c!];

/** Character offsets of the selection inside `cell`, or null when it is elsewhere. */
function selectionIn(cell: HTMLElement): { start: number; end: number } | null {
  const sel = cell.ownerDocument.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!cell.contains(range.startContainer)) return null;
  const pre = cell.ownerDocument.createRange();
  pre.selectNodeContents(cell);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  return { start, end: start + range.toString().length };
}

function select(cell: HTMLElement, from: number, to = from) {
  const doc = cell.ownerDocument;
  const text = cell.firstChild ?? cell.appendChild(doc.createTextNode(""));
  const len = text.textContent!.length;
  const range = doc.createRange();
  range.setStart(text, Math.min(from, len));
  range.setEnd(text, Math.min(to, len));
  const sel = doc.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Show a cell as raw markdown (it is being edited). */
function showRaw(cell: HTMLElement) {
  const text = rawText.get(cell) ?? "";
  if (rendered.has(cell) && (cell.textContent !== text || cell.childElementCount)) {
    cell.textContent = text;
    select(cell, text.length);
  }
  rendered.delete(cell);
}

function showRendered(cell: HTMLElement) {
  const text = rawText.get(cell) ?? "";
  if (rendered.get(cell) === text) return;
  cell.innerHTML = renderInline(text);
  rendered.set(cell, text);
}

function makeCell(tag: "th" | "td") {
  const cell = document.createElement(tag);
  cell.setAttribute("contenteditable", "plaintext-only");
  cell.spellcheck = true;
  return cell;
}

/** Bring the widget's DOM in line with `m`, reusing elements and leaving the focused cell's text alone. */
function render(wrap: HTMLElement, m: TableModel) {
  const st = wrapState.get(wrap)!;
  st.model = m;
  const table = wrap.querySelector("table")!;
  const head = table.tHead!;
  const body = table.tBodies[0];
  m.rows.forEach((row, r) => {
    const section = r ? body : head;
    const tr = section.rows[r ? r - 1 : 0] ?? section.appendChild(document.createElement("tr"));
    row.forEach((text, c) => {
      const cell = (tr.cells[c] as HTMLElement | undefined) ?? tr.appendChild(makeCell(r ? "td" : "th"));
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cell.style.textAlign = m.aligns[c] || "";
      cell.setAttribute("aria-label", `${r ? `Row ${r}` : "Header"}, column ${c + 1}`);
      rawText.set(cell, text);
      if (cell !== document.activeElement) showRendered(cell);
      else if ((cell.textContent ?? "").trim() !== text) {
        // Changed from outside (undo, source edit): take the new text, caret to its end.
        cell.textContent = text;
        select(cell, text.length);
      }
    });
    while (tr.cells.length > row.length) tr.lastElementChild!.remove();
  });
  while (body.rows.length > m.rows.length - 1) body.lastElementChild!.remove();
  syncTools(wrap);
}

function syncTools(wrap: HTMLElement) {
  const { model, cur } = wrapState.get(wrap)!;
  const r = cur?.[0] ?? -1;
  const disable = (act: string, off: boolean) => {
    const b = wrap.querySelector<HTMLButtonElement>(`[data-act="${act}"]`);
    if (b) b.disabled = off;
  };
  disable("row-above", r <= 0);
  disable("row-delete", r <= 0);
  disable("col-delete", model.aligns.length < 2);
}

function findWrap(view: EditorView, from: number): HTMLElement | null {
  for (const w of view.contentDOM.querySelectorAll<HTMLElement>(".cm-table")) {
    if (locate(view, w)?.from === from) return w;
  }
  return null;
}

function locate(view: EditorView, wrap: HTMLElement): Extent | null {
  let at: number;
  try {
    at = view.posAtDOM(wrap);
  } catch {
    return null;
  }
  return view.state.field(tables).extents.find((e) => e.from <= at && at <= e.to) ?? null;
}

function focusCell(wrap: HTMLElement, r: number, c: number, where: "start" | "end" | "all" = "end") {
  const { model } = wrapState.get(wrap)!;
  r = Math.max(0, Math.min(r, model.rows.length - 1));
  c = Math.max(0, Math.min(c, model.aligns.length - 1));
  const cell = wrap.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`);
  if (!cell) return;
  cell.focus({ preventScroll: false });
  const len = (cell.textContent ?? "").length;
  if (where === "start") select(cell, 0);
  else if (where === "end") select(cell, len);
  else select(cell, 0, len);
}

/** Leave the table for the surrounding text: above it (dir -1) or below it (dir 1). */
function exit(view: EditorView, wrap: HTMLElement, dir: -1 | 1) {
  const e = locate(view, wrap);
  if (!e) return;
  const doc = view.state.doc;
  if (dir < 0) {
    if (e.from === 0) return;
    view.dispatch({ selection: { anchor: e.from - 1 }, scrollIntoView: true });
  } else if (e.to >= doc.length) {
    view.dispatch({ changes: { from: e.to, insert: "\n" }, selection: { anchor: e.to + 1 }, scrollIntoView: true });
  } else {
    view.dispatch({ selection: { anchor: e.to + 1 }, scrollIntoView: true });
  }
  view.focus();
}

/** Apply a grid edit to the table in `wrap`, then put the caret in cell `focus`. */
function edit(view: EditorView, wrap: HTMLElement, op: (m: TableModel) => void, focus: [number, number]) {
  const e = locate(view, wrap);
  if (!e) return;
  view.dispatch(restructure(view.state, e, op));
  const w = findWrap(view, e.from);
  if (w) focusCell(w, focus[0], focus[1], "start");
}

function act(view: EditorView, wrap: HTMLElement, action: string) {
  const { model, cur } = wrapState.get(wrap)!;
  const rows = model.rows.length;
  const cols = model.aligns.length;
  const [r, c] = cur ?? [rows - 1, cols - 1];
  switch (action) {
    case "row-above":
      if (r > 0) edit(view, wrap, tableOps.insertRow(r), [r, c]);
      break;
    case "row-below":
      edit(view, wrap, tableOps.insertRow(r + 1), [r + 1, c]);
      break;
    case "row-end":
      edit(view, wrap, tableOps.insertRow(rows), [rows, cur ? c : 0]);
      break;
    case "col-left":
      edit(view, wrap, tableOps.insertCol(c), [r, c]);
      break;
    case "col-right":
      edit(view, wrap, tableOps.insertCol(c + 1), [r, c + 1]);
      break;
    case "col-end":
      edit(view, wrap, tableOps.insertCol(cols), [cur ? r : 0, cols]);
      break;
    case "row-delete":
      if (r > 0) edit(view, wrap, tableOps.deleteRow(r), [Math.min(r, rows - 2), c]);
      break;
    case "col-delete":
      if (cols > 1) edit(view, wrap, tableOps.deleteCol(c), [r, Math.min(c, cols - 2)]);
      break;
    case "code": {
      // Show the source: a caret inside the table switches it to plain text.
      const e = locate(view, wrap);
      if (!e) return;
      const head = view.state.doc.lineAt(e.from);
      const first = tableCells(head.text, head.from, true)[0];
      view.dispatch({ selection: { anchor: first ? first.from : e.from + 1 }, scrollIntoView: true });
      view.focus();
      break;
    }
    case "trash": {
      const e = locate(view, wrap);
      if (!e) return;
      const doc = view.state.doc;
      const to = e.to < doc.length ? e.to + 1 : e.to;
      const from = to === e.to && e.from > 0 ? e.from - 1 : e.from;
      view.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: "delete.table", scrollIntoView: true });
      view.focus();
      break;
    }
  }
}

function onKey(view: EditorView, wrap: HTMLElement, e: KeyboardEvent) {
  const cell = cellOf(e.target);
  if (!cell || e.isComposing) return;
  const [r, c] = pos(cell);
  const { model } = wrapState.get(wrap)!;
  const rows = model.rows.length;
  const cols = model.aligns.length;
  const mod = e.metaKey || e.ctrlKey;
  const go = (rr: number, cc: number, where: "start" | "end" | "all" = "end") => focusCell(wrap, rr, cc, where);
  let handled = true;

  if (mod && e.altKey) {
    if (e.key === "ArrowUp") act(view, wrap, "row-above");
    else if (e.key === "ArrowDown") act(view, wrap, "row-below");
    else if (e.key === "ArrowLeft") act(view, wrap, "col-left");
    else if (e.key === "ArrowRight") act(view, wrap, "col-right");
    else if (e.key === "Backspace") act(view, wrap, e.shiftKey ? "col-delete" : "row-delete");
    else handled = false;
  } else if (mod || e.altKey) {
    handled = false;
  } else {
    const sel = selectionIn(cell);
    const len = (cell.textContent ?? "").length;
    const collapsed = !!sel && sel.start === sel.end;
    switch (e.key) {
      case "Tab":
        if (e.shiftKey) {
          if (c > 0) go(r, c - 1, "all");
          else if (r > 0) go(r - 1, cols - 1, "all");
        } else if (c < cols - 1) go(r, c + 1, "all");
        else if (r < rows - 1) go(r + 1, 0, "all");
        else edit(view, wrap, tableOps.insertRow(rows), [rows, 0]);
        break;
      case "Enter":
        if (r < rows - 1) go(r + 1, c);
        else edit(view, wrap, tableOps.insertRow(rows), [rows, c]);
        break;
      case "ArrowUp":
        if (e.shiftKey) handled = false;
        else if (r > 0) go(r - 1, c);
        else exit(view, wrap, -1);
        break;
      case "ArrowDown":
        if (e.shiftKey) handled = false;
        else if (r < rows - 1) go(r + 1, c);
        else exit(view, wrap, 1);
        break;
      case "ArrowLeft":
        if (e.shiftKey || !collapsed || sel!.start > 0) handled = false;
        else if (c > 0) go(r, c - 1, "end");
        else if (r > 0) go(r - 1, cols - 1, "end");
        else exit(view, wrap, -1);
        break;
      case "ArrowRight":
        if (e.shiftKey || !collapsed || sel!.end < len) handled = false;
        else if (c < cols - 1) go(r, c + 1, "start");
        else if (r < rows - 1) go(r + 1, 0, "start");
        else exit(view, wrap, 1);
        break;
      case "Escape":
        exit(view, wrap, 1);
        break;
      default:
        handled = false;
    }
  }
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

function wire(view: EditorView, wrap: HTMLElement) {
  wrap.addEventListener("focusin", (e) => {
    const cell = cellOf(e.target);
    if (!cell) return;
    wrapState.get(wrap)!.cur = pos(cell);
    showRaw(cell);
    syncTools(wrap);
  });
  wrap.addEventListener("focusout", (e) => {
    const cell = cellOf(e.target);
    if (cell) showRendered(cell);
  });
  wrap.addEventListener("input", (e) => {
    const cell = cellOf(e.target);
    const ext = locate(view, wrap);
    if (!cell || !ext) return;
    const [r, c] = pos(cell);
    const text = (cell.textContent ?? "").replace(/[\r\n]+/g, " ");
    view.dispatch({ changes: cellChange(view.state, ext, r, c, text), userEvent: "input.type" });
  });
  wrap.addEventListener("paste", (e) => {
    if (!cellOf(e.target)) return;
    e.preventDefault();
    const text = (e.clipboardData?.getData("text/plain") ?? "").replace(/[\r\n]+/g, " ");
    document.execCommand("insertText", false, text);
  });
  wrap.addEventListener("keydown", (e) => onKey(view, wrap, e));
  // Toolbar and "+" buttons must not take focus from the cell being edited.
  wrap.addEventListener("mousedown", (e) => {
    if ((e.target as Element).closest("button")) e.preventDefault();
  });
  wrap.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("button[data-act]");
    if (btn && !btn.disabled) act(view, wrap, btn.dataset.act!);
  });
}

class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-table";
    wrap.innerHTML =
      `<div class="cm-table-tools" role="toolbar" aria-label="Table">${toolsHtml}</div>` +
      `<div class="cm-table-scroll"><table><thead></thead><tbody></tbody></table></div>` +
      `<button type="button" class="cm-table-add cm-table-add-row" tabindex="-1" data-act="row-end" title="Add row" aria-label="Add row">${icon("plus")}</button>` +
      `<button type="button" class="cm-table-add cm-table-add-col" tabindex="-1" data-act="col-end" title="Add column" aria-label="Add column">${icon("plus")}</button>`;
    wrapState.set(wrap, { model: modelOf(this.source), cur: null });
    wire(view, wrap);
    render(wrap, modelOf(this.source));
    return wrap;
  }
  updateDOM(dom: HTMLElement) {
    if (!wrapState.has(dom)) return false;
    render(dom, modelOf(this.source));
    return true;
  }
  ignoreEvent() {
    return true;
  }
}

// ---------------------------------------------------------------- state

interface TablesValue {
  extents: Extent[];
  /** Indices of the extents the selection is inside (those are shown as source). */
  editing: string;
  decos: DecorationSet;
}

/** Block nodes that can contain a table; the walk skips everything else (inline content). */
const CONTAINERS = new Set(["Document", "Blockquote", "BulletList", "OrderedList", "ListItem"]);

function findExtents(state: EditorState): Extent[] {
  const extents: Extent[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Table") return CONTAINERS.has(node.name) ? undefined : false; // tables only live in blocks
      extents.push({ from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(node.to).to });
      return false;
    },
  });
  return extents;
}

/**
 * The single "is this table shown as source" predicate, shared by full builds and caret moves: the
 * selection reaches *inside* it (Edit as Markdown, find, select-all). A caret merely at its edge
 * (arrowing past it, a click beside it) keeps the table rendered.
 */
function editingKey(state: EditorState, extents: Extent[]): string {
  const hit: number[] = [];
  extents.forEach((e, i) => {
    if (state.selection.ranges.some((r) => r.from < e.to && r.to > e.from)) hit.push(i);
  });
  return hit.join(",");
}

function decorate(state: EditorState, extents: Extent[], editing: string): DecorationSet {
  const skip = new Set(editing ? editing.split(",").map(Number) : []);
  return Decoration.set(
    extents
      .filter((_, i) => !skip.has(i))
      .map((e) => Decoration.replace({ widget: new TableWidget(state.sliceDoc(e.from, e.to)), block: true }).range(e.from, e.to)),
  );
}

function build(state: EditorState, extents = findExtents(state)): TablesValue {
  const editing = editingKey(state, extents);
  return { extents, editing, decos: decorate(state, extents, editing) };
}

const field = StateField.define<TablesValue>({
  create: (state) => build(state),
  update(value, tr) {
    const reparsed = syntaxTree(tr.state) !== syntaxTree(tr.startState);
    if (tr.docChanged || reparsed) return build(tr.state);
    if (!tr.selection) return value;
    // Extents are cached; a caret move only rebuilds when the set of edited tables changes.
    return editingKey(tr.state, value.extents) === value.editing ? value : build(tr.state, value.extents);
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

/** Arrowing onto a rendered table puts the caret in its first cell (from above) or last row (from below). */
const enterByKeyboard = EditorView.updateListener.of((u) => {
  if (u.docChanged || !u.selectionSet) return;
  const keyboard = u.transactions.some((tr) => tr.isUserEvent("select") && !tr.isUserEvent("select.pointer") && !tr.isUserEvent("select.search"));
  const sel = u.state.selection.main;
  if (!keyboard || !sel.empty || u.state.selection.ranges.length > 1) return;
  // CodeMirror's vertical motion jumps over a block widget, so look for a caret that crossed a
  // table from the line right next to it, or landed on its edge (←/→ across a line break).
  const doc = u.state.doc;
  const prev = u.startState.selection.main.head;
  if (prev > doc.length) return;
  const line = (p: number) => doc.lineAt(p).number;
  const e = u.state.field(field).extents.find((x) => {
    if (x.from === sel.head || x.to === sel.head) return true;
    const above = prev < x.from && sel.head > x.to && line(prev) === line(x.from) - 1;
    const below = prev > x.to && sel.head < x.from && line(prev) === line(x.to) + 1;
    return above || below;
  });
  if (!e) return;
  const fromAbove = prev < e.from;
  const view = u.view;
  requestAnimationFrame(() => {
    const wrap = findWrap(view, e.from);
    if (!wrap) return;
    focusCell(wrap, fromAbove ? 0 : wrapState.get(wrap)!.model.rows.length - 1, 0, "start");
  });
});

/** Renders GFM tables as editable tables; a selection inside one shows its source instead. */
export const tables = field;
export const tableEditing = [field, enterByKeyboard];

/** Put the caret in cell (r, c) of the rendered table around `at`. False when not in a live editor. */
export function editTableCell(view: EditorView, at: number, r = 0, c = 0): boolean {
  if (typeof document === "undefined" || !view.contentDOM) return false;
  const e = view.state.field(field, false)?.extents.find((x) => x.from <= at && at <= x.to);
  if (!e) return false;
  view.dispatch({ selection: { anchor: e.from } });
  const wrap = findWrap(view, e.from);
  if (!wrap) return false;
  focusCell(wrap, r, c, "all");
  return true;
}

/** The table cell being edited, if any. */
export function focusedCell(): HTMLElement | null {
  const a = typeof document === "undefined" ? null : document.activeElement;
  return a instanceof HTMLElement && a.matches(".cm-table td[data-r], .cm-table th[data-r]") ? a : null;
}

const CELL_MARKS: Record<string, [string, string]> = {
  bold: ["**", "**"],
  italic: ["*", "*"],
  strike: ["~~", "~~"],
  highlight: ["==", "=="],
  code: ["`", "`"],
  subscript: ["~", "~"],
  superscript: ["^", "^"],
  link: ["[", "]()"],
};

/**
 * Run a formatting command in the focused table cell. Null when no cell has focus; false when the
 * command makes no sense inside a cell (headings, lists, …).
 */
export function formatCell(id: string): boolean | null {
  const cell = focusedCell();
  if (!cell) return null;
  const marks = CELL_MARKS[id];
  if (!marks) return false;
  const sel = selectionIn(cell) ?? { start: (cell.textContent ?? "").length, end: (cell.textContent ?? "").length };
  const text = (cell.textContent ?? "").slice(sel.start, sel.end);
  document.execCommand("insertText", false, marks[0] + text + marks[1]);
  const inner = sel.start + marks[0].length;
  select(cell, inner, inner + text.length);
  return true;
}
