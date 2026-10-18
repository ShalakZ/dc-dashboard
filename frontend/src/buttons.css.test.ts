import { readdirSync, readFileSync } from "node:fs";
import { parseRules, stripComments, type Rule } from "./test/cssTools";

// W7o: one button height. Add asset, Edit and the labelled Delete in a page header are the same family: they all take their height from the
// base `button` rule, which reads the --ctl-h token (W18 renamed it from --btn-h), and nothing sizes them one by one. Vitest has `css: false`, so the files are read as text.
const read = (file: string) => parseRules(stripComments(readFileSync(file, "utf8")));
const app = read("src/app.css");
const pages = readdirSync("src/styles").filter((f) => f.endsWith(".css")).map((f) => ({ file: `styles/${f}`, rules: read(`src/styles/${f}`) }));
const everyRule: Array<{ file: string; rule: Rule }> = [
  ...app.map((rule) => ({ file: "app.css", rule })),
  ...pages.flatMap((p) => p.rules.map((rule) => ({ file: p.file, rule }))),
];

const only = (selector: string) => {
  const found = app.filter((r) => r.selector === selector);
  expect(found, `exactly one rule for "${selector}" in app.css`).toHaveLength(1);
  return found[0];
};
const sizes = (body: string) => /(?:^|[;\s])(?:min-|max-)?(?:height|width)\s*:/.test(body);
const parts = (selector: string) => selector.split(",").map((part) => part.trim());

describe("the header buttons share one height (W7o)", () => {
  it("--ctl-h is 34px, once, in :root", () => {
    const root = app.filter((r) => r.selector === ":root");
    expect(root[0].body).toMatch(/--ctl-h:\s*34px/);
    expect(root.filter((r) => /--ctl-h\s*:/.test(r.body))).toHaveLength(1);
  });

  it("the base button takes its minimum height from the token, and never a fixed height that would pin it", () => {
    const base = only("button");
    expect(base.body).toMatch(/min-height:\s*var\(--ctl-h\)/);
    expect(base.body).not.toMatch(/(?:^|[;\s])height\s*:/);
    expect(base.body).not.toMatch(/min-height:\s*\d/);
  });

  it("the labelled Delete is the base button in the critical colours: it states no size of its own, so it is as tall as Add asset and Edit", () => {
    const labelled = only(".trash-btn-labelled");
    expect(app.indexOf(labelled)).toBeGreaterThan(app.indexOf(only("button")));
    expect(labelled.at.some((a) => a.startsWith("@layer"))).toBe(true);
    expect(labelled.body).not.toMatch(/(?:^|[;\s])(?:min-)?height\s*:/);
    expect(labelled.body).toMatch(/color:\s*var\(--crit\)/);
    expect(labelled.body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  it("no rule in any stylesheet sizes a page header's buttons (a header button is as tall as every other button)", () => {
    const sized = everyRule.filter(({ rule }) => parts(rule.selector).some((p) => /\.page-head\b.*\bbutton\b|\.page-head\b.*\.actions\b.*\.(?:primary|trash-btn|icon-btn)\b/.test(p)) && sizes(rule.body));
    expect(sized.map(({ file, rule }) => `${file}: ${rule.selector}`)).toEqual([]);
  });

  it("the compact icon buttons of a table row get their size from .icon-btn alone: no rule gives the bin or the menu button a size of its own", () => {
    // the bin and the three-dot button of one row are both .icon-btn (--ctl-h-xs, 28px); a width or height on one of them would make the pair unequal
    const offenders = everyRule.filter(({ rule }) => parts(rule.selector).some((p) => /\.(?:trash-btn|row-menu-btn)(?![\w-])(?!.*\.lid)(?!\s+svg)/.test(p)) && sizes(rule.body));
    expect(offenders.map(({ file, rule }) => `${file}: ${rule.selector}`)).toEqual([]);
    expect(only(".icon-btn").body).toMatch(/width:\s*var\(--ctl-h-xs\);\s*height:\s*var\(--ctl-h-xs\)/);
  });

  it("the guard can see a clash (the checks run on a small example)", () => {
    const sample = parseRules(".page-head .actions .trash-btn { width: 34px; } .x .row-menu-btn { height: 30px; } .ok .trash-btn:hover { color: red; }");
    expect(sample.filter((r) => sizes(r.body)).map((r) => r.selector)).toEqual([".page-head .actions .trash-btn", ".x .row-menu-btn"]);
    expect(sizes("min-height: var(--ctl-h); padding: 0 14px;")).toBe(true);
    expect(sizes("padding: 0 14px; line-height: 1.4;")).toBe(false);
  });
});
