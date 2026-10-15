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

describe("the message slots of Settings and Storage (W7l)", () => {
  // Settings: a refusal under Save added a line and pushed the cards (+33.6 px); Storage: the note Set as default wrapped to two lines and grew
  // both cards (+53.2 px at 1440). Both feet now keep a slot for it. The slots restate nothing: the page's 14px/1.4 is what the p.error and p.muted
  // inside them use, so the slot's 1lh is the message's own line.
  const settingsSlot = () => plain(admin, ".settings-page .form-status");
  const storageSlot = () => plain(admin, ".storage-page .retention-status");

  it("Settings: .form-status reserves one line, in the foot's grid, at the page's own size (no font-size or line-height of its own)", () => {
    expect(px(settingsSlot(), "min-height")).toBe("1lh");
    expect(px(settingsSlot(), "font-size")).toBeUndefined();
    expect(px(settingsSlot(), "line-height")).toBeUndefined();
    expect(px(plain(admin, ".settings-page .form-foot"), "display")).toBe("grid");
  });

  it("Storage: .retention-status reserves at least one line and is a one-cell grid in which the real message and a hidden copy of the longest one overlap", () => {
    expect(px(storageSlot(), "min-height")).toBe("1lh");
    expect(px(storageSlot(), "display")).toBe("grid");
    expect(px(storageSlot(), "font-size")).toBeUndefined();
    expect(px(storageSlot(), "line-height")).toBeUndefined();
    const ghost = plain(admin, ".storage-page .retention-status::before");
    expect(px(ghost, "content")).toBe("attr(data-reserve)");
    expect(px(ghost, "visibility")).toBe("hidden"); // takes room, shows nothing, is not read out
    expect(px(ghost, "grid-area")).toBe("1 / 1");
    expect(px(plain(admin, ".storage-page .retention-status > p"), "grid-area")).toBe("1 / 1");
    expect(px(plain(admin, ".storage-page .retention-foot"), "display")).toBe("grid");
  });

  it("the messages inside them are set in the page's own size: nothing on these two pages gives a paragraph or an error a font-size or line-height", () => {
    const own = admin.filter((r) => /\.(settings|storage)-page/.test(r.selector) && /(^|[\s,>])(p|\.error|\.muted)(?![\w-])/.test(r.selector.replace(/::?[\w-]+/g, "")));
    expect(own.length).toBeGreaterThan(0); // the guard can see them
    for (const r of own) {
      expect(px(r.body, "font-size"), `"${r.selector}" sets no font-size`).toBeUndefined();
      expect(px(r.body, "line-height"), `"${r.selector}" sets no line-height`).toBeUndefined();
    }
    const error = app.find((r) => r.selector === ".error" && r.at.length === 1)!;
    expect(px(error.body, "font-size")).toBeUndefined();
    expect(px(app.find((r) => r.selector === ".muted" && r.at.length === 1)!.body, "font-size")).toBeUndefined();
    expect(px(app.find((r) => r.selector === "body")!.body, "font")).toMatch(/^14px\/1\.4\b/);
  });
});

describe("the closed month's line about today's figures (W11)", () => {
  it("keeps one line of its own size when it is empty, so a poll answer that fills or empties it moves nothing", () => {
    const body = plain(billing, ".billing-page .live-delta");
    expect(px(body, "min-height")).toBe("1lh");
    expect(px(body, "font-size")).toBe("var(--fs-sm)"); // the 1lh is measured at the size the sentence is set in
    expect(px(body, "line-height")).toBeUndefined();
  });

  it("the count of the note turns into the error colour when it is over the limit, and keeps its place", () => {
    expect(px(plain(billing, ".month-dialog .month-over"), "color")).toBe("var(--crit)");
    expect(px(plain(billing, ".month-dialog .month-count"), "min-height")).toBe("1lh");
  });
});
