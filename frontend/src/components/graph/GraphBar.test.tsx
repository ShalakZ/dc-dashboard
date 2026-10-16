import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActionState } from "../../lib/graphView";
import { GraphBar } from "./GraphBar";

const ok: ActionState = { enabled: true };
const none = (reason: string): ActionState => ({ enabled: false, reason });
const NOTHING = "Select a source, group or asset first.";

function bar(over: Partial<React.ComponentProps<typeof GraphBar>> = {}) {
  const props: React.ComponentProps<typeof GraphBar> = {
    summary: "2 sources, 5 points, 2 mapped",
    collapsible: true, expandable: true, tidying: false, unmappedOnly: false,
    onUnmappedOnly: vi.fn(), onCollapseAll: vi.fn(), onExpandAll: vi.fn(), onTidy: vi.fn(),
    expandSelection: ok, collapseSelection: ok, expandBranch: ok, collapseBranch: ok,
    onExpandSelection: vi.fn(), onCollapseSelection: vi.fn(), onExpandBranch: vi.fn(), onCollapseBranch: vi.fn(),
    ...over,
  };
  return { props, ...render(<GraphBar {...props} />) };
}
const root = () => document.querySelector(".graph-bar") as HTMLElement;
const collapseMore = () => screen.getByRole("button", { name: "More ways to collapse" });
const expandMore = () => screen.getByRole("button", { name: "More ways to expand" });
const menuItems = () => screen.getAllByRole("menuitem");

