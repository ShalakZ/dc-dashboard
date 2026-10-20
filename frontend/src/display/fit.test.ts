import { fitWall, GUTTER_SHARE, HEADER_SHARE, MIN_LOGICAL_WIDTH, naturalHeight, REFERENCE_HEIGHT, type Fit } from "./fit";

/** A dashboard as the wall draws it: one full-width card of `rows` rows (80 px rows, 10 px gaps: rows * 80 + (rows - 1) * 10). */
const dash = (rows: number) => [{ x: 0, y: 0, w: 12, h: rows }];
const POWER = naturalHeight(dash(8)); // 710
const COST = naturalHeight(dash(12)); // 1070
const HD = { width: 1920, height: 1080 };
const UHD = { width: 3840, height: 2160 };

describe("constants", () => {
  it("are the owner's numbers (R5)", () => {
    expect(HEADER_SHARE).toBe(0.045);
    expect(GUTTER_SHARE).toBe(0.015);
    expect(MIN_LOGICAL_WIDTH).toBe(1280);
    expect(REFERENCE_HEIGHT).toBe(1080);
  });
});

describe("naturalHeight", () => {
  it("is the pixel height of the grid StaticGrid draws: rows * 80 + (rows - 1) * 10", () => {
    expect(POWER).toBe(710);
    expect(COST).toBe(1070);
    expect(naturalHeight(dash(2))).toBe(170);
    expect(naturalHeight(dash(1))).toBe(80);
  });
  it("is 0 for no widgets", () => {
    expect(naturalHeight([])).toBe(0);
  });
  it("uses the layout closed up vertically: a widget at y = 5 under nothing counts from row 0", () => {
    expect(naturalHeight([{ x: 0, y: 5, w: 12, h: 2 }])).toBe(170);
  });
  it("closes a gap between widgets", () => {
    expect(naturalHeight([{ x: 0, y: 0, w: 12, h: 2 }, { x: 0, y: 6, w: 12, h: 2 }])).toBe(4 * 80 + 3 * 10);
  });
  it("pushes an overlapping widget down below the one it overlaps", () => {
    expect(naturalHeight([{ x: 0, y: 0, w: 6, h: 3 }, { x: 0, y: 0, w: 6, h: 3 }])).toBe(6 * 80 + 5 * 10);
  });
  it("lets a widget beside another share its rows", () => {
    expect(naturalHeight([{ x: 0, y: 0, w: 6, h: 4 }, { x: 6, y: 0, w: 6, h: 4 }])).toBe(4 * 80 + 3 * 10);
  });
  it("counts a widget with no height as one row, as the grid draws it", () => {
    expect(naturalHeight([{ x: 0, y: 0, w: 12, h: 0 }])).toBe(80);
  });
  it("does not change its input", () => {
    const widgets = [{ x: 0, y: 5, w: 12, h: 2 }];
    naturalHeight(widgets);
    expect(widgets).toEqual([{ x: 0, y: 5, w: 12, h: 2 }]);
  });
});

