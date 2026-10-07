import { RANGES, rangeToQuery } from "./timeRange";

describe("rangeToQuery", () => {
  const now = new Date("2026-10-07T12:00:00Z");

  it.each([
    ["1h", "2026-10-07T11:00:00.000Z"],
    ["6h", "2026-10-07T06:00:00.000Z"],
    ["24h", "2026-10-06T12:00:00.000Z"],
    ["7d", "2026-09-30T12:00:00.000Z"],
  ] as const)("%s starts at %s", (range, start) => {
    const q = rangeToQuery(range, now);
    expect(q.start).toBe(start);
    expect(q.end).toBe("2026-10-07T12:00:00.000Z");
    expect(q.buckets).toBe(300);
  });

  it("lists the four ranges in order", () => {
    expect(RANGES).toEqual(["1h", "6h", "24h", "7d"]);
  });
});
