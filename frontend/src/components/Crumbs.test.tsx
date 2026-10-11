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
});
