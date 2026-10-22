import { readFileSync } from "node:fs";
import { parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheets as text (css: false); jsdom has no layout, so the declarations are pinned here.
const rules = parseRules(stripComments(readFileSync("src/styles/storage-events.css", "utf8")));
const plain = (selector: string) => {
  const found = rules.filter((r) => r.selector === selector && r.at.join(" > ") === "@layer w6");
  expect(found, `exactly one plain rule for "${selector}"`).toHaveLength(1);
  return found[0].body;
};

describe("the Change... dialog of the Storage page's System events card (w32)", () => {
  it("writes only selectors under its own form class, all in the layer, so no other page file is restyled", () => {
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.at, rule.selector).toEqual(["@layer w6"]);
      for (const part of rule.selector.split(",").map((p) => p.trim())) expect(part, rule.selector).toMatch(/^\.storage-events-dialog\b/);
    }
  });

  it("keeps a message slot three lines tall from the start, so the question or a refusal arriving moves nothing", () => {
    expect(plain(".storage-events-dialog .storage-events-slot")).toMatch(/min-height:\s*3lh/);
  });

  it("makes a waiting button look disabled by aria-disabled, never by a rule on :disabled (the pressed button keeps the focus)", () => {
    const waiting = rules.filter((r) => r.selector.includes('[aria-disabled="true"]'));
    expect(waiting.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule.selector).not.toContain(":disabled");
  });

  it("is imported by main.tsx after app.css (its layer is declared there)", () => {
    const main = readFileSync("src/main.tsx", "utf8");
    expect(main).toContain('import "./styles/storage-events.css";');
    expect(main.indexOf('import "./styles/storage-events.css"')).toBeGreaterThan(main.indexOf('import "./app.css"'));
  });
});
