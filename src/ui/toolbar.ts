import { icon } from "./icons";

type Button = { id: string; title: string } | "|";

const BUTTONS: Button[] = [
  { id: "paragraph", title: "Paragraph ⌘0" },
  { id: "h1", title: "Heading 1 ⌘1" },
  { id: "h2", title: "Heading 2 ⌘2" },
  { id: "h3", title: "Heading 3 ⌘3" },
  "|",
  { id: "bold", title: "Bold ⌘B" },
  { id: "italic", title: "Italic ⌘I" },
  { id: "strike", title: "Strikethrough ⇧⌘X" },
  { id: "highlight", title: "Highlight ⇧⌘H" },
  { id: "subscript", title: "Subscript ⌃⌘-" },
  { id: "superscript", title: "Superscript ⌃⌘=" },
  { id: "code", title: "Inline Code ⌘E" },
  { id: "link", title: "Link ⌘K" },
  "|",
  { id: "quote", title: "Quote ⇧⌘." },
  { id: "ul", title: "Bullet List ⇧⌘8" },
  { id: "ol", title: "Numbered List ⇧⌘7" },
  { id: "task", title: "Task List ⇧⌘9" },
  { id: "codeblock", title: "Code Block ⌥⌘C" },
  { id: "table", title: "Table ⌥⌘T" },
  { id: "hr", title: "Divider ⇧⌘-" },
  "|",
  { id: "footnote", title: "Footnote ⌥⌘N" },
  { id: "definition", title: "Definition ⌥⌘L" },
  { id: "heading_id", title: "Heading ID ⌥⌘I" },
  { id: "emoji", title: "Emoji" },
];

/** Full formatting bar (blocks + inline). Shown only when pinned (⇧⌘T); selections get the bubble. */
export class Toolbar {
  private pinned = false;
  private buttons = new Map<string, HTMLButtonElement>();

  constructor(private el: HTMLElement, onCommand: (id: string) => void) {
    for (const b of BUTTONS) {
      if (b === "|") {
        el.insertAdjacentHTML("beforeend", '<span class="sep" role="separator" aria-orientation="vertical"></span>');
        continue;
      }
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.innerHTML = icon(b.id.replace("_", "-"));
      btn.title = b.title;
      btn.setAttribute("aria-label", b.title.replace(/\s\S*⌘.*$/, ""));
      btn.setAttribute("aria-pressed", "false");
      btn.tabIndex = -1;
      btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep editor focus/selection
      btn.addEventListener("click", () => onCommand(b.id));
      el.appendChild(btn);
      this.buttons.set(b.id, btn);
    }
    const first = this.buttons.values().next().value;
    if (first) first.tabIndex = 0;
    el.addEventListener("keydown", (e) => this.rove(e));
    this.render();
  }

  /** Arrow keys move between buttons (single tab stop, per the ARIA toolbar pattern). */
  private rove(e: KeyboardEvent) {
    const list = [...this.buttons.values()];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const target = list[(next + list.length) % list.length];
    list.forEach((b) => (b.tabIndex = b === target ? 0 : -1));
    target.focus();
  }

  setPinned(pinned: boolean) {
    this.pinned = pinned;
    this.render();
  }

  setActive(active: Set<string>) {
    for (const [id, btn] of this.buttons) btn.setAttribute("aria-pressed", String(active.has(id)));
  }

  private render() {
    const visible = this.pinned;
    this.el.classList.toggle("visible", visible);
    this.el.inert = !visible;
    document.body.classList.toggle("toolbar-visible", visible);
  }
}
