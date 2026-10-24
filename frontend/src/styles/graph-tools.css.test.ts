import { readFileSync } from "node:fs";
import { parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheets as text (css: false).
const rules = parseRules(stripComments(readFileSync("src/styles/graph-tools.css", "utf8")));
const bodyOf = (selector: string) => rules.filter((rule) => rule.selector === selector).map((rule) => rule.body).join(";");

describe("the Find card's options (w36 whole-wave review, Minor 7)", () => {
  it("keeps one line and a 34px row for a canvas match: the label and the context are cut with an ellipsis", () => {
    expect(bodyOf(".graph-find-opt")).toMatch(/min-height:\s*34px/);
    expect(bodyOf(".graph-find-label")).toMatch(/white-space:\s*nowrap/);
    expect(bodyOf(".graph-find-label")).toMatch(/text-overflow:\s*ellipsis/);
    expect(bodyOf(".graph-find-context")).toMatch(/white-space:\s*nowrap/);
  });

  it("lets the search of a large source's tags wrap, and only that row: its label takes the room and breaks, the row keeps the minimum height", () => {
    const label = bodyOf('.graph-find-opt[data-kind="tags"] .graph-find-label');
    expect(label).toMatch(/white-space:\s*normal/);
    expect(label).toMatch(/max-width:\s*none/);
    expect(label).toMatch(/overflow-wrap:\s*anywhere/);
    expect(label).toMatch(/flex:\s*1 1 0/);
    expect(bodyOf('.graph-find-opt[data-kind="tags"] .graph-find-context')).toMatch(/flex:\s*0 0 auto/);
    expect(bodyOf('.graph-find-opt[data-kind="tags"]')).not.toMatch(/\bheight:/); // the row grows with its text; min-height (34px) is the plain row's
    for (const rule of rules) if (/data-kind/.test(rule.selector)) expect(rule.selector, "no other row is restyled").toMatch(/^\.graph-find-opt\[data-kind="tags"\]/);
  });
});
