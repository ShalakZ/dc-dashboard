/**
 * Loads `/display` again as a fresh document, with no fragment. `history.replaceState` clears the address bar, but the browser keeps the
 * page's first address in `performance.getEntriesByType("navigation")[0].name` for the whole life of the document, and any script of the
 * page can read it; a new document starts with an entry that has no secret in it. The cookie is already set, and a load without a
 * fragment makes no claim, so this cannot loop. It is a function of its own so that tests can stand in for it (jsdom has no navigation).
 */
export function reloadClean(): void {
  try {
    window.location.replace("/display");
  } catch {
    // The page keeps working as it is; the next load of /display will not have the fragment anyway.
  }
}
