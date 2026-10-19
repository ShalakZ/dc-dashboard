import { cleanup, render, screen, within } from "@testing-library/react";
import type { TextStyle } from "../../api/types";
import { TrashButton } from "../TrashButton";
import { TextWidgetView } from "./TextWidgetView";

/** What DashboardEditor passes in edit mode: the span the grid does not start a drag from, holding Edit and Delete. */
const actions = (
  <span className="widget-actions">
    <button type="button" className="icon-btn" aria-label="Edit Notes">E</button>
    <TrashButton label="Delete Notes" onClick={() => {}} />
  </span>
);
const view = (style: TextStyle, text: string) => render(<TextWidgetView title="Notes" config={{ style, text }} />);
const edit = (style: TextStyle, text: string) => render(<TextWidgetView title="Notes" config={{ style, text }} actions={actions} dragHandle />);

describe("TextWidgetView in view mode", () => {
  it("draws a heading as its own h2 with the text, and no region, title bar or button", () => {
    const { container } = view("heading", "Cooling plant");
    expect(screen.getByRole("heading", { level: 2, name: "Cooling plant" })).toHaveClass("widget-text-heading");
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container.querySelector("header")).toBeNull();
    expect(container.firstElementChild).toHaveClass("widget-frame", "widget-text");
    expect(container.firstElementChild).toHaveAttribute("data-style", "heading");
  });

  it("draws a paragraph as a region named by the title that holds the text, line breaks kept in the text node", () => {
    const { container } = view("paragraph", "line one\nline two\n\nafter a blank line");
    const region = screen.getByRole("region", { name: "Notes" });
    const paragraph = container.querySelector("p.widget-text-paragraph");
    expect(region).toContainElement(paragraph as HTMLElement);
    expect(paragraph?.textContent).toBe("line one\nline two\n\nafter a blank line");
    expect(paragraph?.childNodes).toHaveLength(1); // one text node: no <br>, nothing split
    expect(screen.queryByRole("heading")).not.toBeInTheDocument(); // the title names the region and is not drawn
    expect(screen.queryByText("Notes")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container.querySelector("header")).toBeNull();
  });

  it("shows markup as the literal text: no element is made from it, and a link is not a link", () => {
    const { container } = view("paragraph", "<b>x</b> and <a href=\"https://example.com\">here</a> <img src=x onerror=alert(1)>");
    expect(container.querySelector("b, a, img")).toBeNull();
    expect(screen.getByText(/<b>x<\/b> and/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    cleanup();
    view("heading", "<i>not italic</i>");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("<i>not italic</i>");
    expect(document.querySelector("i")).toBeNull();
  });

  it("draws a divider as a separator with no text, no region and no card", () => {
    const { container } = view("divider", "");
    expect(screen.getByRole("separator")).toHaveClass("widget-text-rule");
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container.textContent).toBe("");
    expect(container.firstElementChild).toHaveClass("widget-text");
    expect(container.firstElementChild).not.toHaveClass("widget-frame"); // no card chrome
    expect(container.firstElementChild).toHaveAttribute("data-style", "divider");
  });

  it("never offers Details or CSV, whatever the style", () => {
    for (const style of ["heading", "paragraph", "divider"] as const) {
      const { unmount } = view(style, style === "divider" ? "" : "text");
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe("TextWidgetView in edit mode", () => {
  it("is the data cards' frame: grip, the title as the card's h2, Edit and Delete, and the header is the drag handle", () => {
    const { container } = edit("paragraph", "Some words");
    const card = screen.getByRole("region", { name: "Notes" });
    const head = card.querySelector("header");
    expect(head).toHaveClass("widget-head", "widget-drag-handle");
    expect(head?.querySelector(".widget-grip")).not.toBeNull();
    expect(within(card).getByRole("heading", { level: 2, name: "Notes" })).toHaveClass("widget-title");
    expect(within(card).getByRole("button", { name: "Edit Notes" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Delete Notes" })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /^Details for/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /^Download CSV/ })).not.toBeInTheDocument();
    expect(container.querySelector(".widget-body .widget-text-paragraph")?.textContent).toBe("Some words");
  });

  it("draws a heading as a styled div, never a second h2", () => {
    const { container } = edit("heading", "Cooling plant");
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Notes");
    const text = container.querySelector(".widget-text-heading");
    expect(text?.tagName).toBe("DIV");
    expect(text).toHaveTextContent("Cooling plant");
  });

  it("draws a divider as the rule inside the full card", () => {
    const { container } = edit("divider", "");
    expect(screen.getByRole("region", { name: "Notes" })).toContainElement(screen.getByRole("separator"));
    expect(container.querySelector(".widget-body .widget-text-rule")).not.toBeNull();
  });

  it("shows markup as the literal text here too", () => {
    const { container } = edit("paragraph", "<b>x</b>");
    expect(container.querySelector(".widget-body b")).toBeNull();
    expect(container.querySelector(".widget-text-paragraph")?.textContent).toBe("<b>x</b>");
  });
});
