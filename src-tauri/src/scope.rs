//! Which files and folders the webview may touch.
//!
//! Paths enter the allowlist only through actions the backend can trust: its own Open/Save
//! dialogs, files opened from Finder, and files dropped on the window. Every file command
//! checks its path here, so a compromised webview cannot read or write arbitrary files.
//!
//! Inside an allowed folder only Markdown files are reachable, and nothing hidden (no path
//! component below the folder may start with “.”, be hidden in Finder, or be `~/Library`), so
//! a library folder of `~` still keeps `~/.ssh`, `~/.zshrc`, `~/Library` and friends out of
//! reach. A library folder that itself lives inside `~/Library` (iCloud Drive) works: only
//! components *below* a folder are tested (R4-M2/M4).
//!
//! `.html` is never reachable through a folder: an export target is a one-time grant made by
//! the backend's own Save dialog (R4-M3).

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::files::MD_EXTENSIONS;

const SCOPE_FILE: &str = "scope.json";
const MAX_FOLDERS: usize = 20;
const MAX_FILES: usize = 200;
/// What `export_html` may write.
const EXPORT_EXTENSIONS: &[&str] = &["html"];

#[derive(Default, Serialize, Deserialize)]
struct Allowed {
    /// Most recent first.
    folders: Vec<PathBuf>,
    files: Vec<PathBuf>,
}

/// An asset-protocol grant: a directory, recursive or not.
type AssetGrant = (PathBuf, bool);

pub struct Scope {
    allowed: Mutex<Allowed>,
    store: Option<PathBuf>,
    /// Held across snapshot + write in `save`, so snapshots reach disk in the order they were
    /// taken (an older one can never overwrite a newer one).
    saving: Mutex<()>,
    /// What has been granted to the asset protocol so far (it cannot revoke, only forbid).
    assets: Mutex<HashSet<AssetGrant>>,
    /// Paths already forbidden to the asset protocol to keep `~/Library` out (R4-L4).
    asset_forbidden: Mutex<HashSet<PathBuf>>,
    /// `~/Library`, as given and canonical: never reachable *through* a folder grant whose root
    /// lies above it (R4-M4).
    library: Vec<PathBuf>,
    /// One-time export targets picked in the HTML Save dialog (R4-M3). Not persisted.
    exports: Mutex<HashSet<PathBuf>>,
}

/// Folders a rename must never touch (R3-H1, R4-H1/M1/M2). Each list holds paths as given and
/// canonical.
#[derive(Default)]
pub struct RenameGuard {
    pub home: Vec<PathBuf>,
    /// `~/Library`: protected itself (and its ancestors), plus its direct children and the
    /// iCloud containers in `~/Library/Mobile Documents` — but not folders deeper inside, so a
    /// library in iCloud Drive can be organised.
    pub library: Vec<PathBuf>,
    /// Focus's own data/config folders: protected with their ancestors *and* contents.
    pub app_dirs: Vec<PathBuf>,
}

/// `path` and, if different, its canonical form.
pub fn with_canonical(path: PathBuf) -> Vec<PathBuf> {
    let mut v = vec![path];
    if let Ok(c) = v[0].canonicalize()
        && c != v[0]
    {
        v.push(c);
    }
    v
}

/// Same directory entry (device + inode), for spellings `==` can't see through.
fn same_inode(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    }
}

/// Canonical form of `path`; for a file that doesn't exist yet, its canonical parent + name.
/// Follows a symlink in the final component (the *target* is what gets read or written).
fn canonical(path: &Path) -> Option<PathBuf> {
    if let Ok(p) = path.canonicalize() {
        return Some(p);
    }
    entry_path(path)
}

/// Canonical parent + the final name, *without* following a symlink in the final component:
/// the directory entry itself (what trash and rename act on).
fn entry_path(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?;
    if name == ".." {
        return None;
    }
    let parent = path.parent()?;
    let parent = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    Some(parent.canonicalize().ok()?.join(name))
}

fn has_extension(path: &Path, exts: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| exts.contains(&e.to_ascii_lowercase().as_str()))
}

/// `path` lies in `root` (or is `root`) and no component below `root` is hidden.
pub fn within(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root).is_ok_and(|rest| {
        rest.components().all(|c| match c {
            Component::Normal(n) => !n.to_string_lossy().starts_with('.'),
            _ => false,
        })
    })
}

/// Whether some component of `path` below `root` (root excluded, `path` included) is one the
/// scans skip: `~/Library` (one of `skip`) or hidden in Finder (`UF_HIDDEN`). Components that
/// don't exist (a file about to be created) are not hidden.
fn excluded_below(root: &Path, path: &Path, skip: &[PathBuf]) -> bool {
    let Ok(rest) = path.strip_prefix(root) else {
        return true;
    };
    let mut cur = root.to_path_buf();
    for c in rest.components() {
        cur.push(c);
        if skip.iter().any(|s| s == &cur)
            || fs::symlink_metadata(&cur).is_ok_and(|m| crate::files::finder_hidden(&m))
        {
            return true;
        }
    }
    false
}

fn push_recent(list: &mut Vec<PathBuf>, path: PathBuf, cap: usize) {
    list.retain(|p| p != &path);
    list.insert(0, path);
    list.truncate(cap);
}

