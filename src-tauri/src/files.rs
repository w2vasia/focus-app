use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::scope::{RenameGuard, Scope, with_canonical};

pub const MD_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "txt"];
/// Bytes of each file read for its sidebar summary (larger files: word count is estimated).
const SUMMARY_PREFIX_BYTES: u64 = 64 * 1024;
/// Total bytes read for summaries in one scan; files past it are listed without a summary.
const SUMMARY_SCAN_BUDGET: u64 = 8 * 1024 * 1024;
const SNIPPET_CHARS: usize = 140;
/// `read_file` refuses larger files (a multi-GB file would exhaust memory).
const READ_MAX_BYTES: u64 = 50 * 1024 * 1024;
/// Watcher events are coalesced into one "fs-changed" per this window.
const WATCH_DEBOUNCE: Duration = Duration::from_millis(250);

/// Two watcher slots: the library folder (recursive) and the open file's folder (not recursive),
/// so files opened from outside the library still get external-change reloads.
#[derive(Default)]
pub struct WatchState {
    library: Mutex<Option<RecommendedWatcher>>,
    open_file: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<Entry>,
    /// Summary shown on the sidebar card (files only).
    pub summary: Option<Summary>,
}

#[derive(Debug, Serialize, PartialEq, Default)]
pub struct Summary {
    /// First heading, if the document starts with one.
    pub title: Option<String>,
    /// First lines of prose with markdown syntax stripped.
    pub snippet: String,
    pub words: usize,
    /// Last modification, milliseconds since the Unix epoch.
    pub modified: u64,
}

/// Plain text of a markdown line for previews: drops markers, keeps words.
fn strip_inline(line: &str) -> String {
    let line = line
        .trim_start_matches(|c: char| c == '#' || c == '>' || c.is_whitespace())
        .trim_start_matches(['-', '*', '+'])
        .trim_start();
    let line = line
        .strip_prefix("[ ] ")
        .or_else(|| line.strip_prefix("[x] "))
        .unwrap_or(line);
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' | '_' | '`' | '~' | '=' | '^' => {}
            // [text](url) -> text
            ']' if chars.peek() == Some(&'(') => {
                for c in chars.by_ref() {
                    if c == ')' {
                        break;
                    }
                }
            }
            '[' | '!' => {}
            _ => out.push(c),
        }
    }
    out.trim().to_string()
}

pub fn summarize(text: &str, modified: u64) -> Summary {
    let mut title = None;
    let mut snippet = String::new();
    let mut in_fence = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("```") || t.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence
            || t.is_empty()
            || t.chars()
                .all(|c| matches!(c, '-' | '=' | '*' | '_' | '|' | ':' | ' '))
        {
            continue;
        }
        if title.is_none() && snippet.is_empty() && t.starts_with('#') {
            title = Some(strip_inline(t)).filter(|s| !s.is_empty());
            continue;
        }
        if snippet.chars().count() >= SNIPPET_CHARS {
            break;
        }
        if !snippet.is_empty() {
            snippet.push(' ');
        }
        snippet.push_str(&strip_inline(t));
    }
    let snippet = snippet.chars().take(SNIPPET_CHARS).collect();
    let words = text
        .split_whitespace()
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .count();
    Summary {
        title,
        snippet,
        words,
        modified,
    }
}

