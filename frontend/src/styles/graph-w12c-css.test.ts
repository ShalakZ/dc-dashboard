import { readFileSync } from "node:fs";
import { parseRules, stripComments } from "../test/cssTools";

// The three stylesheets of w12c (the shortcuts bubble, the source card, the value card) hold to the same rules as graph-nodes.css: tokens only,
// nothing outside the layer, a class in every selector, no transition on a paint, every animation switched off for reduced motion.
const FILES = ["graph-keys.css", "graph-source-card.css", "graph-value-tip.css"];

describe.each(FILES)("%s (w12c)", (file) => {
  const text = stripComments(readFileSync(`src/styles/${file}`, "utf8"));
  const rules = parseRules(text);

  it("is one @layer w6 block with nothing outside it, no raw colour, and only selectors that name a class", () => {
    expect(text.match(/@layer/g) ?? []).toHaveLength(1);
    expect(text.slice(0, text.search(/@layer\s+w6\s*\{/)).trim()).toBe("");
    expect(text.trim().endsWith("}")).toBe(true);
    for (const r of rules) {
      expect(r.body, `colour in "${r.selector}"`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      if (!r.at.some((a) => a.startsWith("@keyframes"))) expect(r.selector, "a selector names a class").toMatch(/\./);
    }
  });

  it("has no transition, and every animation has its own reduced-motion off switch", () => {
    for (const r of rules) expect(r.body, `transition in "${r.selector}"`).not.toMatch(/transition\s*:/);
    const animated = rules.filter((r) => /animation\s*:/.test(r.body) && !/animation\s*:\s*none/.test(r.body));
    for (const r of animated) {
      const off = rules.some((o) => o.selector === r.selector && o.at.some((a) => /prefers-reduced-motion\s*:\s*reduce/.test(a)) && /animation\s*:\s*none/.test(o.body));
      expect(off, `"${r.selector}" has a reduced-motion rule`).toBe(true);
    }
  });
});
