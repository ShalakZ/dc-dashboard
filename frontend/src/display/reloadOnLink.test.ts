import { reloadOnLink, reloadPage } from "./reloadOnLink";

// A link opened in a tab that already shows /display is a same-document fragment change: no page load, no claim, and the secret would stay in
// the address bar (review I1). The listener loads the page again, with the fragment, so the one load path takes it and claims.
describe("reloadOnLink", () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/display");
  });

  /** Sets the address without the browser's own hashchange (replaceState fires none), then fires the event by hand. */
  const hashChanges = (address: string) => {
    window.history.replaceState(null, "", address);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };

  it("reloads once when the fragment becomes a link", () => {
    const reload = vi.fn();
    stop = reloadOnLink(reload);
    hashChanges("/display#abc_DEF-123");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a change to an empty fragment (back to the bare address, or a lone #)", () => {
    const reload = vi.fn();
    stop = reloadOnLink(reload);
    hashChanges("/display");
    hashChanges("/display#");
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads again for each later link, and not after it was stopped", () => {
    const reload = vi.fn();
    stop = reloadOnLink(reload);
    hashChanges("/display#one");
    hashChanges("/display#two");
    expect(reload).toHaveBeenCalledTimes(2);
    stop();
    stop = null;
    hashChanges("/display#three");
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("the real reload loads the page again, and never throws when the browser refuses", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { hash: "#x", reload });
    reloadPage();
    expect(reload).toHaveBeenCalledTimes(1);
    vi.stubGlobal("location", {
      hash: "#x",
      reload: () => {
        throw new Error("blocked");
      },
    });
    expect(() => reloadPage()).not.toThrow();
  });
});