/// Last modification time in milliseconds since the Unix epoch (0 if unknown).
fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// Summary of `path` from at most its first `SUMMARY_PREFIX_BYTES`, charged to `budget`. Once
/// the budget is spent only the modification time is reported.
fn file_summary(path: &Path, budget: &mut u64) -> Option<Summary> {
    let meta = fs::metadata(path).ok()?;
    let modified = mtime_ms(&meta);
    let want = meta.len().min(SUMMARY_PREFIX_BYTES);
    if want > *budget {
        *budget = 0;
        return Some(Summary {
            modified,
            ..Default::default()
        });
    }
    let mut bytes = Vec::with_capacity(want as usize);
    fs::File::open(path)
        .ok()?
        .take(SUMMARY_PREFIX_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    *budget -= bytes.len() as u64;
    let truncated = meta.len() > bytes.len() as u64;
    if truncated {
        trim_partial_utf8(&mut bytes);
    }
    let read = bytes.len().max(1) as u64;
    let mut summary = summarize(&decode_text(bytes), modified);
    if truncated {
        // Estimate from the prefix rather than reading the whole file.
        summary.words = (summary.words as u64 * meta.len() / read) as usize;
    }
    Some(summary)
}

/// Drops an incomplete UTF-8 sequence cut off at the end (so a truncated UTF-8 file isn't
/// mistaken for Latin-1).
fn trim_partial_utf8(bytes: &mut Vec<u8>) {
    if let Err(e) = std::str::from_utf8(bytes)
        && e.error_len().is_none()
    {
        bytes.truncate(e.valid_up_to());
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| MD_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Recursively collect markdown files, skipping hidden entries and folders without markdown.
#[cfg(test)]
pub fn scan_dir(dir: &Path) -> std::io::Result<Vec<Entry>> {
    scan_dir_skipping(dir, &[])
}

/// What one scan may still spend.
struct ScanBudget {
    entries: usize,
    summary_bytes: u64,
}

/// Like `scan_dir`, never descending into the folders in `skip` (e.g. `~/Library`).
pub fn scan_dir_skipping(dir: &Path, skip: &[PathBuf]) -> std::io::Result<Vec<Entry>> {
    fs::read_dir(dir)?; // report an unreadable/missing root as an error
    let root = dir.canonicalize()?;
    let mut budget = ScanBudget {
        entries: MAX_SCAN_ENTRIES,
        summary_bytes: SUMMARY_SCAN_BUDGET,
    };
    Ok(scan_level(dir, &root, skip, 0, &mut budget))
}

/// Hidden in Finder (`chflags hidden`, e.g. `~/Library`).
#[cfg(target_os = "macos")]
pub(crate) fn finder_hidden(meta: &fs::Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    meta.st_flags() & libc::UF_HIDDEN != 0
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn finder_hidden(_meta: &fs::Metadata) -> bool {
    false
}

/// The folders scans and watchers ignore: `~/Library` (as given and canonical).
fn skipped_dirs<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let Ok(home) = app.path().home_dir() else {
        return vec![];
    };
    with_canonical(home.join("Library"))
}

/// Folders deeper than this are not listed.
const MAX_SCAN_DEPTH: usize = 8;
/// Upper bound on directory entries examined per scan (keeps e.g. a home folder from hanging).
const MAX_SCAN_ENTRIES: usize = 5_000;

fn scan_level(
    dir: &Path,
    root: &Path,
    skip: &[PathBuf],
    depth: usize,
    budget: &mut ScanBudget,
) -> Vec<Entry> {
    let mut entries = Vec::new();
    let Ok(items) = fs::read_dir(dir) else {
        return entries;
    };
    // Unreadable entries are skipped instead of hiding the whole folder.
    for item in items.flatten() {
        if budget.entries == 0 {
            break;
        }
        budget.entries -= 1;
        let path = item.path();
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let Ok(kind) = item.file_type() else { continue };
        if item.metadata().is_ok_and(|m| finder_hidden(&m)) || skip.contains(&path) {
            continue;
        }
        // file_type() does not follow symlinks: linked folders are skipped (no cycles),
        // linked files are listed only if their target is a markdown file inside the scanned
        // folder (anything else would leak its summary and can't be opened anyway).
        let is_dir = kind.is_dir();
        let is_file = kind.is_file()
            || (kind.is_symlink()
                && path.is_file()
                && path
                    .canonicalize()
                    .is_ok_and(|t| is_markdown(&t) && crate::scope::within(root, &t)));
        if is_dir {
            if depth + 1 >= MAX_SCAN_DEPTH {
                continue;
            }
            let children = scan_level(&path, root, skip, depth + 1, budget);
            if !children.is_empty() {
                entries.push(Entry {
                    name,
                    path: path.to_string_lossy().into(),
                    is_dir: true,
                    children,
                    summary: None,
                });
            }
        } else if is_file && is_markdown(&path) {
            entries.push(Entry {
                summary: file_summary(&path, &mut budget.summary_bytes),
                name,
                path: path.to_string_lossy().into(),
                is_dir: false,
                children: vec![],
            });
        }
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

/// Decodes file bytes: UTF-8 when valid, otherwise Latin-1 (so legacy notes still open).
pub fn decode_text(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|e| e.into_bytes().iter().map(|&b| b as char).collect())
}

#[tauri::command]
pub async fn read_file(scope: State<'_, Scope>, path: String) -> Result<String, String> {
    let path = scope.check_file(&path)?;
    read_capped(&path, READ_MAX_BYTES).map(decode_text)
}

/// The whole file, or an error if it is larger than `cap` bytes or not a regular file.
fn read_capped(path: &Path, cap: u64) -> Result<Vec<u8>, String> {
    use std::os::unix::fs::OpenOptionsExt;
    let file_name = path.file_name().unwrap_or_default().to_string_lossy();
    let too_big = || {
        format!(
            "“{file_name}” is too large to open (over {} MB).",
            cap / (1024 * 1024)
        )
    };
    // O_NONBLOCK: opening a FIFO (or device) named `*.md` must not hang; it is then refused
    // because it isn't a regular file (R4-L3). Reads of regular files ignore the flag.
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .map_err(err)?;
    let meta = file.metadata().map_err(err)?;
    if !meta.is_file() {
        return Err(format!("“{file_name}” is not a regular file."));
    }
    if meta.len() > cap {
        return Err(too_big());
    }
    let mut bytes = Vec::new();
    // `take` guards against a file that grows between the size check and the read.
    file.take(cap + 1).read_to_end(&mut bytes).map_err(err)?;
    if bytes.len() as u64 > cap {
        return Err(too_big());
    }
    Ok(bytes)
}

/// Writes atomically (unique temp file in the same folder, fsync, rename) so a crash or full
/// disk mid-save can never leave a truncated note. Returns the new modification time.
///
/// A read-only target is refused (`PermissionDenied`) instead of being silently replaced. The
/// temp file is created with `O_EXCL` (never follows or reuses an existing file or symlink)
/// and gets its final permissions before any content is written.
pub fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<u64> {
    write_atomic_if(path, contents, None)
}

/// Prefix of the `write_file` error when the file changed on disk since `expected_mtime`.
pub const CONFLICT: &str = "CONFLICT:";

/// The file's current mtime (ms) differs from `expected` (`None`: no check). A file that
/// doesn't exist (moved/deleted) is not a conflict: the "File Missing → Save Again" flow
/// recreates it.
fn conflicts(path: &Path, expected: Option<u64>) -> bool {
    expected.is_some_and(|exp| fs::metadata(path).is_ok_and(|m| mtime_ms(&m) != exp))
}

/// `write_atomic` with a compare-and-swap: if `expected_mtime` is given and the existing file's
/// mtime differs from it (checked just before the final rename), nothing is written and the
/// error message starts with `CONFLICT:` (R4-L2).
pub fn write_atomic_if(
    path: &Path,
    contents: &[u8],
    expected_mtime: Option<u64>,
) -> std::io::Result<u64> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let dir = match path.parent() {
        Some(d) if !d.as_os_str().is_empty() => d,
        _ => Path::new("."),
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let existing = fs::metadata(path).ok();
    if let Some(meta) = &existing
        && (meta.permissions().readonly() || !writable(path))
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("“{name}” is read-only."),
        ));
    }
    // New files get the usual 0666 & ~umask; existing ones keep their mode.
    let mode = existing
        .as_ref()
        .map_or(0o666, |m| m.permissions().mode() & 0o7777);
    let mut tmp = tempfile::Builder::new()
        .prefix(&format!(".{name}."))
        .suffix(".focus-tmp")
        .permissions(fs::Permissions::from_mode(mode))
        .tempfile_in(dir)?;
    if existing.is_some() {
        // `permissions` above is subject to the umask; restore the exact mode, still empty.
        tmp.as_file()
            .set_permissions(fs::Permissions::from_mode(mode))?;
    }
    tmp.write_all(contents)?;
    tmp.as_file().sync_all()?;
    if conflicts(path, expected_mtime) {
        return Err(std::io::Error::other(format!(
            "{CONFLICT} “{name}” was changed on disk by another app."
        ))); // the temp file is removed on drop
    }
    tmp.persist(path).map_err(|e| e.error)?; // the temp file is removed on any error
    Ok(mtime_ms(&fs::metadata(path)?))
}

/// The current user may write `path` (honours ownership and ACL-less mode bits).
fn writable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `c` is a valid NUL-terminated path for the duration of the call.
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

/// Writes atomically. With `expected_mtime` (JS `expectedMtime`, ms as from `file_mtime`), an
/// existing file whose mtime differs is left alone and the error starts with `CONFLICT:`.
#[tauri::command]
pub async fn write_file(
    scope: State<'_, Scope>,
    path: String,
    contents: String,
    expected_mtime: Option<u64>,
) -> Result<u64, String> {
    let path = scope.check_file(&path)?;
    if conflicts(&path, expected_mtime) {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        return Err(format!(
            "{CONFLICT} “{name}” was changed on disk by another app."
        ));
    }
    write_atomic_if(&path, contents.as_bytes(), expected_mtime).map_err(err)
}

/// Modification time of a file, or `None` if it no longer exists.
#[tauri::command]
pub async fn file_mtime(scope: State<'_, Scope>, path: String) -> Result<Option<u64>, String> {
    Ok(file_mtime_of(&scope.check_file(&path)?))
}

pub fn file_mtime_of(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .filter(|m| m.is_file())
        .map(|m| mtime_ms(&m))
}

#[tauri::command]
pub async fn list_dir(
    app: AppHandle,
    scope: State<'_, Scope>,
    path: String,
) -> Result<Vec<Entry>, String> {
    let path = scope.check_folder(&path)?;
    scan_dir_skipping(&path, &skipped_dirs(&app)).map_err(err)
}

/// Creates `Untitled.md` (or `Untitled 2.md`, …) without ever overwriting an existing file.
pub fn create_untitled(dir: &Path) -> std::io::Result<PathBuf> {
    for n in 1.. {
        let name = if n == 1 {
            "Untitled.md".to_string()
        } else {
            format!("Untitled {n}.md")
        };
        let path = dir.join(name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(_) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

#[tauri::command]
pub async fn create_file(scope: State<'_, Scope>, dir: String) -> Result<String, String> {
    let dir = scope.check_folder(&dir)?;
    let path = create_untitled(&dir).map_err(err)?;
    Ok(path.to_string_lossy().into())
}

/// Target path for renaming `from` to `new_name`: keeps the original extension unless the
/// user typed a Markdown one (`v1.2` → `v1.2.md`, `Notes` from `a.markdown` → `Notes.markdown`).
pub fn rename_target(from: &Path, new_name: &str) -> Result<PathBuf, String> {
    let name = new_name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\0') {
        return Err("Enter a name without “/”.".into());
    }
    if name.starts_with('.') {
        return Err("Names starting with “.” are hidden in Finder. Choose another name.".into());
    }
    // The entry itself: a symlink to a folder named `x.md` is a link, and keeps its extension.
    if is_real_dir(from) || is_markdown(Path::new(name)) {
        return Ok(from.with_file_name(name));
    }
    let ext = from.extension().and_then(|e| e.to_str()).unwrap_or("md");
    Ok(from.with_file_name(format!("{name}.{ext}")))
}

/// A directory entry that is a folder itself (not a symlink to one).
fn is_real_dir(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())
}

/// A case-only rename of one directory entry on a case-insensitive volume (`note.md` →
/// `Note.md`). Hard links (different names, same inode) and distinct files on case-sensitive
/// volumes don't count.
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let (Some(an), Some(bn)) = (a.file_name(), b.file_name()) else {
        return false;
    };
    let (an, bn) = (an.to_string_lossy(), bn.to_string_lossy());
    if a.parent() != b.parent() || an == bn || an.to_lowercase() != bn.to_lowercase() {
        return false;
    }
    let same_inode = match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    };
    // On a case-sensitive volume `b` would be listed under its own name.
    let listed = |dir: &Path| {
        fs::read_dir(dir)
            .is_ok_and(|mut it| it.any(|e| e.is_ok_and(|e| e.file_name().to_string_lossy() == bn)))
    };
    same_inode && !a.parent().is_some_and(listed)
}

