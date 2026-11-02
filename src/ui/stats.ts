import { EditorState, Text } from "@codemirror/state";

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;
const WORDS_PER_MINUTE = 230;
const fmt = new Intl.NumberFormat();
const $ = (id: string) => document.getElementById(id)!;

export function countWords(text: string) {
  return text.match(WORD)?.length ?? 0;
}

const plural = (n: number, one: string, many = one + "s") => `${fmt.format(n)} ${n === 1 ? one : many}`;

/** Bottom bar: file · lines | font · theme | words · chars · reading time. */
export class StatusBar {
  private center = document.querySelector<HTMLElement>("#statusbar .center")!;
  private toastEl: HTMLElement | null = null;
  private toastTimer = 0;

  /** Totals are cached per document version, so moving the caret doesn't recount everything. */
  private counted: { doc: Text; words: number } | null = null;

  update(state: EditorState, fileName: string) {
    if (this.counted?.doc !== state.doc) this.counted = { doc: state.doc, words: countWords(state.doc.toString()) };
    const total = this.counted.words;
    const selected = state.selection.ranges.reduce((n, r) => n + (r.empty ? 0 : countWords(state.sliceDoc(r.from, r.to))), 0);
    $("st-file").textContent = fileName;
    $("st-lines").textContent = plural(state.doc.lines, "line");
    $("st-words").textContent = selected ? `${fmt.format(selected)} of ${plural(total, "word")}` : plural(total, "word");
    $("st-chars").textContent = plural(state.doc.length, "char");
    $("st-read").textContent = `${Math.max(1, Math.round(total / WORDS_PER_MINUTE))} min read`;
  }

  setModes(mode: string, font: string, theme: string) {
    $("st-mode").textContent = mode;
    $("st-font").textContent = font;
    $("st-theme").textContent = theme;
  }

  /** Brief message in the centre slot, then back to the mode labels. */
  toast(message: string) {
    clearTimeout(this.toastTimer);
    this.toastEl?.remove();
    const el = document.createElement("span");
    el.className = "toast";
    el.textContent = message;
    for (const child of this.center.children) (child as HTMLElement).hidden = true;
    this.center.appendChild(el);
    this.toastEl = el;
    this.toastTimer = window.setTimeout(() => {
      el.remove();
      this.toastEl = null;
      for (const child of this.center.children) (child as HTMLElement).hidden = false;
    }, 2200);
  }
}
