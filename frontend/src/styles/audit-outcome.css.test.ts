import { readFileSync } from "node:fs";
import { parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheets as text (css: false).
const rules = parseRules(stripComments(readFileSync("src/styles/audit-outcome.css", "utf8")));

describe("the Audit outcome tag's spacing (w32)", () => {
  it("is one rule that spaces the tag from the sentence, in the layer, and leaves the tag itself (shape, colour, height) to tags-events.css", () => {
    expect(rules.map((r) => r.selector)).toEqual([".what-outcome"]);
    expect(rules[0].at).toEqual(["@layer w6"]);
    expect(rules[0].body).toContain("margin-left:");
    expect(rules[0].body).not.toMatch(/background|color|border|radius|height|display|font/);
  });

  it("is imported by main.tsx after the tag stylesheet and app.css (the layer is declared there)", () => {
    const main = readFileSync("src/main.tsx", "utf8");
    expect(main).toContain('import "./styles/audit-outcome.css";');
    expect(main.indexOf('import "./styles/audit-outcome.css"')).toBeGreaterThan(main.indexOf('import "./styles/tags-events.css"'));
    expect(main.indexOf('import "./styles/audit-outcome.css"')).toBeGreaterThan(main.indexOf('import "./app.css"'));
  });
});
