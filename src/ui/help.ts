import { icon, LOGO } from "./icons";

/**
 * Menu commands, written once and rendered as keycaps. Mirrors src-tauri/src/menu.rs item for item
 * (same menus, same order); items without an accelerator show their menu path instead of keys.
 */
type Shortcut = [label: string, keys: string | { menu: string }];

const SHORTCUTS: { group: string; items: Shortcut[] }[] = [
  {
    group: "File",
    items: [
      ["New document", "⌘N"],
      ["Open…", "⌘O"],
      ["Open folder…", "⇧⌘O"],
      ["Save", "⌘S"],
      ["Save as…", "⇧⌘S"],
      ["Export as HTML…", "⇧⌘E"],
      ["Export as PDF…", "⌘P"],
    ],
  },
  {
    group: "Edit",
    items: [
      ["Undo", "⌘Z"],
      ["Redo", "⇧⌘Z"],
      ["Find in document", "⌘F"],
    ],
  },
  {
    group: "Format: text",
    items: [
      ["Bold", "⌘B"],
      ["Italic", "⌘I"],
      ["Strikethrough", "⇧⌘X"],
      ["Highlight", "⇧⌘H"],
      ["Subscript", "⌃⌘-"],
      ["Superscript", "⌃⌘="],
      ["Inline code", "⌘E"],
      ["Link", "⌘K"],
    ],
  },
  {
    group: "Format: blocks",
    items: [
      ["Paragraph", "⌘0"],
      ["Heading 1 – 3", "⌘1 – ⌘3"],
      ["Quote", "⇧⌘."],
      ["Bullet list", "⇧⌘8"],
      ["Numbered list", "⇧⌘7"],
      ["Task list", "⇧⌘9"],
      ["Code block", "⌥⌘C"],
      ["Table", "⌥⌘T"],
      ["Horizontal rule", "⇧⌘-"],
      ["Footnote", "⌥⌘N"],
      ["Definition", "⌥⌘L"],
      ["Heading ID", "⌥⌘I"],
      ["Emoji…", { menu: "Format › Emoji…" }],
    ],
  },
  {
    group: "View",
    items: [
      ["Sidebar", "⌘\\"],
      ["Search library", "⇧⌘L"],
      ["Formatting bar", "⇧⌘T"],
      ["Word count (status bar)", "⇧⌘W"],
      ["Focus mode", "⇧⌘F"],
      ["Focus sentence / paragraph", "⌥⌘F"],
      ["Typewriter scrolling", "⇧⌘Y"],
      ["Edit / Split / Read", "⌥⌘1 – ⌥⌘3"],
      ["Next view", "⇧⌘P"],
      ["Switch font", "⇧⌘J"],
      ["Load remote images", { menu: "View › Load Remote Images" }],
      ["Bigger / smaller text", "⌘= / ⌘-"],
      ["Actual size", { menu: "View › Actual Size" }],
      ["Theme", { menu: "View › Theme: System / Light / Dark" }],
    ],
  },
  {
    group: "Help",
    items: [
      ["Focus help", "⇧⌘/"],
      ["Keyboard shortcuts", { menu: "Help › Keyboard Shortcuts" }],
      ["Markdown reference", { menu: "Help › Markdown Reference" }],
    ],
  },
];

