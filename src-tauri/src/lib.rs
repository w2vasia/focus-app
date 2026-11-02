mod dialogs;
mod export;
mod files;
mod menu;
mod scope;
mod settings;

use std::sync::Mutex;

use std::path::PathBuf;

use tauri::{
    DragDropEvent, Emitter, LogicalPosition, Manager, RunEvent, TitleBarStyle, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};

use scope::Scope;

/// Traffic lights centred on the 44px web titlebar (y is the buttons' vertical centre).
const TRAFFIC_LIGHTS: LogicalPosition<f64> = LogicalPosition::new(16.0, 22.0);

/// When the pending quit request was sent, and whether the webview acknowledged it. Another ⌘Q
/// while a request has gone unacknowledged for at least `HUNG_AFTER` means the webview is hung:
/// quit anyway. A slow-but-alive webview acks quickly, so it never loses edits.
static QUIT_REQUESTED: Mutex<Option<std::time::Instant>> = Mutex::new(None);
static QUIT_ACKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const HUNG_AFTER: std::time::Duration = std::time::Duration::from_secs(1);

/// What a ⌘Q should do.
#[derive(Debug, PartialEq)]
enum QuitAction {
    /// Ask the webview to save and quit (a new request).
    Request,
    /// A request is pending and may still be acknowledged: do nothing yet.
    Wait,
    /// The pending request went unacknowledged too long: exit now.
    Force,
}

fn quit_action(
    pending: Option<std::time::Instant>,
    acked: bool,
    now: std::time::Instant,
) -> QuitAction {
    match pending {
        Some(sent) if !acked => {
            if now.saturating_duration_since(sent) >= HUNG_AFTER {
                QuitAction::Force
            } else {
                QuitAction::Wait
            }
        }
        _ => QuitAction::Request,
    }
}

/// The webview received "quit-requested" and is handling it (possibly showing a prompt).
#[tauri::command]
fn quit_ack() {
    QUIT_ACKED.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Files opened from Finder before the frontend was ready to receive them.
#[derive(Default)]
struct PendingFiles(Mutex<Vec<String>>);

#[tauri::command]
fn take_pending_files(
    app: tauri::AppHandle,
    state: tauri::State<PendingFiles>,
    scope: tauri::State<Scope>,
) -> Vec<String> {
    let paths = std::mem::take(&mut *state.0.lock().unwrap_or_else(|e| e.into_inner()));
    // These came from Finder (RunEvent::Opened), possibly before the scope existed.
    for p in &paths {
        scope.allow_path(&app, &PathBuf::from(p));
    }
    paths
}

/// Called by the frontend once unsaved work has been flushed after a quit request.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(files::WatchState::default())
        .manage(PendingFiles::default())
        .manage(settings::SettingsState::default())
        .menu(menu::build)
        .on_menu_event(|app, event| menu::forward(app, event.id().as_ref()))
        .setup(|app| {
            app.manage(Scope::load(app.handle()));
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Focus")
                .inner_size(900.0, 720.0)
                .min_inner_size(420.0, 320.0)
                .title_bar_style(TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(TRAFFIC_LIGHTS)
                .build()?;
            Ok(())
        })
        // Dropped files/folders are granted here, then announced; the webview opens them from
        // "dropped-paths" so it never races the grant.
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                let app = window.app_handle();
                if let Some(scope) = app.try_state::<Scope>() {
                    for p in paths {
                        scope.allow_path(app, p);
                    }
                }
                let list: Vec<String> = paths
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                let _ = app.emit("dropped-paths", list);
            }
        })
        .invoke_handler(tauri::generate_handler![
            take_pending_files,
            quit_ack,
            dialogs::pick_file,
            dialogs::pick_folder,
            dialogs::pick_save_path,
            quit_app,
            files::read_file,
            files::write_file,
            files::file_mtime,
            files::list_dir,
            files::create_file,
            files::rename_path,
            files::trash_path,
            files::reveal_path,
            files::watch_dir,
            files::watch_open_file,
            settings::get_settings,
            settings::set_setting,
            export::render_markdown,
            export::export_html,
            export::print_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // ⌘Q: let the frontend save first; it calls `quit_app` when done. Another ⌘Q once
            // a request has gone unacknowledged for a second quits regardless, so a hung webview
            // can never trap the user.
            RunEvent::ExitRequested {
                code: None, api, ..
            } if app.get_webview_window("main").is_some() => {
                let now = std::time::Instant::now();
                let mut pending = QUIT_REQUESTED.lock().unwrap_or_else(|e| e.into_inner());
                let acked = QUIT_ACKED.load(std::sync::atomic::Ordering::SeqCst);
                match quit_action(*pending, acked, now) {
                    QuitAction::Force => {}
                    QuitAction::Wait => api.prevent_exit(),
                    QuitAction::Request => {
                        *pending = Some(now);
                        QUIT_ACKED.store(false, std::sync::atomic::Ordering::SeqCst);
                        api.prevent_exit();
                        let _ = app.emit("quit-requested", ());
                    }
                }
            }
            RunEvent::Opened { urls } => {
                let paths: Vec<String> = urls
                    .into_iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                if let Some(scope) = app.try_state::<Scope>() {
                    for p in &paths {
                        scope.allow_path(app, &PathBuf::from(p));
                    }
                }
                app.state::<PendingFiles>()
                    .0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .extend(paths.clone());
                let _ = app.emit("open-files", paths);
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// R2-M4: only an unacknowledged request at least a second old is forced.
    #[test]
    fn force_quit_only_when_hung() {
        let t0 = Instant::now();
        let at = |ms| t0 + Duration::from_millis(ms);
        assert_eq!(quit_action(None, false, t0), QuitAction::Request);
        // quick double press: wait, never force
        assert_eq!(quit_action(Some(t0), false, at(300)), QuitAction::Wait);
        // still unacknowledged after a second: hung
        assert_eq!(quit_action(Some(t0), false, at(1000)), QuitAction::Force);
        assert_eq!(quit_action(Some(t0), false, at(60_000)), QuitAction::Force);
        // acknowledged (alive, maybe showing a prompt): ask again instead of forcing
        assert_eq!(quit_action(Some(t0), true, at(300)), QuitAction::Request);
        assert_eq!(quit_action(Some(t0), true, at(5000)), QuitAction::Request);
    }
}
