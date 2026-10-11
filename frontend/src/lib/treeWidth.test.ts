import { PANE_MIN, TREE_MIN, TREE_STEP, TREE_STEP_BIG, clampTreeWidth, clearTreeWidth, readTreeWidth, saveTreeWidth, treeMax } from "./treeWidth";

const KEY = "dcdash.assetTreeWidth";

describe("the constants", () => {
  it("are 220 px at least, 16 px per arrow key and 48 px with Shift, and the asset pane keeps 560 px", () => {
    expect(TREE_MIN).toBe(220);
    expect(TREE_STEP).toBe(16);
    expect(TREE_STEP_BIG).toBe(48);
    expect(PANE_MIN).toBe(560);
  });
});

describe("treeMax (the argument is the width right of the sidebar)", () => {
  it("is half of it, rounded down, while that leaves the pane its 560 px", () => {
    expect(treeMax(1440)).toBe(720);
    expect(treeMax(1201)).toBe(600);
    expect(treeMax(1204)).toBe(602);
    expect(treeMax(1920)).toBe(960);
  });

  it("is what leaves the pane 560 px when half would take more: 960 gives 400, 1001 gives 441, and both rules meet at 1120 (560)", () => {
    expect(treeMax(960)).toBe(400);
    expect(treeMax(1001)).toBe(441);
    expect(treeMax(1120)).toBe(560);
  });

  it("is never below the minimum, whatever the width", () => {
    expect(treeMax(700)).toBe(220);
    expect(treeMax(440)).toBe(220);
    expect(treeMax(300)).toBe(220);
    expect(treeMax(0)).toBe(220);
  });
});

describe("clampTreeWidth", () => {
  it("keeps a width inside the range, including both ends", () => {
    expect(clampTreeWidth(300, 1200)).toBe(300);
    expect(clampTreeWidth(220, 1200)).toBe(220);
    expect(clampTreeWidth(600, 1200)).toBe(600);
  });

  it("raises 10 to the minimum and lowers 99999 to half the width, or to what leaves the pane 560 px", () => {
    expect(clampTreeWidth(10, 1200)).toBe(220);
    expect(clampTreeWidth(-50, 1200)).toBe(220);
    expect(clampTreeWidth(99999, 1440)).toBe(720);
    expect(clampTreeWidth(9999, 960)).toBe(400);
    expect(clampTreeWidth(99999, 1000)).toBe(440);
  });

  it("rounds to a whole pixel", () => {
    expect(clampTreeWidth(300.4, 1000)).toBe(300);
    expect(clampTreeWidth(300.6, 1000)).toBe(301);
  });

  it("is null for NaN and for either infinity", () => {
    expect(clampTreeWidth(NaN, 1000)).toBeNull();
    expect(clampTreeWidth(Infinity, 1000)).toBeNull();
    expect(clampTreeWidth(-Infinity, 1000)).toBeNull();
  });

  it("an area narrower than twice the minimum leaves exactly the minimum", () => {
    expect(clampTreeWidth(400, 300)).toBe(220);
  });
});

describe("readTreeWidth", () => {
  it("is null when nothing is stored (the CSS default applies)", () => {
    expect(readTreeWidth()).toBeNull();
  });

  it("reads a stored width", () => {
    localStorage.setItem(KEY, "300");
    expect(readTreeWidth()).toBe(300);
  });

  it("returns the stored number as it is, large or small: the choice is clamped when shown, not when read", () => {
    localStorage.setItem(KEY, "720");
    expect(readTreeWidth()).toBe(720);
    localStorage.setItem(KEY, "10");
    expect(readTreeWidth()).toBe(10);
  });

  it.each(["wide", "", "   ", "300px", "-5", "1e3", "0x12c", "NaN", "Infinity", "30.5", "3 00", "99999999999999999999"])("is null for the stored text %j", (text) => {
    localStorage.setItem(KEY, text);
    expect(readTreeWidth()).toBeNull();
  });

  it("is null, and does not throw, when reading storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => readTreeWidth()).not.toThrow();
    expect(readTreeWidth()).toBeNull();
  });
});

describe("saveTreeWidth", () => {
  it("stores the width as whole pixels under dcdash.assetTreeWidth, and readTreeWidth gets it back", () => {
    saveTreeWidth(312.4);
    expect(localStorage.getItem(KEY)).toBe("312");
    expect(readTreeWidth()).toBe(312);
  });

  it("stores nothing for a width that is not a number", () => {
    saveTreeWidth(NaN);
    saveTreeWidth(Infinity);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("does not throw when writing storage throws (full or blocked)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => saveTreeWidth(300)).not.toThrow();
  });
});

describe("clearTreeWidth", () => {
  it("removes the stored width", () => {
    localStorage.setItem(KEY, "300");
    clearTreeWidth();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(readTreeWidth()).toBeNull();
  });

  it("does not throw when removing from storage throws", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => clearTreeWidth()).not.toThrow();
  });
});
