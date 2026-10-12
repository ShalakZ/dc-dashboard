import { readFileSync } from "node:fs";
import { MIRROR_KEY } from "./lib/appearance";
import { NARROW_QUERY, SIDEBAR_KEY } from "./lib/sidebarState";

// The first-paint script is an external file (the CSP is script-src 'self'), so the test runs its source text against stubs.
const source = readFileSync("public/theme-init.js", "utf8"); // vitest runs from the frontend directory
const html = readFileSync("index.html", "utf8");

type Setup = {
  stored?: string | null; // what localStorage answers for the mirror key
  sidebar?: string | null; // what localStorage answers for the sidebar key
  path?: string; // window.location.pathname; undefined = the page has no location
  locationThrows?: boolean;
  storageThrows?: boolean; // reading window.localStorage throws, as it does when storage is blocked
  getItemThrows?: boolean;
  matches?: boolean; // the answer of matchMedia for the dark query; undefined = the browser has none
  narrow?: boolean; // the answer of matchMedia for the narrow-window query
  matchMediaThrows?: boolean;
  setAttributeThrows?: boolean;
};

function run({ stored = null, sidebar = null, path, locationThrows, storageThrows, getItemThrows, matches, narrow, matchMediaThrows, setAttributeThrows }: Setup = {}) {
  const attributes: Record<string, string> = {};
  const queries: string[] = [];
  const keys: string[] = [];
  const doc = {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        if (setAttributeThrows) throw new Error("no <html>");
        attributes[name] = value;
      },
    },
  };
  const win: Record<string, unknown> = {};
  Object.defineProperty(win, "localStorage", {
    get() {
      if (storageThrows) throw new Error("SecurityError");
      return {
        getItem(key: string) {
          keys.push(key);
          if (getItemThrows) throw new Error("blocked");
          return key === SIDEBAR_KEY ? sidebar : stored;
        },
      };
    },
  });
  if (matches !== undefined || narrow !== undefined || matchMediaThrows) {
    win.matchMedia = (query: string) => {
      queries.push(query);
      if (matchMediaThrows) throw new Error("nope");
      return { matches: query === NARROW_QUERY ? narrow : matches };
    };
  }
  if (locationThrows) {
    Object.defineProperty(win, "location", { get() { throw new Error("no location"); } });
  } else if (path !== undefined) {
    win.location = { pathname: path };
  }
  new Function("window", "document", source)(win, doc);
  return { attributes, queries, keys };
}

const pair = (mode: string, theme: string) => JSON.stringify({ mode, theme });