/** Markdown reference rows: [element, syntax]. Matches markdownguide.org/cheat-sheet. */
const SYNTAX: [string, string][] = [
  ["Heading", "# H1  ## H2  ### H3"],
  ["Bold", "**bold text**"],
  ["Italic", "*italicized text*"],
  ["Blockquote", "> blockquote"],
  ["Ordered list", "1. First item"],
  ["Unordered list", "- First item"],
  ["Code", "`code`"],
  ["Horizontal rule", "---"],
  ["Link", "[title](https://www.example.com)"],
  ["Image", "![alt text](image.jpg)"],
  ["Table", "| Syntax | Description |\n| --- | --- |\n| Header | Title |"],
  ["Fenced code block", "```\ncode\n```"],
  ["Footnote", "Text.[^1]\n\n[^1]: The note."],
  ["Heading ID", "### My Heading {#custom-id}"],
  ["Definition list", "term\n: definition"],
  ["Strikethrough", "~~The world is flat.~~"],
  ["Task list", "- [x] Done\n- [ ] To do"],
  ["Emoji", "That is so funny! :joy:"],
  ["Highlight", "==very important words=="],
  ["Subscript", "H~2~O"],
  ["Superscript", "X^2^"],
];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const kbd = (keys: string) =>
  keys
    .split(/( – | \/ )/)
    .map((part) => (/^ (–|\/) $/.test(part) ? `<span class="kbd-sep">${part.trim()}</span>` : `<kbd>${esc(part)}</kbd>`))
    .join("");

