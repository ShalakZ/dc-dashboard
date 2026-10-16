import {
  ASSETS_CLOSED_KEY, readAssetsClosed, readSnap, readUnmappedOnly, SNAP_GRID, SNAP_KEY, UNMAPPED_ONLY_KEY, writeAssetsClosed, writeSnap, writeUnmappedOnly,
} from "./graphPrefs";

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

describe("the Unmapped only preference", () => {
  it("is stored under the key the plan names", () => {
    expect(UNMAPPED_ONLY_KEY).toBe("dcdash.discovery.unmapped-only");
  });

  it("is off when nothing is stored", () => {
    expect(readUnmappedOnly()).toBe(false);
  });

  it.each([
    ["on", true],
    ["off", false],
    ["", false],
    ["ON", false],
    ["true", false],
    ["1", false],
  ])("reads %j as %s (only the exact word on turns it on)", (stored, expected) => {
    localStorage.setItem(UNMAPPED_ONLY_KEY, stored);
    expect(readUnmappedOnly()).toBe(expected);
  });

  it("writes on and off as words and reads them back", () => {
    writeUnmappedOnly(true);
    expect(localStorage.getItem(UNMAPPED_ONLY_KEY)).toBe("on");
    expect(readUnmappedOnly()).toBe(true);
    writeUnmappedOnly(false);
    expect(localStorage.getItem(UNMAPPED_ONLY_KEY)).toBe("off");
    expect(readUnmappedOnly()).toBe(false);
  });

  it("falls back to off, and never throws, when the storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(readUnmappedOnly()).toBe(false);
    expect(() => writeUnmappedOnly(true)).not.toThrow();
  });
});

describe("the folded assets preference", () => {
  it("is stored under the key the plan names, as a JSON array", () => {
    expect(ASSETS_CLOSED_KEY).toBe("dcdash.discovery.assets-closed");
    writeAssetsClosed([3, 1, 2]);
    expect(localStorage.getItem(ASSETS_CLOSED_KEY)).toBe("[1,2,3]");
  });

  it("is empty when nothing is stored", () => {
    expect(readAssetsClosed()).toEqual(new Set());
  });

  it("round-trips a set, a list and a generator alike", () => {
    writeAssetsClosed(new Set([5, 9]));
    expect(readAssetsClosed()).toEqual(new Set([5, 9]));
    writeAssetsClosed([7]);
    expect(readAssetsClosed()).toEqual(new Set([7]));
    writeAssetsClosed((function* () { yield 2; yield 4; })());
    expect(readAssetsClosed()).toEqual(new Set([2, 4]));
  });

  it("writing an empty set stores an empty list (the fold is forgotten)", () => {
    writeAssetsClosed([1]);
    writeAssetsClosed([]);
    expect(localStorage.getItem(ASSETS_CLOSED_KEY)).toBe("[]");
    expect(readAssetsClosed()).toEqual(new Set());
  });

  it("stores only the ids the model still holds when it is given them", () => {
    writeAssetsClosed([1, 2, 3, 99], new Set([1, 3]));
    expect(localStorage.getItem(ASSETS_CLOSED_KEY)).toBe("[1,3]");
    writeAssetsClosed([4], new Set());
    expect(localStorage.getItem(ASSETS_CLOSED_KEY)).toBe("[]");
  });

  it("stores each id once", () => {
    writeAssetsClosed([2, 2, 1, 2]);
    expect(localStorage.getItem(ASSETS_CLOSED_KEY)).toBe("[1,2]");
  });

  it.each([
    ["not JSON", "not json"],
    ["a JSON object", "{\"a\":1}"],
    ["a JSON number", "7"],
    ["a JSON string", "\"1,2\""],
    ["null", "null"],
    ["an empty string", ""],
  ])("reads %s as no folded assets", (_name, stored) => {
    localStorage.setItem(ASSETS_CLOSED_KEY, stored);
    expect(readAssetsClosed()).toEqual(new Set());
  });

  it("keeps the integers of a list and drops the rest", () => {
    localStorage.setItem(ASSETS_CLOSED_KEY, JSON.stringify([1, "2", 3.5, null, 4, true]));
    expect(readAssetsClosed()).toEqual(new Set([1, 4]));
  });

  it("falls back to empty, and never throws, when the storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(readAssetsClosed()).toEqual(new Set());
    expect(() => writeAssetsClosed([1])).not.toThrow();
  });
});
