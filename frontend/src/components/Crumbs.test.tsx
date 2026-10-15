import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Crumbs, type Crumb } from "./Crumbs";

const show = (trail: readonly Crumb[]) =>
  render(
    <MemoryRouter>
      <Crumbs trail={trail} />
    </MemoryRouter>,
  );

describe("Crumbs", () => {
  it("is one navigation landmark named Breadcrumb holding an ordered list", () => {
    const { container } = show([{ label: "Dashboards", to: "/dashboards" }, { label: "Hall A" }]);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav).toHaveClass("crumbs");
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(container.querySelector("nav > ol")).not.toBeNull();
    expect(within(nav).getAllByRole("listitem")).toHaveLength(2);
  });

  it("links every crumb but the last, and marks the last as the current page, not a link", () => {
    show([{ label: "Assets", to: "/assets" }, { label: "MV2", to: "/assets/3" }, { label: "Room-1", to: "/assets/4" }]);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Assets", "/assets"],
      ["MV2", "/assets/3"],
    ]);
    const last = within(nav).getByText("Room-1");
    expect(last.tagName).toBe("SPAN");
    expect(last).toHaveAttribute("aria-current", "page");
    expect(within(nav).queryByRole("link", { name: "Room-1" })).not.toBeInTheDocument();
    expect(nav.querySelectorAll("[aria-current]")).toHaveLength(1);
  });

  it("writes a crumb without a destination as plain text, even before the last one", () => {
    show([{ label: "Sources" }, { label: "sim" }]);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).queryByRole("link")).not.toBeInTheDocument();
    expect(within(nav).getByText("Sources")).toBeInTheDocument();
    expect(within(nav).getByText("sim")).toHaveAttribute("aria-current", "page");
  });

  it("makes the last crumb the current page even when it has a destination", () => {
    show([{ label: "Audit log", to: "/audit" }, { label: "Entry #9", to: "/audit/9" }]);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).getAllByRole("link")).toHaveLength(1);
    expect(within(nav).getByText("Entry #9")).toHaveAttribute("aria-current", "page");
  });

  it("shows a lone crumb as the current page, with no separator", () => {
    const { container } = show([{ label: "Dashboards", to: "/dashboards" }]);
    expect(screen.getByText("Dashboards")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".sep")).toHaveLength(0);
  });

  it("renders nothing for an empty trail", () => {
    const { container } = show([]);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("keeps a 60-character label whole in the DOM (the CSS wraps it)", () => {
    const long = "A".repeat(30) + "-" + "b".repeat(29);
    expect(long).toHaveLength(60);
    show([{ label: "Assets", to: "/assets" }, { label: long }]);
    expect(screen.getByText(long)).toHaveAttribute("aria-current", "page");
  });

  it("hides every separator from assistive technology, one between each pair of crumbs", () => {
    const { container } = show([{ label: "Assets", to: "/assets" }, { label: "MV2", to: "/assets/3" }, { label: "Room-1" }]);
    const seps = Array.from(container.querySelectorAll(".sep"));
    expect(seps).toHaveLength(2);
    for (const sep of seps) {
      expect(sep).toHaveAttribute("aria-hidden", "true");
      expect(sep).toHaveTextContent("/");
    }
  });

  it("puts each separator before the crumb it belongs to, in the same list item, and none before the first", () => {
    const { container } = show([{ label: "Assets", to: "/assets" }, { label: "MV2", to: "/assets/3" }, { label: "Room-1" }]);
    const items = Array.from(container.querySelectorAll("li"));
    expect(items).toHaveLength(3);
    expect(items[0].querySelector(".sep")).toBeNull();
    for (const li of items.slice(1)) {
      const first = li.firstElementChild;
      expect(first).toHaveClass("sep");
      expect(li.querySelectorAll(".sep")).toHaveLength(1);
      expect(li.lastElementChild).not.toBe(first);
    }
    // a separator is never inside a link, so it cannot become part of a link name
    expect(container.querySelectorAll("a .sep")).toHaveLength(0);
    expect(screen.getByRole("link", { name: "MV2" })).toBeInTheDocument();
  });

  describe("icons (W7t)", () => {
    it("draws no icon slot for a crumb without one, so an existing trail is the markup it was", () => {
      const { container } = show([{ label: "Assets", to: "/assets" }, { label: "MV2" }]);
      expect(container.querySelectorAll(".crumb-icon")).toHaveLength(0);
      expect(container.querySelectorAll("svg")).toHaveLength(0);
      expect(container.querySelectorAll(".with-icon")).toHaveLength(0);
    });

    it("draws an aria-hidden icon inside the link, before the label, and keeps the link's name and text", () => {
      const { container } = show([{ label: "Assets Tree", to: "/assets", icon: "assets" }, { label: "MV2", to: "/assets/3", icon: "kindPanel" }, { label: "Room-1", icon: "kindRoom" }]);
      const link = screen.getByRole("link", { name: "Assets Tree" });
      expect(link.textContent).toBe("Assets Tree");
      expect(link.firstElementChild).toHaveClass("crumb-icon");
      expect(link.firstElementChild).toHaveAttribute("aria-hidden", "true");
      expect(link.firstElementChild!.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(link).toHaveClass("with-icon");
      expect(link.getAttribute("href")).toBe("/assets");
      // the icon is inside the item's link, never beside it, so it cannot become a stray list child
      expect(container.querySelectorAll("li > .crumb-icon")).toHaveLength(0);
      expect(container.querySelectorAll(".crumb-icon")).toHaveLength(3);
      expect(screen.getByRole("link", { name: "MV2" })).toHaveAttribute("href", "/assets/3");
    });

    it("puts the icon of the current page inside its span, which keeps aria-current and its text", () => {
      show([{ label: "Assets Tree", to: "/assets", icon: "assets" }, { label: "Panel 1", icon: "kindPanel" }]);
      const current = screen.getByText("Panel 1");
      expect(current.tagName).toBe("SPAN");
      expect(current).toHaveAttribute("aria-current", "page");
      expect(current).toHaveClass("with-icon");
      expect(current.firstElementChild).toHaveClass("crumb-icon");
      expect(current.textContent).toBe("Panel 1");
      expect(screen.queryByRole("link", { name: "Panel 1" })).not.toBeInTheDocument();
    });

    it("draws the icon of a plain-text crumb that has none of its own destination", () => {
      show([{ label: "Sources", icon: "assets" }, { label: "sim" }]);
      const plain = screen.getByText("Sources");
      expect(plain.tagName).toBe("SPAN");
      expect(plain).not.toHaveAttribute("aria-current");
      expect(plain.querySelector(".crumb-icon")).not.toBeNull();
    });

    it("keeps the separator first in its item and outside the icon slot", () => {
      const { container } = show([{ label: "Assets", to: "/assets", icon: "assets" }, { label: "MV2", to: "/assets/3", icon: "kindPanel" }, { label: "Room-1", icon: "kindRoom" }]);
      const items = Array.from(container.querySelectorAll("li"));
      expect(items[0].querySelector(".sep")).toBeNull();
      for (const li of items.slice(1)) expect(li.firstElementChild).toHaveClass("sep");
      expect(container.querySelectorAll(".crumb-icon .sep, a .sep")).toHaveLength(0);
      expect(Array.from(container.querySelectorAll("li > :not(.sep)")).map((el) => el.textContent)).toEqual(["Assets", "MV2", "Room-1"]);
    });

    it("mixes crumbs with and without icons in one trail", () => {
      const { container } = show([{ label: "Assets Tree", to: "/assets", icon: "assets" }, { label: "Asset kinds" }]);
      expect(container.querySelectorAll(".crumb-icon")).toHaveLength(1);
      expect(screen.getByText("Asset kinds")).not.toHaveClass("with-icon");
    });
  });
});
