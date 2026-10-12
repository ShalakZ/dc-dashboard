import {
  applyAppearance,
  DEFAULT_APPEARANCE,
  MIRROR_KEY,
  MODES,
  normalizeAppearance,
  readMirror,
  resolveMode,
  THEMES,
  writeMirror,
} from "./appearance";

/** jsdom has no matchMedia; a test that wants one installs it here and the afterEach below removes it. */
function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", { value: () => ({ matches }), configurable: true, writable: true });
}

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
  document.documentElement.removeAttribute("data-mode");
  document.documentElement.removeAttribute("data-theme");
});

describe("the lists", () => {
  it("keeps the order of the profile panel", () => {
    expect([...MODES]).toEqual(["light", "dark", "system"]);
    expect(THEMES.map((t) => t.id)).toEqual(["navy-gold", "maroon-gold", "graphite", "desert-gold"]);
    expect(THEMES.map((t) => t.label)).toEqual(["Navy and gold", "Maroon and gold", "Graphite", "Desert gold"]);
  });

  it("defaults to the light mode and the navy and gold theme", () => {
    expect(DEFAULT_APPEARANCE).toEqual({ mode: "light", theme: "navy-gold" });
  });

  it("gives every theme a swatch of two hex colours", () => {
    for (const theme of THEMES) {
      expect(theme.swatch.bg, theme.id).toMatch(/^#[0-9a-f]{6}$/);
      expect(theme.swatch.dot, theme.id).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("normalizeAppearance", () => {
  it.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
    ["a string", "dark"],
    ["a number", 5],
    ["an array", [{ mode: "dark" }]],
    ["an empty object", {}],
    ["an unknown key only", { extra: true }],
  ])("%s becomes the defaults", (_name, raw) => {
    expect(normalizeAppearance(raw)).toEqual(DEFAULT_APPEARANCE);
  });

  it("keeps a valid pair", () => {
    expect(normalizeAppearance({ mode: "system", theme: "desert-gold" })).toEqual({ mode: "system", theme: "desert-gold" });
  });

  it("repairs each key on its own", () => {
    expect(normalizeAppearance({ mode: "dark" })).toEqual({ mode: "dark", theme: "navy-gold" });
    expect(normalizeAppearance({ mode: "neon", theme: "graphite" })).toEqual({ mode: "light", theme: "graphite" });
    expect(normalizeAppearance({ mode: "dark", theme: "mauve" })).toEqual({ mode: "dark", theme: "navy-gold" });
    expect(normalizeAppearance({ mode: 1, theme: null })).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({ mode: ["dark"] })).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({ theme: { a: 1 } })).toEqual(DEFAULT_APPEARANCE);
  });

  it("does not take a value from the other key's list", () => {
    expect(normalizeAppearance({ mode: "graphite", theme: "dark" })).toEqual(DEFAULT_APPEARANCE);
  });

  it("answers exactly the two keys", () => {
    expect(Object.keys(normalizeAppearance({ mode: "dark", theme: "graphite", extra: 1 })).sort()).toEqual(["mode", "theme"]);
  });
});

describe("resolveMode", () => {
  it("light and dark are themselves", () => {
    expect(resolveMode("light")).toBe("light");
    expect(resolveMode("dark")).toBe("dark");
  });

  it("system follows the device", () => {
    stubMatchMedia(true);
    expect(resolveMode("system")).toBe("dark");
    stubMatchMedia(false);
    expect(resolveMode("system")).toBe("light");
  });

  it("system is light where there is no matchMedia (jsdom has none)", () => {
    expect(typeof window.matchMedia).toBe("undefined");
    expect(resolveMode("system")).toBe("light");
  });
});

describe("the browser-side mirror", () => {
  it("lives under dcdash.appearance", () => {
    expect(MIRROR_KEY).toBe("dcdash.appearance");
  });

  it("is null when nothing is stored", () => {
    expect(readMirror()).toBeNull();
  });

  it("reads what writeMirror stored", () => {
    writeMirror({ mode: "system", theme: "maroon-gold" });
    expect(JSON.parse(localStorage.getItem(MIRROR_KEY)!)).toEqual({ mode: "system", theme: "maroon-gold" });
    expect(readMirror()).toEqual({ mode: "system", theme: "maroon-gold" });
  });

  it("repairs each key on its own, as the first-paint script does", () => {
    localStorage.setItem(MIRROR_KEY, JSON.stringify({ mode: "dark", theme: "mauve" }));
    expect(readMirror()).toEqual({ mode: "dark", theme: "navy-gold" });
  });

  it.each([["not JSON", "{oops"], ["a JSON number", "5"], ["a JSON string", '"dark"'], ["JSON null", "null"]])("is null for %s", (_name, text) => {
    localStorage.setItem(MIRROR_KEY, text);
    expect(readMirror()).toBeNull();
  });

  it("never throws when the storage does", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(readMirror()).toBeNull();
    expect(() => writeMirror(DEFAULT_APPEARANCE)).not.toThrow();
  });
});

describe("applyAppearance", () => {
  const root = document.documentElement;

  it("sets the mode and the theme on <html>", () => {
    applyAppearance({ mode: "dark", theme: "graphite" });
    expect(root.getAttribute("data-mode")).toBe("dark");
    expect(root.getAttribute("data-theme")).toBe("graphite");
  });

  it("writes only light or dark: system is resolved here, so the dark tokens exist once", () => {
    stubMatchMedia(true);
    applyAppearance({ mode: "system", theme: "navy-gold" });
    expect(root.getAttribute("data-mode")).toBe("dark");
    stubMatchMedia(false);
    applyAppearance({ mode: "system", theme: "navy-gold" });
    expect(root.getAttribute("data-mode")).toBe("light");
  });
});
