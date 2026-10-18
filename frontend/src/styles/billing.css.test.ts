import { readFileSync } from "node:fs";
import { parseRules, stripComments } from "../test/cssTools";

// W17: the Billing table scrolls inside its own box and keeps its header (and the first column) in view. The box's height follows the window
// (--billing-chrome is what sits above it), the header is sticky at the top of the box, the first column at its left, and the corner above both.
// vitest runs from the frontend directory and reads the stylesheets as text (css: false).
const read = (file: string) => parseRules(stripComments(readFileSync(file, "utf8")));
const billing = read("src/styles/pages-billing.css");
const app = read("src/app.css");

const LAYER = "@layer w6";
const MEDIA = "@media (max-height: 559.98px)";

/** The rules of a selector at a given nesting (the layer alone by default). */
const rulesOf = (list: ReturnType<typeof read>, selector: string, at: string[] = [LAYER]) =>
  list.filter((r) => r.selector === selector && r.at.length === at.length && r.at.every((a, i) => a === at[i]));
const bodyOf = (list: ReturnType<typeof read>, selector: string, at: string[] = [LAYER]) => {
  const found = rulesOf(list, selector, at);
  expect(found, `exactly one rule for "${selector}" ${at.join(" > ")}`).toHaveLength(1);
  return found[0].body;
};
const prop = (body: string, name: string) => new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim();
const rem = (body: string, name: string) => {
  const m = /^([\d.]+)rem$/.exec(prop(body, name) ?? "");
  expect(m, `${name} is a length in rem`).not.toBeNull();
  return Number(m![1]);
};

const BOX = ".billing-page .table-wrap.table-scroll";
const HEAD = "table.billing thead th";
const CORNER = "table.billing thead th:first-child";
const ROW_HEAD = 'table.billing tbody th[scope="row"]';

describe("the scroll box of the Billing table (W17, R4)", () => {
  it("scrolls on its own, never taller than the window less what sits above it, with a floor of 20rem", () => {
    const body = bodyOf(billing, BOX);
    expect(prop(body, "overflow")).toBe("auto");
    expect(prop(body, "max-height")).toMatch(/^max\(20rem,\s*calc\(100dvh\s*-\s*var\(--billing-chrome(?:,\s*[\d.]+rem)?\)\)\)$/);
    expect(prop(body, "scroll-padding-top")).toBe("2.75rem"); // a Tab-focused twisty is not left under the sticky header
  });

  it("on a window shorter than 560px the box has no limit: the page scrolls instead", () => {
    expect(prop(bodyOf(billing, BOX, [LAYER, MEDIA]), "max-height")).toBe("none");
  });

  it("what sits above the box is a variable on the page: the closed-month banner and the missing-rate banner each add to it, and both add both", () => {
    const base = rem(bodyOf(billing, ".billing-page"), "--billing-chrome");
    const closed = rem(bodyOf(billing, ".billing-page:has(.closed-box)"), "--billing-chrome");
    const warn = rem(bodyOf(billing, ".billing-page:has(.banner-warn)"), "--billing-chrome");
    const both = rem(bodyOf(billing, ".billing-page:has(.closed-box):has(.banner-warn)"), "--billing-chrome");
    expect(base).toBeGreaterThan(10);
    expect(closed).toBeGreaterThan(base);
    expect(warn).toBeGreaterThan(base);
    expect(both).toBeGreaterThan(Math.max(closed, warn));
    expect(both).toBeLessThanOrEqual(base + (closed - base) + (warn - base) + 1e-9); // never more than the two additions
    // the rule for both outranks the two alone (two :has() against one), so it wins whatever the order
    expect(billing.findIndex((r) => r.selector === ".billing-page:has(.closed-box):has(.banner-warn)")).toBeGreaterThan(
      billing.findIndex((r) => r.selector === ".billing-page:has(.banner-warn)"),
    );
  });

  it("the four chrome values are the ones measured with the 34px month bar and controls bar (W18: 0.5rem less than with the 38px ones), and the chip's room holds the 34px chip", () => {
    // Measured at 1440 x 900 on the pilot-hall look stack: an open month's table box ends 892px down (8px inside the window), as before the change,
    // and a closed month's at 872px, as before; Next month stands on the same x in both (the room is 84px, the chip 81px with the fallback font).
    expect(rem(bodyOf(billing, ".billing-page"), "--billing-chrome")).toBe(15.8);
    expect(rem(bodyOf(billing, ".billing-page:has(.closed-box)"), "--billing-chrome")).toBe(22.5);
    expect(rem(bodyOf(billing, ".billing-page:has(.banner-warn)"), "--billing-chrome")).toBe(19.6);
    expect(rem(bodyOf(billing, ".billing-page:has(.closed-box):has(.banner-warn)"), "--billing-chrome")).toBe(26.3);
    expect(prop(bodyOf(billing, ".billing-page .month-state"), "min-width")).toBe("5.25rem");
    const chip = bodyOf(billing, ".billing-page .month-state .chip");
    expect(prop(chip, "height")).toBe("var(--ctl-h)");
    expect(prop(chip, "padding")).toBe("0 12px");
    expect(prop(bodyOf(billing, ".billing-page .billing-tools"), "min-height")).toBe("var(--ctl-h)");
  });

  it("a classic scrollbar always has its track on Billing, so a fold or a filter that changes the height moves nothing sideways and no blank notch shows beside the top bar", () => {
    const html = bodyOf(billing, "html:has(.billing-page)");
    expect(prop(html, "overflow-y")).toBe("scroll");
    expect(prop(html, "scrollbar-gutter")).toBeUndefined(); // a reserved gutter leaves a blank strip when the page does not scroll
  });

  it("a filter that matches nothing wraps its message and keeps it at the left edge: a long filter never widens the table", () => {
    const body = bodyOf(billing, ".billing-page .bill-nomatch");
    expect(prop(body, "position")).toBe("sticky");
    expect(prop(body, "left")).toBe("0");
    expect(prop(body, "white-space")).toBe("normal");
    expect(prop(body, "max-width")).toBe("min(60ch, 70vw)");
    expect(prop(body, "overflow-wrap")).toBe("anywhere");
  });

  it("the bar over the table holds its room while idle and shows nothing", () => {
    expect(prop(bodyOf(billing, ".billing-page .billing-tools.is-idle"), "visibility")).toBe("hidden");
  });
});