const SECTIONS: { id: string; title: string; body: string }[] = [
  {
    id: "start",
    title: "Getting started",
    body: `
      <p class="lead">Focus is a quiet place to write Markdown. The interface stays out of the way so your words stay in front.</p>
      <ol class="steps">
        <li><strong>Open a folder</strong> of notes with the folder button in the sidebar (or <kbd>⇧⌘O</kbd>). Every Markdown file appears as a card.</li>
        <li><strong>Start writing.</strong> Click a card, or press <kbd>⌘N</kbd> for a new document. You can also drop a Markdown file or a folder onto the window.</li>
        <li><strong>That's it — it saves itself.</strong> Files are saved automatically a moment after you stop typing. New, unnamed documents ask for a name the first time you press <kbd>⌘S</kbd>.</li>
      </ol>
      <p>Everything else is optional: formatting, focus mode, preview, themes and export are covered in the sections on the left.</p>`,
  },
  {
    id: "writing",
    title: "Writing",
    body: `
      <h3>Live preview</h3>
      <p>Write plain Markdown and see it formatted as you go. Markdown symbols like <code>**</code> or <code>#</code> are hidden everywhere except the line you're editing, so the text reads cleanly while the syntax stays one click away.</p>
      <h3>Rendered elements</h3>
      <ul>
        <li><strong>Tables</strong> stay tables while you edit: click a cell and type. <kbd>Tab</kbd> / <kbd>⇧Tab</kbd> and the arrow keys move between cells, <kbd>Enter</kbd> goes down a row, and <kbd>Tab</kbd> in the last cell adds a row. The bar above the table inserts and deletes rows and columns (<kbd>⌥⌘</kbd> + arrows insert, <kbd>⌥⌘⌫</kbd> / <kbd>⇧⌥⌘⌫</kbd> delete row / column); the <strong>+</strong> buttons on its edges add one at the end. Choose <strong>Edit as Markdown</strong> there to change the source directly.</li>
        <li><strong>Task lists</strong> show checkboxes you can click.</li>
        <li><strong>Images</strong> show inline, including files next to your document.</li>
        <li><strong>Links</strong>: <kbd>⌘</kbd>-click to open. Links to other <code>.md</code> files open them here.</li>
        <li><strong>Emoji</strong>: type <code>:</code> and two letters (e.g. <code>:jo</code>) to pick one.</li>
      </ul>`,
  },
  {
    id: "formatting",
    title: "Formatting",
    body: `
      <h3>Selection bubble</h3>
      <p>Select any text and a small toolbar rises above it with ${["bold", "italic", "strike", "highlight", "subscript", "superscript", "code", "link"].map((i) => `<span class="inline-icon" aria-hidden="true">${icon(i)}</span>`).join("")} — bold, italic, strikethrough, highlight, subscript, superscript, code and link. Click again to remove a format. <kbd>Esc</kbd> hides it.</p>
      <h3>Formatting bar</h3>
      <p>Prefer buttons for everything? Press <kbd>⇧⌘T</kbd> to pin the full formatting bar with headings, lists, quotes, code blocks, tables, footnotes and more. Every item is also in the <strong>Format</strong> menu with its shortcut.</p>
      <p class="note">Subscript and superscript can't contain spaces — that's part of the Markdown syntax (<code>H~2~O</code>, <code>X^2^</code>).</p>`,
  },
  {
    id: "views",
    title: "Views & focus",
    body: `
      <h3>Edit, Split, Read</h3>
      <p>The switch at the top right ${["pencil", "split", "book"].map((i) => `<span class="inline-icon" aria-hidden="true">${icon(i)}</span>`).join("")} changes how the document is shown: <strong>Edit</strong> for writing, <strong>Split</strong> for writing with a rendered preview beside it, <strong>Read</strong> for the finished page.</p>
      <h3>Focus mode <span class="inline-icon" aria-hidden="true">${icon("focus")}</span></h3>
      <p>Dims everything except the paragraph you're working on (<kbd>⇧⌘F</kbd>). Switch to sentence-level focus with <kbd>⌥⌘F</kbd>, and turn on <strong>typewriter scrolling</strong> (<kbd>⇧⌘Y</kbd>) to keep the line you're typing in the middle of the window.</p>
      <h3>Type & theme</h3>
      <p><span class="inline-icon" aria-hidden="true">${icon("type")}</span> cycles the writing font between Serif, Sans and Mono. <span class="inline-icon" aria-hidden="true">${icon("moon")}</span> switches between warm paper and deep charcoal. <kbd>⌘=</kbd> and <kbd>⌘-</kbd> change the text size. The status bar at the bottom shows the current view, font and theme — click them to switch.</p>`,
  },
  {
    id: "library",
    title: "Library",
    body: `
      <p>The sidebar <span class="inline-icon" aria-hidden="true">${icon("sidebar")}</span> (<kbd>⌘\\</kbd>) lists the Markdown files in your folder. Each card shows the document's title, when it changed, its first lines, word count and file name.</p>
      <ul>
        <li><strong>Search</strong> (<kbd>⇧⌘L</kbd>) filters by title, file name or text. Press <kbd>↓</kbd> to move into the results, <kbd>Esc</kbd> to clear.</li>
        <li><strong>New file</strong> <span class="inline-icon" aria-hidden="true">${icon("file-plus")}</span> creates a document in the folder and lets you name it right away.</li>
        <li><strong>Rename</strong> with <kbd>F2</kbd>, <strong>move to Trash</strong> with <kbd>⌘⌫</kbd>, or right-click a card for more (including Reveal in Finder).</li>
        <li>The list updates by itself when files change on disk.</li>
        <li>In a <strong>narrow window</strong> the sidebar slides over the document. While it's closed, rest the pointer at the window's left edge to peek at it; it slides away when you move back to your text.</li>
      </ul>`,
  },
  {
    id: "export",
    title: "Export",
    body: `
      <ul>
        <li><strong>HTML</strong> (<kbd>⇧⌘E</kbd>) — a single, self-contained web page with clean typography for light and dark mode.</li>
        <li><strong>PDF</strong> — click <span class="inline-icon" aria-hidden="true">${icon("file-pdf")}</span> in the top bar (or <kbd>⌘P</kbd>). The macOS print dialog opens with just your document; choose <em>PDF → Save as PDF</em>.</li>
      </ul>
      <p>Both support everything in the Markdown reference, including tables, footnotes and task lists.</p>`,
  },
  {
    id: "markdown",
    title: "Markdown reference",
    body: `
      <p>Every element from the <a href="https://www.markdownguide.org/cheat-sheet/">Markdown Guide cheat sheet</a> works here — basic and extended.</p>
      <p class="note">A line that starts with <code>: </code> right under another line becomes a definition. To write a literal colon there, escape it: <code>\\: like this</code>.</p>
      <table class="ref">
        <thead><tr><th>Element</th><th>Syntax</th></tr></thead>
        <tbody>${SYNTAX.map(([el, syn]) => `<tr><td>${esc(el)}</td><td><pre>${esc(syn)}</pre></td></tr>`).join("")}</tbody>
      </table>`,
  },
  {
    id: "shortcuts",
    title: "Keyboard shortcuts",
    body: SHORTCUTS.map(
      ({ group, items }) =>
        `<h3>${group}</h3><dl class="shortcuts">${items
          .map(([label, keys]) => `<div><dt>${esc(label)}</dt><dd>${typeof keys === "string" ? kbd(keys) : `<span class="menu-path">${esc(keys.menu)}</span>`}</dd></div>`)
          .join("")}</dl>`,
    ).join(""),
  },
];

