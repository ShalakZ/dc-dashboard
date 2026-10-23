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