/// Renames without ever replacing an existing file (macOS `RENAME_EXCL`).
pub fn rename_no_clobber(from: &Path, to: &Path) -> std::io::Result<()> {
    rename_no_clobber_with(from, to, rename_excl)
}

fn rename_no_clobber_with(
    from: &Path,
    to: &Path,
    excl: fn(&Path, &Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    if same_file(from, to) {
        return fs::rename(from, to); // case-only change of the same file
    }
    match excl(from, to) {
        // Volumes without RENAME_EXCL support (some network/FAT/exFAT): check, then rename.
        Err(e) if matches!(e.raw_os_error(), Some(libc::ENOTSUP | libc::EINVAL)) => {
            if fs::symlink_metadata(to).is_ok() {
                return Err(std::io::ErrorKind::AlreadyExists.into());
            }
            fs::rename(from, to)
        }
        r => r,
    }
}

#[cfg(target_os = "macos")]
fn rename_excl(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let a = CString::new(from.as_os_str().as_bytes())?;
    let b = CString::new(to.as_os_str().as_bytes())?;
    // SAFETY: both arguments are valid NUL-terminated paths for the duration of the call.
    let rc = unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_EXCL) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn rename_excl(_from: &Path, _to: &Path) -> std::io::Result<()> {
    Err(std::io::Error::from_raw_os_error(libc::ENOTSUP))
}

#[tauri::command]
pub async fn rename_path(
    app: AppHandle,
    scope: State<'_, Scope>,
    path: String,
    new_name: String,
) -> Result<String, String> {
    // The entry itself (a symlink is renamed, not its target); folders may be renamed too.
    // A real folder comes back canonical (its on-disk spelling, R4-H1).
    let from = scope.check_entry(&path, true)?;
    let dir = is_real_dir(&from);
    if dir {
        scope.check_rename_dir(&from, &rename_guard(&app))?;
    }
    let to = rename_target(&from, &new_name)?;
    if !dir && !is_markdown(&to) {
        return Err("Use a Markdown extension (.md, .markdown, .mdown or .txt).".into());
    }
    rename_no_clobber(&from, &to).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => "A file with that name already exists.".to_string(),
        _ => e.to_string(),
    })?;
    scope.follow_rename(&app, &from, &to);
    Ok(to.to_string_lossy().into())
}