describe("theme-init.js", () => {
  it("reads the mirror key the app writes", () => {
    expect(run().keys).toEqual([MIRROR_KEY]);
  });

  it("paints the defaults when nothing is stored", () => {
    expect(run().attributes).toEqual({ "data-mode": "light", "data-theme": "navy-gold" });
  });

  it("paints a valid choice", () => {
    expect(run({ stored: pair("dark", "graphite") }).attributes).toEqual({ "data-mode": "dark", "data-theme": "graphite" });
  });

  it("repairs each key on its own", () => {
    expect(run({ stored: pair("dark", "mauve") }).attributes).toEqual({ "data-mode": "dark", "data-theme": "navy-gold" });
    expect(run({ stored: pair("neon", "desert-gold") }).attributes).toEqual({ "data-mode": "light", "data-theme": "desert-gold" });
    expect(run({ stored: JSON.stringify({ mode: 1, theme: ["graphite"] }) }).attributes).toEqual({ "data-mode": "light", "data-theme": "navy-gold" });
  });

  it("does not take a value from the other key's list", () => {
    expect(run({ stored: pair("graphite", "dark") }).attributes).toEqual({ "data-mode": "light", "data-theme": "navy-gold" });
  });

  it.each([["not JSON", "{oops"], ["a JSON number", "5"], ["a JSON string", '"dark"'], ["JSON null", "null"], ["a JSON array", '["dark"]'], ["an empty string", ""]])(
    "paints the defaults for %s",
    (_name, stored) => {
      expect(run({ stored }).attributes).toEqual({ "data-mode": "light", "data-theme": "navy-gold" });
    },
  );

  it("paints the defaults when localStorage is blocked, whether the access or the read throws", () => {
    expect(run({ storageThrows: true }).attributes).toEqual({ "data-mode": "light", "data-theme": "navy-gold" });
    expect(run({ getItemThrows: true }).attributes).toEqual({ "data-mode": "light", "data-theme": "navy-gold" });
  });

  it("resolves system through the device preference, and writes only light or dark", () => {
    const dark = run({ stored: pair("system", "maroon-gold"), matches: true });
    expect(dark.attributes).toEqual({ "data-mode": "dark", "data-theme": "maroon-gold" });
    expect(dark.queries).toEqual(["(prefers-color-scheme: dark)"]);
    expect(run({ stored: pair("system", "maroon-gold"), matches: false }).attributes).toEqual({ "data-mode": "light", "data-theme": "maroon-gold" });
  });

  it("does not ask the device for light or dark", () => {
    expect(run({ stored: pair("dark", "graphite"), matches: false }).queries).toEqual([]);
  });

  it("is light for system where there is no matchMedia, or where it throws", () => {
    expect(run({ stored: pair("system", "graphite") }).attributes).toEqual({ "data-mode": "light", "data-theme": "graphite" });
    expect(run({ stored: pair("system", "graphite"), matchMediaThrows: true }).attributes).toEqual({ "data-mode": "light", "data-theme": "graphite" });
  });

  it("never throws, not even when <html> refuses the attributes", () => {
    expect(() => run({ stored: pair("dark", "graphite"), setAttributeThrows: true })).not.toThrow();
    expect(() => run({ storageThrows: true, matchMediaThrows: true, setAttributeThrows: true })).not.toThrow();
  });

  it("is ES5: it must run in any browser the SCADA workstation has", () => {
    expect(source).not.toMatch(/\b(const|let|class)\s/);
    expect(source).not.toContain("=>");
    expect(source).not.toContain("`");
    expect(source).not.toMatch(/\b(import|export|async|await)\b/);
  });
});

