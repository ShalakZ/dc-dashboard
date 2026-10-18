import { readFileSync } from "node:fs";
import { parseRules, stripComments, type Rule } from "../test/cssTools";

// The asset page's header drops its buttons under the title when the pane is narrow (W7o). jsdom has no layout, so the declarations are pinned
// and the widths are checked against the sums they come from; the layout itself was measured in a browser and w7o.spec.ts measures it again.
// vitest runs from the frontend directory and reads the stylesheet as text (css: false).
const pages = parseRules(stripComments(readFileSync("src/styles/pages-assets.css", "utf8")));
const inLayer = (r: Rule) => r.at[0] === "@layer w6";
const px = (query: string) => Number(/max-width:\s*([\d.]+)px/.exec(query)![1]);

describe("the asset page header drops its buttons under the title in a narrow pane (W7o)", () => {
  const head = pages.filter((r) => r.selector === ".asset-page .page-head");
  const plain = pages.filter((r) => r.selector === ".asset-page .page-head > .actions");
  const withChip = pages.filter((r) => r.selector === ".asset-page .page-head:has(> .actions > .chip) > .actions");

  it("the header is a container of its own inline size, and has no other containment (it must stay the block grid it was)", () => {
    expect(head).toHaveLength(1);
    expect(inLayer(head[0])).toBe(true);
    expect(head[0].at).toHaveLength(1);
    expect(head[0].body).toMatch(/container-type:\s*inline-size/);
    expect(head[0].body).not.toMatch(/(^|[;\s])(contain|transform|filter|will-change|position|overflow(-[xy])?)\s*:/);
  });

  it("two container queries move the actions into the title's column, one for every page and a wider one for a page with a chip", () => {
    expect(plain).toHaveLength(1);
    expect(withChip).toHaveLength(1);
    for (const rule of [plain[0], withChip[0]]) {
      expect(rule.at).toHaveLength(2);
      expect(rule.at[0]).toBe("@layer w6");
      expect(rule.at[1]).toMatch(/^@container \(max-width: [\d.]+px\)$/);
      expect(rule.body).toMatch(/grid-column:\s*1\b/);
      expect(rule.body).toMatch(/grid-row:\s*auto/);
      expect(rule.body).toMatch(/justify-content:\s*flex-start/);
    }
  });

  it("the widths are the buttons + the 16px gap + 16rem (256px) for the title column, and the chip's one is the wider", () => {
    const [narrow, chip] = [px(plain[0].at[1]), px(withChip[0].at[1])];
    // Edit, Delete and Add asset are 304px; with the "reconnecting…" chip, the widest the group gets, 449px (measured in the browser in W18, when the chip became
    // as tall as the buttons and took 12px of side padding: 448.6px, was 443px with the 22px chip; Segoe UI is narrower, so a Windows machine has room to spare).
    expect(narrow).toBeGreaterThanOrEqual(304 + 16 + 256);
    expect(chip).toBeGreaterThanOrEqual(449 + 16 + 256);
    expect(chip).toBeGreaterThan(narrow);
    // A few pixels of slack, not a different layout: a threshold far above the sum would drop the buttons for no reason.
    expect(narrow - (304 + 16 + 256)).toBeLessThanOrEqual(10);
    expect(chip - (449 + 16 + 256)).toBeLessThanOrEqual(10);
  });

  it("a page with no chip keeps its buttons beside the title in the 636px pane of a 1024px window with the sidebar minimized (w7i.spec.ts expects the sub line to end before them)", () => {
    expect(px(plain[0].at[1])).toBeLessThan(636 - 20);
  });
});
