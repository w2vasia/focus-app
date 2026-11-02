import { Menu } from "@tauri-apps/api/menu";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { basename, Entry, ipc, stripExt } from "../ipc";
import { icon } from "./icons";

function markCurrent(row: HTMLElement, current: boolean) {
  if (current) row.setAttribute("aria-current", "page");
  else row.removeAttribute("aria-current");
}

const fmt = new Intl.NumberFormat();
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** "just now", "5 min ago", "3 h ago", "Yesterday", "Oct 12". */
function relativeTime(ms: number): string {
  if (!ms) return "";
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return "Yesterday";
  return dateFmt.format(ms);
}

const titleOf = (e: Entry) => e.summary?.title || stripExt(e.name);

export interface SidebarHandlers {
  open(path: string): Promise<void> | void;
  /** Return the caret to the document (after renaming). */
  focusEditor(): void;
  openFolder(): void;
  /**
   * Runs `op`, which renames (resolving to the new path) or trashes (null) `path`, and lets the
   * editor follow along. The editor finishes a save of that file first, so the write can't
   * recreate it at the old path (R4-M7). Rejects with `op`'s error.
   */
  move(path: string, op: () => Promise<string | null>): Promise<string | null>;
  /** The library folder can no longer be read (deleted, renamed, unmounted). */
  folderLost(folder: string): void;
}

export class Sidebar {
  private folder: string | null = null;
  private entries: Entry[] = [];
  private query = "";
  private collapsed = new Set<string>();
  private activePath: string | null = null;
  private refreshTimer = 0;
  /** The name field of an in-progress rename; refreshes are skipped while it's on screen (finishing refreshes). */
  private renameInput: HTMLInputElement | null = null;
  private list: HTMLElement;
  private title: HTMLElement;
  private search: HTMLInputElement;

