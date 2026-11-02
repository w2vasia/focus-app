import { Range } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { SyntaxNodeRef } from "@lezer/common";
import { get as emoji } from "node-emoji";
import { allowRemote, canLoadRemote, isRemote, remoteAllowed, remoteImagesAllowed } from "./remoteImages";
import { BulletWidget, CheckboxWidget, ImageWidget, RuleWidget, TextWidget } from "./widgets";

let resolveImage: (src: string) => string = (src) => src;

/** Maps an image reference (possibly relative to the open file) to a loadable URL. */
export function setImageResolver(fn: (src: string) => string) {
  resolveImage = fn;
}

/** Loadable URL of an image node's raw URL text. */
function imageSrc(rawUrl: string): string {
  const raw = rawUrl.replace(/^<|>$/g, "");
  try {
    return resolveImage(raw);
  } catch (e) {
    console.warn("image path not resolvable", raw, e); // never let one image break the preview
    return raw;
  }
}

/** A code fence opener/closer line; group 1 is the fence (`` ``` `` / `~~~`, any length ≥ 3). */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** `![alt](url` in raw text; the URL may hold one level of balanced parens (`a_(b).png`). */
const TAIL_IMAGE = /!\[(?:[^\]\\\n]|\\.)*\]\(\s*(<[^>\n]*>|(?:[^\s()]|\([^\s()]*\))+)/g;

/**
 * Command: load every remote (https) image in the document, the keyboard/menu equivalent of
 * clicking each "Load image" placeholder. False when there is nothing to load.
 */
export function loadRemoteImages(view: EditorView, budgetMs = 200): boolean {
  const { state } = view;
  const end = state.doc.length;
  const tree = ensureSyntaxTree(state, end, budgetMs) ?? syntaxTree(state);
  const found = new Set<string>();
  const consider = (rawUrl: string) => {
    const src = imageSrc(rawUrl);
    if (isRemote(src) && canLoadRemote(src) && !remoteAllowed(src)) found.add(src);
  };
  const parsed = Math.min(tree.length, end);
  tree.iterate({
    to: parsed,
    enter(node) {
      if (node.name !== "Image") return;
      const url = node.node.getChild("URL");
      if (url) consider(state.sliceDoc(url.from, url.to));
      return false;
    },
  });
  // A huge document may not be fully parsed within the budget: scan the rest of the text so the
  // command still finds every image (fenced code is skipped; an image inside an indented code
  // block is allowed too, which is harmless: allowing only matters where a placeholder is shown).
  if (parsed < end) {
    const startLine = state.doc.lineAt(parsed);
    // Skip fenced code (images there are literal text). The scan may start inside a fence the
    // parser already opened: take its opener from the tree.
    let fence: string | null = null;
    for (let n: any = tree.resolveInner(startLine.from, 1); n; n = n.parent) {
      if (n.name === "FencedCode" && n.from < startLine.from) {
        fence = FENCE.exec(state.doc.lineAt(n.from).text)?.[1] ?? null;
        break;
      }
    }
    let chunk: string[] = [];
    const flush = () => {
      for (const m of chunk.join("\n").matchAll(TAIL_IMAGE)) consider(m[1]);
      chunk = [];
    };
    for (let i = startLine.number; i <= state.doc.lines; i++) {
      const text = state.doc.line(i).text;
      const f = FENCE.exec(text)?.[1];
      if (fence) {
        // Closes on the same character, at least as long, with nothing after it.
        if (f && f[0] === fence[0] && f.length >= fence.length && !text.trim().slice(f.length).trim()) fence = null;
      } else if (f) {
        flush();
        fence = f;
      } else chunk.push(text);
    }
    flush();
  }
  if (!found.size) return false;
  found.forEach(allowRemote);
  view.dispatch({ effects: remoteImagesAllowed.of(null) });
  return true;
}

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });
const line = (cls: string) => Decoration.line({ class: cls });
const mark = (cls: string, attrs?: Record<string, string>) => Decoration.mark({ class: cls, attributes: attrs });

/**
 * Live preview must never take the editor down: if *building* the decorations throws (a bug in a
 * node handler, a resolver error), show plain text for this update. This does not cover errors
 * CodeMirror raises later while *applying* the set, e.g. the RangeError for a replace decoration
 * that crosses a line break: that throws outside this function, so only the guard in `add()`
 * below prevents it.
 */
