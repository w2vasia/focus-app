import { EditorView } from "@codemirror/view";
import { Annotation, Text } from "@codemirror/state";
import { undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import { createState } from "./editor/setup";
import { formatCommands, activeFormats } from "./editor/commands";
import { formatCell } from "./editor/tables";
import { insertEmoji } from "./editor/emoji";
import { loadRemoteImages, setImageResolver } from "./editor/livePreview";
import { allowRemote, canLoadRemote, isRemote, remoteAllowed, remotePlaceholder } from "./editor/remoteImages";
import { focusConfig, setFocusConfig } from "./editor/focusMode";
import { Toolbar } from "./ui/toolbar";
import { Sidebar } from "./ui/sidebar";
import { StatusBar } from "./ui/stats";
import { icon } from "./ui/icons";
import { basename, dirname, ipc, stripExt } from "./ipc";
import { flushSettings, loadSettings, ProseFont, setSetting, settings, Theme, ViewMode } from "./settings";
import { SelectionBubble } from "./ui/bubble";
import { Help } from "./ui/help";
import "@fontsource-variable/source-serif-4/opsz.css";
import "@fontsource-variable/source-serif-4/opsz-italic.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./styles/chrome.css";
import "./styles/theme.css";

const AUTOSAVE_MS = 600;
const appWindow = getCurrentWindow();

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const titleEl = $("#doc-title");
const printView = $("#print-view");
const previewEl = $("#preview");
const PREVIEW_DEBOUNCE_MS = 150;
const FONT_LABELS: Record<ProseFont, string> = { serif: "Serif", sans: "Sans", mono: "Mono" };
const FONT_ORDER: ProseFont[] = ["serif", "sans", "mono"];
const VIEW_ORDER: ViewMode[] = ["edit", "split", "read"];
const VIEW_LABELS: Record<ViewMode, string> = { edit: "Edit", split: "Split", read: "Read" };
const mainEl = $("#main");

// ---------------------------------------------------------------- document state

let currentPath: string | null = null;
let dirty = false;
let autosaveTimer = 0;
/** Modification time of `currentPath` when we last read or wrote it; null for new/untitled docs. */
let diskMtime: number | null = null;
/** Message of the most recent failed write, so leaving can offer "quit without saving". */
let lastSaveError: string | null = null;
/** The save in progress, so saves never overlap. */
let saving: Promise<boolean> | null = null;
/**
 * The open file vanished and the user chose "Not Now" (R2-H3): autosave stays off for this
 * document until an explicit Save / Save As, and leaving offers to discard.
 */
let missingAcknowledged = false;
/** Bumped whenever another document is loaded, so slow work for the previous one can tell. */
let docGen = 0;
/** When the write in progress started (0: none), so a hanging write can be noticed on quit (R4-M6). */
let writeStartedAt = 0;
/** Marks edits that came from disk (external change), which must not make the doc dirty. */
const fromDisk = Annotation.define<boolean>();

const view = new EditorView({ parent: $("#editor") });

function resolveRelative(src: string): string {
  if (/^(https?:|data:|asset:|blob:)/.test(src)) return src;
  let decoded = src;
  try {
    decoded = decodeURI(src);
  } catch {
    // malformed escape like "%zz": use the path as written
  }
  if (decoded.startsWith("/")) return decoded;
  return currentPath ? `${dirname(currentPath)}/${decoded}` : decoded;
}

setImageResolver((src) => {
  const resolved = resolveRelative(src);
  return resolved.startsWith("/") ? convertFileSrc(resolved) : resolved;
});

/**
 * `mtime` is the file's modification time as read (enables external-change detection).
 * `remember: false` keeps the stored "last file" untouched (used for the blank doc shown while starting up).
 */
function loadDoc(text: string, path: string | null, { remember = true, mtime = null as number | null } = {}) {
  clearTimeout(autosaveTimer); // a pending autosave belongs to the previous document
  docGen++;
  currentPath = path;
  diskMtime = mtime;
  dirty = false;
  missingAcknowledged = false;
  lastSaveError = null;
  missingToastFor = null;
  const focus = view.state.field(focusConfig, false);
  view.setState(
    createState(text, focus ?? { unit: settings.focusUnit, typewriter: settings.typewriter }, EditorView.updateListener.of(onUpdate)),
  );
  sidebar.setActive(path);
  if (remember) setSetting("lastFile", path);
  status.update(view.state, fileLabel());
  renderTitle();
  schedulePreview();
  focusDoc();
  watchOpenFile(path);
}

/** Focus whatever shows the document: the preview in Read view, otherwise the editor. */
function focusDoc() {
  // R3-L1: a narrow-window overlay covers the document; the keyboard belongs in the overlay.
  if (narrowWindow.matches && document.body.classList.contains("sidebar-open")) return focusSidebar();
  if (effectiveMode() === "read") previewEl.focus({ preventScroll: true });
  else view.focus();
}

/** R2-M9: also watch the open file's own folder (files outside the library get reloads too). */
function watchOpenFile(path: string | null) {
  ipc.watchOpenFile(path).catch((e) => console.warn("open-file watch failed", e));
}

const fileLabel = () => (currentPath ? basename(currentPath) : "Untitled");

function scheduleAutosave() {
  if (!currentPath || missingAcknowledged) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => saveDoc({ auto: true }), AUTOSAVE_MS);
}

function onUpdate(u: import("@codemirror/view").ViewUpdate) {
  if (u.docChanged) {
    schedulePreview();
    if (!u.transactions.some((tr) => tr.annotation(fromDisk))) {
      document.body.classList.add("typing"); // title-bar controls step back (D2)
      if (!dirty) {
        dirty = true;
        renderTitle();
      }
      scheduleAutosave();
    }
  }
  bubble.update(u);
  if (u.docChanged || u.selectionSet) {
    status.update(u.state, fileLabel());
    toolbar.setActive(activeFormats(u.state));
  }
}

