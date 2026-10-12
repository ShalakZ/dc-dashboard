// The appearance choice: a mode (light, dark, or follow the device) and a theme colour. The lists mirror
// backend/dcdash/core/preferences.py and public/theme-init.js; backend/tests/test_preferences_parity.py fails when they drift.

export const MODES = ["light", "dark", "system"] as const;
export type Mode = (typeof MODES)[number];

export type ThemeId = "navy-gold" | "maroon-gold" | "graphite" | "desert-gold";

/** `swatch` is the preset's panel colour and its marker colour (themes.css.test.ts checks them against themes.css). */
export const THEMES: { id: ThemeId; label: string; swatch: { bg: string; dot: string } }[] = [
  { id: "navy-gold", label: "Navy and gold", swatch: { bg: "#283354", dot: "#deb406" } },
  { id: "maroon-gold", label: "Maroon and gold", swatch: { bg: "#7d0849", dot: "#deb406" } },
  { id: "graphite", label: "Graphite", swatch: { bg: "#2b2f36", dot: "#8fb2ff" } },
  { id: "desert-gold", label: "Desert gold", swatch: { bg: "#deb406", dot: "#241c00" } },
];

export type Appearance = { mode: Mode; theme: ThemeId };

export const DEFAULT_APPEARANCE: Appearance = { mode: "light", theme: "navy-gold" };

/** The browser-side copy of the choice, read before the first paint by public/theme-init.js. */
export const MIRROR_KEY = "dcdash.appearance";

const isMode = (value: unknown): value is Mode => typeof value === "string" && (MODES as readonly string[]).includes(value);
const isTheme = (value: unknown): value is ThemeId => typeof value === "string" && THEMES.some((t) => t.id === value);

/** Each key on its own: anything missing, mistyped or not in its list becomes the default for that key. */
export function normalizeAppearance(raw: unknown): Appearance {
  const source = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    mode: isMode(source.mode) ? source.mode : DEFAULT_APPEARANCE.mode,
    theme: isTheme(source.theme) ? source.theme : DEFAULT_APPEARANCE.theme,
  };
}

/** What the page shows: "system" follows the device (the dark tokens exist once, in CSS, under data-mode="dark"). */
export function resolveMode(mode: Mode): "light" | "dark" {
  if (mode !== "system") return mode;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The mirror, or null when there is none to read (nothing stored, not JSON, storage blocked). */
export function readMirror(): Appearance | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MIRROR_KEY) ?? "null");
    return parsed !== null && typeof parsed === "object" ? normalizeAppearance(parsed) : null;
  } catch {
    return null;
  }
}

export function writeMirror(appearance: Appearance): void {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(appearance));
  } catch {
    // storage is full or blocked: the choice still applies, it just is not remembered by this browser
  }
}

/** Puts the look on <html>, where themes.css reads it. */
export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  root.setAttribute("data-mode", resolveMode(appearance.mode));
  root.setAttribute("data-theme", appearance.theme);
}