describe("fitWall", () => {
  it("Power (8 rows) at 1920x1080: scale 1.407, laid out about 1364.6 px wide, header 48.6 px", () => {
    const fit = fitWall(HD, POWER);
    expect(fit.scale).toBeCloseTo(1.407, 2);
    expect(fit.logicalWidth).toBeCloseTo(1364.6, 0);
    expect(fit.headerHeight).toBeCloseTo(48.6, 6);
    expect(fit.gutter).toBeCloseTo(16.2, 6);
    expect(fit.availableHeight).toBeCloseTo(999, 6);
    expect(fit.unit).toBe(1);
  });

  it("the grid and the header and the gutters add up to the window height (nothing scrolls)", () => {
    const fit = fitWall(HD, POWER);
    expect(fit.headerHeight + 2 * fit.gutter + fit.availableHeight).toBeCloseTo(HD.height, 9);
    // the scaled box ends exactly at the bottom gutter when the height is what limits the scale
    expect(fit.top + POWER * fit.scale + fit.gutter).toBeCloseTo(HD.height, 6);
  });

  it("Power at 3840x2160 is the SAME picture: scale 2.814, unit 2, every length twice as large", () => {
    const hd = fitWall(HD, POWER);
    const uhd = fitWall(UHD, POWER);
    expect(uhd.scale).toBeCloseTo(2.814, 2);
    expect(uhd.unit).toBe(2);
    const ratio = (key: keyof Fit) => uhd[key] / hd[key];
    for (const key of ["scale", "headerHeight", "gutter", "availableHeight", "top", "unit"] as const) {
      expect(Math.abs(ratio(key) - 2) / 2).toBeLessThan(0.001);
    }
    expect(uhd.logicalWidth).toBeCloseTo(hd.logicalWidth, 6); // the grid is laid out at the same logical width
  });

  it("Cost (12 rows) at 1920x1080 is shrunk below 1 (0.934) and is still whole", () => {
    const fit = fitWall(HD, COST);
    expect(fit.scale).toBeCloseTo(0.934, 2);
    expect(fit.scale).toBeLessThan(1);
    expect(COST * fit.scale).toBeLessThanOrEqual(fit.availableHeight + 1e-9);
    expect(fit.logicalWidth).toBeGreaterThanOrEqual(MIN_LOGICAL_WIDTH);
  });

  it("a 2-row dashboard (170 px) at 1920x1080 is limited by the width: scale 1.5, laid out 1280 wide, the spare height shared above and below", () => {
    const fit = fitWall(HD, naturalHeight(dash(2)));
    expect(fit.scale).toBeCloseTo(1.5, 9);
    expect(fit.logicalWidth).toBeCloseTo(1280, 9);
    const leftover = fit.availableHeight - 170 * fit.scale;
    expect(leftover).toBeGreaterThan(0);
    expect(fit.top).toBeCloseTo(fit.headerHeight + fit.gutter + leftover / 2, 9);
  });

  it("never lays the grid out narrower than 1280 logical px, whatever the window", () => {
    for (const win of [{ width: 800, height: 1080 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }, { width: 600, height: 4000 }]) {
      for (const natural of [0, 80, 170, 710, 1070, 3000]) {
        const fit = fitWall(win, natural);
        expect(fit.logicalWidth).toBeGreaterThanOrEqual(MIN_LOGICAL_WIDTH - 1e-9);
        expect(fit.logicalWidth * fit.scale).toBeCloseTo(win.width, 6);
      }
    }
  });

  it("a dashboard with nothing in it is scaled by the width alone", () => {
    const fit = fitWall(HD, 0);
    expect(fit.scale).toBeCloseTo(1.5, 9);
    expect(fit.logicalWidth).toBeCloseTo(1280, 9);
    expect(fit.top).toBeCloseTo(fit.headerHeight + fit.gutter + fit.availableHeight / 2, 9);
  });

  it("the header never takes more than 4.5 % of the height, for any window", () => {
    for (const win of [{ width: 1920, height: 1080 }, { width: 3840, height: 2160 }, { width: 1366, height: 768 }, { width: 800, height: 1280 }, { width: 5120, height: 1440 }, { width: 1, height: 1 }, { width: 1000, height: 37.5 }]) {
      const fit = fitWall(win, POWER);
      expect(fit.headerHeight).toBeLessThanOrEqual(0.045 * win.height + 1e-9);
      expect(fit.gutter).toBeLessThanOrEqual(0.015 * win.height + 1e-9);
    }
  });

  it("the unit is the window height over 1080", () => {
    expect(fitWall({ width: 1920, height: 1080 }, POWER).unit).toBe(1);
    expect(fitWall({ width: 1366, height: 768 }, POWER).unit).toBeCloseTo(768 / 1080, 9);
  });

  it("the leftover height is never negative (the scale already makes the dashboard fit)", () => {
    for (const natural of [100, 710, 1070, 2500]) {
      const fit = fitWall({ width: 1280, height: 1080 }, natural);
      expect(fit.top).toBeGreaterThanOrEqual(fit.headerHeight + fit.gutter - 1e-9);
      expect(fit.top + natural * fit.scale).toBeLessThanOrEqual(fit.headerHeight + fit.gutter + fit.availableHeight + 1e-9);
    }
  });

  it("returns finite numbers for a window that is not laid out yet", () => {
    for (const win of [{ width: 0, height: 0 }, { width: 1920, height: 0 }, { width: 0, height: 1080 }, { width: -5, height: -5 }, { width: Number.NaN, height: 1080 }, { width: 1920, height: Number.POSITIVE_INFINITY }]) {
      const fit = fitWall(win, POWER);
      for (const value of Object.values(fit)) expect(Number.isFinite(value)).toBe(true);
      expect(fit.scale).toBe(1);
      expect(fit.unit).toBe(1);
      expect(fit.headerHeight).toBe(0);
      expect(fit.gutter).toBe(0);
      expect(fit.availableHeight).toBe(0);
      expect(fit.top).toBe(0);
    }
  });

  it("treats a natural height that is not a positive number as an empty dashboard", () => {
    expect(fitWall(HD, Number.NaN)).toEqual(fitWall(HD, 0));
    expect(fitWall(HD, -10)).toEqual(fitWall(HD, 0));
  });
});