function renderTitle() {
  const name = currentPath ? stripExt(basename(currentPath)) : "Untitled";
  titleEl.textContent = name;
  titleEl.classList.toggle("dirty", dirty && (!currentPath || missingAcknowledged));
  appWindow.setTitle(name).catch(() => {});
}

/** `auto`: an autosave, which never runs while a vanished file awaits an explicit Save. */
async function saveDoc({ auto = false } = {}): Promise<boolean> {
  clearTimeout(autosaveTimer);
  let waited = false;
  // R3-M1: if the save we wait on gets "Not Now" (File Missing), the user declined recreating
  // the file; writing it anyway once that save ends would override their answer.
  const declinedBefore = missingAcknowledged;
  // Let the running save finish, then save whatever is still unsaved. A loop, because another
  // waiter may have started the next save first; `saving` is set synchronously after the loop.
  while (saving) {
    waited = true;
    await saving;
  }
  if (waited && !dirty) return true;
  if (waited && !declinedBefore && missingAcknowledged) return false;
  if (auto && (missingAcknowledged || !currentPath)) return false;
  if (!currentPath) return saveDocAs();
  lastSaveError = null;
  return holdSaveLock(writeCurrent());
}

/**
 * Makes `task` the save in progress until it settles. Callers wait for `saving` to be null first
 * and call this without awaiting anything in between.
 */
async function holdSaveLock(task: Promise<boolean>): Promise<boolean> {
  saving = task;
  try {
    return await task;
  } finally {
    if (saving === task) saving = null;
    // R3-L1: a folder change reported while we were writing was skipped; look again now.
    if (!saving && diskCheckSkipped) {
      diskCheckSkipped = false;
      checkOpenFileOnDisk();
    }
  }
}

/** `ipc.writeFile`, remembering that a write is in flight (R4-M6). */
async function timedWrite(path: string, text: string, expectedMtime: number | null): Promise<number> {
  writeStartedAt = Date.now();
  try {
    return await ipc.writeFile(path, text, expectedMtime);
  } finally {
    writeStartedAt = 0;
  }
}

const isConflict = (e: unknown) => String(e).startsWith("CONFLICT:");

/** Writes the open document, guarding against changes made to the file outside Focus. */
async function writeCurrent(): Promise<boolean> {
  const path = currentPath!;
  /** The modification time we expect on disk; the backend refuses the write if it differs (R4-L2). */
  let expected = diskMtime;
  /** The backend reported a change on disk that our own check may not see (same mtime). */
  let conflict = false;
  try {
    for (;;) {
      if (expected !== null) {
        // A rejection means the file's folder is gone too (B14): same as a missing file.
        const onDisk = await ipc.fileMtime(path).catch(() => null);
        if (onDisk === null) {
          const again = await ask(`“${basename(path)}” was moved or deleted outside Focus. Save it again at its old location?`, {
            title: "File Missing",
            kind: "warning",
            okLabel: "Save Again",
            cancelLabel: "Not Now",
          });
          if (!again) {
            if (path === currentPath) {
              // Stop asking on every autosave; ⌘S (or Save As) saves it again.
              missingAcknowledged = true;
              diskMtime = null;
              clearTimeout(autosaveTimer);
              renderTitle();
              status.toast("Not saved. Use Save (⌘S) to save it again, or Save As…");
            }
            return false;
          }
          expected = null;
        } else if (conflict || onDisk !== expected) {
          const keepMine = await ask(`“${basename(path)}” was changed outside Focus. Keep your version, or use the one on disk?`, {
            title: "File Changed on Disk",
            kind: "warning",
            okLabel: "Keep Mine",
            cancelLabel: "Use Disk Version",
          });
          if (!keepMine) return path === currentPath ? await reloadFromDisk(path) : false;
          expected = onDisk;
        }
      }
      if (path !== currentPath) return false; // the user switched documents while we asked
      const snapshot = view.state.doc;
      let mtime: number;
      try {
        mtime = await timedWrite(path, snapshot.toString(), expected);
      } catch (e) {
        // Changed on disk between our check and the write: nothing was written; ask again.
        if (!isConflict(e) || expected === null) throw e;
        conflict = true;
        continue;
      }
      return committed(path, snapshot, mtime);
    }
  } catch (e) {
    if (path === currentPath) {
      lastSaveError = String(e);
      status.toast(`Save failed: ${e}`);
    }
    return false;
  }
}

/** After `snapshot` was written to `path` (the open document's file) with modification time `mtime`. */
function committed(path: string, snapshot: Text, mtime: number): boolean {
  if (path !== currentPath) {
    // Renamed, trashed or saved elsewhere meanwhile: this mtime belongs to the old path.
    if (dirty) scheduleAutosave();
    return true;
  }
  diskMtime = mtime;
  missingAcknowledged = false;
  missingToastFor = null;
  if (view.state.doc === snapshot) {
    dirty = false;
    renderTitle();
  } else {
    renderTitle();
    scheduleAutosave(); // typing continued during the write
  }
  return true;
}

/**
 * Replaces the open document with the file on disk, keeping the caret where it can. Returns false
 * (and keeps the user's text) if they typed while the file was read; the next save asks again.
 */
async function reloadFromDisk(path: string): Promise<boolean> {
  const before = view.state.doc;
  const [text, mtime] = await Promise.all([ipc.readFile(path), ipc.fileMtime(path)]);
  if (path !== currentPath) return false;
  if (view.state.doc !== before) {
    if (dirty) scheduleAutosave();
    return false;
  }
  const anchor = Math.min(view.state.selection.main.head, text.length);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor },
    annotations: fromDisk.of(true),
  });
  diskMtime = mtime;
  dirty = false;
  renderTitle();
  return true;
}

