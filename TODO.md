# Review findings — fix list

Source: four review agents (backend/security, editor core, app shell, UI/design) on 2026-10-29.
Each item: where · what goes wrong · fix. Tick when fixed **and** covered by a test or a verified repro.

## Critical

- [x] **C1** `src/editor/livePreview.ts` — Image/link spanning a line break (`![a long⏎alt](x.png)`, link with multi-line title) → `Decoration.replace` across a newline → CodeMirror throws, editor stops accepting input (reproduced). Fix: never replace across lines (safe-replace helper).
- [x] **C2** `src/main.ts` `init()` — `loadDoc("", null)` clears `lastFile` before it is read → last document never reopens on launch (confirmed). Fix: read `lastFile` first / don't persist for the initial empty doc.

## High

- [x] **H1** `src-tauri/src/export.rs` — User text containing U+E000/U+E001 hijacks the heading-id post-processing: attribute injection (`onmouseover=…`) in exported HTML, text between markers dropped; `escape()` doesn't escape `"`. Also indented code `    # x {#y}` treated as heading. Fix: strip sentinels from input, escape quotes, only apply id right before `</hN>`, skip indented code.
- [x] **H2** `src/main.ts` — External change to the open file (another editor, iCloud, git) is overwritten by the next autosave; deleted file is recreated. Fix: track mtime on load; on `fs-changed` reload if clean, ask if dirty; check mtime before write.
- [x] **H3** `src/main.ts` `saveDoc`/`loadDoc` — In-flight save sets `dirty=false` even if the user typed meanwhile → switching file / ⌘Q within ~600 ms loses keystrokes; stale `autosaveTimer` survives `loadDoc`. Fix: compare doc snapshot after write; clear timer in `loadDoc`.
- [x] **H4** `src/editor/commands.ts` `toggleInline` — Bold with caret right after `**bold**` throws "Selection points outside of document"; `**bold** xy` selects wrong range (reproduced). Fix: clamp mapped selection into the unwrapped content.
- [x] **H5** `src/editor/commands.ts` `moveCell` — Tables without outer pipes (`a | b`) → Tab throws (reproduced). Fix: treat line start/end as virtual pipes; bail if no cells.
- [x] **H6** `src/editor/commands.ts` `insertFootnote` — Caret at/after trailing whitespace → `Text\n\n[^1]: [^1]` (reproduced). Fix: place ref at `min(head, trimFrom)`, map caret.
- [x] **H7** `src/ui/sidebar.ts` — `fs-changed` refresh during inline rename replaces the DOM → typed name lost (e.g. right after New File). Fix: defer refresh while renaming.
- [x] **H8** `src-tauri/src/files.rs` `scan_dir` — Follows symlinks with no cycle detection → link loops / opening `~` hang `list_dir`; one unreadable entry hides the whole folder. Fix: don't follow symlinked dirs, depth/entry cap, skip unreadable entries.
- [x] **H9** `src-tauri/src/files.rs`, `export.rs` — File commands accept any absolute path; asset scope is `$HOME/**`. Fix: backend allowlist (open folder + dialog/Finder-picked files), canonicalised.
- [x] **H10** `src-tauri` commands are sync → run on the main thread, long `list_dir`/`trash` freeze UI (unverified for Tauri 2.12). Fix: `async` commands.

## Medium

