import { invoke } from "@tauri-apps/api/core";
import type { FocusUnit } from "./editor/focusMode";

export type Theme = "auto" | "light" | "dark";
export type ProseFont = "serif" | "sans" | "mono";
export type ViewMode = "edit" | "split" | "read";

export interface Settings {
  theme: Theme;
  font: ProseFont;
  viewMode: ViewMode;
  fontSize: number;
  focusUnit: FocusUnit;
  typewriter: boolean;
  sidebarVisible: boolean;
  toolbarPinned: boolean;
  statsVisible: boolean;
  folder: string | null;
  lastFile: string | null;
}

export const DEFAULTS: Settings = {
  theme: "auto",
  font: "serif",
  viewMode: "edit",
  fontSize: 18,
  focusUnit: "paragraph",
  typewriter: false,
  sidebarVisible: false,
  toolbarPinned: false,
  statsVisible: true,
  folder: null,
  lastFile: null,
};

export const settings: Settings = { ...DEFAULTS };

/**
 * Accepts a stored value only if it has the right shape; anything else keeps the default.
 * The backend (`src-tauri/src/settings.rs`) enforces the same rules on read and write.
 */
const VALID: { [K in keyof Settings]: (v: unknown) => boolean } = {
  theme: (v) => v === "auto" || v === "light" || v === "dark",
  font: (v) => v === "serif" || v === "sans" || v === "mono",
  viewMode: (v) => v === "edit" || v === "split" || v === "read",
  fontSize: (v) => typeof v === "number" && Number.isFinite(v) && v >= 12 && v <= 32,
  focusUnit: (v) => v === "paragraph" || v === "sentence",
  typewriter: (v) => typeof v === "boolean",
  sidebarVisible: (v) => typeof v === "boolean",
  toolbarPinned: (v) => typeof v === "boolean",
  statsVisible: (v) => typeof v === "boolean",
  folder: (v) => v === null || (typeof v === "string" && v.startsWith("/")),
  lastFile: (v) => v === null || (typeof v === "string" && v.startsWith("/")),
};

export async function loadSettings() {
  try {
    const stored = await invoke<Record<string, unknown>>("get_settings");
    for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      const value = stored?.[key];
      if (value !== undefined && VALID[key](value)) (settings as any)[key] = value;
    }
  } catch (e) {
    console.warn("settings unavailable", e);
  }
}

/** Writes go out one at a time so a later value can never be overtaken by an earlier one. */
let saving: Promise<unknown> = Promise.resolve();

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings[key] = value;
  saving = saving
    .then(() => invoke("set_setting", { key, value }))
    .catch((e) => console.warn(`couldn't save setting ${key}`, e));
}

/**
 * R3-M2: resolves once every queued setting write has gone out (or after `timeoutMs`, so a hung
 * backend can't keep the app from quitting). Await before quitting or closing the window.
 */
export function flushSettings(timeoutMs = 1000): Promise<void> {
  let timer = 0;
  const timeout = new Promise<void>((resolve) => (timer = window.setTimeout(resolve, timeoutMs)));
  return Promise.race([saving.then(() => undefined), timeout]).finally(() => clearTimeout(timer));
}
