import { EditorSelection, EditorState, Line } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { editTableCell, tableCells } from "./tables";

type Cmd = (view: EditorView) => boolean;

/** Node name in the markdown tree that each inline marker produces. */
const INLINE_NODES: Record<string, string> = {
  "**": "StrongEmphasis",
  "*": "Emphasis",
  "~~": "Strikethrough",
  "==": "Highlight",
  "~": "Subscript",
  "^": "Superscript",
  "`": "InlineCode",
};

/** Innermost enclosing node of the given type around `pos`, if any. */
function enclosing(state: EditorState, pos: number, name: string) {
  for (let n: any = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === name) return n as { from: number; to: number };
  }
  for (let n: any = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === name) return n as { from: number; to: number };
  }
  return null;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Names of all nodes around `pos`, looking at both sides. */
function nodesAt(state: EditorState, pos: number): Set<string> {
  const names = new Set<string>();
  for (const side of [-1, 1] as const) {
    for (let n: any = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) names.add(n.name);
  }
  return names;
}

/** Literal text where inserting markers would corrupt the content (URLs, code). */
const LITERAL = new Set(["URL", "Autolink", "InlineCode", "CodeText", "FencedCode", "CodeBlock"]);
/** Literals whose edges are still "inside": a code block's fence line, a link/image destination. */
const LITERAL_EDGES = new Set(["FencedCode", "CodeBlock"]);
const DESTINATION_PARENTS = new Set(["Link", "Image", "LinkReference"]);

/**
 * Whether a caret at `pos` sits inside literal text. Inline literals (code spans, bare URLs) only
 * count when the caret is strictly inside, so Bold right after `` `code` `` or a URL still works.
 */
function inLiteral(state: EditorState, pos: number): boolean {
  for (const side of [-1, 1] as const) {
    for (let n: any = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (!LITERAL.has(n.name)) continue;
      const edges = LITERAL_EDGES.has(n.name) || (n.name === "URL" && DESTINATION_PARENTS.has(n.parent?.name));
      if (edges ? n.from <= pos && pos <= n.to : n.from < pos && pos < n.to) return true;
    }
  }
  return false;
}
/** Inline literals a word-wrap must not split: wrapping part of one corrupts it. */
const INLINE_LITERAL = new Set(["URL", "Autolink", "InlineCode"]);

/** Whether [from, to) overlaps a bare URL, autolink or code span. */
function overlapsLiteral(state: EditorState, from: number, to: number): boolean {
  let hit = false;
  syntaxTree(state).iterate({
    from,
    to,
    enter(n) {
      if (hit) return false;
      if (INLINE_LITERAL.has(n.name) && n.from < to && n.to > from) hit = true;
    },
  });
  return hit;
}

/** Inline formatting whose markers an inserted pair at a word edge would collide with. */
const FORMATTED = ["StrongEmphasis", "Emphasis", "Strikethrough", "Highlight", "Subscript", "Superscript"];

export function toggleInline(marker: string): Cmd {
  return (view) => {
    const { state } = view;
    const len = marker.length;
    const wrapped = new Set<string>(); // words already wrapped for another caret
    view.dispatch(
      state.changeByRange((range) => {
        // Unwrap when the selection/cursor sits inside an existing element of this kind.
        const node = enclosing(state, range.from, INLINE_NODES[marker]);
        if (node && node.to >= range.to) {
          return {
            changes: [
              { from: node.from, to: node.from + len },
              { from: node.to - len, to: node.to },
            ],
            // Map each end into the unwrapped text; a caret on a marker lands at the content edge.
            range: EditorSelection.range(
              clamp(range.anchor - len, node.from, node.to - 2 * len),
              clamp(range.head - len, node.from, node.to - 2 * len),
            ),
          };
        }
        if (range.empty) {
          const around = nodesAt(state, range.head);
          // Markers inside a URL or code would corrupt it (and render literally anyway).
          if (inLiteral(state, range.head)) return { range };
          // Caret inside a word: format the whole word (keeps `**bo|ld**` + Italic valid). Inside
          // formatting, a caret at the word's edge does too: a pair there collides with `**`.
          const word = state.wordAt(range.head);
          const edgeOk = FORMATTED.some((n) => around.has(n));
          if (word && (edgeOk ? word.from <= range.head && range.head <= word.to : word.from < range.head && range.head < word.to)) {
            // The word is (part of) a URL or code span with the caret at its edge: wrapping it would
            // split the literal, and an empty pair there would glue onto it (`https://x.com__`) or
            // collide with the enclosing markers (`*…*****`). Leave it alone.
            if (overlapsLiteral(state, word.from, word.to)) return { range };
            const key = `${word.from}:${word.to}`;
            if (wrapped.has(key)) return { range }; // another caret already wraps this word; mapping keeps us inside
            wrapped.add(key);
            return {
              changes: [
                { from: word.from, insert: marker },
                { from: word.to, insert: marker },
              ],
              range: EditorSelection.cursor(range.head + len),
            };
          }
          // An empty `*` pair is `**`, which inside bold closes it: use `_` there (`**a _|_ b**`).
          const pair = marker === "*" && around.has("StrongEmphasis") ? "_" : marker;
          return {
            changes: { from: range.from, insert: pair + pair },
            range: EditorSelection.cursor(range.from + len),
          };
        }
        return {
          changes: [
            { from: range.from, insert: marker },
            { from: range.to, insert: marker },
          ],
          range: EditorSelection.range(range.from + len, range.to + len),
        };
      }),
    );
    view.focus();
    return true;
  };
}

