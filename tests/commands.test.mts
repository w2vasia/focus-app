import { EditorSelection, EditorState, TransactionSpec } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { CompletionContext } from "@codemirror/autocomplete";
import { formatCommands } from "../src/editor/commands.ts";
import { extendedSyntax } from "../src/editor/syntax.ts";
import { emojiSource } from "../src/editor/emoji.ts";

/** Minimal stand-in for EditorView: enough for commands that read state and dispatch. */
function fakeView(doc: string, anchor: number, head = anchor) {
  const view: any = {
    state: EditorState.create({ doc, selection: { anchor, head }, extensions: markdown({ base: markdownLanguage, extensions: extendedSyntax }) }),
    dispatch(spec: TransactionSpec) {
      view.state = view.state.update(spec).state;
      ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    },
    focus() {},
  };
  ensureSyntaxTree(view.state, doc.length, 5000);
  return view;
}
const text = (v: any) => v.state.doc.toString();
const sel = (v: any) => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
let failed = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

// H4: unwrapping with the caret on/after the closing marker must not throw or misplace the selection
let v = fakeView("**bold**", 8);
formatCommands.bold(v);
check("unwrap bold, caret after closing **", text(v) === "bold" && v.state.selection.main.head === 4, [text(v), v.state.selection.main.head]);
v = fakeView("**bold** xy", 8);
formatCommands.bold(v);
check("unwrap bold before more text", text(v) === "bold xy" && v.state.selection.main.empty && v.state.selection.main.head === 4, [text(v), v.state.selection.main.anchor, v.state.selection.main.head]);
v = fakeView("**bold**", 3, 5);
formatCommands.bold(v);
check("unwrap bold keeps inner selection", text(v) === "bold" && sel(v) === "ol", [text(v), sel(v)]);

// L4: numbering ignores blank lines; formatting inside a word wraps the word
v = fakeView("a\n\nc", 0, 4);
formatCommands.ol(v);
check("numbered list skips blank lines", text(v) === "1. a\n\n2. c", text(v));
v = fakeView("**bold**", 4);
formatCommands.italic(v);
check("italic inside bold wraps the word", text(v) === "***bold***", text(v));
v = fakeView("plain word here", 7);
formatCommands.bold(v);
check("bold with caret in a word wraps it", text(v) === "plain **word** here" && v.state.selection.main.head === 9, [text(v), v.state.selection.main.head]);

// R2-L4 (a): caret at a word edge inside bold must not split the bold
v = fakeView("**bold text**", 6); // **bold| text**
formatCommands.italic(v);
check("italic at word end inside bold wraps the word", text(v) === "***bold* text**" && v.state.selection.main.head === 7, [text(v), v.state.selection.main.head]);
v = fakeView("**bold**", 2); // **|bold**
formatCommands.italic(v);
check("italic at word start inside bold wraps the word", text(v) === "***bold***" && v.state.selection.main.head === 3, [text(v), v.state.selection.main.head]);
v = fakeView("~~some words~~", 6); // ~~some| words~~
formatCommands.bold(v);
check("bold at word end inside strike wraps the word", text(v) === "~~**some** words~~", text(v));
v = fakeView("plain word", 5); // word end outside formatting keeps the plain insert
formatCommands.bold(v);
check("bold at a plain word end still inserts an empty pair", text(v) === "plain**** word" && v.state.selection.main.head === 7, [text(v), v.state.selection.main.head]);

// R2-L4 (b): no word-wrap inside a link URL or inline code
v = fakeView("see [site](https://example.com/page) now", 22); // inside "example"
formatCommands.bold(v);
check("bold inside a link URL leaves the URL intact", text(v).includes("](https://example.com/page)"), text(v));
v = fakeView("run `npm install` now", 11); // ins|tall
formatCommands.bold(v);
check("bold inside inline code doesn't wrap the word", !text(v).includes("**install**"), text(v));
v = fakeView("```\nlet value = 1\n```", 10); // val|ue in a fenced block
formatCommands.italic(v);
check("italic inside a code block doesn't wrap the word", !text(v).includes("*value*"), text(v));

// R2-L4 (c): two carets in one word wrap it once
v = fakeView("hello world", 1);
v.state = EditorState.create({ doc: "hello world", selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3)]), extensions: [markdown({ base: markdownLanguage, extensions: extendedSyntax }), EditorState.allowMultipleSelections.of(true)] });
formatCommands.bold(v);
check("two carets in one word wrap it once", text(v) === "**hello** world", text(v));
check("both carets kept inside the word", v.state.selection.ranges.map((r: any) => r.head).join() === "3,5", v.state.selection.ranges.map((r: any) => r.head));

