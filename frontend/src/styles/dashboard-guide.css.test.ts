import { readFileSync } from "node:fs";
import { parseRules, stripComments } from "../test/cssTools";

// The guide's and the viewer header's stylesheet (w27). The layer, the tokens-only colours and the clashes are guarded for every page file by app.css.test.ts;
// these are the rules of the header itself: it must not overflow at 1024 px with the sidebar minimised or expanded, a long name and a focus link, and nothing
// may be measured by script to get there (LESSONS front end 10): the widths are reserved here.
const css = stripComments(readFileSync("src/styles/dashboard-guide.css", "utf8"));
const rules = parseRules(css);
const read = (file: string) => parseRules(stripComments(readFileSync(`src/${file}`, "utf8")));
const app = read("app.css");
const focusHeader = read("styles/focus-header.css");
const body = (selector: string, from = rules) => {
  const found = from.filter((r) => r.selector === selector);
  expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
  return found[0].body;
};
const prop = (text: string, name: string) => new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+)`).exec(text)?.[1].trim();

describe("the viewer's header does not overflow", () => {
  it("is a row that wraps, so what does not fit goes to the next line", () => {
    expect(prop(body(".row", app), "flex-wrap")).toBe("wrap");
  });

  it("lets the title shrink and break inside a word, so a 100-character name with no space cannot push the controls out", () => {
    const title = body(".dash-title");
    expect(prop(title, "min-width")).toBe("0");
    expect(prop(title, "max-width")).toBe("100%");
    expect(prop(title, "overflow-wrap")).toBe("anywhere");
  });

  it("keeps the focus link to one line of at most 22rem with an ellipsis (focus-header.css), so a long asset name cannot widen the row", () => {
    const link = body(".focus-open", focusHeader);
    expect(prop(link, "max-width")).toBe("min(100%, 22rem)");
    expect(prop(link, "text-overflow")).toBe("ellipsis");
    expect(prop(link, "white-space")).toBe("nowrap");
  });

  it("reserves the room of 'Updated 00:00' (13 characters, tabular digits) so the time appearing or changing moves nothing", () => {
    const slot = body(".dash-updated");
    expect(prop(slot, "min-width")).toBe("13ch");
    expect(prop(slot, "font-variant-numeric")).toBe("tabular-nums");
    expect(prop(slot, "white-space")).toBe("nowrap");
  });

  it("moves the time and Refresh as one pair: it does not shrink and is not split", () => {
    const pair = body(".dash-fresh");
    expect(prop(pair, "display")).toBe("inline-flex");
    expect(prop(pair, "flex")).toBe("none");
  });

  it("dims the previous time while the next answer is pending, without moving it", () => {
    const wait = body(".dash-updated-wait");
    expect(prop(wait, "opacity")).toBeDefined();
    expect(wait).not.toMatch(/width|display|position|margin|padding/);
  });

  it("makes a waiting Refresh look idle on hover too (aria-disabled, so it keeps the focus the click gave it)", () => {
    const rule = rules.find((r) => r.selector.includes('button[aria-disabled="true"]:hover'));
    expect(rule, "a hover rule for the waiting Refresh").toBeDefined();
    expect(rule!.body).toMatch(/cursor:\s*not-allowed/);
  });
});

describe("the guide panel", () => {
  it("is a bordered box on the surface token, in tokens only", () => {
    const panel = body(".dash-guide");
    expect(prop(panel, "background")).toBe("var(--surface)");
    expect(prop(panel, "border")).toBe("1px solid var(--border)");
    expect(prop(panel, "border-radius")).toBe("var(--radius)");
  });

  it("has no pill, no italic, no monospace and no gradient anywhere", () => {
    expect(css).not.toMatch(/border-radius:\s*(999|9999|50%|100%)/);
    expect(css).not.toMatch(/font-style:\s*italic|monospace|gradient\(/);
  });
});