function selectedLines(state: EditorState, from: number, to: number): Line[] {
  const lines: Line[] = [];
  for (let pos = from; pos <= to; ) {
    const line = state.doc.lineAt(pos);
    lines.push(line);
    pos = line.to + 1;
  }
  return lines;
}

/** Rewrite every line touched by the selection; `fn` gets the line text and its index. */
function mapLines(view: EditorView, fn: (text: string, i: number, all: string[]) => string) {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const lines = selectedLines(state, range.from, range.to);
      const texts = lines.map((l) => l.text);
      const changes = lines.map((l, i) => ({ from: l.from, to: l.to, insert: fn(l.text, i, texts) }));
      const changeSet = state.changes(changes);
      const end = changeSet.mapPos(lines[lines.length - 1].to, 1);
      return {
        changes,
        range: range.empty ? EditorSelection.cursor(end) : EditorSelection.range(changeSet.mapPos(lines[0].from, -1), end),
      };
    }),
  );
  view.focus();
  return true;
}

/** Pandoc-style sub/superscript (`H~2~O`, `X^2^`) can't contain spaces; refuse rather than emit broken markup. */
function noSpaces(cmd: Cmd): Cmd {
  return (view) => (view.state.selection.ranges.some((r) => /\s/.test(view.state.sliceDoc(r.from, r.to))) ? false : cmd(view));
}

const HEADING = /^#{1,6}\s+/;

export function setHeading(level: number): Cmd {
  return (view) =>
    mapLines(view, (text) => {
      const current = text.match(/^(#{1,6})\s/)?.[1].length ?? 0;
      const body = text.replace(HEADING, "");
      return level === 0 || current === level ? body : "#".repeat(level) + " " + body;
    });
}

const LIST_PREFIX = /^(\s*)(?:[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> ?)/;
const PREFIX_OF: Record<string, RegExp> = {
  quote: /^\s*> ?/,
  ul: /^\s*[-*+] (?!\[[ xX]\] )/,
  ol: /^\s*\d+[.)] /,
  task: /^\s*[-*+] \[[ xX]\] /,
};

export function toggleLinePrefix(kind: "quote" | "ul" | "ol" | "task"): Cmd {
  return (view) =>
    mapLines(view, (text, i, all) => {
      const nonEmpty = all.filter((t) => t.trim());
      const allHave = nonEmpty.length > 0 && nonEmpty.every((t) => PREFIX_OF[kind].test(t));
      const [, indent = ""] = text.match(LIST_PREFIX) ?? text.match(/^(\s*)/)!;
      const body = text.replace(LIST_PREFIX, "").replace(/^\s*/, "");
      if (allHave) return indent + body;
      if (!text.trim() && all.length > 1) return text;
      const number = all.slice(0, i + 1).filter((t) => t.trim()).length; // blank lines don't count
      const prefix = { quote: "> ", ul: "- ", ol: `${number}. `, task: "- [ ] " }[kind];
      return indent + prefix + body;
    });
}

export const insertLink: Cmd = (view) => {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      if (/^https?:\/\/\S+$/.test(text)) {
        return {
          changes: { from: range.from, to: range.to, insert: `[](${text})` },
          range: EditorSelection.cursor(range.from + 1),
        };
      }
      const insert = `[${text}](url)`;
      const urlStart = range.from + text.length + 3;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: text ? EditorSelection.range(urlStart, urlStart + 3) : EditorSelection.cursor(range.from + 1),
      };
    }),
  );
  view.focus();
  return true;
};

export const insertCodeBlock: Cmd = (view) => {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const from = state.doc.lineAt(range.from);
      const to = state.doc.lineAt(range.to);
      const body = state.sliceDoc(from.from, to.to);
      const insert = "```\n" + body + "\n```";
      return {
        changes: { from: from.from, to: to.to, insert },
        range: body ? EditorSelection.range(from.from + 4, from.from + 4 + body.length) : EditorSelection.cursor(from.from + 4),
      };
    }),
  );
  view.focus();
  return true;
};

