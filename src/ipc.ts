import { invoke } from "@tauri-apps/api/core";

export interface Summary {
  title: string | null;
  snippet: string;
  words: number;
  /** Milliseconds since the Unix epoch. */
  modified: number;
}

export interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
  children: Entry[];
  summary: Summary | null;
}

export const ipc = {
  readFile: (path: string) => invoke<string>("read_file", { path }),
  /**
   * Atomic write; resolves to the file's new modification time (ms). With `expectedMtime` (ms, as
   * from `fileMtime`/`writeFile`), an existing file whose mtime differs is not written and the
   * promise rejects with a string starting with "CONFLICT:". A missing file is written as before.
   */
  writeFile: (path: string, contents: string, expectedMtime?: number | null) =>
    invoke<number>("write_file", { path, contents, expectedMtime: expectedMtime ?? null }),
  /** Modification time (ms), or null if the file no longer exists. */
  fileMtime: (path: string) => invoke<number | null>("file_mtime", { path }),
  listDir: (path: string) => invoke<Entry[]>("list_dir", { path }),
  createFile: (dir: string) => invoke<string>("create_file", { dir }),
  renamePath: (path: string, newName: string) => invoke<string>("rename_path", { path, newName }),
  trashPath: (path: string) => invoke<void>("trash_path", { path }),
  /** Shows the file or folder in Finder (backend checks access first). */
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  /** Watches the library folder recursively (replaces the previous library watch); emits "fs-changed". */
  watchDir: (path: string) => invoke<void>("watch_dir", { path }),
  /**
   * Watches the open file's folder (non-recursively, in its own slot next to the library watch)
   * so edits by other apps emit "fs-changed" even for files outside the library. Replaces the
   * previous open-file watch; pass null to stop it. Rejects for paths without access.
   */
  watchOpenFile: (path: string | null) => invoke<void>("watch_open_file", { path }),
  renderMarkdown: (markdown: string) => invoke<string>("render_markdown", { markdown }),
  exportHtml: (markdown: string, title: string, path: string) => invoke<void>("export_html", { markdown, title, path }),
  printWindow: () => invoke<void>("print_window"),
  takePendingFiles: () => invoke<string[]>("take_pending_files"),
  // Dialogs run in the backend so it can grant access to exactly what the user picked.
  pickFile: () => invoke<string | null>("pick_file"),
  pickFolder: () => invoke<string | null>("pick_folder"),
  pickSavePath: (directory: string | null, fileName: string, kind: "markdown" | "html") =>
    invoke<string | null>("pick_save_path", { directory, fileName, kind }),
};

export const basename = (p: string) => p.split("/").pop() ?? p;
export const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
export const stripExt = (name: string) => name.replace(/\.(md|markdown|mdown|txt)$/i, "");
