// Helpers for the tests that read a stylesheet as text (app.css.test.ts, themes.css.test.ts): vitest is configured with `css: false`,
// which empties a CSS import.

// The muted greys are the only text on a tinted or white ground that is meant to look faded; WCAG AA asks 4.5:1 for it.
export const AA = 4.5;
export const NON_TEXT = 3; // WCAG 1.4.11: the boundary of a control, a focus ring, an indicator

// Comments go first: one in front of a rule would otherwise become part of its selector.
export const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

export type Rule = { selector: string; body: string; at: string[]; order: number };

/**
 * The style rules of a stylesheet, each with the at-rules it sits in (`@layer w6`, `@media (...)`) and its position.
 * CSS nesting is not used: a `{` after an at-rule header opens a block of rules, any other `{` a declaration block.
 */
export function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  const at: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      const prelude = text.slice(start, i).trim().replace(/\s+/g, " ");
      if (prelude.startsWith("@")) {
        at.push(prelude);
        start = i + 1;
      } else {
        const end = text.indexOf("}", i);
        rules.push({ selector: prelude, body: text.slice(i + 1, end), at: [...at], order: rules.length });
        i = end;
        start = end + 1;
      }
    } else if (text[i] === "}") {
      at.pop();
      start = i + 1;
    }
  }
  return rules;
}

/** The custom properties a declaration block sets, in order. */
export const customProperties = (body: string) =>
  new Map<string, string>([...body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()] as [string, string]));

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
export const luminance = (hex: string) => {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex; // #999 is #999999
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
export const contrast = (fg: string, bg: string) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};
