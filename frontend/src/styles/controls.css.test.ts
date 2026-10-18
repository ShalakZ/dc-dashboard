import { readdirSync, readFileSync, statSync } from "node:fs";
import { parseRules, stripComments, type Rule } from "../test/cssTools";

// W18: one control-height scale. Every control with a visible edge (a button, an input, a select, the Find field, the top-bar chip, a filter chip, a
// segmented button, a status chip in a row of controls) is --ctl-h tall, so two of them on one line are level. The borderless text buttons are
// --ctl-h-sm, an icon button and the small button of a banner, a toast or an audit entry are --ctl-h-xs, a status chip in a line of text or a table cell
// is --chip-h. Vitest has `css: false`, so the stylesheets are read as text (the frontend directory is the working directory).
const read = (file: string) => parseRules(stripComments(readFileSync(file, "utf8")));
const app = read("src/app.css");

const cssFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = `${dir}/${name}`;
    return statSync(path).isDirectory() ? cssFiles(path) : path.endsWith(".css") ? [path] : [];
  });
const everyRule: Array<{ file: string; rule: Rule }> = cssFiles("src").flatMap((file) => read(file).map((rule) => ({ file, rule })));

const only = (selector: string) => {
  const found = app.filter((r) => r.selector === selector && r.at.every((a) => a.startsWith("@layer"))); // not the ones inside a media query
  expect(found, `exactly one rule for "${selector}" in app.css`).toHaveLength(1);
  return found[0].body;
};
const prop = (body: string, name: string) => new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim();
const inPages = (file: string, selector: string) => {
  const found = read(file).filter((r) => r.selector === selector);
  expect(found, `exactly one rule for "${selector}" in ${file}`).toHaveLength(1);
  return found[0].body;
};

describe("the four heights are tokens, once, in :root", () => {
  const root = app.filter((r) => r.selector === ":root");

  it.each([
    ["--ctl-h", "34px"],
    ["--ctl-h-sm", "30px"],
    ["--ctl-h-xs", "28px"],
    ["--chip-h", "22px"],
  ])("%s is %s", (name, value) => {
    expect(root.filter((r) => new RegExp(`${name}\\s*:`).test(r.body))).toHaveLength(1);
    expect(root[0].body).toMatch(new RegExp(`${name}:\\s*${value}`));
  });

  it("no stylesheet still reads or declares --btn-h (a stale var() is dropped without a word)", () => {
    expect(everyRule.filter(({ rule }) => /--btn-h/.test(rule.body) || /--btn-h/.test(rule.selector)).map(({ file, rule }) => `${file}: ${rule.selector}`)).toEqual([]);
  });
});

