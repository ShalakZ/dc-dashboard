import { readFileSync } from "node:fs";
import { parseRules, stripComments } from "../test/cssTools";

// (w36) Map by shape joins Details (and Move...) in the source card's one 20px button row. graph-nodes.css.test.ts pins the six lines at 134px against SOURCE_H: the new button may add no
// height, no line and no wrap. Its width is its words (11px, padding 0 6px by `.gnode button`), so it names no width, padding, margin or colour of its own.
const rules = parseRules(stripComments(readFileSync("src/styles/graph-source-card.css", "utf8")));
const card = (selector: string) => {
  const found = rules.filter((r) => r.selector === selector && r.at.join(" > ") === "@layer w6");
  expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
  return found[0].body;
};

describe("the Map by shape button of the source card (w36, graph-source-card.css)", () => {
  it("is 20px high like Details and Move..., never wraps its words and never shrinks, and the row keeps its single 20px line", () => {
    const body = card(".gsrc-actions .gsrc-shapes");
    expect(body).toMatch(/(?:^|[;\s])height:\s*20px/);
    expect(body).toMatch(/(?:^|[;\s])white-space:\s*nowrap/);
    expect(body).toMatch(/(?:^|[;\s])flex:\s*none/);
    expect(body).not.toMatch(/color|background|opacity|width|margin|padding/);
    expect(card(".gsrc-actions")).toMatch(/(?:^|[;\s])height:\s*20px/);
    expect(card(".gsrc-actions")).not.toMatch(/wrap/); // a row that wrapped would be a second line
  });
});
