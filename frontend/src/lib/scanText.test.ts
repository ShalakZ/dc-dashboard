import { claimedCount, outcomeLabel } from "./scanText";

describe("outcomeLabel", () => {
  it("writes outcomes as words; claimed stays as it is (the end-to-end test looks for it)", () => {
    expect(outcomeLabel("claimed")).toBe("claimed");
    expect(outcomeLabel("needs_credentials")).toBe("needs credentials");
    expect(outcomeLabel("unclaimed")).toBe("unidentified");
  });
  it("shows an outcome it does not know with its underscores turned into spaces", () => {
    expect(outcomeLabel("some_new_outcome")).toBe("some new outcome");
  });
});

describe("claimedCount", () => {
  it("leaves out the sources that rejected the credentials", () => {
    expect(claimedCount({ claimed: 5, needs_credentials: 2 })).toBe(3);
  });
  it("treats a missing counter as zero and never goes negative", () => {
    expect(claimedCount({})).toBe(0);
    expect(claimedCount({ claimed: 1 })).toBe(1);
    expect(claimedCount({ claimed: 1, needs_credentials: 3 })).toBe(0);
  });
});
