import { initialSidebar, readStored, saveSidebar, writeStored } from "./sidebarState";

const KEY = "dcdash.sidebar";

/** jsdom has no matchMedia; a test that wants one installs it here and the afterEach below removes it. */
function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", { value: () => ({ matches }), configurable: true, writable: true });
}

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("initialSidebar", () => {
  it("starts expanded when nothing is stored", () => {
    expect(initialSidebar()).toBe("expanded");
  });

  it("returns a stored minimized", () => {
    localStorage.setItem(KEY, "minimized");
    expect(initialSidebar()).toBe("minimized");
  });

  it("ignores any other stored text", () => {
    localStorage.setItem(KEY, "collapsed");
    expect(initialSidebar()).toBe("expanded");
    localStorage.setItem(KEY, "");
    expect(initialSidebar()).toBe("expanded");
  });

  it("starts minimized in a narrow window, whatever was stored", () => {
    stubMatchMedia(true);
    localStorage.setItem(KEY, "expanded");
    expect(initialSidebar()).toBe("minimized");
  });

  it("in a wide window the stored choice decides", () => {
    stubMatchMedia(false);
    expect(initialSidebar()).toBe("expanded");
    localStorage.setItem(KEY, "minimized");
    expect(initialSidebar()).toBe("minimized");
  });

  it("does not throw without matchMedia (jsdom has none)", () => {
    expect(typeof window.matchMedia).toBe("undefined");
    expect(() => initialSidebar()).not.toThrow();
  });

  it("falls back to expanded when reading storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(initialSidebar()).toBe("expanded");
    expect(readStored("anything")).toBeNull();
  });
});

describe("saveSidebar and the storage helpers", () => {
  it("remembers the state under dcdash.sidebar", () => {
    saveSidebar("minimized");
    expect(localStorage.getItem(KEY)).toBe("minimized");
    expect(initialSidebar()).toBe("minimized");
    saveSidebar("expanded");
    expect(initialSidebar()).toBe("expanded");
  });

  it("does not throw when writing storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => saveSidebar("minimized")).not.toThrow();
    expect(() => writeStored("dcdash.assetTree", "minimized")).not.toThrow();
  });

  it("reads back what writeStored wrote, and null for an unknown key", () => {
    writeStored("dcdash.assetTree", "minimized");
    expect(readStored("dcdash.assetTree")).toBe("minimized");
    expect(readStored("dcdash.nothing")).toBeNull();
  });
});
