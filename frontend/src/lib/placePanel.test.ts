import { placePanel, type Box } from "./placePanel";

const VIEW = { width: 1000, height: 700 };
const PANEL = { width: 180, height: 200 };
const at = (top: number, right = 600, height = 28): Box => ({ top, bottom: top + height, left: right - 28, right });

describe("placePanel: beside the trigger", () => {
  it("opens to the left of the trigger, a gap off its left edge, its top on the trigger's top", () => {
    expect(placePanel(at(100), PANEL, VIEW)).toEqual({ top: 100, left: 600 - 28 - 4 - 180, placement: "down", maxHeight: 592 });
  });

  it("never covers the trigger or the triggers of the rows above and below: its right edge stays left of the trigger", () => {
    const trigger = at(300);
    const placed = placePanel(trigger, PANEL, VIEW);
    expect(placed.left + PANEL.width).toBeLessThanOrEqual(trigger.left - 4);
  });

  it("runs past the bottom: its bottom edge goes on the trigger's bottom and it is 'up'", () => {
    const placed = placePanel(at(600), PANEL, VIEW);
    expect(placed).toMatchObject({ placement: "up", top: 628 - 200, left: 388 });
    expect(placed.top + PANEL.height).toBe(628);
  });

  it("fits exactly: the panel's bottom may touch the 8px kept free, and one pixel more moves it up", () => {
    const edge = 700 - 8 - 200; // trigger top that leaves the panel's bottom on the 8px line
    expect(placePanel(at(edge), PANEL, VIEW)).toMatchObject({ placement: "down", top: edge });
    expect(placePanel(at(edge + 1), PANEL, VIEW).placement).toBe("up");
  });

  it("a panel taller than the window is clamped to the inset and scrolls inside its maxHeight", () => {
    const tall = { width: 180, height: 900 };
    expect(placePanel(at(300), tall, VIEW)).toEqual({ top: 8, left: 388, placement: "up", maxHeight: 700 - 8 - 8 });
    expect(placePanel(at(300), tall, VIEW, 4, 52)).toMatchObject({ top: 52, maxHeight: 700 - 52 - 8 });
  });

  it("an upward panel never goes under the top bar", () => {
    const small = { width: 180, height: 120 };
    const trigger = at(150);
    expect(placePanel(trigger, small, { width: 1000, height: 190 })).toMatchObject({ placement: "up", top: 178 - 120 });
    expect(placePanel(trigger, small, { width: 1000, height: 190 }, 4, 70)).toMatchObject({ placement: "up", top: 70 });
  });

  it("never sits above the inset when the trigger is scrolled under the top bar", () => {
    expect(placePanel(at(-40), PANEL, VIEW, 4, 52).top).toBe(52);
  });

  it("returns the room below as maxHeight for both placements", () => {
    const down = placePanel(at(100), PANEL, VIEW);
    expect(down.maxHeight).toBe(700 - down.top - 8);
    const up = placePanel(at(600), PANEL, VIEW);
    expect(up.maxHeight).toBe(700 - up.top - 8);
    expect(up.maxHeight).toBeGreaterThanOrEqual(PANEL.height);
  });

  it("honours a custom gap", () => {
    expect(placePanel(at(100), PANEL, VIEW, 10)).toMatchObject({ top: 100, left: 600 - 28 - 10 - 180 });
  });

  it("keeps the 8px free at the left: exactly enough room beside the trigger still goes beside it", () => {
    const right = 8 + 180 + 4 + 28; // trigger.left - 4 - 180 === 8
    expect(placePanel(at(100, right), PANEL, VIEW)).toMatchObject({ left: 8, placement: "down", top: 100 });
    expect(placePanel(at(100, right - 1), PANEL, VIEW).top).toBe(132); // one pixel less: the fallback, below the trigger
  });
});

