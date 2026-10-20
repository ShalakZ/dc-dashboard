import { takeFragment } from "./takeFragment";

const visit = (url: string) => window.history.replaceState(null, "", url);

describe("takeFragment", () => {
  it("returns the secret, and the address no longer holds it", () => {
    visit("/display#abc_DEF-123");
    expect(takeFragment()).toBe("abc_DEF-123");
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain("#");
    expect(window.location.pathname).toBe("/display");
  });

  it("always calls history.replaceState(null, '', '/display'), also with no fragment and from /display/", () => {
    const calls: unknown[][] = [];
    const original = window.history.replaceState.bind(window.history);
    vi.spyOn(window.history, "replaceState").mockImplementation((...args) => {
      calls.push(args);
      original(...args);
    });
    visit("/display/");
    calls.length = 0;
    expect(takeFragment()).toBeNull();
    expect(calls).toEqual([[null, "", "/display"]]);
    expect(window.location.pathname).toBe("/display");
  });

  it("clears an empty fragment (the address ended in a bare #)", () => {
    visit("/display#");
    expect(window.location.href).toContain("#");
    expect(takeFragment()).toBeNull();
    expect(window.location.href).not.toContain("#");
  });

  it("accepts 64 characters and refuses 65 (never a truncated secret), and clears the fragment either way", () => {
    visit(`/display#${"a".repeat(64)}`);
    expect(takeFragment()).toBe("a".repeat(64));
    visit(`/display#${"a".repeat(65)}`);
    expect(takeFragment()).toBeNull();
    expect(window.location.href).not.toContain("#");
  });

  it("refuses anything outside letters, digits, _ and -, and still clears the fragment", () => {
    for (const hash of ["a.b", "a b", "a%20b", "a/b", "a=b", "ä", "a;b"]) {
      visit(`/display#${hash}`);
      expect(takeFragment(), hash).toBeNull();
      expect(window.location.href, hash).not.toContain("#");
    }
  });
});