// Subscript / superscript wrap and unwrap
v = fakeView("H2O", 1, 2);
formatCommands.subscript(v);
check("subscript wraps", text(v) === "H~2~O", text(v));
formatCommands.subscript(v);
check("subscript unwraps", text(v) === "H2O", text(v));
check("subscript refuses spaces", formatCommands.subscript(fakeView("so fun", 0, 6)) === false);
v = fakeView("X2", 1, 2);
formatCommands.superscript(v);
check("superscript wraps", text(v) === "X^2^", text(v));

// Footnotes number after the highest existing one and append a definition
v = fakeView("One[^1] two.\n\n[^1]: First.\n", 11);
formatCommands.footnote(v);
check("footnote inserts next number", text(v).startsWith("One[^1] two[^2]."), text(v));
check("footnote definition appended after last", text(v).endsWith("[^1]: First.\n[^2]: "), text(v));
check("caret lands in definition", v.state.selection.main.head === v.state.doc.length);
v = fakeView("Plain", 5);
formatCommands.footnote(v);
check("first footnote", text(v) === "Plain[^1]\n\n[^1]: ", text(v));

// H6: caret in trailing whitespace must not put the reference inside the definition
v = fakeView("Text\n", 5);
formatCommands.footnote(v);
check("footnote with caret on empty last line", text(v) === "Text[^1]\n\n[^1]: " && v.state.selection.main.head === v.state.doc.length, text(v));
v = fakeView("Text  ", 6);
formatCommands.footnote(v);
check("footnote with caret after trailing spaces", text(v) === "Text[^1]\n\n[^1]: ", text(v));

// Definition list
v = fakeView("term", 2);
formatCommands.definition(v);
check("definition under term", text(v) === "term\n: " && v.state.selection.main.head === 7, text(v));
v = fakeView("", 0);
formatCommands.definition(v);
check("definition template", text(v) === "Term\n: Definition" && sel(v) === "Term", text(v));

// Heading ID
v = fakeView("### My Great Heading", 5);
check("heading id added", formatCommands.heading_id(v) && text(v) === "### My Great Heading {#my-great-heading}", text(v));
check("heading id slug selected", sel(v) === "my-great-heading", sel(v));
check("no second id", formatCommands.heading_id(v) === false);
check("not a heading", formatCommands.heading_id(fakeView("plain", 1)) === false);

// Emoji completion
const state = EditorState.create({ doc: "So funny :jo" });
const res = emojiSource(new CompletionContext(state, state.doc.length, false));
check("emoji completes :jo → :joy:", Boolean(res?.options.some((o) => o.label === ":joy:")), res?.options.slice(0, 3).map((o) => o.label));
const codeState = EditorState.create({ doc: "```ruby\nputs :na", extensions: markdown({ base: markdownLanguage }) });
ensureSyntaxTree(codeState, codeState.doc.length, 5000);
check("no emoji popup inside a code block", emojiSource(new CompletionContext(codeState, codeState.doc.length, false)) === null);
// closed inline code with a space before the colon, so only the in-code check can stop it
const inlineState = EditorState.create({ doc: "use `x :sm` here", extensions: markdown({ base: markdownLanguage }) });
ensureSyntaxTree(inlineState, inlineState.doc.length, 5000);
check("no emoji popup inside inline code", emojiSource(new CompletionContext(inlineState, "use `x :sm".length, false)) === null);
const proseState = EditorState.create({ doc: "use x :sm here", extensions: markdown({ base: markdownLanguage }) });
check("same text outside code does complete", emojiSource(new CompletionContext(proseState, "use x :sm".length, false)) !== null);
const time = EditorState.create({ doc: "at 10:30" });
check("no emoji popup for times", emojiSource(new CompletionContext(time, time.doc.length, false)) === null);

