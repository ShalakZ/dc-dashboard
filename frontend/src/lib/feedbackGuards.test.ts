import { readdirSync, readFileSync, statSync } from "node:fs";
import { stripComments } from "../test/cssTools";

// Source guards for the W7k feedback rules. Each one reads the sources as text (the same way app.css.test.ts reads the stylesheets), so a
// later change that brings back a pattern this wave removed fails here, whoever makes it. Every guard also runs on a fixture that
// contains the pattern, to prove it can fail.

const SRC = "src"; // vitest runs from the frontend directory

/** Every file under `dir` whose name ends with one of `suffixes`, as [path, text] (the frontend has no @types/node: see src/test/nodeFs.d.ts). */
function sources(dir: string, suffixes: string[]): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const name of readdirSync(dir)) {
    const path = `${dir}/${name}`;
    if (statSync(path).isDirectory()) found.push(...sources(path, suffixes));
    else if (suffixes.some((suffix) => name.endsWith(suffix))) found.push([path, readFileSync(path, "utf8")]);
  }
  return found;
}

/** Production components and pages: .tsx without the tests and the test helpers (src/test). */
const components = () => sources(SRC, [".tsx"]).filter(([path]) => !path.endsWith(".test.tsx") && !path.startsWith("src/test/"));
const stylesheets = () => sources(SRC, [".css"]);

describe("no loose 'saved' note next to a form (the Save button is the confirmation)", () => {
  /**
   * What the old notes looked like: `{put.isSuccess && <span …> saved</span>}`, the class `muted saved`, a JSX text that is exactly
   * "saved" or "Saved.", and the same two words as a string literal handed to a setter (Storage's setNote("Saved.")).
   * The word "Saved" alone is the SaveButton's own face, so it is not matched.
   */
  const PATTERNS: Array<[string, RegExp]> = [
    ["a success flag that renders a span", /isSuccess\s*&&\s*<span/],
    ["the class `muted saved`", /className="muted saved"/],
    ["a JSX text that is exactly saved", />\s*saved\s*</],
    ["a JSX text that is exactly Saved.", />\s*Saved\.\s*</],
    ['the literal "Saved."', /["'`]Saved\.["'`]/],
    ['the literal " saved"', /["'`] saved["'`]/],
  ];
  const violations = (text: string) => PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);

  it("the guard can fail: each old pattern is found in a fixture, and the SaveButton's own words are not", () => {
    const fixtures: Array<[string, string]> = [
      ["a success flag that renders a span", "{put.isSuccess && <span className=\"x\">ok</span>}"],
      ["the class `muted saved`", '<span className="muted saved">'],
      ["a JSX text that is exactly saved", '<span className="muted"> saved</span>'],
      ["a JSX text that is exactly Saved.", "<p>Saved.</p>"],
      ['the literal "Saved."', 'setNote("Saved.")'],
      ['the literal " saved"', "const t = \" saved\";"],
    ];
    for (const [name, text] of fixtures) expect(violations(text), text).toContain(name);
    expect(violations('<span><Icon name="check" />Saved</span>')).toEqual([]);
    expect(violations('<span className="save-face">Saving…</span>')).toEqual([]);
  });

  it("no component or page has one", () => {
    const files = components();
    expect(files.length).toBeGreaterThan(50); // it really read the tree
    const found = files.flatMap(([path, text]) => violations(text).map((name) => `${path}: ${name}`));
    expect(found).toEqual([]);
  });

  it("no stylesheet has a .saved selector (the old note's rule)", () => {
    const SAVED = /\.saved(?![\w-])/;
    expect(SAVED.test(".tariffs-page .inline-form .saved { align-self: center; }")).toBe(true); // the guard can fail
    expect(SAVED.test('button.save-btn[data-phase="saved"] { color: red; }')).toBe(false);
    const files = stylesheets();
    expect(files.length).toBeGreaterThan(5);
    const found = files.filter(([, text]) => SAVED.test(stripComments(text))).map(([path]) => path);
    expect(found).toEqual([]);
  });
});