export const insertRule: Cmd = (view) => {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const insert = (line.text.trim() ? "\n\n" : "") + "---\n\n";
  view.dispatch({
    changes: { from: line.to, insert },
    selection: EditorSelection.cursor(line.to + insert.length),
    scrollIntoView: true,
  });
  view.focus();
  return true;
};

export const formatCommands: Record<string, Cmd> = {
  bold: toggleInline("**"),
  italic: toggleInline("*"),
  strike: toggleInline("~~"),
  highlight: toggleInline("=="),
  subscript: noSpaces(toggleInline("~")),
  superscript: noSpaces(toggleInline("^")),
  footnote: insertFootnote,
  definition: insertDefinition,
  heading_id: addHeadingId,
  code: toggleInline("`"),
  link: insertLink,
  paragraph: setHeading(0),
  h1: setHeading(1),
  h2: setHeading(2),
  h3: setHeading(3),
  quote: toggleLinePrefix("quote"),
  ul: toggleLinePrefix("ul"),
  ol: toggleLinePrefix("ol"),
  task: toggleLinePrefix("task"),
  codeblock: insertCodeBlock,
  table: insertTable,
  hr: insertRule,
};

/** Formatting states active at the main cursor, for toolbar highlighting. */
export function activeFormats(state: EditorState): Set<string> {
  const active = new Set<string>();
  const head = state.selection.main.head;
  const names: Record<string, string> = {
    StrongEmphasis: "bold",
    Emphasis: "italic",
    Strikethrough: "strike",
    Highlight: "highlight",
    Subscript: "subscript",
    Superscript: "superscript",
    InlineCode: "code",
    Link: "link",
    Blockquote: "quote",
    FencedCode: "codeblock",
    ATXHeading1: "h1",
    ATXHeading2: "h2",
    ATXHeading3: "h3",
  };
  for (let n: any = syntaxTree(state).resolveInner(head, -1); n; n = n.parent) {
    if (names[n.name]) active.add(names[n.name]);
    if (n.name === "BulletList") active.add(state.doc.lineAt(head).text.match(/^\s*[-*+] \[[ xX]\]/) ? "task" : "ul");
    if (n.name === "OrderedList") active.add("ol");
  }
  return active;
}

const TABLE_TEMPLATE = [
  "| Column 1 | Column 2 | Column 3 |",
  "| -------- | -------- | -------- |",
  "|          |          |          |",
  "|          |          |          |",
].join("\n");

export function insertTable(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  // Inside a list item / quote the table continues that container (`- item` → `  | … |`). A
  // thematic break (`* * *`) is no list item; a bare `>` gets its space (`>| a |` is no row).
  const prefix = THEMATIC_BREAK.test(line.text) ? "" : continuationPrefix(line.text).replace(/>$/, "> ");
  const table = prefix + TABLE_TEMPLATE.replace(/\n/g, "\n" + prefix);
  const container = prefix.trimEnd();
  // A blank quote line (`>`) already separates: keep it and start the table below it.
  const quoteOnly = /^[ \t]*>[ \t>]*$/.test(line.text);
  const blank = !line.text.trim();
  const before = quoteOnly ? "\n" : !blank ? "\n" + container + "\n" : line.number > 1 && state.doc.line(line.number - 1).text.trim() ? "\n" : "";
  // When the next line continues the same quote, the separating blank line must stay quoted (an
  // unquoted one would split the quote in two).
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : null;
  const after = next === null ? "\n\n" : container && next.startsWith(container) ? "\n" + container : "\n";
  const at = blank ? line.from : line.to;
  const start = at + before.length + prefix.length + 2; // inside the first header cell
  view.dispatch({
    changes: { from: at, to: line.to, insert: before + table + after },
    selection: EditorSelection.range(start, start + "Column 1".length),
    scrollIntoView: true,
  });
  // In the live editor the new table renders at once with its first header cell selected for typing.
  if (!editTableCell(view, start)) view.focus();
  return true;
}

/**
 * Prefix that continues the container a line sits in: its indentation and quote markers kept,
 * list markers turned into spaces (`> - | a |` → `>   `, `  | 1 |` → `  `).
 */
const continuationPrefix = (line: string) =>
  CONTAINER_PREFIX.exec(line)![0].replace(LIST_MARKER, (m) => " ".repeat(m.length));
/** A thematic break line (`* * *`, `- - -`, `___`): its `*`/`-` are not list markers. */
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_MARKER = /(?:[-*+]|\d{1,9}[.)])(?=[ \t])/g;
/** Indentation, quote markers and list markers (with the spaces after them) at a line's start. */
const CONTAINER_PREFIX = /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*[ \t]*/;