- [x] **M1** `main.ts` — Save failure blocks ⌘Q / window close forever (only a toast). Fix: on failure ask "Discard / Cancel"; second ⌘Q while pending is ignored → guard re-entry.
- [x] **M2** `main.ts` — In Read view, ⌘B/⌘1/⌘F etc. silently edit/search the hidden editor. Fix: ignore edit commands in Read (toast "Switch to Edit to format").
- [x] **M3** `sidebar.ts` `refresh` swallows errors → deleted library folder shows raw OS error on every launch. Fix: propagate; clear folder setting, show empty state.
- [x] **M4** `files.rs` `rename_path` — case-only rename fails on APFS; `v1.2` loses `.md`; `.markdown` silently becomes `.md`; TOCTOU overwrite. Fix: same-file check, keep original extension unless user typed a markdown one, no-clobber rename.
- [x] **M5** `files.rs` `write_file` not atomic → crash/full disk mid-save truncates the note. Fix: temp file + fsync + rename. Same for `create_file` (`create_new`).
- [x] **M6** `main.ts` preview — `#fn-1` / heading anchor clicks do nothing; `decodeURI` throws on `%zz` and kills preview render; out-of-order async renders. Fix: in-preview anchor scroll, safe decode, render sequence guard.
- [x] **M7** `src/editor/tables.ts` — Tables inside blockquotes render a `>` junk column. Fix: strip container prefixes.
- [x] **M8** Performance on large docs: status bar recounts words on every caret move; tables field walks the whole tree on every selection; code-block/quote line decorations not clamped to viewport. Fix: cache counts per doc, prune tree walk, clamp to viewport.
- [x] **M9** `src/editor/focusMode.ts` typewriter re-centres during pointer drags (jumpy) and can scroll a newly opened file to the old caret. Fix: skip `select.pointer`, single pending rAF, state check.
- [x] **M10** `main.ts` quit: hung webview → ⌘Q never quits. Fix: Rust-side fallback (second ⌘Q within a few seconds force-quits after a final save attempt is impossible → just exit).

## Low

- [x] **L1** `settings.ts` — stored values not validated (bad `fontSize` → `NaNpx`, bad `font`/`theme`). Validate against `DEFAULTS`.
- [x] **L2** `sidebar.ts` — trash failure is an unhandled rejection; trashing the open, dirty file discards edits silently.
- [x] **L3** `sidebar.ts` — keyboard nav skips folder rows; focus lost after refresh; no shortcut to search.
- [x] **L4** `commands.ts` — ordered-list numbering counts blank lines; Italic at caret inside bold inserts `**`.
- [x] **L5** `syntax.ts` — any line starting `: ` after prose becomes a definition (false positives). **Won't fix:** this *is* a definition list per Markdown Extra/Pandoc and comrak renders it the same way; diverging would make editor and preview disagree. Documented the `\:` escape in Help (L9).
- [x] **L6** `emoji.ts` — completion active inside code blocks/inline code.
- [x] **L7** `widgets.ts` — checkbox widgets recreated on every keystroke (`pos` in `eq`).
- [x] **L8** `files.rs` — non-UTF-8 files can't be opened; poisoned mutex `unwrap`.
- [x] **L9** Help — missing Undo/Redo, Actual Size, theme items; "Find" listed under Files; says "drop files" but only the first is opened.
- [x] **L10** Menu — `⌘E` replaces standard "Use Selection for Find"; `⌥⌘I` collides with devtools in debug; ⌘+ alias on non-US layouts; missing Window ▸ Zoom / Bring All to Front. → Added Zoom + Bring All to Front; ⌘E kept for Inline Code (documented in menu.rs); ⌥⌘I clash is debug-only; ⌘+ alias not possible (one accelerator per menu item in muda).
- [x] **L11** Undo while focus is in the CodeMirror search field undoes the document.
- [x] **L12** CSP `img-src https:` — remote images load automatically (tracking pixels).

## Design

- [x] **D1** No narrow-window layout: at 720 px title collides with controls, Split leaves a ~175 px column. Sidebar overlay < 900 px, disable Split when too narrow, title/controls spacing.
- [x] **D2** Title bar has 9 controls (Inkwell 6) and the status bar duplicates Edit/Serif/Light. Reduce / fade while typing.
- [x] **D3** Sidebar micro text 10 px (time, meta, footer) → 11–12 px.
- [x] **D4** Focus-mode dim too faint (measured 2.1:1 dark, 1.7:1 light) → ~3:1.
- [x] **D5** Light `--syntax` #97938b is 2.93:1 (comment claims 3:1) → #8f8b83 (3.25:1).
- [x] **D6** Accent identity: blue UI vs amber icon. Option: amber caret/selection (contrast checked).
- [x] **D7** Always-visible scrollbar; weak active card (1.13:1) and hover; headings sit too far from their paragraph.
- [x] **D8** Icon stroke weights inconsistent at 14/16 px; export vs new-file glyphs look alike; no `:disabled` button state.

