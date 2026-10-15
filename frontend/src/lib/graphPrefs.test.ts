import { readSnap, SNAP_GRID, SNAP_KEY, writeSnap } from "./graphPrefs";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("the snap preference", () => {
  it("is stored under the key the plan names, and the grid is 8 px", () => {
    expect(SNAP_KEY).toBe("dcdash.discovery.snap");
    expect(SNAP_GRID).toBe(8);
  });

  it("is on when nothing is stored", () => {
    expect(readSnap()).toBe(true);
  });

  it.each([
    ["off", false],
    ["on", true],
    ["", true],
    ["OFF", true],
    ["false", true],
    ["0", true],
  ])("reads %j as %s (only the exact word off turns it off)", (stored, expected) => {
    localStorage.setItem(SNAP_KEY, stored);
    expect(readSnap()).toBe(expected);
  });

  it("writes on and off as words and reads them back", () => {
    writeSnap(false);
    expect(localStorage.getItem(SNAP_KEY)).toBe("off");
    expect(readSnap()).toBe(false);
    writeSnap(true);
    expect(localStorage.getItem(SNAP_KEY)).toBe("on");
    expect(readSnap()).toBe(true);
  });

  it("falls back to on, and never throws, when the storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(readSnap()).toBe(true);
    expect(() => writeSnap(false)).not.toThrow();
  });
});
