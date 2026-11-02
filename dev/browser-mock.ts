// Dev-only harness: loads the real app UI in a browser with the Tauri backend mocked.
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import cheatSheet from "../tests/cheat-sheet.md?raw";

const DIR = "/Users/demo/Notes";
const now = Date.now();
const FILES: Record<string, string> = {
  [`${DIR}/welcome.md`]: `# Welcome to Focus

A quiet place to write. Open a markdown file from the sidebar, drag one in from anywhere, or just start typing here.

This editor follows a simple philosophy: when you write, the interface should disappear. The toolbar hides. The syntax fades into the background. Only your words stay sharp.

## What you can do

- **Open files** — click *Open* in the sidebar, or drag a \`.md\` file onto the window.
- **Preview** — toggle the eye icon to see rendered output.
- **Focus mode** — dims everything except the paragraph you are working on.
- [x] Themes — warm paper and deep charcoal
- [ ] Write something ==important==

> Simplicity is the ultimate sophistication.

| Key | Action |
| --- | ---: |
| ⌘B | Bold |
| ⌘I | Italic |
`,
  [`${DIR}/cheat-sheet.md`]: cheatSheet,
  [`${DIR}/the-art-of-focus.md`]: "# The Art of Focus\n\nThere is a particular kind of silence that comes before good writing.",
  [`${DIR}/markdown-reference.md`]: "# Markdown Reference\n\nA quick tour of the syntax this editor understands.",
  [`${DIR}/project-notes.md`]: "# Project Notes — Q4\n\nA scratchpad for planning, decisions and loose ends.",
};