const ACTIVE_LINE_PX = 64;

/** Help sheet: section list on the left, content on the right. */
export class Help {
  private dialog = document.createElement("dialog");
  private content: HTMLElement;
  private tabs = new Map<string, HTMLButtonElement>();

  constructor(onLink: (href: string) => void) {
    this.dialog.id = "help";
    this.dialog.setAttribute("aria-labelledby", "help-title");
    this.dialog.innerHTML = `
      <nav class="help-nav" aria-label="Help topics">
        <div class="help-brand">${LOGO}<span>Focus</span></div>
        <h2 id="help-title">Help</h2>
        ${SECTIONS.map((s) => `<button class="help-tab" data-section="${s.id}">${s.title}</button>`).join("")}
      </nav>
      <div class="help-content" tabindex="-1">
        ${SECTIONS.map((s) => `<section id="help-${s.id}" aria-labelledby="help-h-${s.id}"><h2 id="help-h-${s.id}">${s.title}</h2>${s.body}</section>`).join("")}
      </div>
      <button class="btn help-close" aria-label="Close help" title="Close (Esc)">×</button>`;
    document.body.appendChild(this.dialog);
    this.content = this.dialog.querySelector(".help-content")!;

    this.dialog.querySelectorAll<HTMLButtonElement>(".help-tab").forEach((tab) => {
      this.tabs.set(tab.dataset.section!, tab);
      tab.addEventListener("click", () => this.show(tab.dataset.section!));
      tab.addEventListener("keydown", (e) => this.rove(e, tab));
    });
    this.dialog.querySelector(".help-close")!.addEventListener("click", () => this.dialog.close());
    // Click on the backdrop (outside the sheet) closes.
    this.dialog.addEventListener("click", (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });
    this.content.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("a");
      if (!a) return;
      e.preventDefault();
      onLink(a.getAttribute("href") ?? "");
    });
    // Highlight the tab of the section currently in view.
    this.content.addEventListener("scroll", () => {
      // A section counts as current once its heading passes this line (below the 24px scroll margin).
      const top = this.content.getBoundingClientRect().top + ACTIVE_LINE_PX;
      let current = SECTIONS[0].id;
      for (const s of SECTIONS) if (this.dialog.querySelector(`#help-${s.id}`)!.getBoundingClientRect().top <= top) current = s.id;
      this.markTab(current);
    }, { passive: true });
  }

  get isOpen() {
    return this.dialog.open;
  }

  toggle(section?: string) {
    if (this.dialog.open && !section) this.dialog.close();
    else this.open(section);
  }

  open(section = "start") {
    if (!this.dialog.open) this.dialog.showModal();
    this.show(section);
    this.content.focus({ preventScroll: true }); // arrow keys / space scroll the text right away
  }

  private show(id: string) {
    this.dialog.querySelector(`#help-${id}`)?.scrollIntoView({ block: "start" });
    this.markTab(id);
  }

  /** ↑/↓ between topics when a tab has focus. */
  private rove(e: KeyboardEvent, tab: HTMLButtonElement) {
    const list = [...this.tabs.values()];
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = list[(list.indexOf(tab) + step + list.length) % list.length];
    next.focus();
    this.show(next.dataset.section!);
  }

  private markTab(id: string) {
    for (const [key, tab] of this.tabs) {
      if (key === id) tab.setAttribute("aria-current", "true");
      else tab.removeAttribute("aria-current");
    }
  }
}
