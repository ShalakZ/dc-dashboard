import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { foldedForLevel, foldModel } from "../lib/foldLevels";
import { BillingTools } from "./BillingTools";

/** 1 > 2 > 3 > 4 (a chain: maxDepth 3, three rows that can fold). */
const chain = foldModel([{ id: 1, parent_id: null }, { id: 2, parent_id: 1 }, { id: 3, parent_id: 2 }, { id: 4, parent_id: 3 }]);
const flat = foldModel([{ id: 1, parent_id: null }, { id: 2, parent_id: null }]);

function bar(over: Partial<Parameters<typeof BillingTools>[0]> = {}) {
  const onFilter = vi.fn();
  const onFold = vi.fn();
  const props = { typed: "", onFilter, model: chain, effective: new Set<number>(), onFold, ...over } as Parameters<typeof BillingTools>[0];
  render(<BillingTools {...props} />);
  return { onFilter, onFold };
}
const levels = () => screen.getByRole("combobox", { name: "Show levels" });
const optionTexts = () => within(levels()).getAllByRole("option").map((o) => o.textContent);

describe("BillingTools", () => {
  it("is one plain row, not a form, with the five controls and no rows line (that lives in the table's caption)", () => {
    bar();
    const root = document.querySelector(".billing-tools")!;
    expect(root.tagName).toBe("DIV");
    expect(root.closest("form")).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Filter assets" })).toHaveAttribute("placeholder", "Filter by asset name");
    expect(screen.getByRole("button", { name: "Collapse all" })).toHaveAttribute("type", "button");
    expect(screen.getByRole("button", { name: "Expand all" })).toHaveAttribute("type", "button");
    expect(screen.getByRole("button", { name: "What does this mean?" })).toHaveAttribute("type", "button");
    expect(root.querySelector(".tools-count")).toBeNull();
    expect(root).not.toHaveClass("is-idle");
  });

  it("offers the levels 1 to the deepest and then All (the arrow keys walk one way), and reads Custom only while the fold matches no level", () => {
    bar();
    expect(optionTexts()).toEqual(["1", "2", "3", "All"]);
    expect(levels()).toHaveValue("all");
  });

  it("names the level of the fold it is given, and Custom (disabled) for any other", () => {
    const { unmount } = render(<BillingTools typed="" onFilter={vi.fn()} model={chain} effective={foldedForLevel(chain, 2)} onFold={vi.fn()} />);
    expect(levels()).toHaveValue("2");
    expect(optionTexts()).toEqual(["1", "2", "3", "All"]);
    unmount();
    render(<BillingTools typed="" onFilter={vi.fn()} model={chain} effective={new Set([1])} onFold={vi.fn()} />);
    expect(levels()).toHaveValue("custom");
    expect(optionTexts()).toEqual(["1", "2", "3", "All", "Custom"]);
    expect(within(levels()).getByRole("option", { name: "Custom" })).toBeDisabled();
  });

  it("Collapse all, Expand all and a level hand the fold to onFold", async () => {
    const { onFold } = bar();
    await userEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(onFold).toHaveBeenLastCalledWith(foldedForLevel(chain, 1));
    await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(onFold).toHaveBeenLastCalledWith(new Set());
    await userEvent.selectOptions(levels(), "2");
    expect(onFold).toHaveBeenLastCalledWith(foldedForLevel(chain, 2));
    await userEvent.selectOptions(levels(), "All");
    expect(onFold).toHaveBeenLastCalledWith(new Set());
  });

  it("turns the three fold controls off when there is nothing to fold", () => {
    bar({ model: flat });
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Expand all" })).toBeDisabled();
    expect(levels()).toBeDisabled();
    expect(optionTexts()).toEqual(["All"]);
  });

  it("turns them off while the filter has text, and leaves them on for spaces alone (no filter)", () => {
    const { unmount } = render(<BillingTools typed="ra" onFilter={vi.fn()} model={chain} effective={new Set()} onFold={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Expand all" })).toBeDisabled();
    expect(levels()).toBeDisabled();
    unmount();
    render(<BillingTools typed="  " onFilter={vi.fn()} model={chain} effective={new Set()} onFold={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeEnabled();
    expect(levels()).toBeEnabled();
  });

  it("sends what is typed, Escape clears and stays, and Clear filter clears and takes the focus", async () => {
    const { onFilter } = bar({ typed: "ab" });
    const box = screen.getByRole("searchbox", { name: "Filter assets" });
    expect(box).toHaveValue("ab");
    await userEvent.type(box, "c");
    expect(onFilter).toHaveBeenLastCalledWith("abc");
    onFilter.mockClear();
    await userEvent.keyboard("{Escape}");
    expect(onFilter).toHaveBeenCalledExactlyOnceWith("");
    expect(box).toHaveFocus();
    onFilter.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "What does this mean?" }));
    expect(box).not.toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(onFilter).toHaveBeenCalledExactlyOnceWith("");
    expect(box).toHaveFocus();
  });

  it("has no Clear filter button, and Escape does nothing, while the box is empty", async () => {
    const { onFilter } = bar();
    expect(screen.queryByRole("button", { name: "Clear filter" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("searchbox", { name: "Filter assets" }));
    await userEvent.keyboard("{Escape}");
    expect(onFilter).not.toHaveBeenCalled();
  });

  it("idle: the same markup with no data, inert and hidden from assistive technology", () => {
    render(<BillingTools idle />);
    const root = document.querySelector(".billing-tools")!;
    expect(root).toHaveClass("is-idle");
    expect(root).toHaveAttribute("inert");
    expect(root).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button")).not.toBeInTheDocument(); // aria-hidden: out of the accessibility tree
    expect(root.querySelectorAll("button")).toHaveLength(3); // Collapse all, Expand all and the tip, drawn so the box is the same
    expect(Array.from(root.querySelectorAll("button")).every((b) => b.getAttribute("type") === "button")).toBe(true);
    expect(root.querySelectorAll("select option")).toHaveLength(1);
    expect(root.querySelector("select option")).toHaveTextContent("All");
    expect(root.querySelector("input")).toHaveValue("");
    expect(root.querySelector(".tools-count")).toBeNull();
  });
});
