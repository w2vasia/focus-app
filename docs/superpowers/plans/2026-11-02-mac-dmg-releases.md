# Mac DMG GitHub Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build unsigned Apple Silicon and Intel DMGs for Focus 0.1.0, publish them as GitHub Release `v0.1.0`, and link them from the README.

**Architecture:** Local Tauri release builds for `aarch64-apple-darwin` and `x86_64-apple-darwin`, attach the resulting DMGs to a GitHub Release with `gh`, then add a Download section to `README.md` pointing at those asset URLs. Binaries stay on the release only — never committed to git.

**Tech Stack:** Tauri 2, Rust/cargo, npm, GitHub CLI (`gh`)

## Global Constraints

- Version tag and app version: `v0.1.0` / `0.1.0` (match `package.json` and `src-tauri/tauri.conf.json`)
- Assets: `Focus_0.1.0_aarch64.dmg` and `Focus_0.1.0_x64.dmg` (use the exact filenames Tauri emits; rename only if they differ)
- Unsigned builds only — document Gatekeeper right-click → Open
- Do not commit DMGs, `.app` bundles, or `src-tauri/target/` into git
- Never add `Co-authored-by` (or any agent credit) to commits, release notes, or README
- Spec: `docs/superpowers/specs/2026-11-02-mac-dmg-releases-design.md`

## File map

| Path | Role |
| --- | --- |
| `README.md` | Add Download section with release asset links |
| GitHub Release `v0.1.0` | Hosts the two DMG assets (not a repo file) |
| `src-tauri/target/*/release/bundle/dmg/` | Local build output only (gitignored) |

---

### Task 1: Install build prerequisites

**Files:**
- None (toolchain only)

**Interfaces:**
- Consumes: existing Node/Rust/Xcode toolchain from README Requirements
- Produces: Rust targets `aarch64-apple-darwin` and `x86_64-apple-darwin`; `node_modules` present

- [ ] **Step 1: Confirm tools**

Run:

```sh
cd /Users/wasiliy/Documents/Projects/focus-app
node -v
rustc -V
xcode-select -p
gh auth status
```

Expected: Node 20.19+ or 22.12+, rustc present, Xcode CLT path printed, `gh` logged into `github.com` as `w2vasia`.

- [ ] **Step 2: Add Intel Rust target and install npm deps**

Run:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm install
```

Expected: both targets listed by `rustup target list --installed | rg apple-darwin`; npm finishes without errors.

- [ ] **Step 3: Checkpoint**

No commit. Prerequisites only.

---

### Task 2: Build Apple Silicon DMG

**Files:**
- Create (local only): `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Focus_0.1.0_aarch64.dmg` (exact path may be `…/release/bundle/dmg/` under the host target dir for native arm64 — verify after build)

**Interfaces:**
- Consumes: Task 1 toolchain
- Produces: Apple Silicon DMG path for Task 4

- [ ] **Step 1: Build aarch64**

Run:

```sh
cd /Users/wasiliy/Documents/Projects/focus-app
npm run tauri build -- --target aarch64-apple-darwin
```

Expected: build completes; console mentions bundling `Focus.app` / DMG. This can take several minutes.

- [ ] **Step 2: Locate the DMG**

Run:

```sh
fd -e dmg . src-tauri/target | rg -i 'aarch64|arm64|Focus'
ls -lh src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/ 2>/dev/null
ls -lh src-tauri/target/release/bundle/dmg/ 2>/dev/null
```

Expected: one DMG whose name contains `0.1.0` and `aarch64` (or similar). Record the absolute path as `AARCH64_DMG`.

- [ ] **Step 3: Sanity-check the artifact**

Run:

```sh
file "$AARCH64_DMG"
hdiutil imageinfo "$AARCH64_DMG" | head -20
```

Expected: recognized disk image; no corruption errors.

- [ ] **Step 4: Checkpoint**

No commit. Binary stays local.

---

### Task 3: Build Intel DMG

**Files:**
- Create (local only): `src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/Focus_0.1.0_x64.dmg`

**Interfaces:**
- Consumes: Task 1 toolchain
- Produces: Intel DMG path for Task 4

- [ ] **Step 1: Build x86_64**

Run:

```sh
cd /Users/wasiliy/Documents/Projects/focus-app
npm run tauri build -- --target x86_64-apple-darwin
```

Expected: build completes (cross-compile from Apple Silicon is supported). Can take several minutes.

- [ ] **Step 2: Locate the DMG**

Run:

```sh
fd -e dmg . src-tauri/target | rg -i 'x64|x86_64|Focus'
ls -lh src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/
```

Expected: DMG named like `Focus_0.1.0_x64.dmg`. Record absolute path as `X64_DMG`.

- [ ] **Step 3: Sanity-check the artifact**

Run:

```sh
file "$X64_DMG"
hdiutil imageinfo "$X64_DMG" | head -20
```

Expected: recognized disk image.

- [ ] **Step 4: Checkpoint**

No commit.

---

### Task 4: Publish GitHub Release `v0.1.0`

**Files:**
- Remote only: GitHub Release `v0.1.0` with two assets

**Interfaces:**
- Consumes: `AARCH64_DMG`, `X64_DMG` from Tasks 2–3
- Produces: Stable asset URLs for README:

  - `https://github.com/w2vasia/focus-app/releases/download/v0.1.0/<aarch64-filename>`
  - `https://github.com/w2vasia/focus-app/releases/download/v0.1.0/<x64-filename>`

