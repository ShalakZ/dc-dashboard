import { placeTip } from "./placeTip";

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
