use tauri::menu::{Menu, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// (id, label, accelerator). Each id is forwarded verbatim to the webview as a `menu` event.
type Item = (&'static str, &'static str, Option<&'static str>);

const FILE: &[Item] = &[
    ("new", "New", Some("CmdOrCtrl+N")),
    ("open", "Open…", Some("CmdOrCtrl+O")),
    ("open_folder", "Open Folder…", Some("CmdOrCtrl+Shift+O")),
    ("-", "", None),
    ("save", "Save", Some("CmdOrCtrl+S")),
    ("save_as", "Save As…", Some("CmdOrCtrl+Shift+S")),
    ("-", "", None),
    ("export_html", "Export as HTML…", Some("CmdOrCtrl+Shift+E")),
    ("export_pdf", "Export as PDF…", Some("CmdOrCtrl+P")),
];

const EDIT_HISTORY: &[Item] = &[
    ("undo", "Undo", Some("CmdOrCtrl+Z")),
    ("redo", "Redo", Some("CmdOrCtrl+Shift+Z")),
];

const FIND: &[Item] = &[("find", "Find…", Some("CmdOrCtrl+F"))];

const FORMAT: &[Item] = &[
    ("bold", "Bold", Some("CmdOrCtrl+B")),
    ("italic", "Italic", Some("CmdOrCtrl+I")),
    ("strike", "Strikethrough", Some("CmdOrCtrl+Shift+X")),
    ("highlight", "Highlight", Some("CmdOrCtrl+Shift+H")),
    ("subscript", "Subscript", Some("Ctrl+Command+-")),
    ("superscript", "Superscript", Some("Ctrl+Command+=")),
    // ⌘E deliberately replaces macOS "Use Selection for Find" (rarely used in an editor).
    ("code", "Inline Code", Some("CmdOrCtrl+E")),
    ("link", "Link", Some("CmdOrCtrl+K")),
    ("-", "", None),
    ("paragraph", "Paragraph", Some("CmdOrCtrl+0")),
    ("h1", "Heading 1", Some("CmdOrCtrl+1")),
    ("h2", "Heading 2", Some("CmdOrCtrl+2")),
    ("h3", "Heading 3", Some("CmdOrCtrl+3")),
    ("-", "", None),
    ("quote", "Quote", Some("CmdOrCtrl+Shift+.")),
    ("ul", "Bullet List", Some("CmdOrCtrl+Shift+8")),
    ("ol", "Numbered List", Some("CmdOrCtrl+Shift+7")),
    ("task", "Task List", Some("CmdOrCtrl+Shift+9")),
    ("codeblock", "Code Block", Some("CmdOrCtrl+Alt+C")),
    ("table", "Table", Some("CmdOrCtrl+Alt+T")),
    ("hr", "Horizontal Rule", Some("CmdOrCtrl+Shift+-")),
    ("-", "", None),
    ("footnote", "Footnote", Some("CmdOrCtrl+Alt+N")),
    ("definition", "Definition", Some("CmdOrCtrl+Alt+L")),
    ("heading_id", "Heading ID", Some("CmdOrCtrl+Alt+I")),
    ("emoji", "Emoji…", None),
];

const VIEW: &[Item] = &[
    ("toggle_sidebar", "Toggle Sidebar", Some("CmdOrCtrl+\\")),
    (
        "search_library",
        "Search Library",
        Some("CmdOrCtrl+Shift+L"),
    ),
    (
        "toggle_toolbar",
        "Formatting Bar",
        Some("CmdOrCtrl+Shift+T"),
    ),
    (
        "toggle_stats",
        "Toggle Word Count",
        Some("CmdOrCtrl+Shift+W"),
    ),
    ("-", "", None),
    ("toggle_focus", "Focus Mode", Some("CmdOrCtrl+Shift+F")),
    (
        "toggle_focus_unit",
        "Focus: Sentence / Paragraph",
        Some("CmdOrCtrl+Alt+F"),
    ),
    (
        "toggle_typewriter",
        "Typewriter Scrolling",
        Some("CmdOrCtrl+Shift+Y"),
    ),
    ("view_edit", "Edit", Some("CmdOrCtrl+Alt+1")),
    ("view_split", "Split", Some("CmdOrCtrl+Alt+2")),
    ("view_read", "Read", Some("CmdOrCtrl+Alt+3")),
    ("toggle_preview", "Next View", Some("CmdOrCtrl+Shift+P")),
    ("cycle_font", "Switch Font", Some("CmdOrCtrl+Shift+J")),
    ("load_remote_images", "Load Remote Images", None),
    ("-", "", None),
    ("font_bigger", "Bigger Text", Some("CmdOrCtrl+=")),
    ("font_smaller", "Smaller Text", Some("CmdOrCtrl+-")),
    ("font_reset", "Actual Size", None),
    ("-", "", None),
    ("theme_auto", "Theme: System", None),
    ("theme_light", "Theme: Light", None),
    ("theme_dark", "Theme: Dark", None),
];

const HELP: &[Item] = &[
    ("help", "Focus Help", Some("CmdOrCtrl+Shift+/")),
    ("help_shortcuts", "Keyboard Shortcuts", None),
    ("help_markdown", "Markdown Reference", None),
];

fn submenu<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    items: &[Item],
) -> tauri::Result<Submenu<R>> {
    let mut b = SubmenuBuilder::new(app, title);
    for &(id, label, accel) in items {
        if id == "-" {
            b = b.separator();
            continue;
        }
        let mut item = MenuItemBuilder::with_id(id, label);
        if let Some(a) = accel {
            item = item.accelerator(a);
        }
        b = b.item(&item.build(app)?);
    }
    b.build()
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = SubmenuBuilder::new(app, "Focus")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let mut edit = SubmenuBuilder::new(app, "Edit");
    for &(id, label, accel) in EDIT_HISTORY {
        edit = edit.item(
            &MenuItemBuilder::with_id(id, label)
                .accelerator(accel.unwrap())
                .build(app)?,
        );
    }
    edit = edit
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator();
    for &(id, label, accel) in FIND {
        edit = edit.item(
            &MenuItemBuilder::with_id(id, label)
                .accelerator(accel.unwrap())
                .build(app)?,
        );
    }
    let edit = edit.build()?;

    let help = submenu(app, "Help", HELP)?;
    // Registering it as the app's Help menu gives the standard macOS menu search field.
    #[cfg(target_os = "macos")]
    help.set_as_help_menu_for_nsapp()?;

    // Standard macOS Window menu: Minimize, Zoom, Full Screen, Bring All to Front, Close.
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)
        .fullscreen()
        .separator()
        .bring_all_to_front()
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &submenu(app, "File", FILE)?,
            &edit,
            &submenu(app, "Format", FORMAT)?,
            &submenu(app, "View", VIEW)?,
            &window,
            &help,
        ],
    )
}

pub fn forward<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let _ = app.emit("menu", id);
}
