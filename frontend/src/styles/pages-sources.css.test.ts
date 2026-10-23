import { readFileSync } from "node:fs";
import { parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheet as text (css: false).
const rules = parseRules(stripComments(readFileSync("src/styles/pages-sources.css", "utf8")));

describe("the Sources page styles (w34 review)", () => {
  it("the Test result text is bounded to 22 to 44 characters and wraps, so a long Test message never widens the table or squeezes the Name column", () => {
    const found = rules.filter((r) => r.selector === ".table-wrap.dense td > .st.job" && r.at.join(" > ") === "@layer w6");
    expect(found, "exactly one rule for the Test result text").toHaveLength(1);
    const body = found[0].body;
    expect(body).toMatch(/min-width:\s*22ch/);
    expect(body).toMatch(/max-width:\s*44ch/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
    expect(body, "the whole message stays on screen: the owner pastes it back to the developers").not.toMatch(/line-clamp|overflow:\s*hidden|text-overflow|max-height|height/);
  });
});

describe("the Points page styles (w36)", () => {
  const one = (selector: string) => {
    const found = rules.filter((r) => r.selector === selector && r.at.join(" > ") === "@layer w6");
    expect(found, `exactly one rule for ${selector}`).toHaveLength(1);
    return found[0].body;
  };

  it("the line and button under the capped table have a slot of their own, so nothing moves when the line appears, changes or goes (A2)", () => {
    expect(one(".points-cap")).toMatch(/min-height:\s*var\(--ctl-h\)/);
    expect(one(".points-cap")).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });

  it("the button that has nothing left to show waits with aria-disabled, never native disabled", () => {
    expect(one('.points-cap button[aria-disabled="true"]')).toMatch(/cursor:\s*not-allowed/);
  });

  it("the Map by shape link is drawn as a button of the header's height, with tokens only", () => {
    const body = one(".shape-link");
    expect(body).toMatch(/min-height:\s*var\(--ctl-h\)/);
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });
});
