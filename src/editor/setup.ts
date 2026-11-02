import { EditorState, Extension } from "@codemirror/state";
import { EditorView, drawSelection, keymap, dropCursor, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting, indentOnInput } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { livePreview } from "./livePreview";
import { focusMode, FocusConfig } from "./focusMode";
import { extendedSyntax, highlightTag } from "./syntax";
import { tableEditing } from "./tables";
import { emojiCompletion } from "./emoji";
import { completionKeymap } from "@codemirror/autocomplete";
import { moveCell } from "./commands";
import { Prec } from "@codemirror/state";

const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "650" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--muted)" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--syntax)" },
  { tag: [t.url, t.link], color: "var(--muted)" },
  { tag: t.quote, color: "var(--muted)" },
  { tag: t.monospace, fontFamily: "var(--mono)" },
  { tag: highlightTag, backgroundColor: "var(--mark)", borderRadius: "3px", boxShadow: "inset 0 -1.5px 0 var(--mark-edge)" },
  // Code fence languages
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--code-keyword)" },
  { tag: [t.string, t.regexp, t.special(t.string)], color: "var(--code-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--code-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.typeName, t.className], color: "var(--code-fn)" },
]);

export function createState(doc: string, focus: Partial<FocusConfig>, extra: Extension = []): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      EditorView.lineWrapping,
      EditorState.allowMultipleSelections.of(true),
      markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true, extensions: extendedSyntax }),
      syntaxHighlighting(highlight),
      search({ top: true }),
      highlightSelectionMatches(),
      Prec.high(keymap.of([
        { key: "Tab", run: moveCell(1) },
        { key: "Shift-Tab", run: moveCell(-1) },
      ])),
      emojiCompletion,
      keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on", autocapitalize: "sentences", "aria-label": "Document" }),
      placeholder("Start writing…"),
      livePreview,
      tableEditing,
      focusMode(focus),
      extra,
    ],
  });
}
