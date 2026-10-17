import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActionState } from "../../lib/graphView";
import { BarMenu, type BarMenuItem } from "./BarMenu";

const ok: ActionState = { enabled: true };
const none = (reason: string): ActionState => ({ enabled: false, reason });
const NOTHING = "Select a source, group or asset first.";

const pair = (over: Partial<Record<"a" | "b", ActionState>> = {}): BarMenuItem[] => [
  { label: "Collapse selection", state: over.a ?? ok, onSelect: vi.fn() },
  { label: "Collapse this branch", state: over.b ?? ok, onSelect: vi.fn() },
];

function mount(props: Partial<React.ComponentProps<typeof BarMenu>> = {}) {
  const items = (props.items ?? pair()) as BarMenuItem[]; // the tests that read the items back pass an array
  const view = render(
    <>
      <BarMenu name="More ways to collapse" menuLabel="Collapse options" icon="caret" items={items} {...props} />
      <button type="button">Elsewhere</button>
    </>,
  );
  return { items, ...view };
}
const trigger = () => screen.getByRole("button", { name: "More ways to collapse" });
const menuItems = () => screen.getAllByRole("menuitem");

describe("BarMenu", () => {
  it("is a menu button named by `name`, collapsed until pressed, with the icon it is given and the class it is given", () => {
    mount({ icon: "more", className: "graph-bar-more" });
    expect(trigger()).toHaveAttribute("type", "button");
    expect(trigger()).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).not.toHaveAttribute("aria-disabled");
    expect(trigger()).toHaveClass("graph-bar-more");
    expect(trigger().querySelector("svg.i")).not.toBeNull();
    expect(trigger()).toHaveTextContent(""); // the name is the aria-label
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a press opens a menu named by `menuLabel` with the items in order; choosing one calls it, closes the menu and leaves the focus on the button", async () => {
    const { items } = mount();
    await userEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Collapse options" })).toBeInTheDocument();
    expect(menuItems().map((i) => i.textContent)).toEqual(["Collapse selection", "Collapse this branch"]);
    expect(menuItems()[0]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(items[1].onSelect).toHaveBeenCalledTimes(1);
    expect(items[0].onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("opens from the keyboard too: Enter puts the focus in the menu, Escape closes it and gives the focus back to the button", async () => {
    mount();
    trigger().focus();
    await userEvent.keyboard("{Enter}");
    expect(menuItems()[0]).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger()).toHaveFocus();
    await userEvent.keyboard("{Enter}"); // and it opens again
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("a second press on the button closes the menu and does not open it again; the press after that opens it", async () => {
    mount();
    await userEvent.click(trigger());
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.click(trigger());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger());
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("a press elsewhere closes the menu, and the next press on the button opens it", async () => {
    mount();
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(trigger());
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("an item that cannot be used is aria-disabled with its reason as a muted second line and title; the arrows skip it, a click does nothing", async () => {
    const { items } = mount({ items: pair({ a: none(NOTHING) }) });
    await userEvent.click(trigger());
    const [first, second] = menuItems();
    expect(first).toHaveAttribute("aria-disabled", "true");
    expect(first).not.toBeDisabled();
    expect(first).toHaveAttribute("title", NOTHING);
    expect(first.querySelector(".graph-menu-reason")).toHaveTextContent(NOTHING);
    expect(second).toHaveFocus(); // the first ENABLED item
    await userEvent.click(first);
    expect(items[0].onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("a button with nothing to offer is aria-disabled (never disabled), carries the reason in its title and a hidden description, and never opens", async () => {
    mount({ items: pair({ a: none(NOTHING), b: none("Nothing selected opens or closes.") }) });
    expect(trigger()).toHaveAttribute("aria-disabled", "true");
    expect(trigger()).not.toBeDisabled();
    expect(trigger()).toHaveAttribute("title", NOTHING); // the first item's reason
    const described = document.getElementById(trigger().getAttribute("aria-describedby") as string) as HTMLElement;
    expect(described).toHaveClass("sr-only");
    expect(described).toHaveTextContent(NOTHING);
    expect(trigger()).toHaveAccessibleDescription(NOTHING);
    expect(trigger()).not.toContainElement(described);
    await userEvent.click(trigger());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger()).toHaveFocus(); // the click left the focus where it landed
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("the hidden description is always there (empty while the button works), so a button that gets blocked does not add a node", () => {
    const view = mount();
    const hidden = () => document.getElementById(trigger().getAttribute("aria-describedby") as string) as HTMLElement;
    expect(hidden()).toHaveClass("sr-only");
    expect(hidden()).toHaveTextContent("");
    view.rerender(
      <>
        <BarMenu name="More ways to collapse" menuLabel="Collapse options" icon="caret" items={pair({ a: none("Everything is closed."), b: none("Everything is closed.") })} />
        <button type="button">Elsewhere</button>
      </>,
    );
    expect(hidden()).toHaveTextContent("Everything is closed.");
    expect(trigger()).toHaveAttribute("aria-disabled", "true");
  });

  it("one enabled item is enough for the button to open, with the other item showing why it cannot be used", async () => {
    mount({ items: pair({ a: none("Everything selected is already open.") }) });
    expect(trigger()).not.toHaveAttribute("aria-disabled");
    await userEvent.click(trigger());
    expect(menuItems()[0]).toHaveAttribute("aria-disabled", "true");
    expect(menuItems()[0]).toHaveTextContent("Everything selected is already open.");
  });

  it("`disabled` blocks a button whose items are not known until it opens: it says so and never opens", async () => {
    mount({ items: () => pair(), disabled: true });
    expect(trigger()).toHaveAttribute("aria-disabled", "true");
    expect(trigger()).not.toBeDisabled();
    await userEvent.click(trigger());
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("items given as a function are asked for when the menu opens, each time, not before", async () => {
    const make = vi.fn(() => pair());
    mount({ items: make });
    expect(make).not.toHaveBeenCalled();
    await userEvent.click(trigger());
    expect(make).toHaveBeenCalledTimes(1);
    expect(menuItems()).toHaveLength(2);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(trigger());
    expect(make).toHaveBeenCalledTimes(2);
  });

  it("a function that lists nothing opens no menu and leaves the focus on the button", async () => {
    mount({ items: () => [] });
    await userEvent.click(trigger());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });
});
