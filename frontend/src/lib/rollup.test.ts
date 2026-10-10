import { rollupNote, rollupPower, type RollupSource } from "./rollup";
import type { LiveValue } from "./stream";

// 06:00:00 UTC, written the way the API writes a reading time (site offset, microseconds).
const ROW_TS = "2026-10-08T09:00:00.000000+03:00";
const source = (id: number, over: Partial<RollupSource> = {}): RollupSource => ({
  asset_id: id, name: `Rack ${id}`, path: `Site / Room / Rack ${id}`, point_id: 100 + id, value: 1, ts: ROW_TS, stale: false, ...over,
});
const entry = (value: number | null, quality = 0, ts = "2026-10-08T06:00:05.000Z"): LiveValue => ({ ts, value, quality });
const none = new Map<number, LiveValue>();

describe("rollupPower", () => {
  it("is the plain sum of the sources when all of them have a fresh good reading", () => {
    const r = rollupPower([source(1, { value: 3 }), source(2, { value: 4.5 })], none);
    expect(r).toEqual({ kw: 7.5, counted: 2, of: 2, missing: [] });
  });

  it("leaves a stale source out of the sum and lists it as missing", () => {
    const stale = source(2, { value: 4, stale: true });
    const r = rollupPower([source(1, { value: 3 }), stale], none);
    expect(r).toEqual({ kw: 3, counted: 1, of: 2, missing: [stale] });
  });

  it("treats a source without a value (never read, or bad quality) as missing", () => {
    const silent = source(2, { value: null, ts: null });
    const bad = source(3, { value: null });
    const r = rollupPower([source(1, { value: 3 }), silent, bad], none);
    expect(r.kw).toBe(3);
    expect(r.counted).toBe(1);
    expect(r.missing).toEqual([silent, bad]);
  });

  it("gives no figure, not 0, when no source counts", () => {
    const r = rollupPower([source(1, { stale: true }), source(2, { value: null })], none);
    expect(r.kw).toBeNull();
    expect(r.counted).toBe(0);
    expect(r.of).toBe(2);
  });

  it("gives no figure for an empty list", () => {
    expect(rollupPower([], none)).toEqual({ kw: null, counted: 0, of: 0, missing: [] });
  });

  it("sums negative values with their sign, and a sum of exactly 0 is a figure", () => {
    expect(rollupPower([source(1, { value: 5 }), source(2, { value: -2 })], none).kw).toBe(3);
    expect(rollupPower([source(1, { value: 2 }), source(2, { value: -2 })], none).kw).toBe(0);
  });

  it("takes a streamed value that is newer than the fetched row, and it revives a stale row", () => {
    const sources = [source(1, { value: 3 }), source(2, { value: 4, stale: true })];
    const live = new Map([[101, entry(10)], [102, entry(6)]]);
    const r = rollupPower(sources, live);
    expect(r).toEqual({ kw: 16, counted: 2, of: 2, missing: [] });
  });

  it("keeps the fetched row when the stream entry is older than it", () => {
    const r = rollupPower([source(1, { value: 3 })], new Map([[101, entry(10, 0, "2026-10-08T05:59:00.000Z")]]));
    expect(r.kw).toBe(3);
  });

  it("counts a streamed value for a source that had no reading at all", () => {
    const r = rollupPower([source(1, { value: null, ts: null })], new Map([[101, entry(2.5)]]));
    expect(r).toEqual({ kw: 2.5, counted: 1, of: 1, missing: [] });
  });

  it("treats a bad-quality stream entry as missing, even when the fetched row had a figure", () => {
    const bad = source(2, { value: 4 });
    const r = rollupPower([source(1, { value: 3 }), bad], new Map([[102, entry(null, 1)]]));
    expect(r).toEqual({ kw: 3, counted: 1, of: 2, missing: [bad] });
  });

  it("ignores stream entries of other points", () => {
    expect(rollupPower([source(1, { value: 3 })], new Map([[999, entry(50)]])).kw).toBe(3);
  });
});

describe("rollupNote", () => {
  const TIP = "This asset has no power meter of its own: the figure is the sum of its sub-assets' meters.";
  const note = (sources: RollupSource[]) => rollupNote(rollupPower(sources, none), sources);

  it("says how many meters make up the sum, in the singular for one", () => {
    expect(note([source(1), source(2), source(3)]).text).toBe("Sum of the live power of 3 meters below");
    expect(note([source(1)]).text).toBe("Sum of the live power of 1 meter below");
  });

  it("says how many report when some do not", () => {
    expect(note([source(1), source(2, { stale: true }), source(3, { value: null })]).text).toBe("Sum of 1 of 3 meters below; the others are not reporting");
  });

  it("says 'the other is' when exactly one meter is missing", () => {
    expect(note([source(1), source(2, { stale: true }), source(3)]).text).toBe("Sum of 2 of 3 meters below; the other is not reporting");
    expect(note([source(1), source(2, { stale: true })]).text).toBe("Sum of 1 of 2 meters below; the other is not reporting");
  });

  it("lists the silent meters by path in a visible line when some, but not all, report", () => {
    expect(note([source(1), source(2, { stale: true }), source(3, { value: null })]).silent).toBe("Site / Room / Rack 2, Site / Room / Rack 3");
  });

  it("has no visible list when every meter reports or none does", () => {
    expect(note([source(1), source(2)]).silent).toBeNull();
    expect(note([source(1, { stale: true }), source(2, { stale: true })]).silent).toBeNull();
  });

  it("tells two sub-assets with one name apart by their paths", () => {
    const a = source(1, { name: "Meter", path: "Site / Hall A / Meter" });
    const b = source(2, { name: "Meter", path: "Site / Hall B / Meter", stale: true });
    const { title, silent } = note([a, b]);
    expect(silent).toBe("Site / Hall B / Meter");
    expect(title).toContain("Not reporting: Site / Hall B / Meter.");
    expect(title).not.toContain("Hall A");
    expect(note([source(3, { name: "Meter", path: "Site / Hall A / Meter" }), source(4, { name: "Meter", path: "Site / Hall B / Meter" })]).title)
      .toContain("Meters: Site / Hall A / Meter, Site / Hall B / Meter.");
  });

  it("says that none reports, with the singular form for one meter", () => {
    expect(note([source(1, { stale: true }), source(2, { value: null })]).text).toBe("None of the 2 meters below is reporting");
    expect(note([source(1, { stale: true })]).text).toBe("The meter below is not reporting");
  });

  it("starts the tooltip with why the figure is a sum, then names the meters that do not report", () => {
    const { title } = note([source(1), source(2, { stale: true }), source(3, { value: null })]);
    expect(title.startsWith(TIP)).toBe(true);
    expect(title).toContain("Site / Room / Rack 2");
    expect(title).toContain("Site / Room / Rack 3");
    expect(title).not.toContain("Rack 1");
  });

  it("names every meter in the tooltip when all of them report", () => {
    const { title } = note([source(1), source(2)]);
    expect(title.startsWith(TIP)).toBe(true);
    expect(title).toContain("Site / Room / Rack 1");
    expect(title).toContain("Site / Room / Rack 2");
  });
});