/** The Table node around `pos`, looking at both sides so a caret at the table's very start counts. */
function inTable(state: EditorState, pos: number) {
  for (const side of [-1, 1] as const) {
    for (let n: any = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) if (n.name === "Table") return n as { from: number; to: number };
  }
  return null;
}

/** Tab / Shift-Tab between table cells; Tab past the last cell adds a row. */
export function moveCell(dir: 1 | -1): Cmd {
  return (view) => {
    const { state } = view;
    const head = state.selection.main.head;
    const table = inTable(state, head);
    if (!table) return false;
    const doc = state.doc;
    const first = doc.lineAt(table.from).number;
    const last = doc.lineAt(table.to).number;
    // GFM's delimiter row is always the table's second line; body rows of dashes are data.
    const isDelimiter = (n: number) => n === first + 1;
    let line = doc.lineAt(head);
    let cells = tableCells(line.text, line.from, line.number === first);
    let index = cells.findIndex((c) => head <= c.to + 1);
    if (index < 0) index = cells.length - 1;
    index += dir;

    while (index < 0 || index >= cells.length || isDelimiter(line.number)) {
      const next = line.number + (index < 0 ? -1 : 1);
      if (next < first) return true;
      if (next > last) {
        // Append a fresh row shaped like the header (canonical `|   |` form) and land in its first
        // cell. The container prefix comes from the last row, not the header: the header may sit
        // on the list-marker line or not (`- item\n\n  | a |`), but the last row is always a
        // continuation line with exactly the indentation / quote markers the new row needs.
        const header = doc.line(first).text;
        const cols = tableCells(header, 0, true).length;
        if (!cols) return false;
        const prefix = continuationPrefix(line.text);
        const row = "\n" + prefix + "|" + "   |".repeat(cols);
        view.dispatch({ changes: { from: line.to, insert: row }, selection: { anchor: line.to + 1 + prefix.length + 2 }, scrollIntoView: true });
        return true;
      }
      const goingBack = index < 0;
      line = doc.line(next);
      cells = tableCells(line.text, line.from, line.number === first);
      if (isDelimiter(line.number)) {
        index = goingBack ? -1 : cells.length;
        continue;
      }
      index = goingBack ? cells.length - 1 : 0;
    }
    const cell = cells[index];
    view.dispatch({ selection: EditorSelection.range(cell.from, cell.to), scrollIntoView: true });
    return true;
  };
}

/** `text[^n]` at the caret plus a `[^n]: ` definition at the end of the document. */
export function insertFootnote(view: EditorView): boolean {
  const { state } = view;
  const doc = state.doc.toString();
  const used = [...doc.matchAll(/\[\^(\d+)\]/g)].map((m) => +m[1]);
  const n = used.length ? Math.max(...used) + 1 : 1;
  const ref = `[^${n}]`;
  const head = state.selection.main.to;
  const tail = doc.replace(/\s+$/, "");
  const sep = tail.length === 0 ? "" : /\[\^\d+\]:[^\n]*$/.test(tail) ? "\n" : "\n\n";
  const def = `${sep}${ref}: `;
  const trimFrom = tail.length; // drop trailing blank lines before appending
  // A caret in the trailing whitespace would put the reference inside the new definition.
  const refAt = Math.min(head, trimFrom);
  const changes = state.changes(
    refAt === trimFrom
      ? [{ from: trimFrom, to: doc.length, insert: ref + def }]
      : [
          { from: refAt, insert: ref },
          { from: trimFrom, to: doc.length, insert: def },
        ],
  );
  view.dispatch({ changes, selection: { anchor: changes.mapPos(doc.length, 1) }, scrollIntoView: true });
  view.focus();
  return true;
}

/** `Term` + `: Definition` (or a `: ` line under the current term). */
export function insertDefinition(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  if (line.text.trim()) {
    const insert = "\n: ";
    view.dispatch({ changes: { from: line.to, insert }, selection: { anchor: line.to + insert.length }, scrollIntoView: true });
  } else {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: "Term\n: Definition" },
      selection: EditorSelection.range(line.from, line.from + 4),
      scrollIntoView: true,
    });
  }
  view.focus();
  return true;
}

export const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[*_`~=^[\]()]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

/** Append ` {#slug}` to the ATX heading under the caret and select the slug. False off-heading. */
export function addHeadingId(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line.text);
  if (!m || /\{#[\w-]+\}$/.test(m[2])) return false;
  const slug = slugify(m[2]) || "section";
  const at = line.from + line.text.trimEnd().length;
  view.dispatch({
    changes: { from: at, to: line.to, insert: ` {#${slug}}` },
    selection: EditorSelection.range(at + 3, at + 3 + slug.length),
  });
  view.focus();
  return true;
}
