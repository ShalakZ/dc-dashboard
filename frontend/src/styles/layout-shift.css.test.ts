import { readFileSync } from "node:fs";
import { parseRules, stripComments } from "../test/cssTools";

// Two cards used to change height when a message line appeared or went (W7l): the Create user card (a role's description) and the two
// Tariffs add forms (a validation problem or a server refusal). Each now keeps a slot for that line, so the cards stay where they are.
// vitest runs from the frontend directory and reads the stylesheets as text (css: false).
const read = (file: string) => parseRules(stripComments(readFileSync(file, "utf8")));
const admin = read("src/styles/pages-admin.css");
const billing = read("src/styles/pages-billing.css");
const app = read("src/app.css");

// The plain rule of a selector: directly inside the layer, not in @media.
const plain = (rules: ReturnType<typeof read>, selector: string) => {
  const found = rules.filter((r) => r.selector === selector && r.at.length === 1);
  expect(found, `exactly one plain rule for "${selector}"`).toHaveLength(1);
  return found[0].body;
};
const px = (body: string, prop: string) => new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim();

describe("the message slots that keep a card's height (W7l)", () => {
  it("the Create user card's .role-note reserves one line of its own size (min-height: 1lh at --fs-sm)", () => {
    const body = plain(admin, ".form-card .create-user > p.role-note");
    expect(px(body, "min-height")).toBe("1lh");
    expect(px(body, "font-size")).toBe("var(--fs-sm)"); // the 1lh is measured at the size the description is set in
  });

  it("the Tariffs .add-status reserves one line of the errors' own size and weight, as a full line of the form", () => {
    const body = plain(billing, ".tariffs-page .add-status");
    expect(px(body, "min-height")).toBe("1lh");
    expect(px(body, "font-size")).toBe("var(--fs-sm)");
    expect(px(body, "line-height")).toBe("1.4"); // the document's own factor, which the p.error inside inherits
    expect(px(body, "flex")).toBe("0 0 100%");
  });

  it("the errors inside the slot are the same size as the slot, and nothing gives them a line-height of their own", () => {
    const error = plain(billing, ".tariffs-page .inline-form p.error");
    expect(px(error, "font-size")).toBe("var(--fs-sm)");
    expect(px(error, "line-height")).toBeUndefined();
    const everyError = [...admin, ...billing, ...app].filter((r) => /(^|[\s,])p?\.error(?![\w-])/.test(r.selector));
    expect(everyError.length).toBeGreaterThan(1); // the guard can see them
    for (const r of everyError) expect(px(r.body, "line-height"), `"${r.selector}" sets no line-height`).toBeUndefined();
    const documentFont = app.find((r) => r.selector === "body")!;
    expect(px(documentFont.body, "font")).toMatch(/\/1\.4\b/); // the unitless factor the slot restates
  });
});