/// What a folder rename must never touch: `$HOME`, `~/Library` and Focus's own data/config
/// folders, each as given and canonical (see `Scope::check_rename_dir`).
fn rename_guard<R: Runtime>(app: &AppHandle<R>) -> RenameGuard {
    let p = app.path();
    let app_dirs = [p.app_data_dir(), p.app_config_dir(), p.app_local_data_dir()]
        .into_iter()
        .flatten()
        .flat_map(with_canonical)
        .collect();
    RenameGuard {
        home: p.home_dir().map(with_canonical).unwrap_or_default(),
        library: skipped_dirs(app),
        app_dirs,
    }
}

/// Shows a file or folder in Finder; only entries the scope allows (R3-M5).
#[tauri::command]
pub async fn reveal_path(scope: State<'_, Scope>, path: String) -> Result<(), String> {
    let path = scope.check_entry(&path, true)?;
    tauri::async_runtime::spawn_blocking(move || tauri_plugin_opener::reveal_item_in_dir(path))
        .await
        .map_err(err)?
        .map_err(err)
}

/// Moves to the macOS Trash rather than deleting permanently.
#[tauri::command]
pub async fn trash_path(scope: State<'_, Scope>, path: String) -> Result<(), String> {
    // The entry itself: trashing a symlink moves the link, never its target.
    let path = scope.check_entry(&path, false)?;
    trash::delete(path).map_err(err)
}