describe("the header and the first column stay while the days scroll (W17, R4)", () => {
  const z = (body: string) => Number(prop(body, "z-index"));

  it("the header cells are sticky at the top of the box; the corner is sticky at the top and at the left", () => {
    const head = bodyOf(billing, HEAD);
    expect(prop(head, "position")).toBe("sticky");
    expect(prop(head, "top")).toBe("0");
    const corner = bodyOf(billing, CORNER);
    expect(prop(corner, "position")).toBe("sticky");
    expect(prop(corner, "top")).toBe("0");
    expect(prop(corner, "left")).toBe("0");
  });

  it("the row headers are sticky at the left of the box (app.css) and the layers stack corner > header > row header", () => {
    const rowAppCss = bodyOf(app, ROW_HEAD);
    expect(prop(rowAppCss, "position")).toBe("sticky");
    expect(prop(rowAppCss, "left")).toBe("0");
    const rowHead = z(bodyOf(billing, ROW_HEAD));
    const head = z(bodyOf(billing, HEAD));
    const corner = z(bodyOf(billing, CORNER));
    expect(rowHead).toBe(1);
    expect(head).toBe(2);
    expect(corner).toBe(4);
    expect(corner).toBeGreaterThan(head);
    expect(head).toBeGreaterThan(rowHead);
  });

  it("the caption and the legend are not sticky", () => {
    for (const r of billing.filter((x) => /caption|legend/.test(x.selector))) expect(prop(r.body, "position"), `"${r.selector}"`).toBeUndefined();
  });

  it("a sticky cell paints over what scrolls under it: the grounds are the opaque tokens, and no rule of this file makes one see-through", () => {
    // The grounds come from app.css (th: --surface, the row header: --bg); both are hex colours in every look.
    expect(prop(bodyOf(app, "th"), "background")).toBe("var(--surface)");
    expect(prop(bodyOf(app, 'tbody th[scope="row"]'), "background")).toBe("var(--bg)");
    const sticky = billing.filter(
      (r) => /(^|[\s,])(table\.billing\b.*\bth\b|.*\.bill-nomatch)/.test(r.selector) || /position:\s*sticky/.test(r.body),
    );
    expect(sticky.length).toBeGreaterThan(2); // the guard can see them
    for (const r of sticky) {
      expect(r.body, `"${r.selector}"`).not.toMatch(/background(-color)?\s*:\s*(transparent|rgba|hsla|color-mix|[^;]*\/\s*[\d.]+%?\s*\))/);
      expect(r.body, `"${r.selector}"`).not.toMatch(/\bopacity\s*:/);
    }
  });
});

