import { CAMERA_MS, cameraMs, keepInView, overlayMargin, unionRect } from "./graphCamera";

describe("cameraMs", () => {
  it.each([
    [false, 300],
    [true, 0],
  ])("reduced %s -> %d ms", (reduced, ms) => {
    expect(cameraMs(reduced)).toBe(ms);
  });

  it("exports the duration the plan names", () => {
    expect(CAMERA_MS).toBe(300);
  });
});

describe("unionRect", () => {
  it("is null for nothing", () => {
    expect(unionRect([])).toBeNull();
  });

  it("returns a copy of a single rectangle", () => {
    const one = { x: 10, y: 20, w: 220, h: 80 };
    const out = unionRect([one]);
    expect(out).toEqual(one);
    expect(out).not.toBe(one);
  });

  it("covers every rectangle, including negative coordinates", () => {
    expect(unionRect([
      { x: 0, y: 0, w: 220, h: 136 },
      { x: 360, y: 136, w: 220, h: 80 },
      { x: -40, y: 300, w: 10, h: 10 },
    ])).toEqual({ x: -40, y: 0, w: 620, h: 310 });
  });
});

describe("keepInView", () => {
  // The viewport maps a graph point to the screen as graph * zoom + translate; the canvas is 1000 x 600 here.
  const size = { w: 1000, h: 600 };
  const at1 = { x: 0, y: 0, zoom: 1 };
  const box = (x: number, y: number, w = 200, h = 100) => ({ x, y, w, h });

  it.each([
    ["well inside", box(300, 200), at1],
    ["touching the left and top margins", box(40, 40), at1],
    ["touching the right and bottom margins", box(760, 460), at1],
    ["inside after the viewport was panned", box(300, 200), { x: -100, y: 50, zoom: 1 }],
  ])("is null when the box is already in: %s", (_name, b, view) => {
    expect(keepInView(b, view, size)).toBeNull();
  });

  it.each([
    ["left of the margin", box(10, 200), at1, { x: 30, y: 0 }],
    ["right of the margin", box(900, 200), at1, { x: -140, y: 0 }],
    ["above the margin", box(300, 5), at1, { x: 0, y: 35 }],
    ["below the margin", box(300, 520), at1, { x: 0, y: -60 }],
    ["off to the bottom right", box(900, 520), at1, { x: -140, y: -60 }],
    ["entirely off screen to the left", box(-500, 200), at1, { x: 540, y: 0 }],
  ])("moves by the least amount: %s", (_name, b, view, want) => {
    const out = keepInView(b, view, size);
    expect(out).toEqual({ x: view.x + want.x, y: view.y + want.y });
  });

  it("keeps the viewport's own offset in the answer", () => {
    // The box starts at screen x 10 + 10 = 20, 20 px short of the 40 px margin: pan right by 20 on top of the 10 the view already has.
    expect(keepInView(box(10, 200), { x: 10, y: 5, zoom: 1 }, size)).toEqual({ x: 30, y: 5 });
  });

  it("measures the box on screen: zoom 0.5 shrinks it, zoom 2 doubles it", () => {
    // zoom 0.5: the box (x 1400, w 200) spans 700..800 on screen -> inside, null.
    expect(keepInView(box(1400, 200), { x: 0, y: 0, zoom: 0.5 }, size)).toBeNull();
    // zoom 0.5: x 1900 spans 950..1050; the right limit is 960 -> pan left by 90.
    expect(keepInView(box(1900, 200), { x: 0, y: 0, zoom: 0.5 }, size)).toEqual({ x: -90, y: 0 });
    // zoom 2: the box (x 100, w 200) spans 200..600 on screen -> inside.
    expect(keepInView(box(100, 100), { x: 0, y: 0, zoom: 2 }, size)).toBeNull();
    // zoom 2: x 400 spans 800..1200; right limit 960 -> pan left by 240.
    expect(keepInView(box(400, 100), { x: 0, y: 0, zoom: 2 }, size)).toEqual({ x: -240, y: 0 });
  });

  it("aligns a box wider or taller than the room at its left or top margin", () => {
    // 2000 wide at zoom 1 in a room of 920: left edge goes to 40 whatever it was.
    expect(keepInView(box(300, 200, 2000, 100), at1, size)).toEqual({ x: -260, y: 0 });
    expect(keepInView(box(-100, 200, 2000, 100), at1, size)).toEqual({ x: 140, y: 0 });
    // taller than the room (520): the top edge goes to 40.
    expect(keepInView(box(300, 300, 200, 900), at1, size)).toEqual({ x: 0, y: -260 });
    // already aligned at the margin: nothing to do
    expect(keepInView(box(40, 40, 2000, 900), at1, size)).toBeNull();
  });

  it("treats a box exactly as wide as the room as fitting", () => {
    expect(keepInView(box(40, 200, 920, 100), at1, size)).toBeNull();
    expect(keepInView(box(30, 200, 920, 100), at1, size)).toEqual({ x: 10, y: 0 });
  });

  it("takes a different margin", () => {
    expect(keepInView(box(10, 200), at1, size, 0)).toBeNull();
    expect(keepInView(box(10, 200), at1, size, 100)).toEqual({ x: 90, y: 0 });
  });

  // A margin can be given per side (the page keeps a node clear of the minimap and the tools panel drawn over the canvas); a side left out is the usual 40.
  it.each([
    ["top", { top: 100 }, box(300, 60), { x: 0, y: 40 }],
    ["bottom", { bottom: 200 }, box(300, 460), { x: 0, y: -160 }],
    ["left", { left: 100 }, box(60, 200), { x: 40, y: 0 }],
    ["right", { right: 200 }, box(700, 200), { x: -100, y: 0 }],
  ])("a %s margin of its own moves a box that the usual 40 would leave alone", (_side, margin, b, want) => {
    expect(keepInView(b, at1, size)).toBeNull();
    expect(keepInView(b, at1, size, margin)).toEqual(want);
  });

  it.each([
    ["bottom", { bottom: 200 }, box(300, 300)],
    ["top", { top: 100 }, box(300, 100)],
    ["left", { left: 100 }, box(100, 200)],
    ["right", { right: 200 }, box(600, 200)],
  ])("a box that sits just inside its %s margin is left where it is", (_side, margin, b) => {
    expect(keepInView(b, at1, size, margin)).toBeNull();
  });

  it("a side left out of the object is 40, not zero and not the other sides", () => {
    // left 40 by default: the box at x 10 moves 30 right; the bottom margin of 200 does not touch the x axis.
    expect(keepInView(box(10, 200), at1, size, { bottom: 200 })).toEqual({ x: 30, y: 0 });
    // top 40 by default: the box at y 5 moves 35 down, whatever the bottom says.
    expect(keepInView(box(300, 5), at1, size, { bottom: 200 })).toEqual({ x: 0, y: 35 });
    // a side given as 0 is 0
    expect(keepInView(box(0, 200), at1, size, { left: 0 })).toBeNull();
  });

  it("an empty object is the same as the number 40", () => {
    for (const b of [box(10, 200), box(900, 520), box(300, 200), box(300, 300, 200, 900)]) {
      expect(keepInView(b, at1, size, {})).toEqual(keepInView(b, at1, size, 40));
    }
  });

  it("a box taller than the room that is left between the margins is aligned at its top margin", () => {
    // room 600 - 100 - 200 = 300; the box is 900 tall: its top edge goes to 100 whatever it was.
    expect(keepInView(box(300, 300, 200, 900), at1, size, { top: 100, bottom: 200 })).toEqual({ x: 0, y: -200 });
    expect(keepInView(box(300, 100, 200, 900), at1, size, { top: 100, bottom: 200 })).toBeNull();
    // exactly as tall as the room fits
    expect(keepInView(box(300, 100, 200, 300), at1, size, { top: 100, bottom: 200 })).toBeNull();
  });

  it("the margins count on screen pixels, so the zoom does not change them", () => {
    // zoom 2: the box (y 100, h 50) spans 200..300 on screen; the bottom limit is 600 - 400 = 200, so it moves up by 100.
    expect(keepInView(box(100, 100, 100, 50), { x: 0, y: 0, zoom: 2 }, size, { bottom: 400 })).toEqual({ x: 0, y: -100 });
  });

  it("does nothing when the canvas has no size yet", () => {
    expect(keepInView(box(10, 200), at1, { w: 0, h: 0 })).toBeNull();
  });

  it("does not mutate its inputs", () => {
    const b = Object.freeze(box(10, 200));
    const view = Object.freeze({ x: 0, y: 0, zoom: 1 });
    const s = Object.freeze({ w: 1000, h: 600 });
    expect(() => keepInView(b, view, s)).not.toThrow();
  });
});

