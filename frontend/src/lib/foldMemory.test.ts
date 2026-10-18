import { MAX_REMEMBERED, readFoldMemory, writeFoldMemory } from "./foldMemory";

const KEY = "dcdash.testFold";
const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

describe("readFoldMemory", () => {
  it("is null when nothing is stored", () => {
    expect(readFoldMemory(KEY)).toBeNull();
  });

  it("reads a stored array of ids", () => {
    localStorage.setItem(KEY, "[3,1,2]");
    expect(readFoldMemory(KEY)).toEqual(new Set([1, 2, 3]));
  });

  it("reads the text none as remembered, nothing folded: an empty set, not null", () => {
    localStorage.setItem(KEY, "none");
    const read = readFoldMemory(KEY);
    expect(read).not.toBeNull();
    expect(read!.size).toBe(0);
  });

  it("reads the legacy [] as nothing remembered", () => {
    localStorage.setItem(KEY, "[]");
    expect(readFoldMemory(KEY)).toBeNull();
  });

  it.each([
    ["not json", "{nope"],
    ["an object", '{"1":true}'],
    ["a number", "7"],
    ["a string", '"1,2"'],
    ["a string that spells none", '"none"'],
    ["null", "null"],
    ["empty text", ""],
    ["an array with no whole number", JSON.stringify(["1", 1.5, null, true, [2], { id: 3 }])],
  ])("is null for %s", (_, text) => {
    localStorage.setItem(KEY, text);
    expect(readFoldMemory(KEY)).toBeNull();
  });

  it("keeps the whole numbers of a mixed array and drops the rest", () => {
    localStorage.setItem(KEY, JSON.stringify([4, "5", 1.5, null, true, [6], 7, { id: 8 }]));
    expect(readFoldMemory(KEY)).toEqual(new Set([4, 7]));
  });

  it("keeps zero and negative whole numbers", () => {
    localStorage.setItem(KEY, JSON.stringify([0, -2, 3]));
    expect(readFoldMemory(KEY)).toEqual(new Set([0, -2, 3]));
  });

  it("accepts exactly 5000 entries and ignores 5001", () => {
    expect(MAX_REMEMBERED).toBe(5000);
    localStorage.setItem(KEY, JSON.stringify(range(5000)));
    expect(readFoldMemory(KEY)?.size).toBe(5000);
    localStorage.setItem(KEY, JSON.stringify(range(5001)));
    expect(readFoldMemory(KEY)).toBeNull();
  });

  it("is null, and does not throw, when reading storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => readFoldMemory(KEY)).not.toThrow();
    expect(readFoldMemory(KEY)).toBeNull();
  });
});

describe("writeFoldMemory", () => {
  it("writes a sorted JSON array, each id once", () => {
    writeFoldMemory(KEY, new Set([9, 2, 5]));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([2, 5, 9]);
    writeFoldMemory(KEY, [3, 3, 1].values());
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([1, 3]);
  });

  it("writes the text none for an empty set, never []", () => {
    writeFoldMemory(KEY, []);
    expect(localStorage.getItem(KEY)).toBe("none");
    writeFoldMemory(KEY, new Set());
    expect(localStorage.getItem(KEY)).toBe("none");
  });

  it("writes at most 5000 ids", () => {
    writeFoldMemory(KEY, range(5001));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(5000);
    writeFoldMemory(KEY, range(5000));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(5000);
  });

  it("round-trips a non-empty set and an empty one", () => {
    writeFoldMemory(KEY, new Set([7, 3]));
    expect(readFoldMemory(KEY)).toEqual(new Set([3, 7]));
    writeFoldMemory(KEY, new Set());
    expect(readFoldMemory(KEY)).toEqual(new Set());
    expect(readFoldMemory(KEY)).not.toBeNull();
  });

  it("does not throw when writing storage throws (full or blocked)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => writeFoldMemory(KEY, [1, 2])).not.toThrow();
    expect(() => writeFoldMemory(KEY, [])).not.toThrow();
  });
});