- [ ] **Step 1: Confirm release does not already exist**

Run:

```sh
gh release view v0.1.0 --repo w2vasia/focus-app
```

Expected: error / not found. If it exists, stop and ask the user whether to delete/recreate or upload missing assets only.

- [ ] **Step 2: Create the release with both DMGs**

Use the real filenames from Tasks 2–3. Example (adjust paths/names if Tauri differs):

```sh
cd /Users/wasiliy/Documents/Projects/focus-app
gh release create v0.1.0 \
  "$AARCH64_DMG#Focus for Apple Silicon (DMG)" \
  "$X64_DMG#Focus for Intel (DMG)" \
  --repo w2vasia/focus-app \
  --title "Focus 0.1.0" \
  --notes "$(cat <<'EOF'
Unsigned macOS builds of Focus 0.1.0.

- **Apple Silicon:** `Focus_0.1.0_aarch64.dmg`
- **Intel:** `Focus_0.1.0_x64.dmg`

First launch: right-click the app → Open (Gatekeeper blocks unsigned apps until then).
EOF
)"
```

Expected: `gh` prints the release URL; both assets listed.

- [ ] **Step 3: Verify assets**

Run:

```sh
gh release view v0.1.0 --repo w2vasia/focus-app
```

Expected: tag `v0.1.0`, both DMG assets present with non-zero size.

- [ ] **Step 4: Checkpoint**

No git commit required for the release itself. Record the exact download URLs (including final filenames) for Task 5.

---

### Task 5: Add README Download section

**Files:**
- Modify: `README.md` (insert after the screenshot, before `## Features`)

**Interfaces:**
- Consumes: exact release asset URLs from Task 4
- Produces: user-facing download instructions

- [ ] **Step 1: Insert Download section**

In `README.md`, immediately after the screenshot line:

```markdown
![Focus in dark mode](docs/screenshot-dark.png)
```

insert:

```markdown

## Download

macOS 11 or later. Unsigned builds — on first launch, right-click the app → **Open**.

- [Apple Silicon (DMG)](https://github.com/w2vasia/focus-app/releases/download/v0.1.0/Focus_0.1.0_aarch64.dmg)
- [Intel (DMG)](https://github.com/w2vasia/focus-app/releases/download/v0.1.0/Focus_0.1.0_x64.dmg)
- [All releases](https://github.com/w2vasia/focus-app/releases)

If Tauri emitted different filenames, use those exact names in the URLs instead.
```

Keep the existing `## Build` section unchanged for developers.

- [ ] **Step 2: Spot-check links**

Run:

```sh
rg -n 'Download|releases/download/v0.1.0' README.md
curl -sI "https://github.com/w2vasia/focus-app/releases/download/v0.1.0/Focus_0.1.0_aarch64.dmg" | head -5
curl -sI "https://github.com/w2vasia/focus-app/releases/download/v0.1.0/Focus_0.1.0_x64.dmg" | head -5
```

Expected: README contains Download section; both `curl` responses are `HTTP/2 302` or `200` (not 404).

- [ ] **Step 3: Commit and push README only**

```sh
cd /Users/wasiliy/Documents/Projects/focus-app
git status
git add README.md
# Avoid Cursor Co-authored-by trailer: use commit-tree
TREE=$(git write-tree)
PARENT=$(git rev-parse HEAD)
NEW=$(git commit-tree "$TREE" -p "$PARENT" -m "Add README download links for v0.1.0 DMGs.")
git reset --soft "$NEW"
git log -1 --format=full   # must NOT contain Co-authored-by
git push origin main
```

Expected: clean working tree; commit message has no agent co-author; remote updated.

- [ ] **Step 4: Final verification**

Run:

```sh
gh release view v0.1.0 --repo w2vasia/focus-app
git status
```

Expected: release live with both DMGs; no uncommitted binary artifacts staged.

---

## Spec coverage check

| Spec requirement | Task |
| --- | --- |
| Two unsigned DMGs (aarch64 + x64) | 2, 3 |
| GitHub Release `v0.1.0` | 4 |
| README Download section + Gatekeeper note | 5 |
| No binaries in git | 2–5 (explicit) |
| Out of scope: signing, CI, universal, version bump | Not planned |
