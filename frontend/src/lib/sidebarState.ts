export type SidebarState = "expanded" | "minimized";
const KEY = "dcdash.sidebar";
const NARROW = "(max-width: 1179.98px)";

export function readStored(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
export function writeStored(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* not remembered, never an error */ }
}
/** A narrow window starts minimized, otherwise the remembered state, otherwise expanded. No resize listener: the user can always expand. */
export function initialSidebar(): SidebarState {
  if (typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches) return "minimized";
  return readStored(KEY) === "minimized" ? "minimized" : "expanded";
}
export function saveSidebar(state: SidebarState): void { writeStored(KEY, state); }
