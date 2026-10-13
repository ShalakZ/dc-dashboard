/**
 * The router's errorElement. Without one, an error in a page (typically a lazy chunk an update removed, for a tab opened before it)
 * lands on React Router's developer page. This says the same thing in plain words; the stack is in the console, not on the screen.
 * The shell went with the failed page, so the notice carries its own way into the app: a plain link (a full page load; the router is
 * what failed) to the Assets Tree, beside Reload.
 */
export function RouteError() {
  return (
    <main className="route-error">
      <div role="alert" className="banner banner-warn warning">
        <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 10v4.5M12 17.5h.01" /></svg>
        <span>This page could not be loaded. It may have been updated; reload to continue.</span>
        <a className="b-link" href="/assets">Assets Tree</a>
        <button type="button" className="b-act" onClick={() => window.location.reload()}>Reload</button>
      </div>
    </main>
  );
}
