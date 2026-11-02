//! Open/Save dialogs run in the backend so every path the user picks is added to the
//! allowlist (`scope.rs`) by code the webview cannot impersonate.

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::scope::Scope;

const MARKDOWN: &[&str] = &["md", "markdown", "mdown", "txt"];

fn into_string(path: std::path::PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

#[tauri::command]
pub async fn pick_file(app: AppHandle, scope: State<'_, Scope>) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Markdown", MARKDOWN)
        .blocking_pick_file();
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| {
        scope.allow_file(&app, &p);
        into_string(p)
    }))
}

#[tauri::command]
pub async fn pick_folder(
    app: AppHandle,
    scope: State<'_, Scope>,
) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| {
        scope.allow_folder(&app, &p);
        into_string(p)
    }))
}

/// Save dialog. `kind` is "markdown" or "html"; `directory` is where it opens.
#[tauri::command]
pub async fn pick_save_path(
    app: AppHandle,
    scope: State<'_, Scope>,
    directory: Option<String>,
    file_name: String,
    kind: String,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_file_name(file_name);
    dialog = if kind == "html" {
        dialog.add_filter("HTML", &["html"])
    } else {
        dialog.add_filter("Markdown", MARKDOWN)
    };
    // Only open in a folder the user already granted; otherwise macOS picks the default.
    if let Some(dir) = directory.filter(|d| scope.is_known_dir(d)) {
        dialog = dialog.set_directory(dir);
    }
    let picked = dialog.blocking_save_file();
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| {
        if kind == "html" {
            // A one-time grant for `export_html`; nothing is added to the allowlist (R4-M3).
            scope.grant_export(&p);
        } else {
            scope.allow_file(&app, &p);
        }
        into_string(p)
    }))
}
