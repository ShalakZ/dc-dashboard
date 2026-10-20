import { GUIDE_KEY_PREFIX, guideKey, guideSeen, rememberGuide } from "./guideMemory";

describe("the guide's memory", () => {
  it("keys the mark by the version and the account, and gives an account that is not known yet a key of its own", () => {
    expect(guideKey(7)).toBe("dcdash.guide.dashboard.v1:7");
    expect(guideKey(7).startsWith(GUIDE_KEY_PREFIX)).toBe(true);
    expect(guideKey(null)).toBe("dcdash.guide.dashboard.v1:anon");
  });

  it("is unseen until it is remembered, and then seen for that account only", () => {
    expect(guideSeen(1)).toBe(false);
    rememberGuide(1);
    expect(window.localStorage.getItem("dcdash.guide.dashboard.v1:1")).toBe("1");
    expect(guideSeen(1)).toBe(true);
    expect(guideSeen(2)).toBe(false);
    expect(guideSeen(null)).toBe(false);
  });

  it("reads only the value 1 as seen", () => {
    window.localStorage.setItem(guideKey(3), "0");
    expect(guideSeen(3)).toBe(false);
    window.localStorage.setItem(guideKey(3), "yes");
    expect(guideSeen(3)).toBe(false);
  });

  it("never throws when reading is blocked: the guide is simply unseen", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    expect(() => guideSeen(11)).not.toThrow();
    expect(guideSeen(11)).toBe(false);
  });

  it("never throws when writing is blocked, and then remembers for the rest of the page's life", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    expect(guideSeen(901)).toBe(false);
    expect(() => rememberGuide(901)).not.toThrow();
    expect(guideSeen(901)).toBe(true); // this account 901 is used by this test alone: the memory outlives the test
    expect(guideSeen(902)).toBe(false);
  });
});