// R3-L2 (a): a caret touching (not inside) inline code or a bare URL is plain text
v = fakeView("`code` x", 6); // `code`|
formatCommands.bold(v);
check("bold right after inline code inserts a pair", text(v) === "`code`**** x" && v.state.selection.main.head === 8, [text(v), v.state.selection.main.head]);
v = fakeView("x `code`", 2); // |`code`
formatCommands.italic(v);
check("italic right before inline code inserts a pair", text(v) === "x **`code`" && v.state.selection.main.head === 3, [text(v), v.state.selection.main.head]);
v = fakeView("see http://x.com y", 16); // URL|
formatCommands.bold(v);
check("bold right after a bare URL inserts a pair", text(v) === "see http://x.com**** y", text(v));
v = fakeView("see http://x.com y", 10);
formatCommands.bold(v);
check("bold strictly inside a bare URL stays a no-op", text(v) === "see http://x.com y", text(v));
v = fakeView("[a](http://x.com)", 16); // destination end, still inside the link's ( )
formatCommands.bold(v);
check("bold at the end of a link destination stays a no-op", text(v) === "[a](http://x.com)", text(v));
v = fakeView("```\nx\n```", 9); // end of the closing fence
formatCommands.bold(v);
check("bold at a closing code fence stays a no-op", text(v) === "```\nx\n```", text(v));

// R4-M8: a caret at a bare URL / code span edge inside formatting must not wrap part of it
const emphasisTree = (st: EditorState) => { const out: string[] = []; ensureSyntaxTree(st, st.doc.length, 5000)!.iterate({ enter: (n) => { if (/Emphasis$|^URL$|^InlineCode$/.test(n.name)) out.push(`${n.name}:${st.sliceDoc(n.from, n.to)}`); } }); return out; };
const m8: [string, "bold" | "italic"][] = [
  ["**see https://x.com|**", "italic"],
  ["**|https://x.com**", "italic"],
  ["*see https://x.com|*", "bold"],
  ["*|https://x.com y*", "bold"],
  ["**see `code`|**", "italic"],
  ["~~go https://x.com|~~", "bold"],
];
for (const [src, cmd] of m8) {
  const doc = src.replace("|", "");
  v = fakeView(doc, src.indexOf("|"));
  const before = emphasisTree(v.state);
  formatCommands[cmd](v);
  const url = /https:\/\/x\.com|`code`/.exec(doc)![0];
  const literals = (l: string[]) => JSON.stringify(l.filter((n) => /^(URL|InlineCode):/.test(n)));
  check(`${cmd} at a literal edge in \`${src}\` keeps it whole`, text(v).includes(url) && literals(emphasisTree(v.state)) === literals(before), [text(v), emphasisTree(v.state)]);
}
v = fakeView("**see https://x.com**", 19);
formatCommands.italic(v);
check("…bold+URL edge: no change, caret kept", text(v) === "**see https://x.com**" && v.state.selection.main.head === 19, [text(v), v.state.selection.main.head]);
v = fakeView("*see https://x.com*", 18);
formatCommands.bold(v);
check("…italic+URL edge: no change (no `*****`)", text(v) === "*see https://x.com*", text(v));
v = fakeView("**see `code`**", 12); // **see `code`|**: no word at the caret, plain `__` pair
formatCommands.italic(v);
check("…bold+code span edge: code kept, `__` pair inserted", text(v) === "**see `code`__**" && JSON.stringify(emphasisTree(v.state)) === '["StrongEmphasis:**see `code`__**","InlineCode:`code`"]', [text(v), emphasisTree(v.state)]);
v = fakeView("**bold** https://x.com", 6); // a plain word inside bold still wraps
formatCommands.italic(v);
check("…word edge inside bold away from the URL still wraps", text(v) === "***bold*** https://x.com", text(v));

// R3-L2 (b): an empty italic pair inside bold must not be `**` (which would close the bold)
v = fakeView("**a  b**", 4); // **a |  b**
formatCommands.italic(v);
check("italic between spaces inside bold inserts `__`", text(v) === "**a __ b**" && v.state.selection.main.head === 5, [text(v), v.state.selection.main.head]);
v.dispatch({ changes: { from: 5, insert: "x" } });
const strong = (st: EditorState) => { const out: string[] = []; ensureSyntaxTree(st, st.doc.length, 5000)!.iterate({ enter: (n) => { if (/Emphasis$/.test(n.name)) out.push(n.name); } }); return out; };
check("…typing into it gives italic inside bold", JSON.stringify(strong(v.state)) === '["StrongEmphasis","Emphasis"]', [text(v), strong(v.state)]);
v = fakeView("a  b", 2);
formatCommands.italic(v);
check("italic between spaces outside bold still inserts `**`", text(v) === "a ** b" && v.state.selection.main.head === 3, [text(v), v.state.selection.main.head]);

process.exit(failed);
