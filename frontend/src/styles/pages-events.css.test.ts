import { readFileSync } from "node:fs";
import { parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheets as text (css: false).
const rules = parseRules(stripComments(readFileSync("src/styles/pages-events.css", "utf8")));
/** A selector list split at its top-level commas (a comma inside :is(...) stays in its part). */
function parts(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of selector) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  return [...out, current.trim()];
}

describe("the System events stylesheet (w32)", () => {
  it("has rules, and every one is in @layer w6 (app.css.test.ts also holds the one-layer shape and the raw-colour check for the file)", () => {
    expect(rules.length).toBeGreaterThan(20);
    for (const rule of rules) expect(rule.at[0], rule.selector).toBe("@layer w6");
  });

  it("starts every selector with the page class .events-page or the drawer's .event-entry, so no other page or table is restyled", () => {
    for (const rule of rules) {
      for (const part of parts(rule.selector)) expect(part, rule.selector).toMatch(/^\.(events-page|event-entry)(?![\w-])/);
    }
  });

  it("defines no custom property (no token of its own) and writes no raw colour", () => {
    for (const rule of rules) {
      expect(rule.body, rule.selector).not.toMatch(/(^|;)\s*--[\w-]+\s*:/);
      expect(rule.body, rule.selector).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    }
  });

  it("moves nothing: no transition, no animation and no keyframes, so there is no motion to switch off under reduced motion", () => {
    for (const rule of rules) {
      expect(rule.body, rule.selector).not.toMatch(/\b(transition|animation)\b/);
      expect(rule.at.join(" "), rule.selector).not.toMatch(/keyframes|starting-style/);
    }
  });

  it("draws no pill and no corner over 4 px of its own: a corner is a token, and the severity tag is the shared square one", () => {
    for (const rule of rules) {
      const radius = /border-radius:\s*([^;]+)/.exec(rule.body)?.[1];
      if (radius) expect(radius, rule.selector).toMatch(/^(var\(--radius(-sm)?\)(\s+var\(--radius(-sm)?\)|\s+0)*|0(\s+var\(--radius\))+(\s+0)?|0)$/);
      expect(rule.body, rule.selector).not.toMatch(/border-radius:\s*(9{2,}|50%)/);
    }
  });

  it("gives a row of the real table and a row of its skeleton the same height, in ONE rule, so they cannot drift apart", () => {
    const rule = rules.find((r) => parts(r.selector).includes(".events-page .events-table td") && parts(r.selector).includes(".events-page .events-skeleton td"));
    expect(rule, "one rule for both").toBeDefined();
    expect(rule!.body).toMatch(/height:\s*60px/);
  });

  it("does not name the shared severity tag or the audit page's classes (a class written bare in one page file may not be named in another)", () => {
    const text = rules.map((r) => r.selector).join("\n");
    expect(text).not.toMatch(/\.ev-tag|\.audit-|\.ev-tile/);
  });
});

describe("main.tsx (w32 page stylesheet)", () => {
  it("imports the page stylesheet after app.css (its layer is declared there)", () => {
    const main = readFileSync("src/main.tsx", "utf8");
    expect(main).toContain('import "./styles/pages-events.css";');
    expect(main.indexOf('import "./styles/pages-events.css"')).toBeGreaterThan(main.indexOf('import "./app.css"'));
  });
});