## After fixes

- [x] **R1** Re-run the same four reviews (backend/security, editor core, app shell, UI/design) on the fixed code and triage any new findings.

---

# Round 2 — findings from the re-review

Verified by me: R2-C1 (Tauri path resolver: absolute path replaces the base dir), R2-H1 (listeners inside `syncControls`, my bad paste). Editor items were reproduced by the reviewer with scripts.

### Round-1 fixes that did not fully hold
- [x] **H9 → R2-C1** store plugin bypasses the allowlist (see below).
- [x] **H10** `render_markdown` is still a sync command → runs on the main thread; make it async.
- [x] **M7** tables inside list items still broken (→ R2-M6).
- [x] **L4** Italic at a word *edge* inside bold still inserts `**` (→ R2-L4).
- [x] **L9** Help: Actual Size / theme items missing; sidebar footer still says "Drop Markdown files" (plural).
- [x] **M1** "File Missing → Not Now" on quit cancels quit with no discard option (→ R2-H3).

## Critical
- [x] **R2-C1** `capabilities/default.json` `store:default` + Tauri `path.resolve` — `load("/any/abs/path")` reads/writes any JSON-shaped file, incl. `scope.json` (→ grant `/`) or overwrite `~/.zshrc`. Fix: remove `store:*` from the webview; settings via validated backend commands; keep `scope.json` unreachable.