describe("placePanel: no room at the left (below or above the trigger, right edges aligned)", () => {
  it("opens below the trigger, its right edge on the trigger's, when it fits", () => {
    expect(placePanel(at(100, 100), PANEL, VIEW)).toEqual({ top: 132, left: 8, placement: "down", maxHeight: 560 });
    expect(placePanel(at(100, 190), PANEL, VIEW)).toMatchObject({ top: 132, left: 10, placement: "down" });
  });

  it("flips upward when there is no room below but room above", () => {
    const placed = placePanel(at(600, 100), PANEL, VIEW);
    expect(placed).toMatchObject({ placement: "up", top: 600 - 4 - 200 });
    expect(placed.top + PANEL.height).toBeLessThanOrEqual(600); // its bottom is above the trigger
  });

  it("stays below, clamped, and scrolls when it fits neither way", () => {
    const tall = { width: 180, height: 900 };
    expect(placePanel(at(300, 100), tall, VIEW)).toEqual({ top: 332, left: 8, placement: "down", maxHeight: 700 - 332 - 8 });
  });

  it("does not flip under the top bar: it needs room above the inset, not just above the window", () => {
    const small = { width: 180, height: 120 };
    const trigger = at(150, 100);
    expect(placePanel(trigger, small, { width: 1000, height: 190 })).toMatchObject({ placement: "up", top: 150 - 4 - 120 });
    expect(placePanel(trigger, small, { width: 1000, height: 190 }, 4, 52)).toMatchObject({ placement: "down", top: 182 });
  });

  it("keeps 8px off the right edge in a window narrower than the panel needs", () => {
    const placed = placePanel(at(100, 200), PANEL, { width: 200, height: 700 });
    expect(placed.left + PANEL.width).toBe(200 - 8);
  });

  it("a panel wider than the window is pinned to the left margin", () => {
    expect(placePanel(at(100, 600), { width: 1200, height: 100 }, VIEW).left).toBe(8);
  });
});

describe("placePanel: a reserve at the bottom of the window (the toast stack)", () => {
  const RESERVE = 72; // the stack's height plus the 16px it stands off the window plus 8px of air

  it("no reserve, or 0, gives the old results for the same inputs", () => {
    for (const trigger of [at(100), at(480), at(600), at(450, 100), at(600, 100), at(300, 100)]) {
      for (const panel of [PANEL, { width: 180, height: 900 }]) {
        expect(placePanel(trigger, panel, VIEW, 4, 52, 0)).toEqual(placePanel(trigger, panel, VIEW, 4, 52));
      }
    }
    expect(placePanel(at(480), PANEL, VIEW)).toEqual({ top: 480, left: 388, placement: "down", maxHeight: 212 }); // the old value
  });

  it("flips a panel beside the trigger that would reach into the reserve to the upward placement", () => {
    const trigger = at(480); // the panel's bottom edge would be at 680: free of the 8px edge, but inside the reserve
    expect(placePanel(trigger, PANEL, VIEW).placement).toBe("down");
    const placed = placePanel(trigger, PANEL, VIEW, 4, 52, RESERVE);
    expect(placed).toMatchObject({ placement: "up", top: 508 - 200, left: 388 });
    expect(placed.top + PANEL.height).toBeLessThanOrEqual(700 - 8 - RESERVE);
  });

  it("lowers maxHeight by the reserve, for both placements", () => {
    const down = placePanel(at(100), PANEL, VIEW, 4, 52, RESERVE);
    expect(down).toMatchObject({ placement: "down", top: 100, maxHeight: 700 - 100 - 8 - RESERVE });
    const up = placePanel(at(600), PANEL, VIEW, 4, 52, RESERVE);
    expect(up.maxHeight).toBe(700 - up.top - 8 - RESERVE);
  });

  it("a panel that fits above the reserve stays down", () => {
    expect(placePanel(at(300), PANEL, VIEW, 4, 52, RESERVE)).toMatchObject({ placement: "down", top: 300 });
  });

  it("fits exactly: the panel's bottom may touch the line above the reserve, and one pixel more moves it up", () => {
    const edge = 700 - 8 - RESERVE - 200;
    expect(placePanel(at(edge), PANEL, VIEW, 4, 52, RESERVE)).toMatchObject({ placement: "down", top: edge });
    expect(placePanel(at(edge + 1), PANEL, VIEW, 4, 52, RESERVE).placement).toBe("up");
  });

  it("with no room at the left it flips from below the trigger to above it when below would reach into the reserve", () => {
    const trigger = at(450, 100); // below it the panel ends at 682
    expect(placePanel(trigger, PANEL, VIEW, 4, 52)).toMatchObject({ placement: "down", top: 482 });
    const placed = placePanel(trigger, PANEL, VIEW, 4, 52, RESERVE);
    expect(placed).toMatchObject({ placement: "up", top: 450 - 4 - 200, left: 8 });
    expect(placed.maxHeight).toBe(700 - placed.top - 8 - RESERVE);
  });

  it("with no room above either it stays below and scrolls inside a maxHeight that stops above the reserve", () => {
    const tall = { width: 180, height: 900 };
    expect(placePanel(at(300, 100), tall, VIEW, 4, 52, RESERVE)).toEqual({ top: 332, left: 8, placement: "down", maxHeight: 700 - 332 - 8 - RESERVE });
    expect(placePanel(at(300), tall, VIEW, 4, 52, RESERVE)).toMatchObject({ top: 52, maxHeight: 700 - 52 - 8 - RESERVE });
  });
});
