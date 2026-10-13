import { clipBand, placeTip } from "./placeTip";

const window1000 = { width: 1000, height: 700 };
const bubble = { width: 300, height: 60 };
const at = (left: number, top: number, size = 24) => ({ left, top, right: left + size, bottom: top + size });

describe("placeTip", () => {
  it("goes under the button with the left edges aligned", () => {
    expect(placeTip(at(100, 100), bubble, window1000)).toEqual({ top: 130, left: 100, placement: "below" });
  });

  it("aligns the right edges when the bubble would run past the right of the window", () => {
    const place = placeTip(at(900, 100), bubble, window1000);
    expect(place.left).toBe(900 + 24 - 300);
    expect(place.left + bubble.width).toBeLessThanOrEqual(1000 - 8);
  });

  it("is clamped inside the window at both sides", () => {
    expect(placeTip(at(0, 100), bubble, window1000).left).toBe(8);
    expect(placeTip(at(995, 100), bubble, window1000).left + bubble.width).toBeLessThanOrEqual(1000 - 8);
    // a bubble nearly as wide as the window still ends up inside it
    const wide = placeTip(at(500, 100), { width: 980, height: 60 }, window1000);
    expect(wide.left).toBeGreaterThanOrEqual(8);
    expect(wide.left + 980).toBeLessThanOrEqual(1000);
  });

  it("goes above the button when there is no room below and there is room above", () => {
    expect(placeTip(at(100, 650), bubble, window1000)).toEqual({ top: 650 - 6 - 60, left: 100, placement: "above" });
  });

  it("stays below when it fits neither below nor above (it is never pushed off the top)", () => {
    const place = placeTip(at(100, 20), { width: 300, height: 700 }, window1000);
    expect(place.placement).toBe("below");
    expect(place.top).toBe(20 + 24 + 6);
  });
});

describe("placeTip with bounds (the vertical band the bubble must stay inside)", () => {
  const band = { top: 100, bottom: 400 }; // inside the 1000 x 700 window

  it("goes below when it ends inside the band", () => {
    expect(placeTip(at(100, 200), bubble, window1000, 6, band)).toEqual({ top: 230, left: 100, placement: "below" });
  });

  it("goes above when below would run past the band although the window has room, and above fits", () => {
    // below = 260 and ends at 320 (the window would allow it, the band's bottom is 300); above = 164 and ends at 224
    expect(placeTip(at(100, 230), bubble, window1000, 6, { top: 100, bottom: 300 })).toEqual({ top: 164, left: 100, placement: "above" });
  });

  it("is clamped so its bottom is the band's bottom when the trigger is below the band", () => {
    // the trigger is under the band, so neither side puts the bubble inside it: the bubble sits at the band's bottom edge
    const place = placeTip(at(100, 500), bubble, window1000, 6, band);
    expect(place.top + bubble.height).toBe(band.bottom);
    expect(place.placement).toBe("below");
  });

  it("is clamped to the band's top when the trigger is above the band", () => {
    const place = placeTip(at(100, 20), bubble, window1000, 6, band);
    expect(place.top).toBe(band.top);
  });

  it("starts at the band's top when it is taller than the band (the top wins)", () => {
    const place = placeTip(at(100, 150), { width: 300, height: 500 }, window1000, 6, band);
    expect(place.top).toBe(band.top);
  });

  it("never leaves the window either: the band is cut to the window's edge", () => {
    const place = placeTip(at(100, 690), bubble, window1000, 6, { top: -500, bottom: 5000 });
    expect(place.top).toBeGreaterThanOrEqual(8);
    expect(place.top + bubble.height).toBeLessThanOrEqual(700 - 8);
    expect(place.placement).toBe("above");
  });

  it("keeps the horizontal placement of a call without bounds", () => {
    const withBounds = placeTip(at(900, 200), bubble, window1000, 6, band);
    expect(withBounds.left).toBe(placeTip(at(900, 200), bubble, window1000).left);
    expect(placeTip(at(0, 200), bubble, window1000, 6, band).left).toBe(8);
  });

  it("without bounds the results are what they always were (no clamping to anything)", () => {
    expect(placeTip(at(100, 230), bubble, window1000, 6, undefined)).toEqual({ top: 260, left: 100, placement: "below" });
    expect(placeTip(at(100, 650), bubble, window1000, 6, undefined)).toEqual({ top: 584, left: 100, placement: "above" });
    // the trigger is under where a band would end: still just below it, as before
    expect(placeTip(at(100, 500), bubble, window1000)).toEqual({ top: 530, left: 100, placement: "below" });
  });
});

describe("clipBand (the part of the window the scrolling boxes around an element leave visible)", () => {
  const rect = (top: number, bottom: number) =>
    ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  /** A box inside the one before it, each with its own overflow-y and vertical extent. */
  function nest(...boxes: { overflowY?: string; top: number; bottom: number }[]) {
    let parent: HTMLElement = document.body;
    const made = boxes.map((spec) => {
      const el = document.createElement("div");
      if (spec.overflowY !== undefined) el.style.overflowY = spec.overflowY;
      vi.spyOn(el, "getBoundingClientRect").mockReturnValue(rect(spec.top, spec.bottom));
      parent.appendChild(el);
      parent = el;
      return el;
    });
    const leaf = document.createElement("label");
    parent.appendChild(leaf);
    return { leaf, root: made[0] };
  }
  afterEach(() => { document.body.replaceChildren(); });

  it("is the whole window when nothing around the element scrolls or clips", () => {
    const { leaf } = nest({ top: 50, bottom: 60 }, { overflowY: "visible", top: 70, bottom: 80 });
    expect(clipBand(leaf, 700)).toEqual({ top: 0, bottom: 700 });
  });

  it("is the extent of a scrolling ancestor, and of the nearest and the tightest of several", () => {
    const one = nest({ overflowY: "auto", top: 120, bottom: 480 });
    expect(clipBand(one.leaf, 700)).toEqual({ top: 120, bottom: 480 });
    document.body.replaceChildren();
    const many = nest({ overflowY: "hidden", top: 20, bottom: 650 }, { overflowY: "auto", top: 100, bottom: 500 }, { top: 0, bottom: 5000 }, { overflowY: "scroll", top: 150, bottom: 800 });
    expect(clipBand(many.leaf, 700)).toEqual({ top: 150, bottom: 500 });
  });

  it("counts every value but visible and empty (clip, hidden, scroll, auto) and cuts to the window", () => {
    for (const overflowY of ["clip", "hidden", "scroll", "auto"]) {
      document.body.replaceChildren();
      expect(clipBand(nest({ overflowY, top: -300, bottom: 900 }).leaf, 700), overflowY).toEqual({ top: 0, bottom: 700 });
      document.body.replaceChildren();
      expect(clipBand(nest({ overflowY, top: 200, bottom: 300 }).leaf, 700), overflowY).toEqual({ top: 200, bottom: 300 });
    }
  });

  it("stops before <body>: the page's own overflow does not count", () => {
    const { leaf } = nest({ top: 0, bottom: 10 });
    document.body.style.overflowY = "hidden";
    vi.spyOn(document.body, "getBoundingClientRect").mockReturnValue(rect(300, 310));
    try {
      expect(clipBand(leaf, 700)).toEqual({ top: 0, bottom: 700 });
    } finally {
      document.body.style.overflowY = "";
    }
  });

  it("is empty (bottom not above top) when a box has scrolled clean out of the window", () => {
    const { leaf } = nest({ overflowY: "auto", top: 800, bottom: 900 });
    const band = clipBand(leaf, 700);
    expect(band.bottom - band.top).toBeLessThanOrEqual(0);
  });
});