/// Whether a change at `p` (under the watched `root`) can matter to the sidebar or the open
/// file: a visible Markdown file or folder (or anything removed), not a save temp file,
/// nothing under a `skip` folder that lies *below* `root` (a library inside `~/Library` still
/// sees its own changes, R4-M2).
fn relevant_change(root: &Path, skip: &[PathBuf], p: &Path) -> bool {
    if skip
        .iter()
        .any(|s| s != root && s.starts_with(root) && p.starts_with(s))
    {
        return false;
    }
    let rest = p.strip_prefix(root).unwrap_or(p);
    let hidden = rest.components().any(|c| match c {
        Component::Normal(n) => n.to_string_lossy().starts_with('.'),
        _ => false,
    });
    if hidden
        || p.file_name()
            .is_some_and(|n| n.to_string_lossy().ends_with(".focus-tmp"))
    {
        return false;
    }
    // A removed entry can't be stat'ed: it may have been a folder (`notes.v2`), so count it
    // (R4-L3).
    is_markdown(p) || p.is_dir() || fs::symlink_metadata(p).is_err()
}

fn relevant_event(root: &Path, skip: &[PathBuf], event: &notify::Event) -> bool {
    if event.kind.is_access() {
        return false;
    }
    // No paths (e.g. FSEvents "rescan needed"): assume anything may have changed.
    event.paths.is_empty() || event.paths.iter().any(|p| relevant_change(root, skip, p))
}

/// Calls `emit` once per burst: at most once per `window`, `window` after the first signal of
/// a burst. Stops when every sender is dropped (i.e. with its watcher).
fn debouncer(window: Duration, emit: impl Fn() + Send + 'static) -> mpsc::Sender<()> {
    let (tx, rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            let deadline = Instant::now() + window;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                match rx.recv_timeout(left) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            emit();
        }
    });
    tx
}

/// A watcher that emits "fs-changed" (payload `()`) for relevant changes under `path`,
/// coalesced over `WATCH_DEBOUNCE` (R3-M6).
fn watcher(app: AppHandle, path: &Path, mode: RecursiveMode) -> Result<RecommendedWatcher, String> {
    let skip = skipped_dirs(&app);
    let root = path.to_path_buf();
    let tx = debouncer(WATCH_DEBOUNCE, move || {
        let _ = app.emit("fs-changed", ());
    });
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok_and(|event| relevant_event(&root, &skip, &event)) {
            let _ = tx.send(());
        }
    })
    .map_err(err)?;
    watcher.watch(path, mode).map_err(err)?;
    Ok(watcher)
}

/// Watches the library folder (recursively), replacing the previous library watch.
#[tauri::command]
pub async fn watch_dir(
    app: AppHandle,
    state: State<'_, WatchState>,
    scope: State<'_, Scope>,
    path: String,
) -> Result<(), String> {
    let path = scope.check_folder(&path)?;
    let w = watcher(app, &path, RecursiveMode::Recursive)?;
    *state.library.lock().unwrap_or_else(|e| e.into_inner()) = Some(w);
    Ok(())
}