/**
 * On a folder change: pick up edits made to the open file elsewhere (if we have none of our own).
 * Bursts (the library and open-file watchers both report one change) collapse into one check,
 * and a check never runs concurrently with another.
 */
let diskCheckTimer = 0;
let diskCheck: Promise<void> | null = null;
let diskRecheck = false;
/** The path we already said was moved or deleted (once per disappearance, not per event). */
let missingToastFor: string | null = null;
/** A disk check that ran during our own save and must run again once the save is done. */
let diskCheckSkipped = false;
function checkOpenFileOnDisk() {
  clearTimeout(diskCheckTimer);
  diskCheckTimer = window.setTimeout(() => {
    if (diskCheck) {
      diskRecheck = true;
      return;
    }
    diskCheck = (async () => {
      do {
        diskRecheck = false;
        await checkOnce();
      } while (diskRecheck);
    })().finally(() => (diskCheck = null));
  }, 200);
}
async function checkOnce() {
  const path = currentPath;
  if (saving) {
    diskCheckSkipped = true;
    return;
  }
  if (!path || diskMtime === null) return;
  // A rejection means the folder itself is gone (B14): report it like a missing file.
  const onDisk = await ipc.fileMtime(path).catch(() => null);
  if (path !== currentPath || onDisk === diskMtime || diskMtime === null) return;
  if (onDisk === null) {
    if (missingToastFor !== path) status.toast(`“${basename(path)}” was moved or deleted`);
    missingToastFor = path;
    return;
  }
  missingToastFor = null;
  if (!dirty) await reloadFromDisk(path).catch(() => {});
  // With unsaved edits, the next save asks which version to keep.
}

