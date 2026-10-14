import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { mockFetch, shellRoutes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { userFor } from "../test/users";
import { AppShellSkeleton } from "./AppShellSkeleton";
import { BRAND_MARK_SRC } from "./BrandMark";
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
    const mark = container.querySelector(".brand > img.brand-mark")!;
    expect(mark).toHaveAttribute("src", BRAND_MARK_SRC);
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".brand svg")).toBeNull();
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

  // The bar's right side is empty on purpose: the real chip, clock and user block are as wide as their content (the user's name sets the
  // user block's width), so a placeholder of any one width would slide them at the hand-over for every account but one.
  it("leaves the right side of the bar empty: no chip, separator, clock, user block or avatar", () => {
    const { container } = render(<AppShellSkeleton />);
    const barIn = container.querySelector(".navbar > .bar-in")!;
    expect([...barIn.children].map((el) => el.className)).toEqual(["qf", "grow"]);
    expect(container.querySelector(".sk-chip, .live, .vr, .site-time, .profile, .who, .avatar, .sk-avatar, .sk-caret")).toBeNull();
    expect(container.querySelector(".navbar .sk-circle")).toBeNull();
  });

  // The geometry is the real CSS's only if the landmarks nest the way Layout's do. Compared on the listed steps only: Layout has more
  // children (the tip, the chip, the clock, the user), and its skip link and loading bar sit outside .shell.
  describe("keeps Layout's landmark chain", () => {
    const describeEl = (el: Element | null) =>
      el ? `${el.tagName.toLowerCase()}${[...el.classList].filter((c) => !c.startsWith("sk-") && c !== "ready").map((c) => `.${c}`).join("")}` : "(none)";
    const first = (el: Element | null) => el?.firstElementChild ?? null;
    const next = (el: Element | null) => el?.nextElementSibling ?? null;
    /** The chain of one shell: each pair is (what the step is, what it found). */
    const chain = (shell: Element) => {
      const header = first(shell);
      const frame = next(header);
      const side = first(frame);
      const nav = first(side);
      const brand = first(header);
      const barIn = next(brand);
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
        "side > first": describeEl(nav),
        "nav > first": describeEl(first(nav)),
        "nav > second": describeEl(next(first(nav))),
        "nav-group > first": describeEl(first(first(first(nav)))),
      };
    };

    it("is the same on the skeleton and on the real shell", async () => {
      mockFetch({ ...shellRoutes, "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: userFor("admin") } });
      const real = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
      await screen.findByRole("button", { name: /^u Administrator$/ }); // the shell has settled
      const realChain = chain(real.container.querySelector(".shell")!);
      real.unmount();
      const skeleton = render(<AppShellSkeleton />);
      const skeletonChain = chain(skeleton.container.querySelector(".shell")!);
      expect(skeletonChain).toEqual(realChain);
      expect(realChain["frame > second"]).toBe("main"); // the chain found something at every step
      expect(realChain["nav-group > first"]).toBe("span.nav-heading");
      expect(realChain["bar-in > second"]).toBe("span.grow"); // the skeleton's bar ends here; the real one goes on with the chip, the clock and the user
    });
  });
});

// index.html carries a static copy of the skeleton (it paints before any script runs). A string comparison would trip on harmless
// differences (indentation, `<img/>` against `<img>`, `data-x` against `data-x=""`, attribute order), so both sides are parsed to DOM
// and compared with isEqualNode after the whitespace between tags and the comments are dropped. The only difference allowed is `hidden` on the
// static root: it keeps the copy invisible until the stylesheet shows it (app.css), and the React skeleton must never carry it.
describe("the static copy in index.html", () => {
  const html = readFileSync("index.html", "utf8"); // vitest runs from the frontend directory

  /** Comments and whitespace-only text go, recursively: the generated markup has neither, the pasted copy has line breaks between blocks. */
  function tidy(node: Node) {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.COMMENT_NODE || (child.nodeType === Node.TEXT_NODE && !(child.nodeValue ?? "").trim())) child.remove();
      else tidy(child);
    }
  }
  const staticRoot = () => new DOMParser().parseFromString(html, "text/html").getElementById("root")!;
  const generated = (sidebar: "expanded" | "minimized" = "expanded") => {
    const template = document.createElement("template");
    template.innerHTML = renderToStaticMarkup(<AppShellSkeleton sidebar={sidebar} />);
    // React 19 hoists a <link rel="preload" as="image"> in front of any tree that holds an <img src> when it renders to a string; the client
    // never adds one, and the static copy must not (index.html's head is not #root). Dropped so the parity is about the shell alone.
    template.content.querySelectorAll('link[rel="preload"]').forEach((link) => link.remove());
    return template.content;
  };

  it("is the skeleton's markup, element for element (paste this into <div id=\"root\"> when it drifts)", () => {
    const root = staticRoot();
    expect(root, "a #root in index.html").not.toBeNull();
    const copy = root.firstElementChild;
    expect(copy, "the static shell inside #root").not.toBeNull();
    copy!.removeAttribute("hidden");
    tidy(root);
    const expected = generated();
    tidy(expected);
    expect(root.childNodes.length, "#root holds the shell and nothing else").toBe(1);
    const shellMarkup = (expected.firstChild as Element).outerHTML; // the .shell element only, never the hoisted <link>
    expect(expected.firstChild!.isEqualNode(copy), `the static copy has drifted from AppShellSkeleton; the generated markup is:\n${shellMarkup}`).toBe(true);
  });

  it("starts expanded and hidden: the stylesheet shows it, and without one it never paints unstyled", () => {
    const copy = staticRoot().firstElementChild!;
    expect(copy.className).toBe("shell sk-shell");
    expect(copy.getAttribute("data-sidebar")).toBe("expanded");
    expect(copy.hasAttribute("hidden")).toBe(true);
    expect(generated().firstElementChild!.hasAttribute("hidden")).toBe(false);
  });

  it("is classes only: no style attribute (a strict style-src would drop it) and no script in the copy", () => {
    const root = staticRoot();
    expect(root.querySelector("[style]")).toBeNull();
    expect(root.querySelector("script")).toBeNull();
    expect(html).not.toMatch(/\sstyle=/);
  });

  it("sits in #root before the module script", () => {
    expect(html.indexOf('<div id="root">')).toBeGreaterThan(-1);
    expect(html.indexOf("sk-shell")).toBeGreaterThan(html.indexOf('<div id="root">'));
    expect(html.indexOf("sk-shell")).toBeLessThan(html.indexOf('<script type="module"'));
  });
});
