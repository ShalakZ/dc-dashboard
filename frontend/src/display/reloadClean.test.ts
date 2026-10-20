import { reloadClean } from "./reloadClean";

// jsdom has no navigation, so window.location is stood in for. The real function is the one under test here.
describe("reloadClean", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("replaces the current page with the bare /display, so the history keeps no extra entry and the new document has no fragment", () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { replace });
    reloadClean();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/display");
  });

  it("never throws when the browser refuses (the page then keeps working as it is)", () => {
    vi.stubGlobal("location", {
      replace: () => {
        throw new Error("blocked");
      },
    });
    expect(() => reloadClean()).not.toThrow();
  });
});