/// `path` with its `from` prefix swapped for `to`, if it starts with `from`.
fn rebase(path: &Path, from: &Path, to: &Path) -> Option<PathBuf> {
    path.strip_prefix(from).ok().map(|rest| {
        if rest.as_os_str().is_empty() {
            to.to_path_buf()
        } else {
            to.join(rest)
        }
    })
}

fn denied(path: &str) -> String {
    format!("Focus doesn't have access to “{path}”. Open it with File ▸ Open first.")
}

impl Scope {
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Self {
        let dir = app.path().app_data_dir().ok();
        let store = dir.as_ref().map(|d| d.join(SCOPE_FILE));
        // Access is never imported from anywhere else (e.g. the webview-writable settings file):
        // a missing scope.json just means no access yet (R3-H1).
        let (allowed, absent) = match &store {
            Some(file) => read_allowed(file),
            None => (Allowed::default(), false),
        };
        let library = app
            .path()
            .home_dir()
            .map(|h| with_canonical(h.join("Library")))
            .unwrap_or_default();
        let scope = Scope::new(allowed, store, library);
        if absent {
            scope.save();
        }
        scope.sync_assets(app);
        scope
    }

    fn new(allowed: Allowed, store: Option<PathBuf>, library: Vec<PathBuf>) -> Self {
        Scope {
            allowed: Mutex::new(allowed),
            store,
            saving: Mutex::new(()),
            assets: Mutex::new(HashSet::new()),
            asset_forbidden: Mutex::new(HashSet::new()),
            library,
            exports: Mutex::new(HashSet::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Allowed> {
        self.allowed.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn save(&self) {
        let Some(file) = &self.store else { return };
        let _saving = self.saving.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(parent) = file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        // Snapshot while holding `saving` (the allowlist lock itself is released before the
        // write, so checks never wait on disk I/O).
        let json = serde_json::to_string_pretty(&*self.lock());
        if let Ok(json) = json
            && let Err(e) = crate::files::write_atomic(file, json.as_bytes())
        {
            eprintln!("focus: couldn't save {}: {e}", file.display());
        }
    }

    /// The asset-protocol grants the allowlist calls for: folders recursively, the folder
    /// next to a single file non-recursively (images beside it).
    fn wanted_assets(&self) -> HashSet<AssetGrant> {
        let allowed = self.lock();
        let mut want: HashSet<AssetGrant> =
            allowed.folders.iter().map(|f| (f.clone(), true)).collect();
        for file in &allowed.files {
            if let Some(dir) = file.parent()
                && !want.contains(&(dir.to_path_buf(), true))
            {
                want.insert((dir.to_path_buf(), false));
            }
        }
        want
    }

    /// Lets the asset protocol serve images from allowed folders and next to allowed files.
    ///
    /// Tauri's asset scope can only add allow or forbid patterns (forbid always wins), so a
    /// grant that dropped out of the trimmed lists is forbidden — unless that would also block
    /// a grant that is still wanted (one contains the other), in which case it stays served
    /// until the next launch. A path forbidden this way stays unservable until relaunch even
    /// if it is allowed again later (images there just don't load; files still open).
    fn sync_assets<R: Runtime>(&self, app: &AppHandle<R>) {
        let assets = app.asset_protocol_scope();
        let want = self.wanted_assets();
        let mut granted = self.assets.lock().unwrap_or_else(|e| e.into_inner());
        for (dir, recursive) in &want {
            if !granted.contains(&(dir.clone(), *recursive)) {
                let _ = assets.allow_directory(dir, *recursive);
            }
        }
        for (dir, recursive) in revoked(&granted, &want) {
            let _ = assets.forbid_directory(&dir, recursive);
        }
        // Keep forbidden-but-overlapping grants in the set so they are not retried.
        granted.retain(|g| !want.contains(g) && overlaps_any(g, &want));
        // ~/Library stays unservable unless a grant lies inside it (R4-L4).
        let mut forbidden = self
            .asset_forbidden
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for lib in &self.library {
            for p in library_forbids(lib, &want) {
                if forbidden.insert(p.clone()) {
                    let _ = assets.forbid_directory(&p, true);
                }
            }
        }
        granted.extend(want);
    }

    pub fn allow_folder<R: Runtime>(&self, app: &AppHandle<R>, path: &Path) {
        if let Some(p) = canonical(path) {
            push_recent(&mut self.lock().folders, p, MAX_FOLDERS);
            self.save();
            self.sync_assets(app);
        }
    }

    pub fn allow_file<R: Runtime>(&self, app: &AppHandle<R>, path: &Path) {
        self.allow_file_entry(path);
        self.save();
        self.sync_assets(app);
    }

    /// Records a file: its canonical target (for reading/writing) and, for a symlink, the link
    /// itself (so trash/rename can act on the link).
    fn allow_file_entry(&self, path: &Path) {
        let mut allowed = self.lock();
        let target = canonical(path);
        let link = entry_path(path).filter(|e| Some(e) != target.as_ref());
        for p in link.into_iter().chain(target) {
            push_recent(&mut allowed.files, p, MAX_FILES);
        }
    }

    /// Whatever was dropped or opened from Finder: folders become library roots, files are allowed.
    pub fn allow_path<R: Runtime>(&self, app: &AppHandle<R>, path: &Path) {
        if path.is_dir() {
            self.allow_folder(app, path);
        } else {
            self.allow_file(app, path);
        }
    }

    /// `p` (already resolved) is an allowed file or lies inside an allowed folder with nothing
    /// below the folder hidden (dot, Finder-hidden, `~/Library`).
    fn contains(&self, p: &Path) -> bool {
        if self.lock().files.iter().any(|f| f == p) {
            return true;
        }
        self.in_folder(p)
    }

    /// `p` lies (visibly) inside an allowed folder. The lock is not held during the lstat calls.
    fn in_folder(&self, p: &Path) -> bool {
        let roots: Vec<PathBuf> = self
            .lock()
            .folders
            .iter()
            .filter(|d| within(d, p))
            .cloned()
            .collect();
        roots.iter().any(|d| !excluded_below(d, p, &self.library))
    }

    /// A Markdown file to read, write or stat: the canonical (symlink-resolved) path.
    pub fn check_file(&self, path: &str) -> Result<PathBuf, String> {
        let p = canonical(Path::new(path)).ok_or_else(|| denied(path))?;
        if !has_extension(&p, MD_EXTENSIONS) || p.is_dir() {
            return Err(format!("Focus only opens Markdown files, not “{path}”."));
        }
        if self.contains(&p) {
            Ok(p)
        } else {
            Err(denied(path))
        }
    }

    /// Records the exact path the user just picked in the HTML Save dialog as a one-time
    /// export target (R4-M3).
    pub fn grant_export(&self, path: &Path) {
        if let Some(p) = canonical(path).filter(|p| has_extension(p, EXPORT_EXTENSIONS)) {
            self.exports
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(p);
        }
    }

    /// Consumes the one-time export grant for `path`: the canonical path to write. Folder roots
    /// and allowed files never grant `.html`.
    pub fn take_export(&self, path: &str) -> Result<PathBuf, String> {
        let p = canonical(Path::new(path)).ok_or_else(|| denied(path))?;
        if !has_extension(&p, EXPORT_EXTENSIONS) || p.is_dir() {
            return Err(format!("Focus only exports to .html files, not “{path}”."));
        }
        if self
            .exports
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&p)
        {
            Ok(p)
        } else {
            Err(format!(
                "Focus can't export to “{path}”. Choose the file with File ▸ Export first."
            ))
        }
    }

    /// A folder to list, watch or create files in: the canonical path.
    pub fn check_folder(&self, path: &str) -> Result<PathBuf, String> {
        let p = path_canonical(path)?;
        if self.in_folder(&p) {
            Ok(p)
        } else {
            Err(denied(path))
        }
    }

    /// A folder the Save dialog may open in: an allowed folder or the folder of an allowed file.
    /// (Only picks the dialog's starting place; grants nothing.)
    pub fn is_known_dir(&self, path: &str) -> bool {
        self.check_folder(path).is_ok()
            || path_canonical(path)
                .is_ok_and(|d| self.lock().files.iter().any(|f| f.parent() == Some(&d)))
    }

    /// The directory entry `path` names (a symlink is *not* followed), for trash/rename.
    /// Files must be Markdown; folders are accepted only if `allow_dir`.
    ///
    /// A real folder (not a symlink to one) is returned canonicalized, i.e. with its on-disk
    /// spelling (case, Unicode normalization), so later guards compare the folder itself and
    /// not however the webview spelled it (R4-H1).
    pub fn check_entry(&self, path: &str, allow_dir: bool) -> Result<PathBuf, String> {
        let mut p = entry_path(Path::new(path)).ok_or_else(|| denied(path))?;
        let meta = fs::symlink_metadata(&p).map_err(|_| denied(path))?;
        if meta.is_dir() {
            p = p.canonicalize().map_err(|_| denied(path))?;
        }
        if !self.contains(&p) {
            return Err(denied(path));
        }
        let ok_kind = if meta.is_dir() {
            allow_dir
        } else {
            has_extension(&p, MD_EXTENSIONS)
        };
        if !ok_kind {
            return Err(format!("Focus only manages Markdown files, not “{path}”."));
        }
        Ok(p)
    }

    /// Whether the folder `dir` may be renamed. `dir` is canonicalized here again (on-disk
    /// spelling, R4-H1), so a case- or normalization-changed spelling can't slip past.
    /// Refused: a library root; `$HOME`, `~/Library`, Focus's data/config folders and any of
    /// their ancestors; anything inside Focus's folders; folders directly in `$HOME` (R4-M1),
    /// directly in `~/Library`, and iCloud containers (`~/Library/Mobile Documents/*`).
    /// Ordinary folders deeper inside `~/Library` (an iCloud Drive library) may be renamed
    /// (R4-M2).
    pub fn check_rename_dir(&self, dir: &Path, guard: &RenameGuard) -> Result<(), String> {
        let dir = dir.canonicalize().map_err(|e| e.to_string())?;
        let dir = dir.as_path();
        let name = dir.file_name().map_or_else(
            || dir.to_string_lossy().into_owned(),
            |n| n.to_string_lossy().into_owned(),
        );
        let is = |p: &Path| p == dir || same_inode(p, dir);
        if self.lock().folders.iter().any(|f| is(f)) {
            return Err(format!(
                "“{name}” is the library folder. Rename it in Finder instead."
            ));
        }
        let system = || Err(format!("Focus can't rename the system folder “{name}”."));
        let all = guard
            .home
            .iter()
            .chain(&guard.library)
            .chain(&guard.app_dirs);
        for p in all {
            // `dir` is the protected folder or one of its ancestors.
            if p.starts_with(dir) || is(p) {
                return system();
            }
        }
        if guard.app_dirs.iter().any(|a| dir.starts_with(a)) {
            return system();
        }
        let parent = dir.parent();
        let child_of = |dirs: &[PathBuf]| {
            parent.is_some_and(|par| dirs.iter().any(|d| par == d || same_inode(par, d)))
        };
        if child_of(&guard.home) {
            return Err(format!(
                "“{name}” is a folder in your home folder. Rename it in Finder instead."
            ));
        }
        let containers: Vec<PathBuf> = guard
            .library
            .iter()
            .map(|l| l.join("Mobile Documents"))
            .collect();
        if child_of(&guard.library) || child_of(&containers) {
            return system();
        }
        Ok(())
    }

    /// After a rename, keep access: an allowed file follows its new name, and allowed
    /// folders (or files) at or below a renamed folder move with it.
    pub fn follow_rename<R: Runtime>(&self, app: &AppHandle<R>, from: &Path, to: &Path) {
        if self.rebase_all(from, to) {
            self.save();
            self.sync_assets(app);
        }
    }

    fn rebase_all(&self, from: &Path, to: &Path) -> bool {
        let mut guard = self.lock();
        let allowed = &mut *guard;
        let mut changed = false;
        for list in [&mut allowed.folders, &mut allowed.files] {
            for p in list.iter_mut() {
                if let Some(n) = rebase(p, from, to) {
                    *p = n;
                    changed = true;
                }
            }
            let mut seen = HashSet::new();
            list.retain(|p| seen.insert(p.clone()));
        }
        changed
    }
}

fn path_canonical(path: &str) -> Result<PathBuf, String> {
    Path::new(path).canonicalize().map_err(|_| denied(path))
}

fn overlaps_any(g: &AssetGrant, want: &HashSet<AssetGrant>) -> bool {
    want.iter()
        .any(|(w, _)| w.starts_with(&g.0) || g.0.starts_with(w))
}

/// Previously granted entries that are no longer wanted and can be forbidden without blocking
/// anything still wanted.
fn revoked(granted: &HashSet<AssetGrant>, want: &HashSet<AssetGrant>) -> Vec<AssetGrant> {
    granted
        .iter()
        .filter(|g| !want.contains(g) && !overlaps_any(g, want))
        .cloned()
        .collect()
}

/// What to forbid to the asset protocol so `lib` (`~/Library`) is not served (R4-L4): nothing
/// unless a wanted recursive grant strictly contains `lib` (e.g. a library folder of `~`).
/// Then all of `lib`, or — when some wanted grant lies inside `lib` (an iCloud library) —
/// everything in `lib` except the paths leading to those grants.
fn library_forbids(lib: &Path, want: &HashSet<AssetGrant>) -> Vec<PathBuf> {
    let covered = want
        .iter()
        .any(|(g, recursive)| *recursive && lib.starts_with(g) && g != lib);
    if !covered {
        return vec![];
    }
    let keep: Vec<&Path> = want
        .iter()
        .map(|(g, _)| g.as_path())
        .filter(|g| g.starts_with(lib))
        .collect();
    let mut out = Vec::new();
    forbid_except(lib, &keep, &mut out);
    out
}

/// Forbids `dir` entirely unless a `keep` path lies at or below it; then recurses into the
/// children on the way to the kept paths (a kept path itself is left alone).
fn forbid_except(dir: &Path, keep: &[&Path], out: &mut Vec<PathBuf>) {
    if keep.contains(&dir) {
        return;
    }
    if !keep.iter().any(|k| k.starts_with(dir)) {
        out.push(dir.to_path_buf());
        return;
    }
    let Ok(items) = fs::read_dir(dir) else { return };
    for item in items.flatten() {
        let child = item.path();
        if item.file_type().is_ok_and(|t| t.is_dir()) {
            forbid_except(&child, keep, out);
        } else if !keep.iter().any(|k| k.starts_with(&child)) {
            out.push(child);
        }
    }
}

/// Reads scope.json. Returns the allowlist and whether the file is absent (first run).
/// A corrupt or unreadable file is logged and backed up (never silently replaced).
fn read_allowed(file: &Path) -> (Allowed, bool) {
    match fs::read_to_string(file) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(allowed) => (allowed, false),
            Err(e) => {
                let backup = file.with_extension("json.corrupt");
                let copied = fs::copy(file, &backup).is_ok();
                eprintln!(
                    "focus: {} is corrupt ({e}); starting with no folder access{}",
                    file.display(),
                    if copied {
                        format!(", backup at {}", backup.display())
                    } else {
                        String::new()
                    }
                );
                (Allowed::default(), false)
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Allowed::default(), true),
        Err(e) => {
            eprintln!("focus: couldn't read {}: {e}", file.display());
            (Allowed::default(), false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn scope_with(folders: Vec<PathBuf>, files: Vec<PathBuf>) -> Scope {
        Scope::new(Allowed { folders, files }, None, vec![])
    }

    fn scope_lib(folders: Vec<PathBuf>, files: Vec<PathBuf>, library: &Path) -> Scope {
        Scope::new(
            Allowed { folders, files },
            None,
            vec![library.to_path_buf()],
        )
    }

    #[cfg(target_os = "macos")]
    fn hide(p: &Path) {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(p.as_os_str().as_bytes()).unwrap();
        // SAFETY: valid NUL-terminated path.
        assert_eq!(
            unsafe { libc::chflags(c.as_ptr(), libc::UF_HIDDEN as _) },
            0
        );
    }

    /// The volume holding `dir` ignores case (APFS default on macOS).
    fn case_insensitive(dir: &Path) -> bool {
        let probe = dir.join("CaseProbe");
        fs::create_dir(&probe).unwrap();
        let yes = dir.join("caseprobe").exists();
        fs::remove_dir(&probe).unwrap();
        yes
    }

    fn guard_for(home: &Path, app: &Path) -> RenameGuard {
        RenameGuard {
            home: vec![home.to_path_buf()],
            library: vec![home.join("Library")],
            app_dirs: vec![app.to_path_buf()],
        }
    }

    fn s(p: &Path) -> &str {
        p.to_str().unwrap()
    }

    fn root() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        (tmp, root)
    }

    #[test]
    fn allows_only_listed_folders_and_files() {
        let (_tmp, root) = root();
        fs::create_dir(root.join("notes")).unwrap();
        fs::write(root.join("notes/a.md"), "").unwrap();
        fs::write(root.join("single.md"), "").unwrap();
        fs::write(root.join("secret.md"), "").unwrap();
        let scope = scope_with(vec![root.join("notes")], vec![root.join("single.md")]);

        assert!(scope.check_file(s(&root.join("notes/a.md"))).is_ok());
        assert!(
            scope.check_file(s(&root.join("notes/new.md"))).is_ok(),
            "new files inside a folder"
        );
        assert!(scope.check_file(s(&root.join("single.md"))).is_ok());
        assert!(scope.check_file(s(&root.join("secret.md"))).is_err());
        // `..` tricks are resolved before checking
        assert!(
            scope
                .check_file(s(&root.join("notes/../secret.md")))
                .is_err()
        );
        assert!(scope.check_file(s(&root.join("notes/.."))).is_err());
        assert!(scope.check_folder(s(&root.join("notes/.."))).is_err());
        assert!(scope.check_folder(s(&root.join("notes"))).is_ok());
        // a single allowed file does not grant its folder
        assert!(scope.check_folder(s(&root)).is_err());
    }

    /// R2-H2: only Markdown, nothing hidden below the root.
    #[test]
    fn folder_grants_only_unhidden_markdown() {
        let (_tmp, root) = root();
        fs::create_dir_all(root.join(".ssh")).unwrap();
        fs::create_dir_all(root.join("notes/.git")).unwrap();
        fs::write(root.join(".ssh/id_rsa"), "key").unwrap();
        fs::write(root.join(".ssh/notes.md"), "").unwrap();
        fs::write(root.join(".zshrc"), "").unwrap();
        fs::write(root.join(".hidden.md"), "").unwrap();
        fs::write(root.join("notes/.git/x.md"), "").unwrap();
        fs::write(root.join("data.json"), "{}").unwrap();
        fs::write(root.join("a.MD"), "").unwrap();
        fs::write(root.join("b.txt"), "").unwrap();
        let scope = scope_with(vec![root.clone()], vec![]);

        for bad in [
            ".ssh/id_rsa",
            ".ssh/notes.md",
            ".zshrc",
            ".hidden.md",
            "notes/.git/x.md",
            "data.json",
            "new.json",
            "notes",
        ] {
            assert!(scope.check_file(s(&root.join(bad))).is_err(), "{bad}");
        }
        for good in ["a.MD", "b.txt", "notes/new.markdown"] {
            assert!(scope.check_file(s(&root.join(good))).is_ok(), "{good}");
        }
        assert!(scope.check_folder(s(&root.join(".ssh"))).is_err());
        assert!(scope.check_folder(s(&root.join("notes/.git"))).is_err());
        assert!(
            scope
                .check_entry(s(&root.join(".hidden.md")), false)
                .is_err()
        );
        assert!(
            scope
                .check_entry(s(&root.join("data.json")), false)
                .is_err()
        );
        assert!(scope.check_entry(s(&root.join("notes")), false).is_err());
        assert!(scope.check_entry(s(&root.join("notes")), true).is_ok());
        // a folder never grants .html (R4-M3)
        assert!(scope.take_export(s(&root.join("out.html"))).is_err());
        assert!(scope.check_file(s(&root.join("out.html"))).is_err());
    }

    /// A single allowed file of another type (e.g. dropped image) is still not readable.
    #[test]
    fn single_files_need_markdown_extension() {
        let (_tmp, root) = root();
        fs::write(root.join("pic.png"), "").unwrap();
        let scope = scope_with(vec![], vec![root.join("pic.png"), root.join("x.html")]);
        assert!(scope.check_file(s(&root.join("pic.png"))).is_err());
        assert!(scope.check_file(s(&root.join("x.html"))).is_err());
        // an allowed .html file (e.g. from an older scope.json) is no export grant either
        assert!(scope.take_export(s(&root.join("x.html"))).is_err());
    }

    /// R4-M3: the HTML Save dialog grants exactly the picked path, once.
    #[test]
    fn export_is_a_one_time_grant() {
        let (_tmp, root) = root();
        fs::create_dir(root.join("site")).unwrap();
        let scope = scope_with(vec![root.clone()], vec![]);
        let out = root.join("site/out.html");
        assert!(
            scope.take_export(s(&out)).is_err(),
            "folder grants no .html"
        );
        scope.grant_export(&out);
        assert!(scope.take_export(s(&root.join("site/index.html"))).is_err());
        assert!(scope.check_file(s(&out)).is_err(), "not readable as a note");
        // `..` spelling resolves to the same file
        assert_eq!(
            scope.take_export(s(&root.join("site/../site/out.html"))),
            Ok(out.clone())
        );
        assert!(scope.take_export(s(&out)).is_err(), "used up");
        // non-.html picks grant nothing
        scope.grant_export(&root.join("a.md"));
        assert!(scope.take_export(s(&root.join("a.md"))).is_err());
    }

    /// R4-M4: folder grants skip ~/Library and Finder-hidden components like the scans do,
    /// except below a root that itself lives inside ~/Library, and for explicitly allowed files.
    #[test]
    fn folder_grants_skip_library_and_finder_hidden() {
        let (_tmp, home) = root();
        let lib = home.join("Library");
        let icloud = lib.join("Mobile Documents/com~apple~CloudDocs/Notes");
        fs::create_dir_all(icloud.join("sub")).unwrap();
        fs::create_dir_all(lib.join("Preferences")).unwrap();
        fs::create_dir_all(home.join("Secret")).unwrap();
        fs::write(lib.join("Preferences/p.md"), "").unwrap();
        fs::write(icloud.join("sub/n.md"), "").unwrap();
        fs::write(home.join("Secret/s.md"), "").unwrap();
        fs::write(home.join("hidden.md"), "").unwrap();
        #[cfg(target_os = "macos")]
        {
            hide(&lib);
            hide(&home.join("Secret"));
            hide(&home.join("hidden.md"));
        }
        let scope = scope_lib(
            vec![home.clone(), icloud.clone()],
            vec![lib.join("Preferences/p.md")],
            &lib,
        );
        // through the ~ root: ~/Library is out
        assert!(
            scope
                .check_file(s(&lib.join("Mobile Documents/x.md")))
                .is_err()
        );
        assert!(scope.check_folder(s(&lib)).is_err());
        assert!(scope.check_entry(s(&lib), true).is_err());
        #[cfg(target_os = "macos")]
        {
            assert!(scope.check_file(s(&home.join("Secret/s.md"))).is_err());
            assert!(scope.check_file(s(&home.join("Secret/new.md"))).is_err());
            assert!(scope.check_file(s(&home.join("hidden.md"))).is_err());
            assert!(
                scope
                    .check_entry(s(&home.join("hidden.md")), false)
                    .is_err()
            );
            assert!(scope.check_folder(s(&home.join("Secret"))).is_err());
        }
        assert!(scope.check_file(s(&home.join("new.md"))).is_ok());
        // the root inside ~/Library (iCloud) works, components above it aren't tested
        assert!(scope.check_file(s(&icloud.join("sub/n.md"))).is_ok());
        assert!(scope.check_file(s(&icloud.join("new.md"))).is_ok());
        assert!(scope.check_folder(s(&icloud.join("sub"))).is_ok());
        assert!(scope.check_entry(s(&icloud.join("sub")), true).is_ok());
        // an explicitly allowed file inside ~/Library stays allowed
        assert!(scope.check_file(s(&lib.join("Preferences/p.md"))).is_ok());
        assert!(scope.check_file(s(&lib.join("Preferences/q.md"))).is_err());
    }

    #[test]
    fn symlink_out_of_folder_is_denied() {
        let (_tmp, root) = root();
        fs::create_dir(root.join("notes")).unwrap();
        fs::create_dir(root.join("notes/.private")).unwrap();
        fs::write(root.join("secret.md"), "").unwrap();
        fs::write(root.join("notes/.private/p.md"), "").unwrap();
        symlink(root.join("secret.md"), root.join("notes/escape.md")).unwrap();
        symlink(
            root.join("notes/.private/p.md"),
            root.join("notes/hidden-link.md"),
        )
        .unwrap();
        symlink(root.join("secret.md"), root.join("notes/escape-link")).unwrap();
        let scope = scope_with(vec![root.join("notes")], vec![]);
        assert!(scope.check_file(s(&root.join("notes/escape.md"))).is_err());
        assert!(
            scope
                .check_file(s(&root.join("notes/hidden-link.md")))
                .is_err()
        );
        assert!(
            scope
                .check_file(s(&root.join("notes/escape-link")))
                .is_err()
        );
        // a linked folder pointing out is not a folder in scope either
        symlink(&root, root.join("notes/up")).unwrap();
        assert!(scope.check_folder(s(&root.join("notes/up"))).is_err());
    }

    /// R2-M2: trash/rename check the link itself, not where it points.
    #[test]
    fn entry_is_the_link_not_the_target() {
        let (_tmp, root) = root();
        fs::create_dir(root.join("notes")).unwrap();
        fs::write(root.join("outside.md"), "").unwrap();
        symlink(root.join("outside.md"), root.join("notes/link.md")).unwrap();
        let scope = scope_with(vec![root.join("notes")], vec![]);
        // the link lives in the folder: it may be trashed/renamed (the target is untouched)
        assert_eq!(
            scope
                .check_entry(s(&root.join("notes/link.md")), false)
                .unwrap(),
            root.join("notes/link.md")
        );
        // but its target is not readable through it
        assert!(scope.check_file(s(&root.join("notes/link.md"))).is_err());

        // A link outside the folder pointing *into* it can't be trashed via the folder grant.
        fs::write(root.join("notes/in.md"), "").unwrap();
        symlink(root.join("notes/in.md"), root.join("in-link.md")).unwrap();
        assert!(
            scope
                .check_entry(s(&root.join("in-link.md")), false)
                .is_err()
        );

        // Individually allowed symlinked file: both the link and the target are recorded.
        let single = scope_with(vec![], vec![]);
        single.allow_file_entry(&root.join("in-link.md"));
        assert!(
            single
                .check_entry(s(&root.join("in-link.md")), false)
                .is_ok()
        );
        assert!(single.check_file(s(&root.join("in-link.md"))).is_ok());
        assert!(
            single
                .check_entry(s(&root.join("notes/in.md")), false)
                .is_ok()
        );
    }

    #[test]
    fn rename_follows_files_and_folders() {
        let (_tmp, root) = root();
        let scope = scope_with(
            vec![root.join("lib"), root.join("other")],
            vec![root.join("a.md"), root.join("lib/sub/b.md")],
        );
        assert!(scope.rebase_all(&root.join("lib"), &root.join("Library")));
        assert!(scope.rebase_all(&root.join("a.md"), &root.join("A2.md")));
        assert!(!scope.rebase_all(&root.join("nope"), &root.join("x")));
        let allowed = scope.lock();
        assert_eq!(
            allowed.folders,
            vec![root.join("Library"), root.join("other")]
        );
        assert_eq!(
            allowed.files,
            vec![root.join("A2.md"), root.join("Library/sub/b.md")]
        );
        // `lib2` is not inside `lib`
        drop(allowed);
        let scope = scope_with(vec![root.join("lib2")], vec![]);
        assert!(!scope.rebase_all(&root.join("lib"), &root.join("x")));
    }

    /// R2-M1: single files grant their folder non-recursively; trimmed grants are revoked
    /// unless that would block something still wanted.
    #[test]
    fn asset_grants() {
        let r = PathBuf::from("/r");
        let scope = scope_with(
            vec![r.join("lib")],
            vec![r.join("docs/a.md"), r.join("lib/sub/b.md")],
        );
        let want = scope.wanted_assets();
        assert!(want.contains(&(r.join("lib"), true)));
        assert!(want.contains(&(r.join("docs"), false)));
        assert!(!want.contains(&(r.join("docs"), true)));

        let granted: HashSet<AssetGrant> = [
            (r.join("old"), true),
            (r.join("lib/deeper"), true), // inside a still-wanted folder: keep
            (r.clone(), true),            // contains a wanted folder: can't forbid
            (r.join("docs"), false),
        ]
        .into();
        assert_eq!(revoked(&granted, &want), vec![(r.join("old"), true)]);
    }

    /// R3-H1: library roots and protected folders (and their ancestors/contents) can't be
    /// renamed; ordinary subfolders can.
    #[test]
    fn rename_dir_guard() {
        let (_tmp, root) = root();
        let lib = root.join("home");
        let support = lib.join("Library/Application Support/focus");
        fs::create_dir_all(&support).unwrap();
        fs::create_dir_all(lib.join("notes/sub")).unwrap();
        let scope = scope_with(vec![lib.clone()], vec![]);
        let guard = RenameGuard {
            home: vec![],
            library: vec![lib.join("Library")],
            app_dirs: vec![support.clone()],
        };
        let ok = |p: &Path| scope.check_rename_dir(p, &guard).is_ok();
        assert!(ok(&lib.join("notes")));
        assert!(ok(&lib.join("notes/sub")));
        assert!(!ok(&lib), "library root");
        assert!(!ok(&lib.join("Library")), "~/Library itself");
        assert!(
            !ok(&lib.join("Library/Application Support")),
            "inside / ancestor"
        );
        assert!(!ok(&support), "app data");
        assert!(!ok(&root), "ancestor of protected");
        // the entry check still accepts the folder; the guard is what refuses it
        assert!(scope.check_entry(s(&lib.join("Library")), true).is_ok());
    }

    /// R4-M1/M2: folders directly in $HOME (and in ~/Library, and iCloud containers) are
    /// refused; folders inside an iCloud library are not, but Focus's own data still is.
    #[test]
    fn rename_guard_home_children_and_icloud() {
        let (_tmp, home) = root();
        let lib = home.join("Library");
        let app = lib.join("Application Support/focus");
        let container = lib.join("Mobile Documents/iCloud~md~obsidian");
        let vault = container.join("Documents/Vault");
        for d in [
            &app.join("x"),
            &vault.join("sub"),
            &home.join("Pictures/trip"),
        ] {
            fs::create_dir_all(d).unwrap();
        }
        let scope = scope_with(vec![home.clone(), vault.clone()], vec![]);
        let guard = guard_for(&home, &app);
        let ok = |p: &Path| scope.check_rename_dir(p, &guard).is_ok();
        assert!(!ok(&home), "home");
        assert!(!ok(&home.join("Pictures")), "direct child of home");
        assert!(ok(&home.join("Pictures/trip")));
        assert!(
            !ok(&lib.join("Mobile Documents")),
            "direct child of ~/Library"
        );
        assert!(!ok(&container), "iCloud container");
        assert!(
            ok(&container.join("Documents")),
            "inside an iCloud container"
        );
        assert!(!ok(&vault), "library root");
        assert!(ok(&vault.join("sub")), "folder in an iCloud library");
        assert!(!ok(&app), "app data");
        assert!(!ok(&app.join("x")), "inside app data");
    }

    /// R4-H1: a case- or normalization-changed spelling of a protected folder or a library root
    /// is the same folder on a case-insensitive volume and must be refused.
    #[test]
    fn rename_guard_sees_through_spelling() {
        let (_tmp, home) = root();
        if !case_insensitive(&home) {
            eprintln!("skipped: case-sensitive volume");
            return;
        }
        let lib = home.join("Library");
        let app = lib.join("Application Support/focus");
        fs::create_dir_all(&app).unwrap();
        fs::create_dir_all(home.join("Notes/Sub")).unwrap();
        fs::create_dir_all(home.join("Café/Sub")).unwrap(); // NFC on disk
        let scope = scope_with(
            vec![home.clone(), home.join("Notes"), home.join("Café")],
            vec![],
        );
        let guard = guard_for(&home, &app);
        // What the webview may send: entry check, then the guard on what it returns.
        let renamable = |typed: &Path| {
            scope
                .check_entry(s(typed), true)
                .and_then(|e| scope.check_rename_dir(&e, &guard))
                .is_ok()
        };
        assert!(!renamable(&home.join("library")), "~/library");
        assert!(!renamable(&home.join("LIBRARY")));
        assert!(!renamable(&home.join("library/application support")));
        assert!(!renamable(&home.join("library/Application Support/FOCUS")));
        assert!(!renamable(&home.join("notes")), "case-changed library root");
        assert!(
            !renamable(&home.join("Cafe\u{301}")),
            "NFD-spelled library root"
        );
        assert!(
            renamable(&home.join("notes/sub")),
            "ordinary folder, any case"
        );
        // the entry comes back with its on-disk spelling, so rebasing matches
        assert_eq!(
            scope.check_entry(s(&home.join("notes/sub")), true).unwrap(),
            home.join("Notes/Sub")
        );
        assert_eq!(
            scope
                .check_entry(s(&home.join("Cafe\u{301}/Sub")), true)
                .unwrap(),
            home.join("Café/Sub")
        );
    }

    /// R4-L4: ~/Library is forbidden to the asset protocol only when a grant covers it, and
    /// never on the way to a grant inside it.
    #[test]
    fn library_asset_forbids() {
        let (_tmp, home) = root();
        let lib = home.join("Library");
        let notes = lib.join("Mobile Documents/com~apple~CloudDocs/Notes");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(lib.join("Mobile Documents/other")).unwrap();
        fs::create_dir_all(lib.join("Preferences")).unwrap();
        fs::write(lib.join("Mobile Documents/file.txt"), "").unwrap();
        let set = |v: &[(PathBuf, bool)]| v.iter().cloned().collect::<HashSet<_>>();
        assert!(library_forbids(&lib, &set(&[(home.join("docs"), true)])).is_empty());
        assert!(library_forbids(&lib, &set(&[(home.clone(), false)])).is_empty());
        assert!(
            library_forbids(&lib, &set(&[(lib.clone(), true)])).is_empty(),
            "root is ~/Library"
        );
        assert_eq!(
            library_forbids(&lib, &set(&[(home.clone(), true)])),
            vec![lib.clone()]
        );
        let mut got = library_forbids(&lib, &set(&[(home.clone(), true), (notes.clone(), true)]));
        got.sort();
        assert_eq!(
            got,
            vec![
                lib.join("Mobile Documents/file.txt"),
                lib.join("Mobile Documents/other"),
                lib.join("Preferences"),
            ]
        );
    }

    /// R3-H1: a missing scope.json grants nothing (no import from settings.json).
    #[test]
    fn missing_scope_grants_nothing() {
        let (_tmp, root) = root();
        let settings = root.join("settings.json");
        fs::write(&settings, r#"{"folder":"/","lastFile":"/etc/hosts.md"}"#).unwrap();
        let (allowed, absent) = read_allowed(&root.join("scope.json"));
        assert!(absent);
        assert!(allowed.folders.is_empty() && allowed.files.is_empty());
    }

    /// R3-L4: concurrent saves never leave an older snapshot on disk.
    #[test]
    fn saves_land_in_order() {
        let (_tmp, root) = root();
        let store = root.join("scope.json");
        let scope =
            std::sync::Arc::new(Scope::new(Allowed::default(), Some(store.clone()), vec![]));
        let handles: Vec<_> = (0..16)
            .map(|i| {
                let scope = scope.clone();
                let dir = root.join(format!("d{i}"));
                std::thread::spawn(move || {
                    push_recent(&mut scope.lock().folders, dir, MAX_FOLDERS);
                    scope.save();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let (on_disk, _) = read_allowed(&store);
        assert_eq!(on_disk.folders, scope.lock().folders);
    }

    #[test]
    fn corrupt_scope_is_kept_and_not_migrated() {
        let (_tmp, root) = root();
        let file = root.join("scope.json");
        fs::write(&file, "{not json").unwrap();
        let (allowed, absent) = read_allowed(&file);
        assert!(!absent, "corrupt is not absent: no legacy migration");
        assert!(allowed.folders.is_empty());
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "{not json",
            "left in place"
        );
        assert_eq!(
            fs::read_to_string(root.join("scope.json.corrupt")).unwrap(),
            "{not json"
        );
        let (_, absent) = read_allowed(&root.join("missing.json"));
        assert!(absent);
    }
}