async function saveDocAs(): Promise<boolean> {
  clearTimeout(autosaveTimer); // an autosave to the old path must not run while the dialog is up
  const firstLine = view.state.doc.line(1).text.replace(/^#+\s*/, "").trim().slice(0, 60);
  const base = sidebar.currentFolder ?? (currentPath ? dirname(currentPath) : null);
  const name = `${firstLine.replace(/[/:]/g, "-") || "Untitled"}.md`;
  const path = await ipc.pickSavePath(base, name, "markdown");
  if (!path) return false;
  while (saving) await saving; // a save to the old path finishes there first
  clearTimeout(autosaveTimer); // …and may have scheduled the next one there
  lastSaveError = null;
  // R4-M5: the document moves to `path` only once the write succeeded, under the save lock, so
  // an autosave waiting meanwhile can never write the new path after a failure (or the reverse).
  const ok = await holdSaveLock(writeAs(path, docGen));
  sidebar.scheduleRefresh();
  return ok;
}

/** Writes the open document to `path` (the Save dialog already confirmed any overwrite). */
async function writeAs(path: string, gen: number): Promise<boolean> {
  const snapshot = view.state.doc;
  let mtime: number;
  try {
    mtime = await timedWrite(path, snapshot.toString(), null);
  } catch (e) {
    if (gen === docGen) {
      // R3-M4: the document still lives where it was (or is still untitled).
      lastSaveError = String(e);
      status.toast(`Save failed: ${e}`);
    }
    return false;
  }
  if (gen !== docGen) return true; // another document was opened meanwhile; the file is written
  currentPath = path;
  missingAcknowledged = false;
  missingToastFor = null;
  dirty = true; // committed() decides, from what was typed during the write
  committed(path, snapshot, mtime);
  status.update(view.state, fileLabel());
  sidebar.setActive(path);
  setSetting("lastFile", path);
  watchOpenFile(path);
  return true;
}

/**
 * Make sure nothing is lost before the current document is replaced. Returns false to abort.
 * R3-H2: saves repeat while the document is still dirty, because keystrokes typed during a write
 * aren't in that write. Only a save that ended with nothing new typed lets the caller move on.
 */
const MAX_SETTLE_SAVES = 5;
async function settleDoc(): Promise<boolean> {
  lastSaveError = null;
  for (let saves = 0; dirty; saves++) {
    if (saves >= MAX_SETTLE_SAVES) {
      status.toast("Still saving your latest changes; try again in a moment");
      return false;
    }
    if (currentPath && missingAcknowledged) {
      const choice = await message(`“${basename(currentPath)}” was moved or deleted outside Focus, and your recent changes aren't saved.`, {
        title: "Unsaved Changes",
        kind: "warning",
        buttons: { yes: "Save Again", no: "Discard", cancel: "Cancel" },
      });
      if (choice !== "Save Again") return choice === "Discard";
      if (!(await saveDoc())) return false;
    } else if (currentPath) {
      if (!(await saveDoc())) {
        // R4-L1: "Not Now" on File Missing: offer Save Again / Discard / Cancel right away.
        if (currentPath && missingAcknowledged) continue;
        return false;
      }
    } else {
      if (!view.state.doc.length) return true;
      const keep = await ask("Save the untitled document before continuing?", {
        title: "Unsaved Changes",
        kind: "warning",
        okLabel: "Save…",
        cancelLabel: "Discard",
      });
      if (!keep) return true;
      if (!(await saveDocAs())) return false;
    }
  }
  return true;
}

/**
 * Settle the document before quitting or closing. If saving failed (read-only file, unmounted
 * volume), offer to leave anyway instead of trapping the user. Repeated ⌘Q reuses the same prompt,
 * except while a write hangs (R4-M6): then it asks whether to quit anyway, as does a write that
 * is still running after a few seconds.
 */
const STUCK_WRITE_MS = 5000;
let leaving: { done: Promise<boolean>; quitAnyway(): void } | null = null;
function readyToLeave(): Promise<boolean> {
  if (leaving) {
    offerQuitWhileSaving(0);
    return leaving.done;
  }
  let quitAnyway!: () => void;
  const forced = new Promise<boolean>((resolve) => (quitAnyway = () => resolve(true)));
  const settled = (async () => {
    // R3-M2: queued setting writes must land before the app exits; typing during that wait
    // is settled again.
    for (let round = 0; round < 3; round++) {
      if (!(await settleForLeaving())) return false;
      const doc = view.state.doc;
      await flushSettings();
      if (view.state.doc === doc) return true;
    }
    return false;
  })();
  const timer = window.setInterval(() => offerQuitWhileSaving(STUCK_WRITE_MS), 1000);
  const done = Promise.race([settled, forced]).finally(() => {
    clearInterval(timer);
    leaving = null;
  });
  leaving = { done, quitAnyway };
  return done;
}

/** Asks once at a time, and at most once per wait unless ⌘Q is pressed again. */
let quitPrompt: Promise<void> | null = null;
let quitPromptedFor: Promise<boolean> | null = null;
function offerQuitWhileSaving(minWriteMs: number) {
  if (!leaving || quitPrompt || !writeStartedAt || Date.now() - writeStartedAt < minWriteMs) return;
  if (minWriteMs && quitPromptedFor === leaving.done) return; // the timer asks only once
  const wait = leaving;
  quitPromptedFor = wait.done;
  quitPrompt = ask(`Focus is still saving “${fileLabel()}”. Quit anyway?`, {
    title: "Still Saving",
    kind: "warning",
    okLabel: "Quit Anyway",
    cancelLabel: "Keep Waiting",
  })
    .then((quit) => {
      if (quit && leaving === wait) wait.quitAnyway();
    })
    .catch(() => {})
    .finally(() => (quitPrompt = null));
}

async function settleForLeaving(): Promise<boolean> {
  if (await settleDoc()) return true;
  // "Not Now" on File Missing leads to Save Again / Discard / Cancel inside settleDoc (R4-L1),
  // so a false here is a cancel, unless saving failed.
  if (!lastSaveError) return false; // the user cancelled (e.g. the Save dialog)
  return await ask(`Focus couldn't save “${fileLabel()}”: ${lastSaveError}\n\nQuit anyway and lose your recent changes?`, {
    title: "Couldn't Save",
    kind: "warning",
    okLabel: "Quit Without Saving",
    cancelLabel: "Cancel",
  });
}

/** Bumped by every open request: only the latest one may load its file (R4-L1). */
let openSeq = 0;
async function openPath(path: string) {
  const seq = ++openSeq;
  if (path === currentPath) return;
  if (!(await settleDoc())) return;
  // Superseded by a later open, or another document was loaded meanwhile (New, Trash…).
  const gen = docGen;
  const stale = () => seq !== openSeq || gen !== docGen;
  if (stale()) return;
  try {
    let settled = view.state.doc;
    const [text, mtime] = await Promise.all([ipc.readFile(path), ipc.fileMtime(path)]);
    // Keystrokes typed while the file was read belong to the old document: settle them too.
    while (!stale() && dirty && view.state.doc !== settled) {
      settled = view.state.doc;
      if (!(await settleDoc())) return;
    }
    if (stale() || path === currentPath) return;
    loadDoc(text, path, { mtime });
  } catch (e) {
    status.toast(`Could not open ${basename(path)}`);
  }
}

async function newDoc() {
  const seq = ++openSeq; // a slower open requested earlier must not replace the new document
  if ((await settleDoc()) && seq === openSeq) loadDoc("", null);
}

async function openDialog() {
  const path = await ipc.pickFile();
  if (path) await openPath(path);
}

async function openFolderDialog() {
  const folder = await ipc.pickFolder();
  if (!folder) return;
  try {
    await sidebar.setFolder(folder);
  } catch (e) {
    status.toast(`Couldn't open “${basename(folder)}”: ${e}`);
    return;
  }
  setSetting("folder", folder);
  toggleSidebar(true);
}

// ---------------------------------------------------------------- export

const exportTitle = () => (currentPath ? stripExt(basename(currentPath)) : "Untitled");

async function exportHtml() {
  const base = currentPath ? dirname(currentPath) : sidebar.currentFolder;
  const path = await ipc.pickSavePath(base, `${exportTitle()}.html`, "html");
  if (!path) return;
  try {
    await ipc.exportHtml(view.state.doc.toString(), exportTitle(), path);
    status.toast(`Exported ${basename(path)}`);
  } catch (e) {
    status.toast(`Export failed: ${e}`);
  }
}

/** Opens the macOS print sheet with only the rendered document; "Save as PDF" lives there. */
async function exportPdf() {
  if (!view.state.doc.toString().trim()) return status.toast("Nothing to export yet");
  printView.innerHTML = await renderHtml({ loadRemote: true });
  document.title = exportTitle(); // used as the default PDF file name
  try {
    await ipc.printWindow();
  } catch (e) {
    status.toast(`PDF export failed: ${e}`);
  }
}

/** Rendered HTML with local image paths made loadable by the webview. */
/** `loadRemote`: PDF export includes web images; the on-screen preview asks first (privacy). */
async function renderHtml({ loadRemote = false } = {}): Promise<string> {
  const tpl = document.createElement("template"); // template content is inert: nothing loads yet
  tpl.innerHTML = await ipc.renderMarkdown(view.state.doc.toString());
  tpl.content.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    if (isRemote(src) && !loadRemote && !remoteAllowed(src)) {
      img.replaceWith(remotePlaceholder(src, img.getAttribute("alt") ?? ""));
      return;
    }
    const resolved = resolveRelative(src);
    if (resolved.startsWith("/")) img.src = convertFileSrc(resolved);
  });
  tpl.content.querySelectorAll("a[href^='http']").forEach((a) => a.setAttribute("target", "_blank"));
  return tpl.innerHTML;
}

