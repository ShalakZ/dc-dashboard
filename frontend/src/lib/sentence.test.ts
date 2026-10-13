import { sentence } from "./sentence";

describe("sentence", () => {
  it("turns an API message into a sentence: a capital letter and a full stop", () => {
    expect(sentence("cannot remove the last active administrator")).toBe("Cannot remove the last active administrator.");
    expect(sentence("a role with that name already exists")).toBe("A role with that name already exists.");
  });

  it("leaves a message that already ends a sentence as it is", () => {
    expect(sentence("Role not found.")).toBe("Role not found.");
    expect(sentence("Your role does not allow this.")).toBe("Your role does not allow this.");
    expect(sentence("is that right?")).toBe("Is that right?");
    expect(sentence("stop!")).toBe("Stop!");
  });

  it("ignores spaces round the text and returns nothing for nothing", () => {
    expect(sentence("  role is in use by 2 account(s)  ")).toBe("Role is in use by 2 account(s).");
    expect(sentence("")).toBe("");
    expect(sentence("   ")).toBe("");
  });

  it("reads a formatted validation list as one sentence", () => {
    expect(sentence("name: String should have at most 64 characters")).toBe("Name: String should have at most 64 characters.");
  });
});