const summary = (text: string, i: number) => {
  const lines = text.split("\n").filter((l) => l.trim());
  const title = lines[0]?.startsWith("#") ? lines[0].replace(/^#+\s*/, "") : null;
  return {
    title,
    snippet: lines.slice(title ? 1 : 0).join(" ").replace(/[*_`=#>|-]/g, "").slice(0, 140),
    words: text.split(/\s+/).filter(Boolean).length,
    modified: now - i * 3_600_000,
  };
};

// Simulated disk: modification times, an optional slow write, and a hook to edit files "from another app".
const MTIMES: Record<string, number> = Object.fromEntries(Object.keys(FILES).map((p, i) => [p, now - i * 3_600_000]));
const disk = {
  writeDelayMs: 0,
  failWrites: false,
  failTrash: false,
  quit: 0,
  /** true = first button, false = second; a string answers with that button label. */
  askAnswer: true as boolean | string,
  /** Answers for the next dialogs, in order (each like askAnswer); askAnswer once empty. */
  answers: [] as (boolean | string)[],
  asks: [] as string[],
  files: FILES,
  /** Settings written via set_setting, and the current watch targets. */
  settings: {} as Record<string, unknown>,
  watches: {} as Record<string, string | null>,
  /** Change a file as another app would, then fire the watcher event. */
  async externalEdit(path: string, text: string | null) {
    if (text === null) {
      delete FILES[path];
      delete MTIMES[path];
    } else {
      FILES[path] = text;
      MTIMES[path] = Date.now() + 1;
    }
    const { emit } = await import("@tauri-apps/api/event");
    await emit("fs-changed", null);
  },
};
(window as any).__disk = disk;

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

mockWindows("main");
mockConvertFileSrc("macos");
mockIPC(
  (cmd, args: any) => {
    switch (cmd) {
      case "list_dir":
        return Object.entries(FILES).map(([path, text], i) => ({
          name: path.split("/").pop(), path, is_dir: false, children: [], summary: summary(text, i),
        }));
      case "read_file":
        return FILES[args.path] ?? "";
      case "quit_app":
        disk.quit++;
        return null;
      case "write_file":
        if (disk.failWrites) return Promise.reject("Read-only file system (os error 30)");
        return new Promise((resolve, reject) =>
          setTimeout(() => {
            // Compare-and-swap like the backend: checked just before the (atomic) write lands.
            const expected = args.expectedMtime ?? null;
            if (expected !== null && args.path in FILES && MTIMES[args.path] !== expected)
              return reject(`CONFLICT: “${args.path.split("/").pop()}” was changed on disk`);
            FILES[args.path] = args.contents;
            MTIMES[args.path] = Date.now();
            resolve(MTIMES[args.path]);
          }, disk.writeDelayMs),
        );
      case "create_file": {
        let n = 1, path = `${args.dir}/Untitled.md`;
        while (path in FILES) path = `${args.dir}/Untitled ${++n}.md`;
        FILES[path] = "";
        MTIMES[path] = Date.now();
        return path;
      }
      case "trash_path":
        if (disk.failTrash) return Promise.reject("Operation not permitted (os error 1)");
        delete FILES[args.path];
        delete MTIMES[args.path];
        return null;
      case "rename_path": {
        const to = `${args.path.slice(0, args.path.lastIndexOf("/"))}/${args.newName}`;
        if (to in FILES) throw "A file with that name already exists";
        FILES[to] = FILES[args.path];
        MTIMES[to] = MTIMES[args.path];
        delete FILES[args.path];
        delete MTIMES[args.path];
        return to;
      }
      case "file_mtime":
        return args.path in FILES ? MTIMES[args.path] ?? now : null;
      case "plugin:dialog|ask":
      case "plugin:dialog|confirm":
      case "plugin:dialog|message":
        disk.asks.push(String(args.message));
        const answer = disk.answers.length ? disk.answers.shift()! : disk.askAnswer;
        if (typeof answer === "string") return answer;
        // Real dialogs return the clicked button's label; ask() compares it with okLabel.
        if (args.buttons && typeof args.buttons === "object") {
          // e.g. { OkCancelCustom: ["Keep Mine", "Use Disk Version"] } or { OkCustom: "Done" }
          const labels = Object.values(args.buttons as Record<string, string | string[]>).flat();
          return answer ? labels[0] : (labels[1] ?? "Cancel");
        }
        if (args.buttons === "YesNo") return answer ? "Yes" : "No";
        if (args.buttons === "OkCancel") return answer ? "Ok" : "Cancel";
        return answer;
      case "render_markdown":
        return args.markdown
          .split(/\n{2,}/)
          .map((b: string) => (/^#{1,6} /.test(b) ? `<h${b.indexOf(" ")}>${escape(b.replace(/^#+ /, ""))}</h${b.indexOf(" ")}>` : `<p>${escape(b)}</p>`))
          .join("\n");
      case "take_pending_files":
        return [];
      case "get_settings": {
        const params = new URLSearchParams(location.search);
        return {
          lastFile: `${DIR}/welcome.md`,
          folder: DIR,
          sidebarVisible: true,
          theme: params.get("theme") ?? "light",
          // ?bad=1 returns corrupt values to exercise the frontend's settings validation
          ...(params.has("bad") ? { fontSize: "huge", font: "comic", theme: 42, viewMode: "x", typewriter: "yes" } : {}),
        };
      }
      case "set_setting":
        disk.settings[args.key] = args.value;
        return null;
      case "watch_dir":
      case "watch_open_file":
        disk.watches[cmd] = args.path ?? null;
        return null;
      default:
        return null; // window/menu/event writes: no-ops
    }
  },
  { shouldMockEvents: true },
);

// Fake the native window chrome so the layout reads like the app.
document.body.innerHTML = (await fetch("/index.html").then((r) => r.text())).match(/<body>([\s\S]*)<\/body>/)![1];
document.body.insertAdjacentHTML(
  "afterbegin",
  `<style>#titlebar::before{content:"";position:absolute;left:16px;top:50%;width:52px;height:12px;transform:translateY(-50%);
   background:radial-gradient(circle at 6px 6px,#ff5f57 5.5px,transparent 6px),radial-gradient(circle at 26px 6px,#febc2e 5.5px,transparent 6px),radial-gradient(circle at 46px 6px,#28c840 5.5px,transparent 6px)}</style>`,
);
await import("../src/main.ts");