// ---------------------------------------------------------------- preview pane

let previewTimer = 0;
function schedulePreview() {
  if (effectiveMode() === "edit") return;
  clearTimeout(previewTimer);
  const seq = ++previewSeq;
  previewTimer = window.setTimeout(async () => {
    const html = await renderHtml();
    if (seq === previewSeq) previewEl.innerHTML = html; // a slower, older render never overwrites a newer one
  }, PREVIEW_DEBOUNCE_MS);
}
let previewSeq = 0;

previewEl.addEventListener("click", (e) => {
  const placeholder = (e.target as HTMLElement).closest<HTMLElement>(".remote-image");
  if (placeholder) {
    const src = placeholder.dataset.src ?? "";
    allowRemote(src);
    const img = document.createElement("img");
    img.src = src;
    img.alt = placeholder.querySelector(".ri-label")?.textContent ?? "";
    placeholder.replaceWith(img);
    return;
  }
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (href.startsWith("#")) {
    // Footnotes (#fn-1 / #fnref-1) and heading ids jump within the preview.
    let id = href.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // keep the raw fragment
    }
    previewEl.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  window.dispatchEvent(new CustomEvent("open-link", { detail: a.getAttribute("href") ?? "" }));
});

// ---------------------------------------------------------------- view toggles

/** Keep the titlebar buttons' pressed states and icons in sync with settings. */
function syncControls() {
  const pressed: Record<string, boolean> = {
    toggle_sidebar: settings.sidebarVisible,
    toggle_focus: view.state.field(focusConfig, false)?.enabled ?? false,
  };
  document.querySelectorAll<HTMLButtonElement>("#view-controls [data-mode]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.dataset.mode === effectiveMode()));
    btn.tabIndex = btn.dataset.mode === effectiveMode() ? 0 : -1;
    if (!btn.dataset.rendered) btn.innerHTML = icon((btn.dataset.rendered = btn.dataset.icon!));
  });
  document.querySelectorAll<HTMLButtonElement>("#view-controls [data-action]").forEach((btn) => {
    const id = btn.dataset.action!;
    if (id in pressed) btn.setAttribute("aria-pressed", String(pressed[id]));
    const name = id === "toggle_theme" ? (isDark() ? "sun" : "moon") : btn.dataset.icon!;
    if (btn.dataset.rendered !== name) {
      btn.innerHTML = icon(name);
      btn.dataset.rendered = name;
    }
  });
  status.setModes(VIEW_LABELS[effectiveMode()], FONT_LABELS[settings.font], isDark() ? "Dark" : "Light");
}

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const isDark = () => (settings.theme === "auto" ? darkQuery.matches : settings.theme === "dark");
darkQuery.addEventListener("change", () => syncControls());

const sidebarEl = $("#sidebar");

/** `moveFocus: false` leaves focus alone (startup, or a caller that focuses something itself). */
function toggleSidebar(force?: boolean, { moveFocus = true } = {}) {
  const wasOpen = document.body.classList.contains("sidebar-open");
  const visible = force ?? !settings.sidebarVisible;
  endPeek(); // an explicit toggle replaces a hover peek
  bubble.hide(); // the sidebar may now cover the selection (narrow windows)
  setSetting("sidebarVisible", visible);
  document.body.classList.toggle("sidebar-open", visible);
  syncControls();
  if (!moveFocus || visible === wasOpen) return;
  if (!visible && sidebarEl.contains(document.activeElement)) focusDoc();
  else if (visible && narrowWindow.matches) focusSidebar();
}

/** R2-L2: an overlay takes focus, so the keyboard isn't left in the covered document. */
function focusSidebar() {
  const target =
    sidebarEl.querySelector<HTMLElement>('.card[aria-current="page"]') ??
    sidebarEl.querySelector<HTMLElement>(".search input, input[type=search]") ??
    sidebarEl.querySelector<HTMLElement>("button");
  target?.focus({ preventScroll: false });
}

/** Below this width Split can't fit; it shows as Edit until the window is wider again. */
const narrowForSplit = window.matchMedia("(max-width: 820px)");
const narrowWindow = window.matchMedia("(max-width: 900px)");
const effectiveMode = (): ViewMode => (settings.viewMode === "split" && narrowForSplit.matches ? "edit" : settings.viewMode);

function setViewMode(mode: ViewMode) {
  setSetting("viewMode", mode);
  applyViewMode();
  focusDoc();
}

const splitUnavailable = () => narrowForSplit.matches;

/** An explicit pick (click, ⌥⌘2): Split is refused while the window is too narrow for it. */
function chooseViewMode(mode: ViewMode) {
  if (mode === "split" && splitUnavailable()) {
    status.toast("Split needs a wider window");
    return false;
  }
  setViewMode(mode);
  return true;
}

/** The next/previous mode from the one shown, skipping Split while it can't be shown. */
function stepViewMode(step: number): ViewMode {
  const modes = VIEW_ORDER.filter((m) => m !== "split" || !splitUnavailable());
  const i = modes.indexOf(effectiveMode());
  return modes[(i + step + modes.length) % modes.length];
}

function applyViewMode() {
  const mode = effectiveMode();
  mainEl.dataset.mode = mode;
  previewEl.hidden = mode === "edit";
  bubble.hide();
  schedulePreview();
  const split = document.querySelector<HTMLButtonElement>('#view-controls [data-mode="split"]');
  split?.setAttribute("aria-disabled", String(narrowForSplit.matches));
  if (split) split.title = narrowForSplit.matches ? "Split needs a wider window" : "Split ⌥⌘2";
  syncControls();
}
narrowForSplit.addEventListener("change", () => {
  const active = document.activeElement; // before hiding the preview drops its focus
  applyViewMode();
  // Split collapsed to Edit: focus must not stay in the now hidden preview or on the disabled segment.
  if (previewEl.hidden && (previewEl.contains(active) || active === document.body)) view.focus();
  else if (active instanceof HTMLElement && active.dataset.mode === "split" && splitUnavailable())
    document.querySelector<HTMLButtonElement>(`#view-controls [data-mode="${effectiveMode()}"]`)?.focus();
});

