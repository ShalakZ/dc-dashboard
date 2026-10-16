/** The parts of a keyboard event the Undo shortcut reads (a DOM event and React's synthetic one both fit). */
type UndoKeyEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

/**
 * Ctrl+Z and Cmd+Z, but not Redo (Shift) or Alt. On a layout whose key is not a Latin letter (Arabic, Cyrillic) the typed key is a letter of that
 * script, so the physical key decides. The Assets Tree and the mapping Undo (hooks/useMappingActions.tsx) share this, so the two always agree.
 */
export function isUndoKey(e: UndoKeyEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return false;
  const key = (e.key ?? "").toLowerCase();
  return key === "z" || (!/^[a-z]$/.test(key) && e.code === "KeyZ");
}