describe("GraphBar", () => {
  it("is the old bar: the summary is the one polite announcer (no role), then the buttons in order, the chevrons beside their button and the switch last", () => {
    bar();
    expect(root()).toHaveClass("graph-bar");
    const summary = root().firstElementChild as HTMLElement;
    expect(summary.tagName).toBe("P");
    expect(summary).toHaveClass("graph-summary");
    expect(summary).toHaveAttribute("aria-live", "polite");
    expect(summary).toHaveAttribute("aria-atomic", "true");
    expect(summary).not.toHaveAttribute("role");
    expect(summary).toHaveAttribute("title", "2 sources, 5 points, 2 mapped");
    expect(summary).toHaveTextContent("2 sources, 5 points, 2 mapped");
    const buttons = within(root()).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Collapse all", "More ways to collapse", "Expand all", "More ways to expand", "Tidy layout",
    ]);
    for (const button of buttons) expect(button).toHaveAttribute("type", "button");
    // the switch comes after everything, and is a switch, not a checkbox
    const toggle = screen.getByRole("switch", { name: "Unmapped only" });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(toggle.compareDocumentPosition(buttons[4]) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(root().querySelector("label")).toContainElement(toggle);
  });

  it("the old buttons call back; a button with nothing to do is aria-disabled (never disabled), says why in its title, and does nothing when clicked", async () => {
    const view = bar();
    await userEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
    await userEvent.click(screen.getByRole("button", { name: "Tidy layout" }));
    expect(view.props.onCollapseAll).toHaveBeenCalledTimes(1);
    expect(view.props.onExpandAll).toHaveBeenCalledTimes(1);
    expect(view.props.onTidy).toHaveBeenCalledTimes(1);
    for (const name of ["Collapse all", "Expand all", "Tidy layout"]) {
      expect(screen.getByRole("button", { name })).not.toHaveAttribute("aria-disabled");
      expect(screen.getByRole("button", { name })).not.toHaveAttribute("title");
    }
    view.unmount();

    const idle = bar({ collapsible: false, expandable: false, tidying: true });
    for (const [name, title] of [["Collapse all", "Nothing is open"], ["Expand all", "Everything is open"], ["Tidy layout", null]] as const) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).not.toBeDisabled();
      if (title) expect(button).toHaveAttribute("title", title);
      await userEvent.click(button);
    }
    expect(idle.props.onCollapseAll).not.toHaveBeenCalled();
    expect(idle.props.onExpandAll).not.toHaveBeenCalled();
    expect(idle.props.onTidy).not.toHaveBeenCalled();
  });

  it("the Unmapped only switch shows the state it is given and calls back with the new one", async () => {
    const off = bar();
    const toggle = screen.getByRole("switch", { name: "Unmapped only" });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    expect(off.props.onUnmappedOnly).toHaveBeenCalledWith(true);
    off.unmount();

    const on = bar({ unmappedOnly: true });
    expect(screen.getByRole("switch", { name: "Unmapped only" })).toBeChecked();
    await userEvent.click(screen.getByRole("switch", { name: "Unmapped only" }));
    expect(on.props.onUnmappedOnly).toHaveBeenCalledWith(false);
  });

  it("each chevron is a menu button, collapsed until pressed", () => {
    bar();
    for (const chevron of [collapseMore(), expandMore()]) {
      expect(chevron).toHaveAttribute("aria-haspopup", "menu");
      expect(chevron).toHaveAttribute("aria-expanded", "false");
      expect(chevron).not.toHaveAttribute("aria-disabled");
      expect(chevron.querySelector("svg.i")).not.toBeNull(); // the inline chevron
      expect(chevron).toHaveTextContent(""); // its name is the aria-label
    }
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("the collapse chevron opens a menu with Collapse selection and Collapse this branch, which call back, close the menu and leave the focus on the chevron", async () => {
    const view = bar();
    await userEvent.click(collapseMore());
    expect(collapseMore()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Collapse options" })).toBeInTheDocument();
    expect(menuItems().map((i) => i.textContent)).toEqual(["Collapse selection", "Collapse this branch"]);
    expect(menuItems()[0]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(view.props.onCollapseBranch).toHaveBeenCalledTimes(1);
    expect(view.props.onCollapseSelection).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(collapseMore()).toHaveFocus();
    expect(collapseMore()).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(collapseMore());
    await userEvent.keyboard("{Enter}");
    expect(view.props.onCollapseSelection).toHaveBeenCalledTimes(1);
  });

  it("the expand chevron opens Expand selection and Expand this branch", async () => {
    const view = bar();
    await userEvent.click(expandMore());
    expect(screen.getByRole("menu", { name: "Expand options" })).toBeInTheDocument();
    expect(menuItems().map((i) => i.textContent)).toEqual(["Expand selection", "Expand this branch"]);
    await userEvent.click(menuItems()[1]);
    expect(view.props.onExpandBranch).toHaveBeenCalledTimes(1);
    await userEvent.click(expandMore());
    await userEvent.click(menuItems()[0]);
    expect(view.props.onExpandSelection).toHaveBeenCalledTimes(1);
    expect(view.props.onCollapseSelection).not.toHaveBeenCalled();
  });

  it("opens from the keyboard too: Enter on the chevron puts the focus in the menu, Escape closes it and gives the focus back to the chevron", async () => {
    bar();
    collapseMore().focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(menuItems()[0]).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(collapseMore()).toHaveFocus();
    await userEvent.keyboard("{Enter}"); // and it opens again
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("a second press on the chevron closes its menu and does not open it again; the press after that opens it", async () => {
    bar();
    await userEvent.click(collapseMore());
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.click(collapseMore());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(collapseMore()).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(collapseMore());
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("a press elsewhere closes the menu, and the next press on the chevron opens it", async () => {
    bar();
    await userEvent.click(expandMore());
    await userEvent.click(screen.getByRole("switch", { name: "Unmapped only" }));
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(expandMore());
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("an item that cannot be used is aria-disabled with its reason as a muted second line and title; the arrows skip it, a click does nothing", async () => {
    const view = bar({ collapseSelection: none(NOTHING) });
    await userEvent.click(collapseMore());
    const [selection, branch] = menuItems();
    expect(selection).toHaveAttribute("aria-disabled", "true");
    expect(selection).not.toBeDisabled();
    expect(selection).toHaveAttribute("title", NOTHING);
    expect(selection.querySelector(".graph-menu-reason")).toHaveTextContent(NOTHING);
    expect(branch).toHaveFocus(); // the first ENABLED item
    await userEvent.keyboard("{ArrowDown}");
    expect(branch).toHaveFocus(); // the only enabled one: the arrows wrap onto it
    await userEvent.click(selection);
    expect(view.props.onCollapseSelection).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("a chevron with nothing to offer is aria-disabled (never disabled), carries the reason in its title and a hidden description, and never opens", async () => {
    bar({ collapseSelection: none(NOTHING), collapseBranch: none("Nothing selected opens or closes.") });
    const chevron = collapseMore();
    expect(chevron).toHaveAttribute("aria-disabled", "true");
    expect(chevron).not.toBeDisabled();
    expect(chevron).toHaveAttribute("title", NOTHING); // the first item's reason
    const described = document.getElementById(chevron.getAttribute("aria-describedby") as string) as HTMLElement;
    expect(described).toHaveClass("sr-only");
    expect(described).toHaveTextContent(NOTHING);
    expect(chevron).toHaveAccessibleDescription(NOTHING);
    expect(chevron).not.toContainElement(described);
    await userEvent.click(chevron);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(chevron).toHaveFocus(); // the click left the focus where it landed
    chevron.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("menu")).toBeNull();
    // the other chevron is not touched by it
    expect(expandMore()).not.toHaveAttribute("aria-disabled");
    expect(expandMore()).not.toHaveAttribute("title");
  });

  it("the hidden description is always there (empty while the chevron works), so a chevron that gets blocked does not move anything", () => {
    const view = bar();
    const hidden = () => document.getElementById(collapseMore().getAttribute("aria-describedby") as string) as HTMLElement;
    expect(hidden()).toHaveClass("sr-only");
    expect(hidden()).toHaveTextContent("");
    view.rerender(<GraphBar {...view.props} collapseSelection={none("Everything selected is already closed.")} collapseBranch={none("Everything selected is already closed.")} />);
    expect(hidden()).toHaveTextContent("Everything selected is already closed.");
    expect(collapseMore()).toHaveAttribute("aria-disabled", "true");
  });

  it("one enabled item is enough for the chevron to open, with the other item showing why it cannot be used", async () => {
    bar({ expandSelection: none("Everything selected is already open."), expandBranch: ok });
    expect(expandMore()).not.toHaveAttribute("aria-disabled");
    await userEvent.click(expandMore());
    expect(menuItems()[0]).toHaveAttribute("aria-disabled", "true");
    expect(menuItems()[0]).toHaveTextContent("Everything selected is already open.");
  });
});