function applyFont(font: ProseFont) {
  setSetting("font", font);
  document.documentElement.dataset.font = font;
  view.requestMeasure();
  syncControls();
}

function setFocus(patch: Parameters<typeof setFocusConfig.of>[0]) {
  view.dispatch({ effects: setFocusConfig.of(patch) });
  const cfg = view.state.field(focusConfig);
  setSetting("focusUnit", cfg.unit);
  setSetting("typewriter", cfg.typewriter);
  if ("enabled" in patch) status.toast(cfg.enabled ? `Focus: ${cfg.unit}` : "Focus off");
  syncControls();
}

function applyTheme(theme: Theme) {
  setSetting("theme", theme);
  document.documentElement.dataset.theme = theme;
  appWindow.setTheme(theme === "auto" ? null : theme).catch(() => {});
  syncControls();
}

function applyFontSize(size: number) {
  const clamped = Math.min(32, Math.max(12, size));
  setSetting("fontSize", clamped);
  document.documentElement.style.setProperty("--font-size", `${clamped}px`);
  view.requestMeasure();
}

/** Undo/redo/search arrive from the native menu, so route them to whatever has focus. */
const inTextField = () => document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;

function editCommand(id: "undo" | "redo") {
  // Any text field (rename, library search, the editor's own find box) undoes its own text.
  if (inTextField()) document.execCommand(id);
  else (id === "undo" ? undo : redo)(view);
}

const menuActions: Record<string, () => unknown> = {
  new: newDoc,
  open: openDialog,
  open_folder: openFolderDialog,
  save: saveDoc,
  save_as: saveDocAs,
  export_html: exportHtml,
  export_pdf: exportPdf,
  undo: () => editCommand("undo"),
  redo: () => editCommand("redo"),
  find: () => openSearchPanel(view),
  toggle_sidebar: () => toggleSidebar(),
  toggle_toolbar: () => {
    setSetting("toolbarPinned", !settings.toolbarPinned);
    toolbar.setPinned(settings.toolbarPinned);
  },
  toggle_stats: () => {
    setSetting("statsVisible", !settings.statsVisible);
    document.body.classList.toggle("no-statusbar", !settings.statsVisible);
  },
  search_library: () => {
    toggleSidebar(true);
    sidebar.focusSearch();
  },
  toggle_preview: () => setViewMode(stepViewMode(1)),
  help: () => help.toggle(),
  help_shortcuts: () => help.open("shortcuts"),
  help_markdown: () => help.open("markdown"),
  view_edit: () => setViewMode("edit"),
  view_split: () => chooseViewMode("split"),
  view_read: () => setViewMode("read"),
  toggle_theme: () => applyTheme(isDark() ? "light" : "dark"),
  cycle_font: () => applyFont(FONT_ORDER[(FONT_ORDER.indexOf(settings.font) + 1) % FONT_ORDER.length]),
  toggle_focus: () => setFocus({ enabled: !view.state.field(focusConfig).enabled }),
  toggle_focus_unit: () => {
    const unit = view.state.field(focusConfig).unit === "paragraph" ? "sentence" : "paragraph";
    setFocus({ unit, enabled: true });
  },
  toggle_typewriter: () => {
    setFocus({ typewriter: !view.state.field(focusConfig).typewriter });
    status.toast(view.state.field(focusConfig).typewriter ? "Typewriter on" : "Typewriter off");
  },
  font_bigger: () => applyFontSize(settings.fontSize + 1),
  font_smaller: () => applyFontSize(settings.fontSize - 1),
  font_reset: () => applyFontSize(18),
  theme_auto: () => applyTheme("auto"),
  theme_light: () => applyTheme("light"),
  theme_dark: () => applyTheme("dark"),
  load_remote_images: () => {
    if (!loadRemoteImages(view)) return status.toast(remoteImagesStatus());
    schedulePreview(); // the preview's placeholders become images too
  },
};

/** R3-L1: why "Load Remote Images" had nothing to load. */
function remoteImagesStatus(): string {
  const srcs = [...view.state.doc.toString().matchAll(/!\[[^\]]*\]\(\s*<?(https?:\/\/[^\s)>]+)/gi)].map((m) => m[1]);
  if (!srcs.length) return "No remote images in this document";
  const blocked = srcs.filter((src) => !canLoadRemote(src)).length;
  if (blocked === srcs.length) return "Insecure (http) images can't be loaded";
  if (blocked) return "Remote images loaded; insecure (http) images can't be loaded";
  return "All remote images are already loaded";
}

/** Commands that change or search the document, which is hidden in Read view. */
const EDITING_COMMANDS = new Set(["undo", "redo", "find", "emoji"]);

function runCommand(id: string) {
  const fieldUndo = (id === "undo" || id === "redo") && inTextField(); // the field's own text, not the document
  if (effectiveMode() === "read" && !fieldUndo && (EDITING_COMMANDS.has(id) || id in formatCommands)) {
    status.toast("Switch to Edit or Split to make changes");
    return;
  }
  if (menuActions[id]) return menuActions[id]();
  // A table cell being edited takes inline formatting itself; block formats don't fit in a cell.
  if (id === "emoji" || id in formatCommands) {
    const inCell = formatCell(id);
    if (inCell === false) status.toast("Not available inside a table cell");
    if (inCell !== null) return;
  }
  if (id === "emoji") return insertEmoji(view);
  const handled = formatCommands[id]?.(view);
  if (id === "heading_id" && !handled) status.toast("Place the caret in a heading without an ID");
  if ((id === "subscript" || id === "superscript") && !handled) status.toast(`${id === "subscript" ? "Subscript" : "Superscript"} can't contain spaces`);
}

