//! App preferences, persisted by the backend so the webview never gets a generic file API.
//!
//! Only the known keys with well-formed values are read or written (mirrors `VALID` in
//! `src/settings.ts`). The file is `<app data>/settings.json`, the same one the store plugin
//! used, so existing preferences carry over.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Runtime, State};

const SETTINGS_FILE: &str = "settings.json";
const MAX_PATH_LEN: usize = 4096;

/// Serialises read-modify-write of the settings file.
#[derive(Default)]
pub struct SettingsState(Mutex<()>);

fn one_of(v: &Value, options: &[&str]) -> bool {
    v.as_str().is_some_and(|s| options.contains(&s))
}

fn abs_path_or_null(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.starts_with('/') && s.len() <= MAX_PATH_LEN && !s.contains('\0'),
        _ => false,
    }
}

/// Whether `value` is acceptable for `key`; unknown keys are never valid.
pub fn is_valid(key: &str, value: &Value) -> bool {
    match key {
        "theme" => one_of(value, &["auto", "light", "dark"]),
        "font" => one_of(value, &["serif", "sans", "mono"]),
        "viewMode" => one_of(value, &["edit", "split", "read"]),
        "fontSize" => value
            .as_f64()
            .is_some_and(|n| n.is_finite() && (12.0..=32.0).contains(&n)),
        "focusUnit" => one_of(value, &["paragraph", "sentence"]),
        "typewriter" | "sidebarVisible" | "toolbarPinned" | "statsVisible" => value.is_boolean(),
        "folder" | "lastFile" => abs_path_or_null(value),
        _ => false,
    }
}

/// The valid known entries of a settings object (anything else is dropped).
pub fn sanitize(all: &Map<String, Value>) -> Map<String, Value> {
    all.iter()
        .filter(|(k, v)| is_valid(k, v))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn read_map(file: &std::path::Path) -> Map<String, Value> {
    fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}

/// Validates and stores one key in `file` (other keys are kept as they are).
pub fn write_key(file: &std::path::Path, key: &str, value: Value) -> Result<(), String> {
    if !is_valid(key, &value) {
        return Err(format!("Invalid setting “{key}”."));
    }
    let mut map = read_map(file);
    map.insert(key.to_string(), value);
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&Value::Object(map)).map_err(|e| e.to_string())?;
    crate::files::write_atomic(file, json.as_bytes())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn settings_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(SETTINGS_FILE))
        .map_err(|e| e.to_string())
}

/// The stored preferences: only known keys with valid values (missing ones → frontend defaults).
#[tauri::command]
pub async fn get_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<Map<String, Value>, String> {
    let file = settings_file(&app)?;
    let _guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    Ok(sanitize(&read_map(&file)))
}

/// Stores one preference. Rejects unknown keys and wrongly typed values.
#[tauri::command]
pub async fn set_setting(
    app: AppHandle,
    state: State<'_, SettingsState>,
    key: String,
    value: Value,
) -> Result<(), String> {
    let file = settings_file(&app)?;
    let _guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    write_key(&file, &key, value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_keys_and_types() {
        for (k, v) in [
            ("theme", json!("dark")),
            ("font", json!("mono")),
            ("viewMode", json!("split")),
            ("fontSize", json!(18)),
            ("fontSize", json!(12.5)),
            ("focusUnit", json!("sentence")),
            ("typewriter", json!(true)),
            ("statsVisible", json!(false)),
            ("folder", json!(null)),
            ("lastFile", json!("/Users/me/a.md")),
        ] {
            assert!(is_valid(k, &v), "{k} = {v}");
        }
        for (k, v) in [
            ("theme", json!(42)),
            ("theme", json!("neon")),
            ("font", json!("comic")),
            ("fontSize", json!("huge")),
            ("fontSize", json!(100)),
            ("fontSize", json!(11)),
            ("typewriter", json!("yes")),
            ("folder", json!("relative/path")),
            ("folder", json!({"a": 1})),
            ("lastFile", json!(["/a"])),
            ("lastFile", json!("/a\u{0}b")),
            ("unknown", json!(true)),
            ("__proto__", json!({})),
            ("../scope", json!("x")),
        ] {
            assert!(!is_valid(k, &v), "{k} = {v}");
        }
    }

    #[test]
    fn writes_only_valid_keys_and_keeps_others() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("settings.json");
        fs::write(
            &file,
            r#"{"theme":"light","preview":true,"fontSize":"huge"}"#,
        )
        .unwrap();

        write_key(&file, "fontSize", json!(20)).unwrap();
        assert!(write_key(&file, "fontSize", json!("big")).is_err());
        assert!(write_key(&file, "folders", json!(["/"])).is_err());

        let raw = read_map(&file);
        assert_eq!(raw["fontSize"], json!(20));
        assert_eq!(raw["preview"], json!(true), "unknown keys are left alone");
        assert!(!raw.contains_key("folders"));

        let clean = sanitize(&raw);
        assert_eq!(clean.len(), 2);
        assert_eq!(clean["theme"], json!("light"));
        assert_eq!(clean["fontSize"], json!(20));
    }

    #[test]
    fn missing_or_corrupt_file_reads_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("settings.json");
        assert!(read_map(&file).is_empty());
        fs::write(&file, "[1,2").unwrap();
        assert!(read_map(&file).is_empty());
        write_key(&file, "theme", json!("dark")).unwrap();
        assert_eq!(read_map(&file)["theme"], json!("dark"));
    }
}
