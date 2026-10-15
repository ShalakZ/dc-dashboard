import { alignGuides, GUIDE_PAD, type Rect } from "./graphGuides";

const D: Rect = { x: 100, y: 100, w: 220, h: 80 }; // lines: x 100 / 210 / 320, y 100 / 140 / 180
const at = (x: number, y: number, w = 50, h = 30): Rect => ({ x, y, w, h });
const none = { vertical: [], horizontal: [] };

describe("alignGuides: one line per side of the dragged node", () => {
  it("has nothing to say without other nodes", () => {
    expect(alignGuides(D, [])).toEqual(none);
  });

  it("has nothing to say when no line is within the tolerance", () => {
    expect(alignGuides(D, [at(500, 500)])).toEqual(none);
  });

  // Each case: an other node that shares exactly one line with D, and the guide that must appear.
  it.each([
    ["left edge", at(100, 300, 40, 40), "vertical", 100],
    ["centre", at(160, 300, 100, 40), "vertical", 210],
    ["right edge", at(200, 300, 120, 40), "vertical", 320],
    ["top edge", at(500, 100, 50, 30), "horizontal", 100],
    ["middle", at(500, 130, 50, 20), "horizontal", 140],
    ["bottom edge", at(500, 150, 50, 30), "horizontal", 180],
  ] as const)("a shared %s makes one %s guide at %s", (_name, other, axis, line) => {
    const guides = alignGuides(D, [other]);
    const other_axis = axis === "vertical" ? "horizontal" : "vertical";
    expect(guides[other_axis]).toEqual([]);
    expect(guides[axis]).toHaveLength(1);
    expect(guides[axis][0].at).toBe(line);
  });

  it("spans both nodes plus the pad (vertical guide)", () => {
    const [g] = alignGuides(D, [at(100, 300, 40, 40)]).vertical;
    expect(GUIDE_PAD).toBe(24);
    expect(g).toEqual({ at: 100, from: 100 - 24, to: 340 + 24 });
  });

  it("spans both nodes plus the pad (horizontal guide), the other node on the left", () => {
    const [g] = alignGuides(D, [at(-400, 100, 50, 30)]).horizontal;
    expect(g).toEqual({ at: 100, from: -400 - 24, to: 320 + 24 });
  });

  it("matches the edge of one node with the opposite edge of another (they touch along a line)", () => {
    // the other node's right edge (x 100) is the dragged node's left edge
    const guides = alignGuides(D, [at(-20, 300, 120, 40)]);
    expect(guides.vertical.map((g) => g.at)).toEqual([100]);
  });

  it("joins several nodes on the same line into one guide that spans them all", () => {
    const guides = alignGuides(D, [at(100, 300, 40, 40), at(100, -200, 40, 40), at(100, 600, 40, 40)]);
    expect(guides.vertical).toEqual([{ at: 100, from: -200 - 24, to: 640 + 24 }]);
  });

  it("gives up to three guides per axis, in ascending order", () => {
    const guides = alignGuides(D, [at(100, 300, 40, 40), at(160, 400, 100, 40), at(200, 500, 120, 40)]);
    expect(guides.vertical.map((g) => g.at)).toEqual([100, 210, 320]);
  });
});

describe("alignGuides: the tolerance", () => {
  it("takes a line one graph pixel off (the default)", () => {
    expect(alignGuides(D, [at(101, 300)]).vertical.map((g) => g.at)).toEqual([100]);
    expect(alignGuides(D, [at(99, 300)]).vertical.map((g) => g.at)).toEqual([100]);
  });

  it("does not take a line just outside it", () => {
    expect(alignGuides(D, [at(101.5, 300)]).vertical).toEqual([]);
    expect(alignGuides(D, [at(98.9, 300)]).vertical).toEqual([]);
  });

  it("takes a wider tolerance when asked, and zero means exactly equal", () => {
    expect(alignGuides(D, [at(101.5, 300)], { tolerance: 2 }).vertical).toHaveLength(1);
    expect(alignGuides(D, [at(100.5, 300)], { tolerance: 0 }).vertical).toEqual([]);
    expect(alignGuides(D, [at(100, 300)], { tolerance: 0 }).vertical).toHaveLength(1);
  });

  it("does not lose a tolerance of 1 to floating point", () => {
    expect(2.2 - 1.2 > 1).toBe(true); // the raw difference is 1.0000000000000002
    expect(alignGuides({ ...D, x: 1.2 }, [at(2.2, 300)]).vertical).toHaveLength(1);
  });
});

describe("alignGuides: only the nearest nodes count", () => {
  it("looks at the nearest `cap` nodes by centre distance and ignores the rest", () => {
    const near = at(100, 300, 40, 40);
    const far = at(100, 5000, 40, 40);
    expect(alignGuides(D, [far, near], { cap: 1 }).vertical).toEqual([{ at: 100, from: 76, to: 364 }]);
    expect(alignGuides(D, [far], { cap: 1 }).vertical).toHaveLength(1); // alone it is the nearest
    expect(alignGuides(D, [far, at(900, 900, 40, 40)], { cap: 1 })).toEqual(none); // the stranger is nearer than the aligned far one
  });

  it("with a tie at the edge of the cap, keeps the earlier node", () => {
    const left = at(100, 300, 40, 40); // aligned with D's left edge; its centre (120, 320) is 90 across and 180 down from D's (210, 140)
    const right = at(290, 300, 20, 40); // not aligned; centre (300, 320): the mirror image, as near
    expect(alignGuides(D, [left, right], { cap: 1 }).vertical).toHaveLength(1);
    expect(alignGuides(D, [right, left], { cap: 1 }).vertical).toHaveLength(0);
  });

  it("with the default cap of 200, a perfectly aligned node 250 places further out is not seen", () => {
    const crowd: Rect[] = [];
    for (let i = 0; i < 250; i++) crowd.push(at(1000 + i * 3, 1000 + i, 40, 40)); // nowhere near an aligned line of D
    const far = at(100, 90000, 40, 40);
    expect(alignGuides(D, [...crowd, far])).toEqual(none);
    expect(alignGuides(D, [...crowd.slice(0, 199), far]).vertical).toHaveLength(1); // 200 nodes in all: the cap holds them all
  });

  it("looks at nothing when the cap is zero", () => {
    expect(alignGuides(D, [at(100, 300)], { cap: 0 })).toEqual(none);
  });

  it("does not reorder or change what it is given", () => {
    const others = [at(100, 300), at(900, 900)];
    const copy = JSON.parse(JSON.stringify(others));
    alignGuides(D, others, { cap: 1 });
    expect(others).toEqual(copy);
  });
});

describe("alignGuides: speed", () => {
  it("handles 2,000 nodes in a few milliseconds (this is the per-frame cost of a drag)", () => {
    const others: Rect[] = [];
    for (let i = 0; i < 2000; i++) others.push(at((i % 40) * 260, Math.floor(i / 40) * 90, 220, 64));
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) alignGuides({ x: 1040, y: 640, w: 220, h: 64 }, others);
    const each = (performance.now() - t0) / 20;
    expect(each).toBeLessThan(25);
  });
});
