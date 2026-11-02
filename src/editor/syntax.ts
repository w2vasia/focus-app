import { BlockContext, Line, MarkdownConfig, Subscript, Superscript, Emoji, InlineContext } from "@lezer/markdown";
import { Tag, tags } from "@lezer/highlight";

/** Extended-syntax parser extensions on top of GFM (markdownguide.org/cheat-sheet). */

export const highlightTag = Tag.define();

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };
const EQUALS = 61;
const COLON = 58;
const BRACKET = 91;
const CARET = 94;

/** `==highlighted text==` */
const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: { "Highlight/...": highlightTag } },
    { name: "HighlightMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "Highlight",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== EQUALS || cx.char(pos + 1) !== EQUALS || cx.char(pos + 2) === EQUALS) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const spaceBefore = /\s|^$/.test(before);
        const spaceAfter = /\s|^$/.test(after);
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !spaceAfter, !spaceBefore);
      },
      after: "Emphasis",
    },
  ],
};

const FOOTNOTE_REF = /^\[\^([^\]\s]+)\]/;
const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:[ \t]*/;

/** `text[^1]` and `[^1]: The note.` */
const Footnote: MarkdownConfig = {
  defineNodes: [
    { name: "FootnoteRef", style: tags.special(tags.link) },
    { name: "FootnoteDefinition", block: true },
    { name: "FootnoteMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "FootnoteRef",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== BRACKET || cx.char(pos + 1) !== CARET) return -1;
        const m = FOOTNOTE_REF.exec(cx.slice(pos, cx.end));
        if (!m || cx.char(pos + m[0].length) === COLON) return -1;
        const end = pos + m[0].length;
        return cx.addElement(cx.elt("FootnoteRef", pos, end, [cx.elt("FootnoteMark", pos, pos + 2), cx.elt("FootnoteMark", end - 1, end)]));
      },
      before: "Link",
    },
  ],
  parseBlock: [
    {
      name: "FootnoteDefinition",
      parse(cx: BlockContext, line: Line) {
        const m = FOOTNOTE_DEF.exec(line.text.slice(line.pos));
        if (!m) return false;
        const start = cx.lineStart + line.pos;
        const contentStart = start + m[0].length;
        const children = [cx.elt("FootnoteMark", start, contentStart), ...cx.parser.parseInline(line.text.slice(line.pos + m[0].length), contentStart)];
        const end = cx.lineStart + line.text.length;
        cx.nextLine();
        cx.addElement(cx.elt("FootnoteDefinition", start, end, children));
        return true;
      },
      endLeaf: (_cx: BlockContext, line: Line) => FOOTNOTE_DEF.test(line.text.slice(line.pos)),
      before: "Blockquote",
    },
  ],
};

const DEFINITION = /^:[ \t]+/;

/** `Term` followed by `: Definition` on the next line. */
const DefinitionList: MarkdownConfig = {
  defineNodes: [
    { name: "DefinitionDescription", block: true },
    { name: "DefinitionMark", style: tags.processingInstruction },
  ],
  parseBlock: [
    {
      name: "DefinitionDescription",
      parse(cx: BlockContext, line: Line) {
        const m = DEFINITION.exec(line.text.slice(line.pos));
        if (!m) return false;
        const start = cx.lineStart + line.pos;
        const contentStart = start + m[0].length;
        const children = [cx.elt("DefinitionMark", start, start + 1), ...cx.parser.parseInline(line.text.slice(line.pos + m[0].length), contentStart)];
        const end = cx.lineStart + line.text.length;
        cx.nextLine();
        cx.addElement(cx.elt("DefinitionDescription", start, end, children));
        return true;
      },
      // A definition line ends the term paragraph instead of continuing it.
      endLeaf: (_cx: BlockContext, line: Line) => DEFINITION.test(line.text.slice(line.pos)),
      before: "Blockquote",
    },
  ],
};

export const extendedSyntax = [Highlight, Footnote, DefinitionList, Subscript, Superscript, Emoji];
