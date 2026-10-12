import { readFileSync } from "node:fs";
import { MIRROR_KEY } from "./lib/appearance";

// The first-paint script is an external file (the CSP is script-src 'self'), so the test runs its source text against stubs.
const source = readFileSync("public/theme-init.js", "utf8"); // vitest runs from the frontend directory
const html = readFileSync("index.html", "utf8");

type Setup = {
  stored?: string | null; // what localStorage answers for the mirror key
  storageThrows?: boolean; // reading window.localStorage throws, as it does when storage is blocked
  getItemThrows?: boolean;
  matches?: boolean; // the answer of matchMedia; undefined = the browser has none
  matchMediaThrows?: boolean;
  setAttributeThrows?: boolean;
};

function run({ stored = null, storageThrows, getItemThrows, matches, matchMediaThrows, setAttributeThrows }: Setup = {}) {
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
          return stored;
        },
      };
    },
  });
  if (matches !== undefined || matchMediaThrows) {
    win.matchMedia = (query: string) => {
      queries.push(query);
      if (matchMediaThrows) throw new Error("nope");
      return { matches };
    };
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
