/* First paint of the appearance (W7d). An external file because the CSP is script-src 'self'; index.html loads it
   synchronously in <head>, before the module script, so the page never flashes the wrong look. It mirrors
   src/lib/appearance.ts (lists, key, defaults); backend/tests/test_preferences_parity.py fails when they drift.
   Plain ES5 and it never throws: whatever it cannot read, the default stays. */
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
})();
