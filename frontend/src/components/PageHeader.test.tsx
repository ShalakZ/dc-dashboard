import { cleanup, render, screen } from "@testing-library/react";
import { createRef, type ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { iconHtml } from "../test/iconHtml";
import { PageHeader } from "./PageHeader";

// The crumbs are links, so the header needs a router around it.
const inRouter = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("PageHeader", () => {
  it("renders exactly one h1 with the title, in a header.page-head", () => {
    const { container } = render(<PageHeader title="Billing" />);
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Billing" })).toBeInTheDocument();
    const header = container.querySelector("header.page-head");
    expect(header).not.toBeNull();
    expect(header).toContainElement(screen.getByRole("heading", { level: 1 }));
  });

  it("puts the crumbs in one nav labelled Breadcrumb above the title", () => {
    const { container } = inRouter(<PageHeader title="MV2" crumbs={[{ label: "Assets", to: "/assets" }, { label: "MV2" }]} />);
    const crumbs = container.querySelector("nav.crumbs");
    expect(crumbs).toHaveTextContent("Assets/MV2");
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBe(crumbs);
    expect(screen.getByRole("link", { name: "Assets" })).toHaveAttribute("href", "/assets");
    expect(crumbs!.compareDocumentPosition(screen.getByRole("heading", { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders no crumbs element for an empty trail", () => {
    const { container } = inRouter(<PageHeader title="MV2" crumbs={[]} />);
    expect(container.querySelector(".crumbs")).toBeNull();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("shows the sub line and the actions slot, with the buttons reachable", () => {
    const { container } = render(<PageHeader title="Users" sub="Who can sign in" actions={<button type="button">Add user</button>} />);
    expect(container.querySelector("p.sub")).toHaveTextContent("Who can sign in");
    expect(container.querySelector("div.actions")).toContainElement(screen.getByRole("button", { name: "Add user" }));
  });

  it("renders no crumbs, sub or actions element when they are absent", () => {
    const { container } = render(<PageHeader title="Assets" />);
    expect(container.querySelector(".crumbs")).toBeNull();
    expect(container.querySelector(".sub")).toBeNull();
    expect(container.querySelector(".actions")).toBeNull();
  });

  it("keeps its parts as direct children of the header (the CSS grid places them, no wrapper)", () => {
    const { container } = inRouter(<PageHeader title="Audit log" crumbs={[{ label: "Admin" }]} sub="Every change" actions={<button type="button">Export</button>} />);
    const parts = Array.from(container.querySelector("header.page-head")!.children).map((el) => `${el.tagName.toLowerCase()}${el.className ? `.${el.className}` : ""}`);
    expect(parts).toEqual(["nav.crumbs", "h1", "p.sub", "div.actions"]);
  });

  it("with an icon, wraps a tile and the h1 in one .page-title (still one h1, named by the title alone)", () => {
    const { container } = render(<PageHeader title="Panel 1" icon="kindPanel" />);
    const title = container.querySelector("header.page-head > div.page-title")!;
    expect(Array.from(title.children).map((el) => `${el.tagName.toLowerCase()}${el.className ? `.${el.className}` : ""}`)).toEqual(["span.page-tile", "h1"]);
    expect(title.querySelector(".page-tile svg")).toHaveAttribute("aria-hidden", "true");
    expect(title.querySelector(".page-tile svg")!.innerHTML).toBe(iconHtml("kindPanel"));
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Panel 1" })).toBe(title.querySelector("h1"));
  });

  it("keeps the other parts as direct children of the header when there is an icon too", () => {
    const { container } = inRouter(<PageHeader title="MV2" icon="kindSite" crumbs={[{ label: "Assets" }]} sub="Site" actions={<button type="button">Edit</button>} />);
    const parts = Array.from(container.querySelector("header.page-head")!.children).map((el) => `${el.tagName.toLowerCase()}${el.className ? `.${el.className}` : ""}`);
    expect(parts).toEqual(["nav.crumbs", "div.page-title", "p.sub", "div.actions"]);
  });

  it("with a headingRef the h1 is the ref's element and can be focused by script only; without one it has no tabindex", () => {
    const ref = createRef<HTMLHeadingElement>();
    render(<PageHeader title="Users & Roles" headingRef={ref} />);
    const heading = screen.getByRole("heading", { level: 1, name: "Users & Roles" });
    expect(ref.current).toBe(heading);
    expect(heading).toHaveAttribute("tabindex", "-1");
    ref.current!.focus();
    expect(heading).toHaveFocus();
    cleanup();
    render(<PageHeader title="Billing" />);
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveAttribute("tabindex");
  });

  it("the headingRef reaches the h1 inside the tile wrapper too", () => {
    const ref = createRef<HTMLHeadingElement>();
    const { container } = render(<PageHeader title="Panel 1" icon="kindPanel" headingRef={ref} />);
    expect(ref.current).toBe(container.querySelector(".page-title > h1"));
  });

  it("without an icon the markup is exactly today's: the h1 straight in the header, no .page-title, no tile", () => {
    const { container } = render(<PageHeader title="Billing" />);
    expect(container.querySelector(".page-title, .page-tile")).toBeNull();
    expect(container.querySelector("header.page-head > h1")).toHaveTextContent("Billing");
  });
});
