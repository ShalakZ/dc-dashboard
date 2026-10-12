import { render, screen } from "@testing-library/react";
import { mockFetch, shellRoutes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { AppShellSkeleton } from "./AppShellSkeleton";
import { Layout } from "./Layout";

/** jsdom has no matchMedia; a test that wants a window of a given kind installs one, and the afterEach below removes it. */
function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", { value: () => ({ matches }), configurable: true, writable: true });
}
afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

/** Every text node under `root`: the shell skeleton holds one word and no other text. */
function textNodes(root: Node): string[] {
  const found: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) found.push(node.nodeValue ?? "");
  return found;
}

describe("AppShellSkeleton", () => {
  it("has exactly one status, the word Loading, busy, and it is not a skeleton region", () => {
    const { container } = render(<AppShellSkeleton />);
    const statuses = container.querySelectorAll('[role="status"]');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toHaveAttribute("aria-busy", "true");
    expect(statuses[0]).toHaveTextContent(/^Loading$/);
    expect(screen.getByRole("status")).toBe(statuses[0]); // the only one in the accessibility tree too (a status has no name from content)
    expect(container.querySelector(".sk-region")).toBeNull(); // a region fades in after 150 ms and would join W7f's chain of seen skeletons
    expect(statuses[0].closest("main")).not.toBeNull();
  });

  it("hides the bar and the sidebar from the accessibility tree", () => {
    const { container } = render(<AppShellSkeleton />);
    expect(container.querySelector("header.navbar")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".side")).toHaveAttribute("aria-hidden", "true");
  });

  it("has nothing focusable (no skip link, no tab stop)", () => {
    const { container } = render(<AppShellSkeleton />);
    expect(container.querySelector("a, button, input, select, textarea, [tabindex]")).toBeNull();
  });

  it("is classes only: no style attribute (index.html carries a copy of this markup), no hidden attribute", () => {
    const { container } = render(<AppShellSkeleton />);
    expect(container.querySelector("[style]")).toBeNull();
    expect(container.querySelector("[hidden]")).toBeNull(); // only the static copy in index.html is hidden
  });

  it("holds one word, Loading, and no other text (the brand name is drawn by CSS)", () => {
    const { container } = render(<AppShellSkeleton />);
    expect(textNodes(container)).toEqual(["Loading"]);
  });

  it("draws three groups of three rows and a foot row, as placeholders", () => {
    const { container } = render(<AppShellSkeleton />);
    const groups = container.querySelectorAll(".nav-groups > .nav-group");
    expect(groups).toHaveLength(3);
    for (const group of groups) {
      expect(group.firstElementChild).toHaveClass("nav-heading");
      expect(group.querySelectorAll(":scope > .side-row")).toHaveLength(3);
    }
    expect(container.querySelectorAll(".side-foot > .side-row")).toHaveLength(1);
    for (const row of container.querySelectorAll(".side-row")) {
      expect(row.querySelector(".sk-circle")).not.toBeNull();
      expect(row.querySelector(".lbl .sk-line")).not.toBeNull();
    }
    expect(container.querySelector(".brand > .brand-mark svg")).not.toBeNull();
    expect(container.querySelector(".brand > .lbl")).toBeEmptyDOMElement();
  });

  describe("data-sidebar", () => {
    it("follows the prop", () => {
      const { container, rerender } = render(<AppShellSkeleton sidebar="minimized" />);
      expect(container.querySelector(".shell")).toHaveAttribute("data-sidebar", "minimized");
      rerender(<AppShellSkeleton sidebar="expanded" />);
      expect(container.querySelector(".shell")).toHaveAttribute("data-sidebar", "expanded");
    });

    it("defaults to the state Layout starts in: expanded, a remembered minimized, a narrow window", () => {
      const first = render(<AppShellSkeleton />);
      expect(first.container.querySelector(".shell")).toHaveAttribute("data-sidebar", "expanded");
      first.unmount();

      localStorage.setItem("dcdash.sidebar", "minimized");
      const stored = render(<AppShellSkeleton />);
      expect(stored.container.querySelector(".shell")).toHaveAttribute("data-sidebar", "minimized");
      stored.unmount();

      localStorage.clear();
      stubMatchMedia(true);
      const narrow = render(<AppShellSkeleton />);
      expect(narrow.container.querySelector(".shell")).toHaveAttribute("data-sidebar", "minimized");
    });
  });

  // The geometry is the real CSS's only if the landmarks nest the way Layout's do. Compared on the listed steps only: Layout has more
  // children (the tip, the chip, the clock), and its skip link and loading bar sit outside .shell.
  describe("keeps Layout's landmark chain", () => {
    const describeEl = (el: Element | null) =>
      el ? `${el.tagName.toLowerCase()}${[...el.classList].filter((c) => !c.startsWith("sk-") && c !== "ready").map((c) => `.${c}`).join("")}` : "(none)";
    const first = (el: Element | null) => el?.firstElementChild ?? null;
    const next = (el: Element | null) => el?.nextElementSibling ?? null;
    /** The bar's right side stands in for the real chip, caret and button by slot, not by class: a placeholder has its own classes. */
    const slot = (el: Element) => (el.matches(".live, .sk-chip") ? "chip" : el.matches("svg.i, .sk-caret") ? "caret" : describeEl(el));
    const slots = (els: Iterable<Element>) => [...els].map(slot);
    const following = (el: Element | null) => { const found: Element[] = []; for (let n = next(el); n; n = next(n)) found.push(n); return found; };
    /** The chain of one shell: each pair is (what the step is, what it found). */
    const chain = (shell: Element) => {
      const header = first(shell);
      const frame = next(header);
      const side = first(frame);
      const nav = first(side);
      const brand = first(header);
      const barIn = next(brand);
      const grow = barIn!.querySelector(":scope > .grow");
      const who = barIn!.querySelector(".profile > .who");
      return {
        shell: describeEl(shell),
        "shell > first": describeEl(header),
        "shell > second": describeEl(frame),
        "frame > first": describeEl(side),
        "frame > second": describeEl(next(side)),
        "header > first": describeEl(brand),
        "header > second": describeEl(barIn),
        "brand > first": describeEl(first(brand)),
        "brand > second": describeEl(next(first(brand))),
        "bar-in > first": describeEl(first(barIn)),
        "bar-in > second": describeEl(next(first(barIn))),
        "bar-in after the grow": slots(following(grow)),
        "who": slots(who?.children ?? []),
        "who > lbl": slots(who?.querySelector(".lbl")?.children ?? []),
        "side > first": describeEl(nav),
        "nav > first": describeEl(first(nav)),
        "nav > second": describeEl(next(first(nav))),
        "nav-group > first": describeEl(first(first(first(nav)))),
      };
    };

    it("is the same on the skeleton and on the real shell", async () => {
      mockFetch({ ...shellRoutes, "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "u", role: "admin" } } });
      const real = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
      await screen.findByRole("button", { name: /^u Administrator$/ }); // the shell has settled
      const realChain = chain(real.container.querySelector(".shell")!);
      real.unmount();
      const skeleton = render(<AppShellSkeleton />);
      const skeletonChain = chain(skeleton.container.querySelector(".shell")!);
      expect(skeletonChain).toEqual(realChain);
      expect(realChain["frame > second"]).toBe("main"); // the chain found something at every step
      expect(realChain["nav-group > first"]).toBe("span.nav-heading");
      // the right side of the bar: the data chip, the separators, the clock and the user, as the real bar has them, so the avatar and the chip sit where the real ones will
      expect(realChain["bar-in after the grow"]).toEqual(["chip", "span.vr", "span.site-time", "span.vr", "div.profile"]);
      expect(realChain.who).toEqual(["span.avatar", "span.lbl", "caret"]);
      expect(realChain["who > lbl"]).toEqual(["span.who-name", "span.who-role"]);
    });
  });
});
