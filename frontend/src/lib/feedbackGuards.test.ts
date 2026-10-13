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

describe("no browser confirmation box anywhere (every delete goes through the styled dialog)", () => {
  /** Block comments and line comments out (a `//` right after a colon or a quote is part of a URL or a string, not a comment). */
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  /**
   * `window.confirm(` and a bare `confirm(`. A word character before the name keeps `onConfirm(`, `useConfirm(` and the like out, a dot
   * before it keeps `foo.confirm(` out unless it is `window.`, and `?confirm=true` (the API's query flag) has no parenthesis.
   */
  const BROWSER_BOX = /(?<![\w$.])(?:window\.)?confirm\s*\(/;
  const production = () => sources(SRC, [".ts", ".tsx"]).filter(([path]) => !/\.test\.tsx?$/.test(path) && !path.startsWith("src/test/") && !path.endsWith(".d.ts"));

  it("the guard can fail: it finds both spellings in a fixture, and not the look-alikes", () => {
    expect(BROWSER_BOX.test(code("if (!window.confirm(`Delete ${x}?`)) return;"))).toBe(true);
    expect(BROWSER_BOX.test(code("if (!confirm('Sure?')) return;"))).toBe(true);
    expect(BROWSER_BOX.test(code("const ok = await confirm({ title })"))).toBe(true); // the name belongs to the browser: a hook's result is named ask
    expect(BROWSER_BOX.test(code("onConfirm(seen); const [ask, dialog] = useConfirm(); api.del(`/api/a/1?confirm=true`)"))).toBe(false);
    expect(BROWSER_BOX.test(code("// the old window.confirm( is gone\n/* confirm( */ const a = 1;"))).toBe(false);
  });

  it("no component, page, hook or helper of src calls it", () => {
    const files = production();
    expect(files.length).toBeGreaterThan(100); // it really read the tree
    const found = files.filter(([, text]) => BROWSER_BOX.test(code(text))).map(([path]) => path);
    expect(found).toEqual([]);
  });
});

describe("one feedback per action (a form that saves in place has the Save button; a toast is for actions with no confirming control)", () => {
  const imports = (text: string, name: string) => new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(text);
  /** Both a SaveButton and a toast in one file is two feedbacks for one save, unless the file holds two different forms. */
  const both = (text: string) => imports(text, "SaveButton") && imports(text, "useToast");
  /** Files that hold two different forms: the one with a SaveButton does not toast; the other form does. Add a line only with the reason. */
  const ALLOWED_BOTH: Record<string, string> = {
    "src/pages/TariffsPage.tsx": "the Currency card saves in place (SaveButton, no toast); the Add rate form clears its fields and toasts; the rate delete toasts",
  };

  it("the guard can fail: a file with both imports is found, a file with one is not", () => {
    const save = 'import { SaveButton } from "../components/SaveButton";';
    const toast = 'import { useToast } from "../components/Toasts";';
    expect(both(`${save}\n${toast}`)).toBe(true);
    expect(both(`${toast}\nimport { SaveButton, type SaveState } from "../components/SaveButton";`)).toBe(true);
    expect(both(save)).toBe(false);
    expect(both(toast)).toBe(false);
    expect(both('// SaveButton and useToast are named here only in a comment')).toBe(false);
  });

  it("no file imports both SaveButton and useToast, except the one that holds two different forms", () => {
    const files = components();
    expect(files.length).toBeGreaterThan(50);
    const found = files.filter(([, text]) => both(text)).map(([path]) => path).sort();
    expect(found).toEqual(Object.keys(ALLOWED_BOTH).sort()); // also fails when an allow-list entry is stale
    // The two pages that were converted in this wave must pass without an allow-list.
    expect(found).not.toContain("src/pages/SettingsPage.tsx");
    expect(found).not.toContain("src/pages/StoragePage.tsx");
  });

  it("the password page confirms with a toast only: no success flag and no success paragraph in it", () => {
    const SUCCESS = /isSuccess|className="form-ok"/;
    expect(SUCCESS.test("{change.isSuccess && (<p className=\"form-ok\">Password changed.</p>)}")).toBe(true); // the guard can fail
    expect(SUCCESS.test("toast.success(\"Password changed. Other sessions were signed out.\")")).toBe(false);
    const page = readFileSync(`${SRC}/pages/PasswordPage.tsx`, "utf8");
    expect(page).toContain("useToast");
    expect(SUCCESS.test(page)).toBe(false);
    // and the rule that styled it is gone from every stylesheet
    expect(stylesheets().filter(([, css]) => css.includes(".form-ok")).map(([path]) => path)).toEqual([]);
  });
});
