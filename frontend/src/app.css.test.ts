import { readFileSync } from "node:fs";
import { MUTED_FIGURE } from "./lib/widgetFormat";

// vitest is configured with `css: false`, which empties a CSS import, so the stylesheet is read as text.
const css = readFileSync("src/app.css", "utf8"); // vitest runs from the frontend directory

// The muted greys are the only text on a tinted or white ground that is meant to look faded; WCAG AA asks 4.5:1 for it.
const AA = 4.5;

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex; // #999 is #999999
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (fg: string, bg: string) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};

/** The value of `property` in the rule whose selector list is exactly `selector`. */
function declared(selector: string, property: string): string {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].trim() === selector);
  expect(rules, `a rule for "${selector}"`).toHaveLength(1);
  const value = new RegExp(`(?:^|;|\\s)${property}:\\s*(#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)\\b`).exec(rules[0][2])?.[1];
  expect(value, `${property} of "${selector}"`).toBeDefined();
  return value!;
}

describe("contrast of the muted text", () => {
  it("the wording is checked against known ratios", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrast("#999999", "#f4f4f4")).toBeLessThan(AA); // what the billing cell used to be (about 2.6:1)
    expect(contrast("#999999", "#ffffff")).toBeLessThan(AA); // and the dimmed stat figure (about 2.8:1)
  });

  it("a muted Billing cell reads at 4.5:1 on its shaded ground", () => {
    const ink = declared("table.billing td.muted, table.billing td.muted .muted", "color");
    const ground = declared("table.billing td.muted", "background");
    expect(contrast(ink, ground)).toBeGreaterThanOrEqual(AA);
  });

  it("a dimmed stat figure reads at 4.5:1 on the white widget", () => {
    expect(contrast(declared(".stat .big.muted", "color"), declared(".widget-frame", "background"))).toBeGreaterThanOrEqual(AA);
  });

  it("the gauge's dimmed figure is the stat's, so it reads at 4.5:1 on the white widget too", () => {
    expect(MUTED_FIGURE).toBe(declared(".stat .big.muted", "color"));
    expect(contrast(MUTED_FIGURE, declared(".widget-frame", "background"))).toBeGreaterThanOrEqual(AA);
  });

  it("the plain muted text does too", () => {
    expect(contrast(declared(".muted", "color"), declared("body", "background"))).toBeGreaterThanOrEqual(AA);
  });
});