describe("overlayMargin", () => {
  // The canvas is 600 tall on a page that starts 100 px down; the minimap is 152 tall and its top is at 450 (its own bottom margin clears the corner link).
  const canvas = { top: 100, bottom: 700, width: 800, height: 600 };
  const minimap = { top: 450, bottom: 602 + 100, width: 200, height: 152 };
  const tools = { top: 108, bottom: 150, width: 800, height: 42 };

  it("keeps the node clear of the minimap at the bottom and of the tools panel at the top", () => {
    // bottom: 700 - 450 + 16 = 266; top: 150 - 100 + 8 = 58
    expect(overlayMargin(canvas, minimap, tools)).toEqual({ top: 58, bottom: 266 });
  });

  it("is the usual 40 on a side whose overlay is not drawn", () => {
    expect(overlayMargin(canvas, null, null)).toEqual({ top: 40, bottom: 40 });
    expect(overlayMargin(canvas, minimap, null)).toEqual({ top: 40, bottom: 266 });
    expect(overlayMargin(canvas, null, tools)).toEqual({ top: 58, bottom: 40 });
  });

  it("an overlay with no size counts as not drawn (hidden, or a page that cannot measure)", () => {
    const empty = { top: 0, bottom: 0, width: 0, height: 0 };
    expect(overlayMargin(canvas, empty, empty)).toEqual({ top: 40, bottom: 40 });
  });

  it("is never less than 40, however small the overlay", () => {
    expect(overlayMargin(canvas, { top: 690, bottom: 700, width: 20, height: 10 }, { top: 100, bottom: 110, width: 20, height: 10 })).toEqual({ top: 40, bottom: 40 });
  });

  it("feeds keepInView: a node low on the screen is lifted above the minimap, a node under the tools panel is lowered", () => {
    const size = { w: 800, h: 600 };
    const view = { x: 0, y: 0, zoom: 1 };
    const margin = overlayMargin(canvas, minimap, tools);
    // a node 80 tall at screen y 400..480: inside the usual 40 margin (560), but under the minimap (limit 334)
    expect(keepInView({ x: 100, y: 400, w: 220, h: 80 }, view, size)).toBeNull();
    expect(keepInView({ x: 100, y: 400, w: 220, h: 80 }, view, size, margin)).toEqual({ x: 0, y: -146 });
    // a node at screen y 45..125: clear of the usual margin, under the tools panel (limit 58)
    expect(keepInView({ x: 100, y: 45, w: 220, h: 80 }, view, size)).toBeNull();
    expect(keepInView({ x: 100, y: 45, w: 220, h: 80 }, view, size, margin)).toEqual({ x: 0, y: 13 });
  });
});