// ---------------------------------------------------------------- UI wiring

const toolbar = new Toolbar($("#toolbar"), runCommand);
const status = new StatusBar();
const bubble = new SelectionBubble(() => view, runCommand);
const help = new Help((href) => window.dispatchEvent(new CustomEvent("open-link", { detail: href })));
view.scrollDOM.addEventListener("scroll", () => bubble.reposition(), { passive: true });
const sidebar = new Sidebar($("#sidebar"), {
  async open(path) {
    await openPath(path);
    // R2-L2: in a narrow window the overlay steps aside for the opened document, unless a
    // rename starts right away (New File names the file in the list).
    if (!narrowWindow.matches || currentPath !== path) return;
    setTimeout(() => {
      const el = document.activeElement;
      const renaming = el instanceof HTMLInputElement && sidebarEl.contains(el) && el.type !== "search" && !el.closest(".search");
      if (renaming) return;
      if (settings.sidebarVisible) toggleSidebar(false);
      else endPeek();
    });
  },
  openFolder: openFolderDialog,
  focusEditor() {
    // Back to the document (Escape in search, rename done): a narrow overlay steps aside too.
    if (narrowWindow.matches && settings.sidebarVisible) toggleSidebar(false, { moveFocus: false });
    endPeek();
    focusDoc();
  },
  folderLost(folder) {
    setSetting("folder", null);
    status.toast(`Folder “${basename(folder)}” is no longer available`);
  },
  async move(path, op) {
    if (path !== currentPath) {
      const to = await op();
      followMove(path, to);
      return to;
    }
    // R4-M7: a write in flight would recreate the file after it moved; let it finish first and
    // keep autosaves waiting (under the save lock) until the editor follows the file.
    clearTimeout(autosaveTimer);
    while (saving) await saving;
    clearTimeout(autosaveTimer);
    let result: { to: string | null } | { error: unknown };
    await holdSaveLock(
      (async () => {
        try {
          const to = await op();
          followMove(path, to);
          result = { to };
          return true;
        } catch (error) {
          result = { error };
          return false;
        }
      })(),
    );
    if ("error" in result!) throw result.error;
    return result!.to;
  },
});

/** After a file was renamed (`to`) or trashed (null): the editor follows if it's the open one. */
function followMove(from: string, to: string | null) {
  if (from !== currentPath) return;
  if (to) {
    currentPath = to;
    missingToastFor = null;
    setSetting("lastFile", to);
    sidebar.setActive(to);
    renderTitle();
    watchOpenFile(to);
    if (dirty) scheduleAutosave(); // the autosave cancelled for the move
  } else if (dirty) {
    // Trashed with unsaved edits: keep the text as an untitled document instead of discarding it.
    const text = view.state.doc.toString();
    loadDoc(text, null);
    dirty = true;
    renderTitle();
    status.toast("File moved to Trash; your unsaved text is still here");
  } else {
    loadDoc("", null);
  }
}

window.addEventListener("open-link", (e) => {
  const href = (e as CustomEvent<string>).detail;
  if (/^(https?|mailto):/i.test(href)) openUrl(href);
  else if (/\.(md|markdown|mdown|txt)(#.*)?$/i.test(href)) openPath(resolveRelative(href.replace(/#.*$/, "")));
});

document.querySelectorAll<HTMLButtonElement>("#view-controls [data-action]").forEach((btn) =>
  btn.addEventListener("click", () => runCommand(btn.dataset.action!)),
);
$("#st-font").addEventListener("click", () => runCommand("cycle_font"));
$("#st-mode").addEventListener("click", () => runCommand("toggle_preview"));
document.querySelectorAll<HTMLButtonElement>("#view-controls [data-mode]").forEach((btn) => {
  btn.addEventListener("click", () => chooseViewMode(btn.dataset.mode as ViewMode));
  // Radio-group keyboard pattern: arrows move between modes.
  btn.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = stepViewMode(step);
    setViewMode(next);
    document.querySelector<HTMLButtonElement>(`#view-controls [data-mode="${next}"]`)?.focus();
  });
});
$("#st-theme").addEventListener("click", () => runCommand("toggle_theme"));

// Window resizes move text under the selection bubble; keep it on its text (or hidden).
window.addEventListener("resize", () => bubble.reposition());

// D2: any pointer movement brings the faded title-bar controls back.
window.addEventListener("mousemove", () => document.body.classList.remove("typing"), { passive: true });

// D1: keep the centred title clear of the controls, whatever their width.
new ResizeObserver(([entry]) => {
  $("#titlebar").style.setProperty("--controls-w", `${Math.ceil(entry.contentRect.width)}px`);
}).observe($("#view-controls"));

// D1: in a narrow window the sidebar overlays the editor; clicking beside it closes it.
mainEl.addEventListener(
  "mousedown",
  (e) => {
    if (narrowWindow.matches && settings.sidebarVisible) {
      e.preventDefault();
      e.stopPropagation();
      toggleSidebar(false);
    }
  },
  { capture: true },
);

// R2-L2: Escape closes the narrow-window overlay (after the search field / bubble had their turn).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || !narrowWindow.matches || !settings.sidebarVisible) return;
  const target = e.target as Element;
  if (target.closest?.("dialog")) return; // Help handles its own Escape
  if (target instanceof HTMLInputElement && sidebarEl.contains(target) && !target.closest(".search")) return; // rename field
  e.preventDefault();
  toggleSidebar(false);
  focusDoc();
});