/// Watches the folder of the open file (not recursively), replacing the previous file watch,
/// so changes made by other apps reach the editor even outside the library. `None` stops it.
#[tauri::command]
pub async fn watch_open_file(
    app: AppHandle,
    state: State<'_, WatchState>,
    scope: State<'_, Scope>,
    path: Option<String>,
) -> Result<(), String> {
    let w = match path {
        Some(path) => {
            let file = scope.check_file(&path)?;
            let dir = file
                .parent()
                .ok_or_else(|| "No parent folder.".to_string())?;
            Some(watcher(app, dir, RecursiveMode::NonRecursive)?)
        }
        None => None,
    };
    *state.open_file.lock().unwrap_or_else(|e| e.into_inner()) = w;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_filters_and_sorts() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("b.md"), "").unwrap();
        fs::write(root.join("A.markdown"), "").unwrap();
        fs::write(root.join("image.png"), "").unwrap();
        fs::write(root.join(".hidden.md"), "").unwrap();
        fs::create_dir(root.join("empty")).unwrap();
        fs::create_dir(root.join("notes")).unwrap();
        fs::write(root.join("notes/c.md"), "").unwrap();

        let names: Vec<_> = scan_dir(root)
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, ["notes", "A.markdown", "b.md"]);
    }

    #[test]
    fn summary_extracts_title_snippet_and_words() {
        let s = summarize(
            "# My **Title**\n\n```\ncode here\n```\nSome *nice* [link](http://x) text.\n\n- item two\n",
            7,
        );
        assert_eq!(s.title.as_deref(), Some("My Title"));
        assert_eq!(s.snippet, "Some nice link text. item two");
        assert_eq!(s.modified, 7);
        assert_eq!(s.words, 10); // My Title code here Some nice link text item two
    }

    #[test]
    fn atomic_write_replaces_and_reports_mtime() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("a.md");
        fs::write(&p, "old").unwrap();
        let m = write_atomic(&p, b"new").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "new");
        assert!(m > 0);
        assert_eq!(file_mtime_of(&p), Some(m));
        assert_eq!(
            fs::read_dir(tmp.path()).unwrap().count(),
            1,
            "no temp file left behind"
        );
        assert_eq!(file_mtime_of(&tmp.path().join("gone.md")), None);
    }

    /// H8: symlinked folders (incl. loops) are not followed; linked files still show.
    #[test]
    fn scan_skips_symlink_loops() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub/a.md"), "# A").unwrap();
        std::os::unix::fs::symlink(root, root.join("sub/loop")).unwrap();
        std::os::unix::fs::symlink(root.join("sub/a.md"), root.join("link.md")).unwrap();
        let entries = scan_dir(root).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["sub", "link.md"]);
        assert_eq!(entries[0].children.len(), 1, "loop link not followed");
        assert!(scan_dir(&root.join("missing")).is_err());
    }

    /// M4: extensions, case-only renames and no-clobber.
    #[test]
    fn rename_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let md = root.join("a.markdown");
        fs::write(&md, "").unwrap();
        assert!(
            rename_target(&md, "v1.2")
                .unwrap()
                .ends_with("v1.2.markdown")
        );
        assert!(
            rename_target(&md, "Notes.md")
                .unwrap()
                .ends_with("Notes.md")
        );
        assert!(rename_target(&md, ".hidden").is_err());
        assert!(rename_target(&md, "a/b").is_err());

        let note = root.join("note.md");
        fs::write(&note, "x").unwrap();
        rename_no_clobber(&note, &root.join("Note.md")).expect("case-only rename works");
        let names: Vec<_> = fs::read_dir(root)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert!(names.contains(&"Note.md".to_string()), "{names:?}");

        fs::write(root.join("other.md"), "keep").unwrap();
        let err = rename_no_clobber(&root.join("Note.md"), &root.join("other.md")).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(root.join("other.md")).unwrap(), "keep");
    }

    /// M5: new files never overwrite; L8: non-UTF-8 text still opens.
    #[test]
    fn create_untitled_and_decode() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("Untitled.md"), "mine").unwrap();
        let p = create_untitled(tmp.path()).unwrap();
        assert!(p.ends_with("Untitled 2.md"));
        assert_eq!(
            fs::read_to_string(tmp.path().join("Untitled.md")).unwrap(),
            "mine"
        );
        assert_eq!(decode_text(b"caf\xe9".to_vec()), "café");
        assert_eq!(decode_text("ok ✓".as_bytes().to_vec()), "ok ✓");
    }

    /// R2-M3: read-only targets are refused; temp files are unique and never follow links.
    #[test]
    fn atomic_write_respects_read_only_and_perms() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("ro.md");
        fs::write(&p, "keep").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o444)).unwrap();
        let e = write_atomic(&p, b"new").unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read_to_string(&p).unwrap(), "keep");

        let q = tmp.path().join("mode.md");
        fs::write(&q, "x").unwrap();
        fs::set_permissions(&q, fs::Permissions::from_mode(0o640)).unwrap();
        write_atomic(&q, b"y").unwrap();
        let mode = fs::metadata(&q).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode, 0o640, "keeps the original mode");

        // The old fixed temp name, pre-planted as a symlink, is neither followed nor reused.
        let victim = tmp.path().join("victim.txt");
        fs::write(&victim, "safe").unwrap();
        std::os::unix::fs::symlink(&victim, tmp.path().join(".a.md.focus-tmp")).unwrap();
        let a = tmp.path().join("a.md");
        write_atomic(&a, b"note").unwrap();
        assert_eq!(fs::read_to_string(&a).unwrap(), "note");
        assert_eq!(fs::read_to_string(&victim).unwrap(), "safe");
        let leftovers: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.contains("focus-tmp") && n != ".a.md.focus-tmp")
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        fs::set_permissions(&p, fs::Permissions::from_mode(0o644)).unwrap();
    }

    #[test]
    fn atomic_write_concurrent_temp_names_dont_collide() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("same.md");
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let p = p.clone();
                std::thread::spawn(move || write_atomic(&p, format!("v{i}").as_bytes()))
            })
            .collect();
        for h in handles {
            h.join().unwrap().unwrap();
        }
        assert!(fs::read_to_string(&p).unwrap().starts_with('v'));
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
    }

    /// R2-L8: RENAME_EXCL unsupported → exists-check + rename; still never clobbers.
    #[test]
    fn rename_falls_back_without_excl_support() {
        fn unsupported(_: &Path, _: &Path) -> std::io::Result<()> {
            Err(std::io::Error::from_raw_os_error(libc::ENOTSUP))
        }
        fn invalid(_: &Path, _: &Path) -> std::io::Result<()> {
            Err(std::io::Error::from_raw_os_error(libc::EINVAL))
        }
        fn denied(_: &Path, _: &Path) -> std::io::Result<()> {
            Err(std::io::Error::from_raw_os_error(libc::EACCES))
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("a.md"), "a").unwrap();
        fs::write(root.join("b.md"), "b").unwrap();
        rename_no_clobber_with(&root.join("a.md"), &root.join("c.md"), unsupported).unwrap();
        assert_eq!(fs::read_to_string(root.join("c.md")).unwrap(), "a");
        let e =
            rename_no_clobber_with(&root.join("c.md"), &root.join("b.md"), invalid).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "b");
        // other errors are passed through, no fallback
        let e = rename_no_clobber_with(&root.join("c.md"), &root.join("d.md"), denied).unwrap_err();
        assert_eq!(e.raw_os_error(), Some(libc::EACCES));
        assert!(!root.join("d.md").exists());
    }

    /// R2-L8: hard links are not "the same file" (renaming onto one must not clobber it).
    #[test]
    fn hard_links_are_not_case_renames() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("a.md"), "a").unwrap();
        fs::hard_link(root.join("a.md"), root.join("link.md")).unwrap();
        assert!(!same_file(&root.join("a.md"), &root.join("link.md")));
        let e = rename_no_clobber(&root.join("a.md"), &root.join("link.md")).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::AlreadyExists);
        assert!(root.join("a.md").exists() && root.join("link.md").exists());
        assert!(!same_file(&root.join("a.md"), &root.join("a.md")));
    }

    /// R2-M2: renaming a symlinked note renames the link; the target keeps its name.
    #[test]
    fn rename_acts_on_the_link() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("target.md"), "t").unwrap();
        std::os::unix::fs::symlink(root.join("target.md"), root.join("link.md")).unwrap();
        rename_no_clobber(&root.join("link.md"), &root.join("renamed.md")).unwrap();
        assert!(root.join("target.md").is_file());
        assert!(
            fs::symlink_metadata(root.join("renamed.md"))
                .unwrap()
                .is_symlink()
        );
    }

    /// R2-M2: linked files pointing outside the scanned folder (or at hidden/non-md files)
    /// are not listed.
    #[test]
    fn scan_skips_links_out_of_root() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let root = base.join("lib");
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(base.join("outside.md"), "# Secret").unwrap();
        fs::write(root.join("in.md"), "# In").unwrap();
        fs::write(root.join(".hidden/h.md"), "# H").unwrap();
        fs::write(root.join("data.json"), "{}").unwrap();
        std::os::unix::fs::symlink(base.join("outside.md"), root.join("out.md")).unwrap();
        std::os::unix::fs::symlink(root.join(".hidden/h.md"), root.join("h.md")).unwrap();
        std::os::unix::fs::symlink(root.join("data.json"), root.join("data.md")).unwrap();
        std::os::unix::fs::symlink(root.join("in.md"), root.join("in-link.md")).unwrap();
        let names: Vec<_> = scan_dir(&root)
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, ["in-link.md", "in.md"]);
    }

    /// R2-L9: summaries of Latin-1 files.
    #[test]
    fn summary_decodes_latin1() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("l1.md");
        fs::write(&p, b"# Caf\xe9\n\nNa\xefve text\n").unwrap();
        let mut budget = u64::MAX;
        let s = file_summary(&p, &mut budget).unwrap();
        assert_eq!(s.title.as_deref(), Some("Café"));
        assert_eq!(s.snippet, "Naïve text");
    }

    /// R3-L4: read_file refuses oversized files.
    #[test]
    fn read_is_capped() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("big.md");
        fs::write(&p, vec![b'a'; 2048]).unwrap();
        assert_eq!(read_capped(&p, 2048).unwrap().len(), 2048);
        let e = read_capped(&p, 2047).unwrap_err();
        assert!(e.contains("too large"), "{e}");
    }

    /// R3-M6: summaries read a bounded prefix and a bounded total per scan.
    #[test]
    fn summaries_are_bounded() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("long.md");
        // "é" straddles the prefix boundary: still decoded as UTF-8, not Latin-1.
        let mut text = "# Título\n\n".to_string();
        while text.len() < SUMMARY_PREFIX_BYTES as usize - 1 {
            text.push_str("word ");
        }
        text.truncate(SUMMARY_PREFIX_BYTES as usize - 1);
        text.push('é');
        text.push_str(&" word".repeat(20_000));
        fs::write(&p, &text).unwrap();
        let mut budget = u64::MAX;
        let s = file_summary(&p, &mut budget).unwrap();
        assert_eq!(s.title.as_deref(), Some("Título"));
        assert_eq!(u64::MAX - budget, SUMMARY_PREFIX_BYTES, "prefix only");
        let exact = text.split_whitespace().count();
        assert!(
            s.words > exact * 9 / 10 && s.words < exact * 11 / 10,
            "{} vs {exact}",
            s.words
        );

        let mut small = 10;
        let s = file_summary(&p, &mut small).unwrap();
        assert_eq!((s.title, s.words, small), (None, 0, 0), "budget spent");
        assert!(s.modified > 0);
    }

    /// R3-M6: scans skip Finder-hidden entries and the given folders.
    #[test]
    fn scan_skips_finder_hidden_and_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        for d in ["Library", "Hidden", "notes"] {
            fs::create_dir(root.join(d)).unwrap();
            fs::write(root.join(d).join("a.md"), "x").unwrap();
        }
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::ffi::OsStrExt;
            let c = std::ffi::CString::new(root.join("Hidden").as_os_str().as_bytes()).unwrap();
            // SAFETY: valid NUL-terminated path.
            assert_eq!(
                unsafe { libc::chflags(c.as_ptr(), libc::UF_HIDDEN as _) },
                0
            );
        }
        let names: Vec<_> = scan_dir_skipping(&root, &[root.join("Library")])
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        #[cfg(target_os = "macos")]
        assert_eq!(names, ["notes"]);
        #[cfg(not(target_os = "macos"))]
        assert_eq!(names, ["Hidden", "notes"]);
    }

    /// R3-M6: only visible Markdown files and folders count as changes.
    #[test]
    fn watcher_filters_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        fs::create_dir(root.join("dir")).unwrap();
        fs::write(root.join("image.png"), "").unwrap();
        let skip = [root.join("Library")];
        let rel = |p: &str| relevant_change(&root, &skip, &root.join(p));
        assert!(rel("a.md"));
        assert!(rel("dir"));
        assert!(rel("gone-folder"), "removed folder");
        assert!(rel("notes.v2"), "removed dotted folder (R4-L3)");
        assert!(!rel(".a.md.abc123.focus-tmp"));
        assert!(!rel("x.md.focus-tmp"));
        assert!(!rel(".git/index"));
        assert!(!rel(".hidden/a.md"));
        assert!(!rel("image.png"));
        assert!(!rel("Library/Caches/x.md"));
        let ev = |kind, paths: Vec<PathBuf>| {
            let mut e = notify::Event::new(kind);
            e.paths = paths;
            e
        };
        use notify::EventKind;
        assert!(relevant_event(&root, &skip, &ev(EventKind::Any, vec![])));
        assert!(!relevant_event(
            &root,
            &skip,
            &ev(
                EventKind::Access(notify::event::AccessKind::Any),
                vec![root.join("a.md")]
            )
        ));
        assert!(relevant_event(
            &root,
            &skip,
            &ev(EventKind::Any, vec![root.join("x.png"), root.join("b.md")])
        ));
    }

    /// R4-M2: a skip folder at or above the watched root (a library inside ~/Library) filters
    /// nothing; one below it still does.
    #[test]
    fn watcher_inside_skipped_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().canonicalize().unwrap();
        let lib = home.join("Library");
        let root = lib.join("Mobile Documents/com~apple~CloudDocs/Notes");
        fs::create_dir_all(root.join("sub")).unwrap();
        let skip = [lib.clone()];
        assert!(relevant_change(&root, &skip, &root.join("a.md")));
        assert!(relevant_change(&root, &skip, &root.join("sub")));
        assert!(!relevant_change(&root, &skip, &root.join(".obsidian/x.md")));
        assert!(
            relevant_change(&lib, &skip, &lib.join("a.md")),
            "root is ~/Library"
        );
        assert!(
            !relevant_change(&home, &skip, &root.join("a.md")),
            "below a ~ root"
        );
        assert!(relevant_change(&home, &skip, &home.join("a.md")));
    }

    /// R4-L2: compare-and-swap write.
    #[test]
    fn write_checks_expected_mtime() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("a.md");
        let m = write_atomic(&p, b"one").unwrap();
        let e = write_atomic_if(&p, b"two", Some(m + 1)).unwrap_err();
        assert!(e.to_string().starts_with("CONFLICT:"), "{e}");
        assert_eq!(fs::read_to_string(&p).unwrap(), "one");
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1, "temp removed");
        let m2 = write_atomic_if(&p, b"two", Some(m)).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "two");
        assert_eq!(file_mtime_of(&p), Some(m2));
        write_atomic_if(&p, b"three", None).unwrap();
        // a missing file is written as before (File Missing → Save Again)
        let gone = tmp.path().join("gone.md");
        write_atomic_if(&gone, b"back", Some(m)).unwrap();
        assert_eq!(fs::read_to_string(&gone).unwrap(), "back");
    }

    /// R4-L3: a linked folder named `x.md` keeps its extension; FIFOs are refused, not read.
    #[test]
    fn linked_folders_and_fifos() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir(root.join("real")).unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("x.md")).unwrap();
        assert!(
            rename_target(&root.join("x.md"), "y")
                .unwrap()
                .ends_with("y.md")
        );
        assert!(
            rename_target(&root.join("real"), "y")
                .unwrap()
                .ends_with("y")
        );

        let fifo = root.join("pipe.md");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o644) }, 0);
        let e = read_capped(&fifo, 1024).unwrap_err();
        assert!(e.contains("not a regular file"), "{e}");
    }

    /// R3-M6: a burst of signals emits once; the thread ends with its sender.
    #[test]
    fn debouncer_coalesces() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let tx = debouncer(Duration::from_millis(100), move || {
            c.fetch_add(1, Ordering::SeqCst);
        });
        for _ in 0..500 {
            tx.send(()).unwrap();
        }
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        tx.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(count.load(Ordering::SeqCst), 2);
        drop(tx);
    }
}