// The static shell in index.html (W7h) is shown only under <html data-shell>; the script decides from the path and mirrors
// initialSidebar() (src/lib/sidebarState.ts). It reads window.location only, and tests the path before any storage or matchMedia call.
describe("theme-init.js: data-shell", () => {
  const withShell = (shell: string) => ({ "data-mode": "light", "data-theme": "navy-gold", "data-shell": shell });
  const defaults = { "data-mode": "light", "data-theme": "navy-gold" };

  it("is expanded on the app's pages", () => {
    for (const path of ["/", "/assets", "/assets/3", "/users", "/loginx", "/settings/setup"]) {
      expect(run({ path }).attributes, path).toEqual(withShell("expanded"));
    }
  });

  it("is not set on the sign-in and setup pages, whatever the case or the trailing path (the router matches case-insensitively)", () => {
    for (const path of ["/login", "/login/", "/Login", "/LOGIN/", "/setup", "/setup/x", "/Setup"]) {
      expect(run({ path, sidebar: "minimized", narrow: true }).attributes, path).toEqual(defaults);
    }
  });

  it("tests the path before it reads storage or asks matchMedia, so those pages cost nothing", () => {
    const login = run({ path: "/login", matches: false, narrow: true });
    expect(login.keys).toEqual([MIRROR_KEY]);
    expect(login.queries).toEqual([]);
  });

  it("is minimized when the remembered state is, expanded for any other stored value", () => {
    expect(run({ path: "/", sidebar: "minimized" }).attributes).toEqual(withShell("minimized"));
    expect(run({ path: "/", sidebar: "expanded" }).attributes).toEqual(withShell("expanded"));
    expect(run({ path: "/", sidebar: "Minimized" }).attributes).toEqual(withShell("expanded"));
    expect(run({ path: "/", sidebar: null }).attributes).toEqual(withShell("expanded"));
  });

  it("is minimized in a narrow window whatever is stored, and expanded in a wide one that has no memory", () => {
    const narrow = run({ path: "/", narrow: true, sidebar: "expanded" });
    expect(narrow.attributes).toEqual(withShell("minimized"));
    expect(narrow.queries).toEqual([NARROW_QUERY]);
    expect(run({ path: "/", narrow: false }).attributes).toEqual(withShell("expanded"));
    expect(run({ path: "/", narrow: false, sidebar: "minimized" }).attributes).toEqual(withShell("minimized"));
  });

  it("leaves the appearance alone, and the appearance leaves it alone", () => {
    expect(run({ path: "/", stored: pair("dark", "maroon-gold"), sidebar: "minimized" }).attributes).toEqual({
      "data-mode": "dark",
      "data-theme": "maroon-gold",
      "data-shell": "minimized",
    });
    expect(run({ path: "/", stored: "{oops", sidebar: "minimized" }).attributes).toEqual(withShell("minimized"));
  });

  it("reads the same key and asks the same question as the app (sidebarState.ts)", () => {
    expect(/var SIDEBAR_KEY = "([^"]+)"/.exec(source)?.[1]).toBe(SIDEBAR_KEY);
    expect(/var NARROW_QUERY = "([^"]+)"/.exec(source)?.[1]).toBe(NARROW_QUERY);
    expect(run({ path: "/", sidebar: "minimized" }).keys).toEqual([MIRROR_KEY, SIDEBAR_KEY]);
  });

  it("falls back to the remembered state where matchMedia is missing or throws", () => {
    expect(run({ path: "/", sidebar: "minimized" }).attributes).toEqual(withShell("minimized")); // no matchMedia at all
    expect(run({ path: "/", sidebar: "minimized", matchMediaThrows: true }).attributes).toEqual(withShell("minimized"));
    expect(run({ path: "/", matchMediaThrows: true }).attributes).toEqual(withShell("expanded"));
  });

  it("is expanded where storage is blocked, and the appearance defaults stay right", () => {
    expect(run({ path: "/", storageThrows: true }).attributes).toEqual(withShell("expanded"));
    expect(run({ path: "/", getItemThrows: true }).attributes).toEqual(withShell("expanded"));
    expect(run({ path: "/", getItemThrows: true, narrow: true }).attributes).toEqual(withShell("minimized"));
  });

  it("sets nothing, and throws nothing, where the page has no location", () => {
    expect(run({ sidebar: "minimized" }).attributes).toEqual(defaults);
    expect(run({ locationThrows: true, stored: pair("dark", "graphite") }).attributes).toEqual({ "data-mode": "dark", "data-theme": "graphite" });
  });

  it("never throws, not even when <html> refuses the attributes", () => {
    expect(() => run({ path: "/", sidebar: "minimized", setAttributeThrows: true })).not.toThrow();
    expect(() => run({ path: "/", storageThrows: true, matchMediaThrows: true, setAttributeThrows: true })).not.toThrow();
  });
});

describe("index.html", () => {
  it("starts with the defaults on <html>, so a failed script still gives the default look", () => {
    expect(html).toMatch(/<html lang="en" data-mode="light" data-theme="navy-gold">/);
  });

  it("loads the script synchronously in <head>, before the module script", () => {
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    const tags = head.match(/<script\b[^>]*>/g) ?? [];
    expect(tags).toEqual(['<script src="/theme-init.js">']); // the only script in <head>, a plain one: not defer, not async, not a module
    expect(html.indexOf("/theme-init.js")).toBeLessThan(html.indexOf("/src/main.tsx"));
  });
});
