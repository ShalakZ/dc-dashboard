import { applyUpdates, parseStreamMessage, type LiveValue } from "./stream";

// One dcdash_latest message as collector/writer.py publishes it: [point_id, epoch seconds, scaled value | null, quality]
const message = JSON.stringify([
  [7, 1791393134.08, 12.5, 0],
  [8, 1791393134.08, null, 1],
]);

describe("parseStreamMessage", () => {
  it("parses rows into point_id / LiveValue pairs, converting epoch seconds to ISO", () => {
    expect(parseStreamMessage(message)).toEqual([
      [7, { ts: "2026-10-07T17:12:14.080Z", value: 12.5, quality: 0 }],
      [8, { ts: "2026-10-07T17:12:14.080Z", value: null, quality: 1 }],
    ]);
  });

  it("still accepts ISO string timestamps", () => {
    expect(parseStreamMessage(JSON.stringify([[7, "2026-10-07T10:00:00+00:00", 1, 0]]))).toEqual([
      [7, { ts: "2026-10-07T10:00:00+00:00", value: 1, quality: 0 }],
    ]);
  });

  it("returns an empty list for malformed data", () => {
    expect(parseStreamMessage("not json")).toEqual([]);
    expect(parseStreamMessage('{"a":1}')).toEqual([]);
  });
});

describe("applyUpdates", () => {
  const v = (value: number | null): LiveValue => ({ ts: "t", value, quality: 0 });

  it("ignores points not in the map", () => {
    const current = new Map([[7, v(1)]]);
    const next = applyUpdates(current, [[99, v(5)]], new Set([7]));
    expect(next).toBe(current);
  });

  it("null value replaces previous value", () => {
    const next = applyUpdates(new Map([[7, v(1)]]), [[7, v(null)]], new Set([7]));
    expect(next.get(7)?.value).toBeNull();
  });

  it("returns a new map when a wanted point changes", () => {
    const current = new Map<number, LiveValue>();
    const next = applyUpdates(current, [[7, v(3)], [8, v(4)]], new Set([7, 8]));
    expect(next).not.toBe(current);
    expect([...next.keys()]).toEqual([7, 8]);
  });
});