describe("the controls with a visible edge are one height", () => {
  it("the base button, input and select read --ctl-h; a textarea keeps its own height (a dialog limits it, see the Close month note box)", () => {
    expect(prop(only("button"), "min-height")).toBe("var(--ctl-h)");
    const field = app.filter((r) => r.selector.includes('input:is(:not([type]), [type="text"]') && r.selector.includes("select, textarea") && !r.selector.includes(":disabled"));
    expect(field, "the base rule of the text fields").toHaveLength(1);
    expect(prop(field[0].body, "min-height")).toBe("var(--ctl-h)");
    expect(prop(only("textarea"), "min-height")).toBe("0");
  });

  it("the top-bar chip is as tall as the Find field beside it, and both are --ctl-h", () => {
    expect(prop(only(".live"), "height")).toBe("var(--ctl-h)");
    expect(prop(only('.qf input[type="search"]'), "height")).toBe("var(--ctl-h)");
  });

  it("a filter chip is --ctl-h (it has an edge and shares a line with buttons and date fields on the Audit page)", () => {
    expect(prop(only(".filter-chip"), "height")).toBe("var(--ctl-h)");
  });

  it("a status chip is --chip-h, and --ctl-h where it stands in a row of controls (the asset header's actions and Billing's month bar)", () => {
    expect(prop(only(".chip"), "height")).toBe("var(--chip-h)");
    const header = only(".page-head > .actions > .chip");
    expect(prop(header, "height")).toBe("var(--ctl-h)");
    expect(prop(header, "padding")).toBe("0 12px");
    const month = inPages("src/styles/pages-billing.css", ".billing-page .month-state .chip");
    expect(prop(month, "height")).toBe("var(--ctl-h)");
    expect(prop(month, "padding")).toBe("0 12px");
    // both come after the plain chip rule, and the row rules outrank it (a child combinator against one class)
    expect(app.findIndex((r) => r.selector === ".page-head > .actions > .chip")).toBeGreaterThan(app.findIndex((r) => r.selector === ".chip"));
  });

  it("the borderless text buttons are --ctl-h-sm, the icon buttons and the small buttons of a banner, a toast and an audit entry --ctl-h-xs", () => {
    expect(prop(only(".quiet"), "min-height")).toBe("var(--ctl-h-sm)");
    expect(prop(only(".danger-quiet"), "min-height")).toBe("var(--ctl-h-sm)");
    const icon = only(".icon-btn");
    expect(prop(icon, "width")).toBe("var(--ctl-h-xs)");
    expect(prop(icon, "height")).toBe("var(--ctl-h-xs)");
    expect(prop(only(".banner .b-act"), "min-height")).toBe("var(--ctl-h-xs)");
    expect(prop(inPages("src/styles/feedback-toasts.css", ".toast-action"), "min-height")).toBe("var(--ctl-h-xs)");
    expect(prop(inPages("src/styles/pages-admin.css", ".audit-entry .copy-btn"), "min-height")).toBe("var(--ctl-h-xs)");
    const spacer = inPages("src/styles/pages-admin.css", ".roles-panel .icon-btn-spacer");
    expect(prop(spacer, "width")).toBe("var(--ctl-h-xs)");
    expect(prop(spacer, "height")).toBe("var(--ctl-h-xs)");
  });

  it("the segmented range buttons, the audit range separator and the trend toolbar's labels follow --ctl-h", () => {
    expect(prop(inPages("src/styles/pages-assets.css", ".range-picker button"), "min-height")).toBe("var(--ctl-h)");
    expect(prop(inPages("src/styles/pages-assets.css", ".trend-frame .trend-bar > span"), "min-height")).toBe("var(--ctl-h)");
    expect(prop(inPages("src/styles/pages-admin.css", ".audit-page .range-sep"), "height")).toBe("var(--ctl-h)");
    expect(prop(inPages("src/styles/pages-billing.css", ".billing-page .billing-tools"), "min-height")).toBe("var(--ctl-h)");
  });

  it("the skeleton of a control draws --ctl-h: the plain block and the Find box", () => {
    expect(prop(only(".sk-block"), "height")).toBe("var(--ctl-h)");
    expect(prop(only(".sk-shell .navbar .sk-find"), "height")).toBe("var(--ctl-h)");
  });
});

describe("nobody patches a control back to the old 38px", () => {
  // The deliberate list: a rule that may still say 38px. It is empty; a 38px field next to a 34px button is the bug W18 removed. Add a selector here,
  // with its reason, only for a box that is not a control (a table cell, a canvas node) and is meant to be 38px.
  const DELIBERATE: string[] = [];
  const old = /(?:^|[;\s])(?:min-)?height\s*:\s*38(?:px)?\s*(?:;|$)/;

  it("no rule in any stylesheet declares height or min-height of 38px, outside the deliberate list", () => {
    const found = everyRule.filter(({ rule }) => old.test(rule.body) && !DELIBERATE.includes(rule.selector));
    expect(found.map(({ file, rule }) => `${file}: ${rule.selector}`)).toEqual([]);
  });

  it("the check can see a patch (it runs on a small example)", () => {
    const sample = parseRules(".a { min-height: 38px; } .b { height: 38px; padding: 0; } .c { padding-right: 38px; } .d { min-height: var(--ctl-h); } .e { line-height: 38px; }");
    expect(sample.filter((r) => old.test(r.body)).map((r) => r.selector)).toEqual([".a", ".b"]);
  });
});