// w20: the month bar and the controls bar share one row when the page is wide enough. .billing-main is a size container (its inline size only: a
// plain `size` would collapse its height), and ONE @container block switches the toolbar from stacked (the default, as before w20) to a row and
// picks the smaller chrome value for the table box. The numbers behind the threshold are in the plan (docs/superpowers/plans/2026-10-18-w20-billing-toolbar.md, F2).
describe("the toolbar (w20)", () => {
  const MAIN = ".billing-page .billing-main";
  const TOOLBAR = ".billing-page .billing-toolbar";
  const BAR = ".billing-page .billing-bar";
  const TOOLS = ".billing-page .billing-tools";
  const COUNT = ".billing-page .tools-count";
  const containerRules = billing.filter((r) => r.at.some((a) => a.startsWith("@container")));
  const containerAt = [...new Set(containerRules.flatMap((r) => r.at.filter((a) => a.startsWith("@container"))))];
  const inWide = (selector: string) => {
    const found = containerRules.filter((r) => r.selector === selector);
    expect(found, `exactly one @container rule for "${selector}"`).toHaveLength(1);
    expect(found[0].at, `"${selector}"`).toEqual([LAYER, containerAt[0]]);
    return found[0].body;
  };
  const indexOfRule = (selector: string, at: string[] = [LAYER]) =>
    billing.findIndex((r) => r.selector === selector && r.at.length === at.length && r.at.every((a, i) => a === at[i]));

  it("the wrapper under the page header is a size container on its inline size only (a plain `size`, the shorthand or `contain` would collapse its height)", () => {
    const body = bodyOf(billing, MAIN);
    expect(prop(body, "container-type")).toBe("inline-size");
    expect(body).not.toMatch(/(^|[;\s])(container-type:\s*(size|normal)|contain:|container:)/); // the guard of tree-move.css.test.ts; `size` would match inside `inline-size` only without the anchor
  });

  it("the toolbar is a column of the two bars, 16px apart, 12px above the table (34 + 16 + 34 + 12 is the 96px the stacked page always had); the bars have no margin of their own", () => {
    const body = bodyOf(billing, TOOLBAR);
    expect(prop(body, "display")).toBe("flex");
    expect(prop(body, "flex-direction")).toBe("column");
    expect(prop(body, "gap")).toBe("16px");
    expect(prop(body, "margin")).toBe("0 0 12px");
    expect(prop(bodyOf(billing, BAR), "margin")).toBe("0");
    expect(prop(bodyOf(billing, TOOLS), "margin")).toBe("0");
    expect(prop(bodyOf(billing, TOOLS), "flex-wrap")).toBe("wrap"); // the table group still wraps (measured: nowrap shrinks every item and wraps the Show levels label)
  });

  it("there is exactly ONE container query in the file: (min-width: Nrem) with N at least 98, the room the two groups need (1558px, valid only with the filter's 10rem basis; w20.spec.ts measures the real switch at 99rem)", () => {
    expect(containerAt).toHaveLength(1);
    const m = /^@container \(min-width: ([\d.]+)rem\)$/.exec(containerAt[0]);
    expect(m, "an unnamed (min-width: Nrem) query").not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(98);
    for (const r of containerRules) expect(r.at, `"${r.selector}"`).toEqual([LAYER, containerAt[0]]);
  });

  it("in the wide layout the toolbar is one row: the month group keeps its width on the left, the table group takes the rest and is right-aligned, all on one centre line", () => {
    const toolbar = inWide(TOOLBAR);
    expect(prop(toolbar, "flex-direction")).toBe("row");
    expect(prop(toolbar, "align-items")).toBe("center");
    expect(prop(toolbar, "gap")).toBe("16px");
    expect(prop(toolbar, "margin-bottom")).toBe("16px"); // no second row, so the 12px that sat under the controls bar is the page's 16px under the one row
    expect(prop(inWide(`${TOOLBAR} > .billing-bar`), "flex")).toBe("none");
    const tools = inWide(`${TOOLBAR} > .billing-tools`);
    expect(prop(tools, "flex")).toBe("1 1 0");
    expect(prop(tools, "min-width")).toBe("0");
    expect(prop(tools, "justify-content")).toBe("flex-end");
  });

  it("inside the block the filter drops to its 10rem minimum and the group still wraps (review Critical: with the default 14rem basis the group needs 725px, the threshold is wrong and the tools wrap to two lines up to about 1622px)", () => {
    expect(prop(inWide(`${TOOLBAR} .tools-filter`), "flex-basis")).toBe("10rem");
    const inBlock = containerRules.map((r) => r.body).join(";");
    expect(inBlock).not.toMatch(/flex-wrap/); // wrap stays (the base rule); `nowrap` was measured worse
    expect(prop(bodyOf(billing, ".billing-page .tools-filter"), "min-width")).toBe("10rem");
    expect(prop(bodyOf(billing, ".billing-page .tools-filter"), "flex")).toBe("1 1 14rem"); // the stacked default is untouched
  });

  it("in the wide layout the table box is taller by the 46px the missing second row gave back: --billing-chrome-wide, one per banner variant", () => {
    expect(prop(inWide(BOX), "max-height")).toMatch(/^max\(20rem,\s*calc\(100dvh\s*-\s*var\(--billing-chrome-wide(?:,\s*[\d.]+rem)?\)\)\)$/);
    expect(inWide(BOX)).not.toMatch(/overflow|scroll-padding/); // only the height changes; the base rule keeps the rest
    const sets: [string, number][] = [
      [".billing-page", 15.8],
      [".billing-page:has(.closed-box)", 22.5],
      [".billing-page:has(.banner-warn)", 19.6],
      [".billing-page:has(.closed-box):has(.banner-warn)", 26.3],
    ];
    const wides: number[] = [];
    for (const [sel] of sets) {
      const stacked = rem(bodyOf(billing, sel), "--billing-chrome");
      const wide = rem(bodyOf(billing, sel), "--billing-chrome-wide");
      expect(stacked - wide, `"${sel}": the wide value sits 2.5 to 3.2rem under the stacked one`).toBeGreaterThanOrEqual(2.5);
      expect(stacked - wide, `"${sel}"`).toBeLessThanOrEqual(3.2);
      wides.push(wide);
    }
    // closed and warn each add to the open value, and both add both, like the stacked set
    expect(wides[1]).toBeGreaterThan(wides[0]);
    expect(wides[2]).toBeGreaterThan(wides[0]);
    expect(wides[3]).toBeGreaterThan(Math.max(wides[1], wides[2]));
  });

  it("source order decides (the wide rules have the base rules' weight): base toolbar rules first, then the container block, and the short-window `max-height: none` after it", () => {
    const base = indexOfRule(BOX);
    const firstWide = billing.findIndex((r) => r.at.some((a) => a.startsWith("@container")));
    const media = indexOfRule(BOX, [LAYER, MEDIA]);
    expect(base).toBeGreaterThanOrEqual(0);
    expect(base).toBeLessThan(firstWide);
    expect(firstWide).toBeLessThan(media);
    expect(indexOfRule(TOOLBAR)).toBeLessThan(firstWide);
    expect(indexOfRule(BAR)).toBeLessThan(firstWide);
    // the rules of the block stay together
    const idx = billing.map((r, i) => (r.at.some((a) => a.startsWith("@container")) ? i : -1)).filter((i) => i >= 0);
    expect(idx[idx.length - 1] - idx[0]).toBe(idx.length - 1);
  });

  it("the rows line is the last item of the caption's row, sticky at the right of the visible box (the caption is as wide as the table, which scrolls sideways), on the page's ground, one --fs-xs line", () => {
    const row = bodyOf(billing, ".billing-page .cap-row");
    expect(prop(row, "display")).toBe("flex");
    expect(prop(row, "justify-content")).toBe("space-between");
    expect(prop(row, "align-items")).toBe("baseline");
    const count = bodyOf(billing, COUNT);
    expect(prop(count, "position")).toBe("sticky");
    expect(prop(count, "right")).toBe("14px"); // the caption's own right padding
    expect(prop(count, "background")).toBe("var(--bg)");
    expect(prop(count, "font-size")).toBe("var(--fs-xs)"); // --fs-sm made the caption 39px tall instead of 38
    expect(prop(count, "white-space")).toBe("nowrap");
    expect(count).not.toMatch(/min-width|margin-left|color:/); // the 28ch room and the bar's grey are gone: the caption's muted colour applies
  });
});
