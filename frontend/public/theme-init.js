/* First paint of the appearance (W7d). An external file because the CSP is script-src 'self'; index.html loads it
   synchronously in <head>, before the module script, so the page never flashes the wrong look. It mirrors
   src/lib/appearance.ts (lists, key, defaults); backend/tests/test_preferences_parity.py fails when they drift.
   The second block (W7h) decides whether index.html's static copy of the app shell is shown. Plain ES5 and it never throws:
   whatever it cannot read, the default stays. */
(function () {
  var MODES = ["light", "dark", "system"];
  var THEMES = ["navy-gold", "maroon-gold", "graphite", "desert-gold"];
  var DEFAULT_MODE = "light";
  var DEFAULT_THEME = "navy-gold";
  var MIRROR_KEY = "dcdash.appearance";

  var mode = DEFAULT_MODE;
  var theme = DEFAULT_THEME;
  try {
    var saved = JSON.parse(window.localStorage.getItem(MIRROR_KEY));
    if (saved && typeof saved === "object") {
      if (typeof saved.mode === "string" && MODES.indexOf(saved.mode) >= 0) mode = saved.mode;
      if (typeof saved.theme === "string" && THEMES.indexOf(saved.theme) >= 0) theme = saved.theme;
    }
  } catch (e) {
    /* blocked storage or not JSON: the defaults */
  }

  var resolved = mode;
  if (mode === "system") {
    resolved = "light";
    try {
      if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches) resolved = "dark";
    } catch (e) {
      /* no device preference to read: light */
    }
  }

  try {
    var root = document.documentElement;
    root.setAttribute("data-mode", resolved);
    root.setAttribute("data-theme", theme);
  } catch (e) {
    /* index.html already carries the defaults */
  }

  /* The static shell in index.html is shown only under <html data-shell="expanded|minimized">, and only where the app will show the
     shell: not on the sign-in and setup pages (the router matches paths without regard to case, so the path is lower-cased first).
     The state mirrors initialSidebar() in src/lib/sidebarState.ts: a narrow window is minimized, else the remembered state, else
     expanded; theme-init.test.ts keeps the key and the query equal. Only window.location is read, and the path is tested before any
     storage or matchMedia call, so the pages that show no shell cost nothing. */
  var SIDEBAR_KEY = "dcdash.sidebar";
  var NARROW_QUERY = "(max-width: 1179.98px)";
  try {
    var path = String(window.location.pathname).toLowerCase();
    if (!/^\/(login|setup)(\/|$)/.test(path)) {
      var shell = "expanded";
      try {
        if (typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches) shell = "minimized";
      } catch (e) {
        /* no window width to read: the remembered state decides */
      }
      if (shell === "expanded") {
        try {
          if (window.localStorage.getItem(SIDEBAR_KEY) === "minimized") shell = "minimized";
        } catch (e) {
          /* blocked storage: expanded */
        }
      }
      document.documentElement.setAttribute("data-shell", shell);
    }
  } catch (e) {
    /* no location or no <html>: the static shell stays hidden */
  }
})();
