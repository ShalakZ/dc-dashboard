import { placePanel, type Box } from "./placePanel";

const VIEW = { width: 1000, height: 700 };
const PANEL = { width: 180, height: 200 };
const at = (top: number, right = 600, height = 28): Box => ({ top, bottom: top + height, left: right - 28, right });

describe("placePanel", () => {
  it("opens below the trigger, its right edge on the trigger's, when it fits", () => {
    expect(placePanel(at(100), PANEL, VIEW)).toEqual({ top: 132, left: 420, placement: "down", maxHeight: 560 });
  });

  it("flips upward when there is no room below but room above", () => {
    const placed = placePanel(at(600), PANEL, VIEW);
    expect(placed).toMatchObject({ placement: "up", top: 600 - 4 - 200 });
    expect(placed.top + PANEL.height).toBeLessThanOrEqual(600); // its bottom is above the trigger
  });

  it("fits exactly: the panel's bottom may touch the 8px kept free, and one pixel more flips it", () => {
    const edge = 700 - 8 - 200 - 4 - 28; // trigger top that leaves the panel's bottom on the 8px line
    expect(placePanel(at(edge), PANEL, VIEW).placement).toBe("down");
    expect(placePanel(at(edge + 1), PANEL, VIEW).placement).toBe("up");
  });

  it("stays below, clamped, and scrolls when it fits neither way", () => {
    const tall = { width: 180, height: 900 };
    expect(placePanel(at(300), tall, VIEW)).toEqual({ top: 332, left: 420, placement: "down", maxHeight: 700 - 332 - 8 });
  });

  it("an upward panel never goes under the top bar: it needs room above the inset, not just above the window", () => {
    // 150px above the trigger is enough for the default 8px inset (a 200px panel is not: use a 120px one), but not once a 52px bar is in the way
    const small = { width: 180, height: 120 };
    const trigger = at(600);
    expect(placePanel({ ...trigger, top: 150, bottom: 178 }, small, { width: 1000, height: 190 })).toMatchObject({ placement: "up", top: 150 - 4 - 120 });
    expect(placePanel({ ...trigger, top: 150, bottom: 178 }, small, { width: 1000, height: 190 }, 4, 52)).toMatchObject({ placement: "down", top: 182 });
  });

  it("never sits above the inset when the trigger is scrolled under the top bar", () => {
    expect(placePanel(at(-40), PANEL, VIEW, 4, 52).top).toBe(52);
  });

  it("keeps 8px off the left edge when the trigger is near it", () => {
    expect(placePanel(at(100, 60), PANEL, VIEW).left).toBe(8);
  });

  it("keeps 8px off the right edge when the trigger touches it", () => {
    const placed = placePanel(at(100, 1000), PANEL, VIEW);
    expect(placed.left + PANEL.width).toBe(1000 - 8);
  });

  it("a panel wider than the window is pinned to the left margin", () => {
    expect(placePanel(at(100, 600), { width: 1200, height: 100 }, VIEW).left).toBe(8);
  });

  it("returns the room below as maxHeight for both placements", () => {
    const down = placePanel(at(100), PANEL, VIEW);
    expect(down.maxHeight).toBe(700 - down.top - 8);
    const up = placePanel(at(600), PANEL, VIEW);
    expect(up.maxHeight).toBe(700 - up.top - 8);
    expect(up.maxHeight).toBeGreaterThanOrEqual(PANEL.height);
  });

  it("honours a custom gap", () => {
    expect(placePanel(at(100), PANEL, VIEW, 10).top).toBe(138);
  });
});
