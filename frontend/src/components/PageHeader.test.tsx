import { render, screen } from "@testing-library/react";
import { PageHeader } from "./PageHeader";

describe("PageHeader", () => {
  it("renders exactly one h1 with the title, in a header.page-head", () => {
    const { container } = render(<PageHeader title="Billing" />);
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Billing" })).toBeInTheDocument();
    const header = container.querySelector("header.page-head");
    expect(header).not.toBeNull();
    expect(header).toContainElement(screen.getByRole("heading", { level: 1 }));
  });

  it("puts the crumbs in a p (never a nav) above the title", () => {
    const { container } = render(<PageHeader title="MV2" crumbs={<>Assets / MV2</>} />);
    const crumbs = container.querySelector("p.crumbs");
    expect(crumbs).toHaveTextContent("Assets / MV2");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(container.querySelector("nav")).toBeNull();
    expect(crumbs!.compareDocumentPosition(screen.getByRole("heading", { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    const { container } = render(<PageHeader title="Audit log" crumbs="Admin" sub="Every change" actions={<button type="button">Export</button>} />);
    const parts = Array.from(container.querySelector("header.page-head")!.children).map((el) => `${el.tagName.toLowerCase()}${el.className ? `.${el.className}` : ""}`);
    expect(parts).toEqual(["p.crumbs", "h1", "p.sub", "div.actions"]);
  });
});
