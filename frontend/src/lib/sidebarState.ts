export type SidebarState = "expanded" | "minimized";
/** public/theme-init.js mirrors both (it paints the static shell before this bundle runs); theme-init.test.ts keeps the copies equal. */
export const SIDEBAR_KEY = "dcdash.sidebar";
export const NARROW_QUERY = "(max-width: 1179.98px)";

export function readStored(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
export function writeStored(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* not remembered, never an error */ }
}
/** A narrow window starts minimized, otherwise the remembered state, otherwise expanded. No resize listener: the user can always expand. */
export function initialSidebar(): SidebarState {
  try {
    if (typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches) return "minimized";
  } catch { /* a matchMedia that fails is like none: the remembered choice decides, as in public/theme-init.js */ }
  return readStored(SIDEBAR_KEY) === "minimized" ? "minimized" : "expanded";
}
export function saveSidebar(state: SidebarState): void { writeStored(SIDEBAR_KEY, state); }
