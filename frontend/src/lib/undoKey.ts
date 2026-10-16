/** The parts of a keyboard event the Undo shortcut reads (a DOM event and React's synthetic one both fit). */
type UndoKeyEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

/**
 * Ctrl+Z and Cmd+Z, but not Redo (Shift) or Alt. The key that TYPES a z undoes on any layout. Only when the typed key is one character of
 * another script (Cyrillic, Arabic: no Latin z to type at all) does the physical Z position decide. A layout that types some other ASCII
 * character there must not: QWERTZ types y, AZERTY w, Dvorak a semicolon (and a dead key reads "Dead"). The Assets Tree and the mapping Undo
 * (hooks/useMappingActions.tsx) share this, so the two always agree.
 */
export function isUndoKey(e: UndoKeyEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return false;
  const key = e.key ?? "";
  if (key.toLowerCase() === "z") return true;
  return e.code === "KeyZ" && key.length === 1 && key.charCodeAt(0) > 0x7f;
}