function build(view: EditorView): DecorationSet {
  try {
    return buildDecorations(view);
  } catch (e) {
    console.error("live preview disabled for this update", e);
    return Decoration.none;
  }
}

export function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  // Lines touched by the selection, as [from, to] spans widened to whole lines. Selection ranges
  // are sorted and disjoint, so a binary search answers "is this line being edited?" without
  // visiting every selected line (⌘A on a 200k-line document used to cost ~38 ms per rebuild).
  const active: number[] = [];
  if (view.hasFocus) {
    for (const r of state.selection.ranges) {
      const from = doc.lineAt(r.from).from;
      const to = doc.lineAt(r.to).to;
      // Two ranges on one line share it: merge so the spans stay sorted and disjoint.
      if (active.length && from <= active[active.length - 1]) active[active.length - 1] = Math.max(to, active[active.length - 1]);
      else active.push(from, to);
    }
  }
  /** Whether the line holding `pos` is touched by the selection (pos lies in a whole-line span). */
  const isActive = (pos: number) => {
    let lo = 0;
    let hi = active.length / 2 - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pos < active[2 * mid]) hi = mid - 1;
      else if (pos > active[2 * mid + 1]) lo = mid + 1;
      else return true;
    }
    return false;
  };
  const decos: Range<Decoration>[] = [];
  const add = (d: Decoration, from: number, to = from) => {
    // Plugins may not replace line breaks: CodeMirror throws when it applies such a set (after
    // build() returned, so its try/catch can't help). This check is the only protection, e.g.
    // for an image whose alt text wraps.
    if (d.point && to > from && doc.lineAt(from).number !== doc.lineAt(to).number) return;
    decos.push(d.range(from, to));
  };
  /** Hide [from, to) plus one trailing space, unless the line is being edited. */
  const conceal = (from: number, to: number, withSpace = false) => {
    if (isActive(from)) return;
    if (withSpace && state.sliceDoc(to, to + 1) === " ") to++;
    if (to > from) add(hide, from, to);
  };
  const eachLine = (from: number, to: number, cls: string) => {
    // Only lines in view: a 20k-line code block shouldn't decorate 20k lines per keystroke.
    from = Math.max(from, view.viewport.from);
    to = Math.min(to, view.viewport.to);
    for (let pos = from; pos <= to; ) {
      const l = doc.lineAt(pos);
      add(line(cls), l.from);
      pos = l.to + 1;
    }
  };

  const { from, to } = view.viewport;
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node: SyntaxNodeRef) => {
      const name = node.name;
      const parent = node.node.parent?.name ?? "";

      const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
      if (heading) {
        const l = doc.lineAt(node.from);
        add(line(`cm-h${heading[1]}`), l.from);
        // The blank line after a heading is drawn short, so the heading binds to its text.
        if (l.number < doc.lines && !doc.line(l.number + 1).text.trim()) add(line("cm-heading-gap"), doc.line(l.number + 1).from);
        // Custom heading id: `## Title {#custom-id}`
        const id = /\s*\{#[\w-]+\}\s*$/.exec(l.text);
        if (id && name.startsWith("ATX")) {
          const from = l.from + id.index;
          if (isActive(from)) add(mark("cm-heading-id"), from, l.to);
          else add(hide, from, l.to);
        }
        return;
      }

      switch (name) {
        case "HeaderMark":
          if (parent.startsWith("ATX")) conceal(node.from, node.to, true);
          return;

        case "EmphasisMark":
        case "StrikethroughMark":
        case "HighlightMark":
        case "SubscriptMark":
        case "SuperscriptMark":
          conceal(node.from, node.to);
          return;

        case "Highlight":
          add(mark("cm-highlight"), node.from, node.to);
          return;
        case "Subscript":
          add(mark("cm-sub"), node.from, node.to);
          return;
        case "Superscript":
          add(mark("cm-sup"), node.from, node.to);
          return;

        case "Emoji": {
          const glyph = emoji(state.sliceDoc(node.from + 1, node.to - 1));
          if (glyph && !isActive(node.from)) add(Decoration.replace({ widget: new TextWidget(glyph, "cm-emoji") }), node.from, node.to);
          return;
        }

        case "FootnoteRef":
          if (isActive(node.from)) add(mark("cm-footnote-ref"), node.from, node.to);
          else add(Decoration.replace({ widget: new TextWidget(state.sliceDoc(node.from + 2, node.to - 1), "cm-footnote-ref") }), node.from, node.to);
          return false;

        case "FootnoteDefinition": {
          add(line("cm-footnote-def"), doc.lineAt(node.from).from);
          const label = node.node.getChild("FootnoteMark");
          if (label) add(mark("cm-footnote-label"), label.from, label.to);
          return;
        }

        case "DefinitionDescription": {
          add(line("cm-dd"), doc.lineAt(node.from).from);
          const term = node.node.prevSibling;
          if (term?.name === "Paragraph") add(line("cm-dt"), doc.lineAt(term.to).from);
          return;
        }

        case "DefinitionMark":
          conceal(node.from, node.to, true);
          return;

        case "InlineCode":
          add(mark("cm-inline-code"), node.from, node.to);
          return;

        case "CodeMark":
          if (parent === "InlineCode") conceal(node.from, node.to);
          else add(mark("cm-fence"), node.from, node.to);
          return;

        case "FencedCode":
        case "CodeBlock": {
          eachLine(node.from, node.to, "cm-codeblock");
          add(line("cm-codeblock-first"), doc.lineAt(node.from).from);
          add(line("cm-codeblock-last"), doc.lineAt(node.to).from);
          return;
        }

        case "Blockquote":
          eachLine(node.from, node.to, "cm-quote");
          return;

        case "QuoteMark":
          conceal(node.from, node.to, true);
          return;

        case "ListMark": {
          if (isActive(node.from) || node.node.parent?.parent?.name !== "BulletList") return;
          const isTask = node.node.nextSibling?.name === "Task";
          if (isTask) conceal(node.from, node.to, true);
          else add(bullet, node.from, node.to);
          return;
        }

        case "TaskMarker": {
          const checked = state.sliceDoc(node.from + 1, node.from + 2).toLowerCase() === "x";
          const task = node.node.parent!;
          if (checked && node.to < task.to) add(mark("cm-task-done"), node.to, task.to);
          if (!isActive(node.from)) {
            add(Decoration.replace({ widget: new CheckboxWidget(checked) }), node.from, node.to);
          }
          return;
        }

        case "HorizontalRule":
          add(line("cm-hr-line"), doc.lineAt(node.from).from);
          if (!isActive(node.from)) add(rule, node.from, node.to);
          return;

        case "Image": {
          if (isActive(node.from)) return;
          const url = node.node.getChild("URL");
          if (!url) return;
          const raw = state.sliceDoc(node.from, node.to);
          const alt = raw.slice(2, raw.indexOf("]"));
          const src = imageSrc(state.sliceDoc(url.from, url.to));
          add(Decoration.replace({ widget: new ImageWidget(src, alt) }), node.from, node.to);
          return false;
        }

        case "Link": {
          const marks = node.node.getChildren("LinkMark");
          const url = node.node.getChild("URL");
          if (marks.length < 2) return;
          const href = url ? state.sliceDoc(url.from, url.to).replace(/^<|>$/g, "") : "";
          if (marks[1].from > marks[0].to) {
            add(mark("cm-link", href ? { "data-href": href } : undefined), marks[0].to, marks[1].from);
          }
          // Hide "[" and everything from "]" onward when it is an inline link.
          if (url) {
            conceal(marks[0].from, marks[0].to);
            conceal(marks[1].from, node.to);
          }
          return;
        }

        case "URL":
          if (parent !== "Link" && parent !== "Image" && parent !== "LinkReference") {
            add(mark("cm-link", { "data-href": state.sliceDoc(node.from, node.to) }), node.from, node.to);
          }
          return;
      }
    },
  });
  return Decoration.set(decos, true);
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      const imagesAllowed = u.transactions.some((tr) => tr.effects.some((e) => e.is(remoteImagesAllowed)));
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || imagesAllowed || syntaxTree(u.state) !== syntaxTree(u.startState)) {
        this.decorations = build(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(e) {
        const link = (e.target as HTMLElement).closest<HTMLElement>("[data-href]");
        if (!link || !(e.metaKey || e.ctrlKey)) return false;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("open-link", { detail: link.dataset.href }));
        return true;
      },
    },
  },
);