  constructor(private el: HTMLElement, private handlers: SidebarHandlers) {
    el.setAttribute("aria-label", "Library");
    el.innerHTML = `
      <header>
        <span class="folder-name">Library</span>
        <div class="actions">
          <button class="btn sm new-file" title="New File" aria-label="New file">${icon("file-plus")}</button>
          <button class="btn sm open-folder-btn" title="Open Folder… ⇧⌘O" aria-label="Open folder">${icon("folder-open")}</button>
        </div>
      </header>
      <label class="search">
        ${icon("search")}
        <input type="search" placeholder="Search" aria-label="Search documents" spellcheck="false" autocomplete="off" />
      </label>
      <nav class="tree" aria-label="Documents"></nav>
      <div class="empty">
        ${icon("folder", "empty-icon")}
        <p>Open a folder to browse<br />your Markdown files.</p>
        <button class="btn open-folder">Open Folder…</button>
      </div>
      <footer>Drop a Markdown file or folder here, <span class="nowrap">or use <kbd>⌘O</kbd>.</span></footer>`;
    this.list = el.querySelector(".tree")!;
    this.title = el.querySelector(".folder-name")!;
    this.search = el.querySelector(".search input")!;
    el.querySelector(".open-folder")!.addEventListener("click", () => handlers.openFolder());
    el.querySelector(".open-folder-btn")!.addEventListener("click", () => handlers.openFolder());
    el.querySelector(".new-file")!.addEventListener("click", () => this.newFile());
    this.search.addEventListener("input", () => {
      this.query = this.search.value.trim().toLowerCase();
      this.render();
    });
    this.search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.search.value = "";
        this.query = "";
        this.render();
        handlers.focusEditor();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.list.querySelector<HTMLElement>(".row")?.focus();
      }
    });
  }

  /** Only while the field is still in the DOM: a re-render can remove it without a blur, which must not freeze refreshes. */
  private get renaming() {
    return Boolean(this.renameInput?.isConnected);
  }

  get currentFolder() {
    return this.folder;
  }

  focusSearch() {
    this.search.focus();
    this.search.select();
  }

  /** Rejects if the folder can't be read, so callers can forget it. */
  async setFolder(folder: string) {
    this.entries = await ipc.listDir(folder);
    this.folder = folder;
    this.renameInput = null; // a rename in the old list is abandoned
    this.title.textContent = basename(folder);
    this.el.classList.add("has-folder");
    this.render();
    await ipc.watchDir(folder).catch((e) => console.warn("watch failed", e));
  }

  /** Back to the "Open Folder…" empty state. */
  private clearFolder() {
    this.folder = null;
    this.entries = [];
    this.renameInput = null;
    this.title.textContent = "Library";
    this.el.classList.remove("has-folder");
    this.list.replaceChildren();
  }

  /** Debounced refresh for bursts of file-system events. */
  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.refresh(), 150);
  }

  async refresh() {
    if (!this.folder) return;
    if (this.renaming) return;
    const folder = this.folder;
    try {
      this.entries = await ipc.listDir(folder);
      this.render();
    } catch {
      this.clearFolder();
      this.handlers.folderLost(folder);
    }
  }

  setActive(path: string | null) {
    this.activePath = path;
    this.list.querySelectorAll<HTMLElement>(".card").forEach((el) => markCurrent(el, el.dataset.path === path));
  }

  async newFile() {
    if (!this.folder) return this.handlers.openFolder();
    const path = await ipc.createFile(this.folder);
    this.query = this.search.value = "";
    await this.refresh();
    await this.handlers.open(path); // load first, so loading doesn't steal focus from the name field
    this.startRename(path);
  }

  private matches(e: Entry): boolean {
    if (!this.query) return true;
    if (e.is_dir) return e.children.some((c) => this.matches(c));
    return [e.name, e.summary?.title ?? "", e.summary?.snippet ?? ""].some((t) => t.toLowerCase().includes(this.query));
  }

  private render() {
    // Keep keyboard focus on the same row across re-renders (refreshes after saves, renames…).
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("#sidebar .row")?.dataset.path;
    const frag = this.renderEntries(this.entries, 0);
    if (!frag.childNodes.length) {
      const none = document.createElement("p");
      none.className = "no-results";
      none.textContent = this.query ? `No documents match “${this.search.value.trim()}”.` : "No Markdown files in this folder.";
      frag.appendChild(none);
    }
    this.list.replaceChildren(frag);
    if (focused) this.list.querySelector<HTMLElement>(`.row[data-path="${CSS.escape(focused)}"]`)?.focus();
  }

  private renderEntries(entries: Entry[], depth: number): DocumentFragment {
    const frag = document.createDocumentFragment();
    for (const entry of entries.filter((e) => this.matches(e))) {
      const indent = `calc(var(--space-3) + ${depth} * var(--space-3))`;
      if (entry.is_dir) {
        const row = document.createElement("button");
        row.className = "row dir";
        row.dataset.path = entry.path;
        row.style.paddingLeft = indent;
        row.title = entry.name;
        row.innerHTML = `${icon("chevron", "chevron")}<span class="label"></span>`;
        row.querySelector(".label")!.textContent = entry.name;

        const children = document.createElement("div");
        children.setAttribute("role", "group");
        children.appendChild(this.renderEntries(entry.children, depth + 1));
        const setExpanded = (expanded: boolean) => {
          children.hidden = !expanded;
          row.setAttribute("aria-expanded", String(expanded));
          if (expanded) this.collapsed.delete(entry.path);
          else this.collapsed.add(entry.path);
        };
        // While searching, every matching folder is open.
        setExpanded(Boolean(this.query) || !this.collapsed.has(entry.path));
        row.addEventListener("click", () => setExpanded(row.getAttribute("aria-expanded") !== "true"));
        row.addEventListener("keydown", (e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") this.moveFocus(row, e.key === "ArrowDown" ? 1 : -1);
          else if (e.key === "ArrowLeft") setExpanded(false);
          else if (e.key === "ArrowRight") setExpanded(true);
          else return;
          e.preventDefault();
        });
        frag.append(row, children);
        continue;
      }

      const s = entry.summary;
      const card = document.createElement("button");
      card.className = "row card";
      card.dataset.path = entry.path;
      card.style.paddingLeft = indent;
      card.title = entry.path;
      card.innerHTML = `
        ${icon("file-text")}
        <span class="card-body">
          <span class="card-top"><span class="card-title label"></span><span class="card-time"></span></span>
          <span class="card-snippet"></span>
          <span class="card-meta"><span class="words"></span><span aria-hidden="true">·</span><span class="fname"></span></span>
        </span>`;
      card.querySelector(".card-title")!.textContent = titleOf(entry);
      card.querySelector(".card-time")!.textContent = relativeTime(s?.modified ?? 0);
      card.querySelector(".card-snippet")!.textContent = s?.snippet || "Empty document";
      card.querySelector(".words")!.textContent = `${fmt.format(s?.words ?? 0)} words`;
      card.querySelector(".fname")!.textContent = entry.name;
      markCurrent(card, entry.path === this.activePath);

      card.addEventListener("click", () => this.handlers.open(entry.path));
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.showContextMenu(entry.path);
      });
      card.addEventListener("keydown", (e) => {
        if (e.key === "F2") this.startRename(entry.path);
        else if (e.key === "Backspace" && e.metaKey) this.trash(entry.path);
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") this.moveFocus(card, e.key === "ArrowDown" ? 1 : -1);
        else return;
        e.preventDefault();
      });
      frag.appendChild(card);
    }
    return frag;
  }

  /** ↑/↓ through every visible row (folders and documents); above the first goes to search. */
  private moveFocus(from: HTMLElement, dir: 1 | -1) {
    const rows = [...this.list.querySelectorAll<HTMLElement>(".row")].filter((r) => r.offsetParent);
    const i = rows.indexOf(from) + dir;
    if (i < 0) this.search.focus();
    else rows[i]?.focus();
  }

  private async showContextMenu(path: string) {
    const menu = await Menu.new({
      items: [
        { id: "rename", text: "Rename…", action: () => this.startRename(path) },
        { id: "reveal", text: "Reveal in Finder", action: () => ipc.revealPath(path).catch(() => {}) },
        { item: "Separator" },
        { id: "trash", text: "Move to Trash", action: () => this.trash(path) },
      ],
    });
    await menu.popup();
    // R4-L4: free the native menu. Item actions arrive as separate events after the popup
    // closes; closing the menu drops their handlers, so give them a moment first.
    setTimeout(() => menu.close().catch(() => {}), 1000);
  }

  private async trash(path: string) {
    const ok = await ask(`Move “${basename(path)}” to the Trash?`, { title: "Move to Trash", kind: "warning", okLabel: "Move to Trash" });
    if (!ok) return;
    try {
      await this.handlers.move(path, () => ipc.trashPath(path).then(() => null));
    } catch (e) {
      await message(String(e), { title: "Couldn't Move to Trash", kind: "error" });
      return;
    }
    await this.refresh();
  }

  startRename(path: string) {
    const card = this.list.querySelector<HTMLElement>(`.card[data-path="${CSS.escape(path)}"]`);
    if (!card) return;
    const input = document.createElement("input");
    input.className = "rename";
    input.value = stripExt(basename(path));
    card.querySelector(".card-title")!.replaceWith(input);
    input.addEventListener("click", (e) => e.stopPropagation());
    input.focus();
    input.select();
    let done = false;
    this.renameInput = input;
    const finish = async (commit: boolean) => {
      if (done) return;
      done = true;
      if (this.renameInput === input) this.renameInput = null;
      const name = input.value.trim();
      if (commit && name && name !== stripExt(basename(path))) {
        const ext = basename(path).match(/\.[^.]+$/)?.[0] ?? ".md";
        try {
          const newName = /\.(md|markdown|mdown|txt)$/i.test(name) ? name : name + ext;
          await this.handlers.move(path, () => ipc.renamePath(path, newName));
        } catch (e) {
          await message(String(e), { title: "Rename failed", kind: "error" });
        }
      }
      await this.refresh();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        finish(e.key === "Enter").then(() => this.handlers.focusEditor());
      }
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
  }
}
