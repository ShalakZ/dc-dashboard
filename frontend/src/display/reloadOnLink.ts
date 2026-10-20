/**
 * Loads the page again, with its address as it is (the fragment stays), so that main.tsx's one load path takes the secret out of the address
 * and claims. A function of its own so that tests can stand in for it (jsdom has no navigation).
 */
export function reloadPage(): void {
  try {
    window.location.reload();
  } catch {
    // The page keeps working as it is; the link can be opened again.
  }
}

/**
 * Opening a display link in a tab that already shows /display changes only the fragment: the browser loads nothing, so nothing would claim
 * and the 256-bit secret would stay in the address bar and the history. A change to a non-empty fragment loads the page again instead (the
 * reload keeps the fragment; takeFragment clears the address and the claim follows). A change to an empty fragment (the bare address) is
 * ignored. Returns a function that stops listening.
 */
export function reloadOnLink(reload: () => void = reloadPage): () => void {
  const onChange = () => {
    if (window.location.hash !== "") reload();
  };
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
