import { readFileSync } from "node:fs";
import { markdownLanguage, markdown } from "@codemirror/lang-markdown";
import { extendedSyntax } from "../src/editor/syntax.ts";
const lang = markdown({ base: markdownLanguage, extensions: extendedSyntax }).language;
const doc = readFileSync(new URL("./cheat-sheet.md", import.meta.url), "utf8");
const tree = lang.parser.parse(doc);
const seen = new Map<string, string>();
tree.iterate({ enter: (n) => { if (!seen.has(n.name)) seen.set(n.name, doc.slice(n.from, n.to).split("\n")[0].slice(0, 40)); } });
const want = ["ATXHeading1","ATXHeading2","ATXHeading3","StrongEmphasis","Emphasis","Blockquote","OrderedList","BulletList","InlineCode","HorizontalRule","Link","Image","Table","FencedCode","FootnoteRef","FootnoteDefinition","DefinitionDescription","Strikethrough","Task","Emoji","Highlight","Subscript","Superscript"];
let fail = 0;
for (const w of want) { const ok = seen.has(w); if (!ok) fail++; console.log(`${ok ? "✓" : "✗"} ${w.padEnd(22)} ${seen.get(w) ?? ""}`); }
// footnote def must not be swallowed as a link reference / paragraph
console.log("LinkReference present:", seen.has("LinkReference"));
process.exit(fail);
