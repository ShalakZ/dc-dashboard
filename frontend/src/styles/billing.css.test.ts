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
