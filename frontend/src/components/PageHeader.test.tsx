import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
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
});