/*
 * Narrow windows: with the sidebar closed, resting the pointer at the window's left edge peeks it
 * in (like an auto-hiding dock). A peek is transient: it doesn't change the sidebarVisible setting,
 * doesn't take keyboard focus or dim the document, and slides away once the pointer moves back
 * over the document. Clicking a document in it opens that document and ends the peek.
 */
const PEEK_EDGE = 8; // px from the left edge that count as "at the edge"
const PEEK_DWELL = 150; // ms the pointer must rest there, so passing by doesn't trigger it
const PEEK_LINGER = 300; // ms grace after leaving before it hides
let peekTimer = 0;

const peeking = () => document.body.classList.contains("sidebar-peek");

function endPeek() {
  clearTimeout(peekTimer);
  peekTimer = 0;
  document.body.classList.remove("sidebar-peek");
}

function canPeek(e: MouseEvent) {
  return (
    narrowWindow.matches &&
    !settings.sidebarVisible &&
    e.buttons === 0 && // not while drag-selecting text
    !document.querySelector("dialog[open]") &&
    e.clientY > $("#titlebar").offsetHeight // the traffic lights live up there
  );
}

document.addEventListener("mousemove", (e) => {
  if (!peeking()) {
    if (canPeek(e) && e.clientX <= PEEK_EDGE) {
      peekTimer ||= window.setTimeout(() => {
        peekTimer = 0;
        bubble.hide();
        document.body.classList.add("sidebar-peek");
      }, PEEK_DWELL);
    } else if (peekTimer) {
      clearTimeout(peekTimer);
      peekTimer = 0;
    }
    return;
  }
  // Keep it while the pointer is over it, or while the keyboard is in it (search, rename).
  const over = e.clientX <= sidebarEl.getBoundingClientRect().right + 16;
  if (over || sidebarEl.contains(document.activeElement)) {
    clearTimeout(peekTimer);
    peekTimer = 0;
  } else {
    peekTimer ||= window.setTimeout(endPeek, PEEK_LINGER);
  }
});

// Clicking the document, Escape, or widening the window ends a peek; keyboard focus stays put.
mainEl.addEventListener("mousedown", () => peeking() && endPeek());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && peeking() && !e.defaultPrevented) {
    endPeek();
    if (sidebarEl.contains(document.activeElement)) focusDoc();
  }
});
narrowWindow.addEventListener("change", endPeek);

// Drag highlight only; the drop itself arrives as "dropped-paths" after the backend granted access.
getCurrentWebview().onDragDropEvent((e) => {
  document.body.classList.toggle("dragging", e.payload.type === "enter" || e.payload.type === "over");
});

/** Open a dropped .md file, or browse a dropped folder. */
async function openDropped(paths: string[]) {
  document.body.classList.remove("dragging");
  const [first] = paths;
  if (!first) return;
  if (/\.(md|markdown|mdown|txt)$/i.test(first)) return openPath(first);
  try {
    await ipc.listDir(first); // only succeeds for directories
    setSetting("folder", first);
    await sidebar.setFolder(first);
    toggleSidebar(true);
  } catch {
    status.toast("Drop a Markdown file or a folder");
  }
}

// Clicking the empty margin around the text column should still place the caret.
$("#editor").addEventListener("mousedown", (e) => {
  if (e.target === e.currentTarget) {
    e.preventDefault();
    view.focus();
  }
});

async function openPending() {
  const [first] = await ipc.takePendingFiles();
  if (first) await openPath(first);
  return Boolean(first);
}

async function init() {
  await loadSettings();
  const lastFile = settings.lastFile; // read before anything can overwrite it
  applyTheme(settings.theme);
  applyFontSize(settings.fontSize);
  applyFont(settings.font);
  toolbar.setPinned(settings.toolbarPinned);
  document.body.classList.toggle("no-statusbar", !settings.statsVisible);
  // Anything typed before the editor was ready stays (R3-L1).
  const early = view.state.doc.toString();
  loadDoc(early, null, { remember: false });
  if (early) {
    dirty = true;
    renderTitle();
  }
  toggleSidebar(settings.sidebarVisible, { moveFocus: false });
  setViewMode(VIEW_ORDER.includes(settings.viewMode) ? settings.viewMode : "edit");

  // R4-L1: quitting must work while the first library scan runs (large or slow folders).
  let quitting = false;
  await listen("quit-requested", async () => {
    invoke("quit_ack").catch(() => {}); // tells the backend we're alive (no force-quit on a 2nd ⌘Q)
    if ((await readyToLeave()) && !quitting) {
      quitting = true;
      // Both waiters of one settle resume together; one quit_app is enough.
      await invoke("quit_app")
        .catch(() => {})
        .finally(() => (quitting = false));
    }
  });
  await appWindow.onCloseRequested(async (e) => {
    if (!(await readyToLeave())) e.preventDefault();
  });

  if (settings.folder) await sidebar.setFolder(settings.folder).catch(() => setSetting("folder", null));

  await listen<string>("menu", (e) => runCommand(e.payload));
  await listen("fs-changed", () => {
    sidebar.scheduleRefresh();
    checkOpenFileOnDisk();
  });
  await listen("open-files", () => openPending());
  await listen<string[]>("dropped-paths", (e) => openDropped(e.payload));

  const opened = await openPending();
  // R3-L1: text typed while starting up must not be replaced by the last file.
  const typed = () => dirty || view.state.doc.length > 0 || currentPath !== null;
  if (!opened && lastFile && !typed()) {
    await Promise.all([ipc.readFile(lastFile), ipc.fileMtime(lastFile)])
      .then(([text, mtime]) => {
        if (!typed()) loadDoc(text, lastFile, { mtime });
      })
      .catch(() => setSetting("lastFile", null));
  }
}

init();
