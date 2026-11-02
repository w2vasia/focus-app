import { autocompletion, CompletionContext, CompletionResult, startCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { search } from "node-emoji";

const MAX_RESULTS = 40;
const STARTERS = /^(smile|joy|heart|thumbsup|tada|fire|rocket|eyes|sparkles|white_check_mark)$/;

/** `:jo` → 😂 joy, 🕹️ joystick … ; inserts the `:shortcode:` (rendered as a glyph by live preview). */
export function emojiSource(ctx: CompletionContext): CompletionResult | null {
  if (inCode(ctx)) return null; // ":name" in code is code, not an emoji
  const word = ctx.matchBefore(/(?:^|(?<=[\s(]))[:][\w+-]*$/);
  if (!word) return null;
  const query = word.text.slice(1).toLowerCase();
  if (query.length < 2 && !ctx.explicit) return null;
  const hits = search(query ? query : STARTERS)
    .sort((a, b) => Number(!a.name.startsWith(query)) - Number(!b.name.startsWith(query)) || a.name.length - b.name.length)
    .slice(0, MAX_RESULTS);
  if (!hits.length) return null;
  return {
    from: word.from,
    options: hits.map((h) => ({ label: `:${h.name}:`, displayLabel: `${h.emoji}  ${h.name}`, apply: `:${h.name}:` })),
    validFor: /^:[\w+-]*$/,
  };
}

const CODE_NODES = new Set(["FencedCode", "CodeBlock", "InlineCode", "CodeText", "HTMLBlock"]);

function inCode(ctx: CompletionContext) {
  for (let n: any = syntaxTree(ctx.state).resolveInner(ctx.pos, -1); n; n = n.parent) if (CODE_NODES.has(n.name)) return true;
  return false;
}

export const emojiCompletion = autocompletion({ override: [emojiSource], icons: false, activateOnTyping: true });

/** Format → Emoji…: type a colon and open the picker. */
export function insertEmoji(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  const before = view.state.sliceDoc(from - 1, from);
  const insert = before && !/\s|\(/.test(before) ? " :" : ":";
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
  view.focus();
  startCompletion(view);
  return true;
}