## High
- [x] **R2-H1** `main.ts:412-434` resize/mousemove listeners, ResizeObserver and capture mousedown are inside `syncControls()` → added again on every toggle (leak). Move to module level.
- [x] **R2-H2** `scope.rs` allowed folder grants *every* file type incl. dotfiles → library = `~` exposes `~/.ssh`, `~/.zshrc`, LaunchAgents. Restrict read/write/create/rename to Markdown (+ `.html` for export), reject hidden path components.
- [x] **R2-H3** `main.ts` "File Missing → Not Now" re-prompts on every autosave; quit has no way out but "Save Again". Stop autosave until explicit ⌘S; offer Discard on quit.
- [x] **R2-H4** Dark theme: selection and `==highlight==` blend to nearly the same olive (#4e4027 vs #544a26). Distinct hue/strength.

## Medium
- [x] **R2-M1** `scope.rs` asset scope: allowing one file grants its whole parent tree recursively to `asset://`; never revoked on trim. Non-recursive for single files; rebuild after pruning.
- [x] **R2-M2** `files.rs` trash/rename on a symlinked `.md` act on the *target*; linked files outside the scope still leak their summary to the sidebar. Operate on the link (check canonical parent); skip out-of-scope links in scans.
- [x] **R2-M3** `write_atomic` silently overwrites read-only (0444) files; temp file has fixed name (collisions, symlink follow, briefly world-readable). Respect read-only; unique `create_new` temp; set perms before writing.
- [x] **R2-M4** `lib.rs` double ⌘Q can force-quit a *slow* (not hung) webview → unsaved edits lost. Only force if the first press is ≥ ~1 s old and unacked.
- [x] **R2-M5** `main.ts` saves can still overlap with ≥2 waiters; `diskMtime` assigned after the path changed (Save As/rename/trash during a write → false prompts / recreated file); reload/file-switch can drop keystrokes typed during the read; stale `lastSaveError`.
- [x] **R2-M6** `tables.ts`/`commands.ts` tables inside list items (`- | a | b |`) get a junk column; appended rows lose quote/list prefix and outer pipes.
- [x] **R2-M7** `tables.ts` cheaper update can leave a table stale as source (select across a table then click away; caret at a quoted/list table's line start). One overlap predicate for build + update.
- [x] **R2-M8** `main.ts` Read view swallows ⌘Z in text fields (toast instead of undo); opening a file in Read view moves focus into the hidden editor; disabled Split still selectable by keyboard/⇧⌘P/⌥⌘2.
- [x] **R2-M9** H2 only covers files inside the watched folder; a file opened from elsewhere never gets external-change reloads. Watch the open file's folder too.

## Low
- [x] **R2-L1** `bubble.ts` hides when the selection *start* is scrolled off (hit-test a visible point); bubble covers the line above on the first line (flip below when no room).
- [x] **R2-L2** Narrow overlay: no Escape to close, focus not moved into sidebar, stays open over the newly opened doc.
- [x] **R2-L3** `sidebar.ts` `renaming` can stick at true if the input is removed without blur → sidebar stops refreshing.
- [x] **R2-L4** `commands.ts` word-wrap formatting: word edges inside bold; inside link URL / inline code (corrupts); duplicate carets in one word.
- [x] **R2-L5** `isDelimiterRow` matches body rows made of dashes (Tab skips data).
- [x] **R2-L6** Remote images: two copies of one URL; not keyboard-reachable; `http:` passes placeholder but CSP blocks it.
- [x] **R2-L7** Typewriter: a click no longer re-centres (skip only while dragging).
- [x] **R2-L8** `files.rs` rename edge cases: `renamex_np` unsupported on some volumes (fallback); hard links treated as same file; renaming an allowed root folder loses access; corrupt `scope.json` silently resets access.
- [x] **R2-L9** `livePreview.ts` comment overstates the try/catch (only the `add()` guard prevents the apply-time throw); `file_summary` still `read_to_string` (no Latin-1 summary); misleading "no access" toast when the library folder vanishes.
- [x] **R2-L10** Design: light selection a bit faint (.22 → .30); disabled Split needs a tooltip (pointer-events:none blocks it); stray hairline above help section titles; narrow-overlay scrim too faint in light; footnote ref amber not link-blue; Focus toggle pressed state grey instead of amber.

### Known limitations after round 2
- A sidebar rename/trash that happens while a save is already writing can still recreate the old file (needs the sidebar to await the save, or backend support).
- Image folders forbidden after list trimming stay unservable until relaunch (Tauri can't revoke asset grants).
- A corrupt settings.json is overwritten on the next write without a backup (scope.json gets one).

## After round 2
- [x] **R2-R** Re-run the four reviews once more.

## Round 2 — workstreams (one subagent each; disjoint files)
| Stream | Owns | Items | Status |
|---|---|---|---|
| A backend/security | `src-tauri/**`, `src/settings.ts`, `src/ipc.ts`, `dev/browser-mock.ts` | R2-C1, R2-H2, R2-M1, R2-M2, R2-M3, R2-M4, H10, R2-L8, R2-L9 (Rust), R2-M9 (backend) | **done** — verified: store plugin gone from capabilities/Rust/npm, 33 Rust tests, clippy clean, tsc clean. Known limits: forbidden asset paths unservable until relaunch; corrupt settings.json not backed up. New ipc: `watchOpenFile(path\|null)`. |
| B editor core | `src/editor/**`, `tests/**`, `package.json` | M7/R2-M6, R2-M7, L4/R2-L4, R2-L5, R2-L6, R2-L7, R2-L9 (comment) | **done** — verified: 128 checks pass, tsc clean. Follow-ups: main.ts binds `loadRemoteImages(view)` (livePreview.ts) to a menu item + re-renders preview (C); CSS for `.remote-image.insecure` (D) |
| C app shell | `src/main.ts` | R2-H1, R2-H3, M1, R2-M5, R2-M8, R2-M9 (frontend), R2-L2 + follow-ups from B/D | **done** — verified: no listeners inside syncControls, tsc clean, 128 checks, 33 Rust tests, clippy clean. Added View ▸ Load Remote Images; disabled Split ignores click/arrows/⌥⌘2/⇧⌘P. |
| D design/UI | `src/styles/**`, `src/ui/bubble.ts`, `src/ui/help.ts`, `src/ui/sidebar.ts`, `index.html` | R2-H4, R2-L1, R2-L3, R2-L10, L9 | **done** — verified: tsc clean, 128 checks, screenshots r2-*.png checked. Also fixed: native ::selection doubled the CM selection tint. Follow-ups for C: ignore clicks/arrow keys/⌥⌘2 on aria-disabled Split. CSS for `.remote-image.insecure` added (verified in chrome.css). |

---

# Round 3 — findings from the third review

Round-2 fixes verified to hold: R2-C1, R2-H2 (one hole → R3-H1), R2-M1–M4, H10, R2-L5–L8, R2-H1, R2-H3/M1, R2-M8, R2-M9, R2-L2, R2-M7 (12k-step fuzz, 0 mismatches), C1 (30k-doc fuzz, 0 crossing replaces), R2-L4, R2-L6, R2-L7, R2-L1, L9.
Verified by me: R3-H1 chain (rename accepts folders → missing scope.json → migrate_legacy reads webview-writable settings.json).

### Round-2 fixes that did not fully hold
- [x] **R2-M5 → R3-H2** keystrokes typed *during the final write* still lost (see below).
- [x] **R2-M6 → R3-M3** appended table row loses indentation when the table isn't on the list-marker line.

## High
- [x] **R3-H1** `files.rs` rename_path + `scope.rs` migrate_legacy: a compromised webview with a broad library can rename Focus's app-data folder (→ scope.json gone), set `folder` to `/` via set_setting, and get it imported as an allowed root on next launch; folder renames can also rename ~/Library, ~/Desktop… Fix: remove/neutralise legacy migration (backend-only marker), refuse folder renames of app-data/config dirs and of ancestors of `$HOME/Library` (consider allowing folder renames only for folders the sidebar shows, i.e. containing Markdown).
- [x] **R3-H2** `main.ts` settleDoc/openPath/newDoc/quit: text typed while the last save is writing is lost on file switch / New / Quit (reproduced: "BBB" typed during a 300 ms write is gone). Fix: `while (dirty)` save loop (bounded) before leaving the document.

## Medium
- [x] **R3-M1** `main.ts` "Not Now" answered while a quit/switch waits on that save → the waiter writes anyway and recreates the declined file. Snapshot `missingAcknowledged` before waiting; bail if it flipped.
- [x] **R3-M2** `settings.ts`/`main.ts` queued setting writes can be lost at quit/close (app.exit races them). Export a flush and await it before `quit_app` / window close.
- [x] **R3-M3** see R2-M6 above (list-indented table rows; comrak then breaks the list). Take the continuation prefix from the table's last row; test indentation.
- [x] **R3-M4** `main.ts` failed Save As still retargets currentPath/lastFile/sidebar highlight; restore previous state on failure.
- [x] **R3-M5** `capabilities` `opener:allow-reveal-item-in-dir` is unscoped (webview can probe any path's existence). Backend `reveal` command through check_entry; drop the permission.
- [x] **R3-M6** watcher storms: one IPC event per raw notify event, no filtering/coalescing → each burst = full scan (own autosaves, ~/Library writes when library = ~). Filter (non-hidden Markdown/dirs, skip *.focus-tmp), coalesce ~250 ms; skip UF_HIDDEN / ~/Library in scans; cap bytes summarised per scan.
- [x] **R3-M7** `livePreview.ts` large selection: activeLines Set walks every selected line on every rebuild (~38 ms with ⌘A on 200k lines) → scrolling stutters. Range check instead of a Set.
- [x] **R3-M8** design: dark narrow-overlay scrim *brightens* (mixes light --fg); use a black-based scrim in dark.
- [x] **R3-M9** design: light `--code-number` #9a6f1c (3.93:1) and `--code-string` #5b7f48 (4.0:1) on --surface fail AA; dark `--muted` on `--surface` 4.01:1 (inline code, kbd, placeholders).

## Low
- [x] **R3-L1** `main.ts`: typing during startup overwritten by lastFile load (skip if dirty); external change during our own save never picked up (recheck after save); narrow-window launch with sidebarVisible focuses the covered editor; "No remote images" toast when all are already loaded.
- [x] **R3-L2** `commands.ts`: Bold/Italic right after inline code or a bare URL is a silent no-op (literal check should need from < pos < to); Italic between two spaces inside bold inserts `**`; `\\|` (escaped backslash) treated as escaped pipe in table cells.
- [x] **R3-L3** remote images: http placeholder can't be clicked to edit its source (ignoreEvent); loadRemoteImages may miss images on huge docs (partial parse).
- [x] **R3-L4** backend: `.txt`/`.md` write surface under a broad root (CMakeLists.txt, requirements.txt, CLAUDE.md…) — consider skipping UF_HIDDEN/~/Library and known tool files; least-privilege capabilities (core:default pulls menu/tray/image/event emit); Scope::save snapshot written outside the lock; no size cap on read_file (multi-GB → OOM abort); rename case/NFC edge; apply_heading_ids quadratic. **Status:** read cap, Scope::save ordering, linear heading ids, least-privilege capabilities done (A). Left open: .txt/tool-file write surface, rename case/NFC edge. **Closed in R4:** NFC/case rename edge fixed by R4-H1; ~/Library + Finder-hidden excluded by R4-M4. Remaining .txt write surface inside a user-picked library accepted as by design.
- [x] **R3-L5** design: highlight vs selection differ by hue only (add a non-colour cue, e.g. underline on ==mark==); check (in the harness) whether `theme.css:24` `:focus ::selection` actually re-tints CM text (reviewer claim, looks doubtful — the selector needs a focused *descendant* of .cm-content); disabled `.btn` at .35 nearly invisible (.45); help shortcut rows uneven height; help sub-headings flush to the top after scroll (scroll-padding); insecure image placeholder needs a glyph.

## After round 3
- [x] **R3-R** Re-run the four reviews.

---

# Round 4 — findings from the fourth review

Round-3 fixes verified to hold: R3-H1 escalation chain (migration gone; empty allowlist on missing scope.json), R3-H2 (typing during write kept on switch/quit/New/untitled), R3-M1, R3-M2, R3-M3 (lezer-checked across 25 container shapes), R3-M5, R3-M6, R3-M7 (3k-doc fuzz, 0 mismatches), R3-M8, R3-M9, R3-L2, R3-L3, R3-L4 parts. Capabilities cover every frontend call (checked against tauri 2.12.5 sources).
Verified by me: R4-H1 (entry_path keeps webview-typed case; disk is case-insensitive APFS).

## High
- [x] **R4-H1** `scope.rs` entry_path / check_rename_dir: case- or NFC/NFD-changed spelling (`~/library`) bypasses the protected-dir and library-root guards → ~/Library renameable. Compare canonicalized dir (realpath gives on-disk case) or (dev, ino); same for follow_rename/rebase. Test with case-changed `Library`.

## Medium
- [x] **R4-M1** `files.rs` rename_path: folders directly in `$HOME` (~/Pictures, ~/Music, ~/Applications…) still renameable. Refuse direct children of `$HOME` (or only allow folders the sidebar shows).
- [x] **R4-M2** regression: library inside ~/Library (iCloud Drive, Obsidian iCloud vaults) — watcher drops every event (no sidebar refresh, no external-change detection → stale overwrite risk), all folder renames refused. Filter/skip only paths *below* the root; protect ~/Library itself + ancestors, not its contents.
- [x] **R4-M3** `export.rs` export_html: any `.html` inside a library root writable (site/index.html → stored XSS). One-time grant for the exact pick_save_path(kind=html) path.
- [x] **R4-M4** `scope.rs` check_file/check_entry/create_file still allow ~/Library and UF_HIDDEN paths (scans skip them). Apply the same exclusions (except explicit grants / roots inside ~/Library).
- [x] **R4-M5** `main.ts` saveDocAs: queued autosave waiter resumes before the failure restore and writes to the new path (stray file). Commit currentPath only after a successful write, or waiters bail if the path changed.
- [x] **R4-M6** `main.ts` readyToLeave: quit impossible while a write hangs (each ⌘Q acks, no prompt). Timeout / second ⌘Q → "Focus is still saving … Quit anyway?".
- [x] **R4-M7** `main.ts`/`sidebar.ts`: trash or rename of the open file during an in-flight write → atomic write recreates it (reproduced). Await `saving` + cancel autosave before move.
- [x] **R4-M8** `commands.ts` regression from R3-L2: caret at a bare URL edge inside bold/italic → Italic/Bold wraps part of the URL (`**see https://x.com|**` → `https://x.*com***`). Skip word-wrap when the word overlaps URL/InlineCode.
- [x] **R4-M9** design: light `--mark-edge` 2.0:1 vs mark (needs ≥3:1 non-text); dark `--muted` on hovered rows / `--active` 4.21:1.

## Low
- [x] **R4-L1** `main.ts`: "Not Now" during switch/New/Open silently cancels — continue to the Save Again/Discard/Cancel prompt; open-request sequence token (slow read of A overrides later click on B); register quit/close listeners before the first library scan; remote-images message when https loaded but http blocked.
- [x] **R4-L2** backend: compare-and-swap write (expected mtime checked just before rename) — external edit between our check and write is silently overwritten.
- [x] **R4-L3** `files.rs`: symlink-to-folder named `x.md` loses extension on rename (use symlink_metadata); read_file on FIFO/device `*.md` hangs (check is_file / O_NONBLOCK); deleted dotted folder (`notes.v2`) not seen by watcher filter.
- [x] **R4-L4** `sidebar.ts` context Menu never closed (resource leak; needs core:resources:allow-close); asset protocol grant includes ~/Library (forbid it); drop redundant dialog:allow-ask/allow-confirm.
- [x] **R4-L5** `commands.ts` insertTable: on a thematic break (`* * *`) becomes an indented code block; blank `>` line gives `>|` and the trailing newline splits the quote. `livePreview.ts` tail scan: balanced parens in URLs, skip fenced regions.
- Carried over from R3-L4: `.txt`/tool-file write surface (partly covered by R4-M4).

## After round 4
- [x] **R4-R** Re-run the four reviews.

---

# Feature (user request, 2026-10-29)
- [x] Narrow windows: hover-peek sidebar from the left window edge (150 ms dwell, 300 ms linger, no scrim/focus steal, not while drag-selecting / in titlebar / dialogs; ends on doc click, Esc, opening a card). `main.ts` peek block, `chrome.css` `body.sidebar-peek`, help text. Verified in harness.

# Round 5 — findings from the fifth review

Round-4 fixes verified to hold: R4-H1 (realpath + dev/ino), R4-M1–M4, R4-L2 CAS, R4-L3, R4-L4; R4-M5, R4-M6 (write-hang case), R4-M7, R4-L1; R4-M8 (197k fuzz), R4-L5 (top-level), live preview 6k-doc fuzz, tables 18k-edit fuzz; R4-M9 contrast (all pairs ≥ targets). No High findings.

## Medium
- [ ] **R5-M1** `main.ts` settleDoc (regression of R4-M5): during an untitled Save As write, settle still sees currentPath null → re-asks "Save the untitled document?" (second Save panel), or Discard quits before the chosen file is written. `while (saving) await saving` at the top of each settle iteration.
- [ ] **R5-M2** `main.ts` timedWrite/offerQuitWhileSaving: quit still impossible when `fileMtime` stat or move's trash/rename hangs (only writeFile is timed). Track "busy since" for the whole locked task (minus dialogs).
- [ ] **R5-M3** backend: write_file/rename can create or overwrite tool-executed files under a broad root (`requirements.txt`, `CMakeLists.txt`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`…). Deny well-known tool file names (case-insensitive) in check_file/rename_target, and/or let write_file only write existing files or explicit grants (new files via create_file). (Reopens R3-L4.)
- [ ] **R5-M4** backend: asset protocol serves every file type under roots (incl. UF_HIDDEN), with CORS for the window origin → canvas can read any image under the root. Custom URI scheme: image extensions only, scope.in_folder exclusions, no CORS header. Also fixes the ~/Library forbid snapshot (R5-L…).
- [ ] **R5-M5** `commands.ts` insertTable: thematic break inside a container (`> * * *`, `- - - -`, `1. - - -`) → table becomes an indented code block. Derive the container prefix from the parse tree (Blockquote/ListItem ancestors) instead of regex.
- [ ] **R5-M6** design: `#doc-title` truncates to a stub ("welco…") between ~761–880 px while space is free (chrome.css:725). Let the title use the space between traffic lights and controls, or raise the hide breakpoint.
- [ ] **R5-M7** design/a11y: closed sidebar still reachable by Tab and screen readers (width 0 only). `inert` when closed — but not while peeking.
- [ ] **R5-M8** design: `==` HighlightMark delimiters get the mark background and `--syntax` colour → nearly invisible (dark 1.80:1), and the highlight renders as three pills with seams. One continuous mark span; delimiters in a readable colour.

## Low
- [ ] **R5-L1** `main.ts`: concurrent settle callers show duplicate prompts (share one in-flight settle); startup lastFile load ignores openSeq (a click during a slow read is dropped); failed trash/rename of the open dirty file stops autosave (reschedule on error); leftover "Still Saving" dialog alongside another prompt / says "Untitled" during Save As; repeated CONFLICT → one prompt per conflict (cap).
- [ ] **R5-L2** backend: CAS returns mtime read after rename (take it from the temp file before persist) and compares mtime only (add ino/size); scan shows summaries of symlinked `.md` whose target is under ~/Library/UF_HIDDEN (apply excluded_below); package folders (`.app`, `.photoslibrary`, `.bundle`, `.framework`) renameable/writable inside — refuse; case-changed file names lose single-file grants on rename (canonicalize final name); firmlink ancestor spelling (compare ancestors by dev/ino).
- [ ] **R5-L3** `commands.ts`/`livePreview.ts`: nested-quote `after` splits outer quote (use min quote depth); prefix from regex for non-list `10. item` → code block (tree prefix, as R5-M5); tail scan: spaces-only fence indent, reject backtick fence with backtick in info, alt text with `\n`/one `[...]`, `\\.` in URL; empty pair at line start can form a fence/thematic break (`~~~~text`, `****`).
- [ ] **R5-L4** design: 1 px sidebar-bg strip at x=0 when closed (`background-clip: padding-box` or border width 0); unfocused selection same as focused (grey it when the editor is blurred); straight vs curly apostrophes in messages (main.ts:514, 860-861, remoteImages.ts); dark code fence markers 2.6:1 on --surface (use --muted).

## After round 5
- [ ] **R5-R** Re-run the four reviews.

# Bug (user report, 2026-10-29)
- [x] Split/Read with the sidebar open: a long unbroken line (URL, code) widened the whole window layout (titlebar/buttons/content pushed right, up to ~28 000 px). Fix: `body { grid-template-columns: minmax(0, 1fr) }`, `#app { min-width: 0 }`, `.prose { overflow-wrap: anywhere }` (code blocks keep scrolling sideways). Verified in harness: layout stays 1280 px in all views.
