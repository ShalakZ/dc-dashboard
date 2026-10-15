import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { Asset } from "../api/types";
import { buildTree } from "../lib/tree";
import { AssetTree, type AssetTreeMove, type AssetTreeRemove } from "./AssetTree";

// W7s: the Delete button of the pick bar. The tree reports the picked ids, the button and the row to focus afterwards; the page deletes.
// Rows (tree order): Site 1 > (Room A 2 > Panel 1 3, Room B 4); Yard 5 > Shed 6.

const a = (id: number, parent_id: number | null, name: string): Asset => ({ id, parent_id, name, kind: "generic", sort_order: id });
const flat: Asset[] = [a(1, null, "Site"), a(2, 1, "Room A"), a(3, 2, "Panel 1"), a(4, 1, "Room B"), a(5, null, "Yard"), a(6, 5, "Shed")];

const moveApi = (): AssetTreeMove => ({ onDrop: vi.fn(), onMoveTo: vi.fn(), moved: null });
const removeApi = (): AssetTreeRemove => ({ onDelete: vi.fn() });
type Props = Partial<Parameters<typeof AssetTree>[0]>;
const ui = (props: Props = {}) => (
  <MemoryRouter>
    <AssetTree nodes={buildTree(flat)} selectedId={null} move={moveApi()} remove={removeApi()} {...props} />
  </MemoryRouter>
);

const slot = () => screen.getByRole("group", { name: "Selection" });
const hLink = (name: string) => screen.getByRole("link", { name, hidden: true });
const twisty = (name: string) => screen.getByRole("button", { name: `Children of ${name}`, hidden: true });
const deleteButton = () => within(slot()).getByRole("button", { name: /^Delete the / });
const queryDelete = () => within(slot()).queryByRole("button", { name: /^Delete/ });
const buttonNames = () => within(slot()).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
const pickedNames = () => [...document.querySelectorAll(".node[data-picked] a")].map((x) => x.textContent);

/** A Ctrl/Shift-click on a row's link. The default is cancelled so jsdom does not navigate on a click nobody handled. */
function click(name: string, init: MouseEventInit) {
  const spy = (e: Event) => e.preventDefault();
  document.addEventListener("click", spy);
  fireEvent.click(hLink(name), init);
  document.removeEventListener("click", spy);
}
const ctrlClick = (name: string) => click(name, { ctrlKey: true });
const shiftClick = (name: string) => click(name, { shiftKey: true });

const NOT_COUNTED = "The open asset is not counted unless it is also picked.";
const notCountedSentence = (name: string) => `The open asset, ${name}, is not counted.`;

describe("the Delete button of the pick bar", () => {
  it("is not drawn without a remove prop, picked or not (a role that may not delete)", () => {
    render(ui({ remove: undefined, selectedId: 4 }));
    expect(queryDelete()).not.toBeInTheDocument();
    ctrlClick("Room A");
    expect(slot()).toHaveTextContent("1 picked");
    expect(queryDelete()).not.toBeInTheDocument();
    expect(buttonNames()).toEqual(["Move to...", "Clear"]);
  });

  it("is not drawn while nothing is picked, not even with an asset open (the open asset's own Delete is on its page)", () => {
    render(ui({ selectedId: 4 }));
    expect(within(slot()).getByRole("button", { name: "Move to..." })).toBeInTheDocument();
    expect(queryDelete()).not.toBeInTheDocument();
    expect(buttonNames()).toEqual(["Move to..."]);
  });

  it("appears with the first pick between Move to... and Clear, is named for the picks and says Delete", () => {
    render(ui());
    ctrlClick("Room A");
    const one = deleteButton();
    expect(one).toHaveAccessibleName("Delete the picked asset");
    expect(one).toHaveTextContent(/^Delete$/); // the visible word is inside the name (label in name)
    expect(one).toHaveAttribute("type", "button");
    expect(buttonNames()).toEqual(["Move to...", "Delete the picked asset", "Clear"]);
    ctrlClick("Shed");
    expect(deleteButton()).toHaveAccessibleName("Delete the 2 picked assets");
    expect(deleteButton()).toHaveTextContent(/^Delete$/);
    expect(buttonNames()).toEqual(["Move to...", "Delete the 2 picked assets", "Clear"]);
  });

  it("goes with the last pick (Clear)", async () => {
    render(ui());
    ctrlClick("Room A");
    expect(deleteButton()).toBeInTheDocument();
    await userEvent.click(within(slot()).getByRole("button", { name: "Clear" }));
    expect(queryDelete()).not.toBeInTheDocument();
  });

  it("is never drawn without move, even when remove is given: picking is the move feature's", () => {
    render(ui({ move: undefined, remove: removeApi(), selectedId: 4 }));
    expect(screen.queryByRole("group", { name: "Selection" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
    ctrlClick("Room A"); // left to the browser: nothing is picked
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
  });

  it("hands the page the picked ids (not the open asset), the button and the row to focus afterwards, and leaves the picks alone", async () => {
    const remove = removeApi();
    render(ui({ remove, selectedId: 4 })); // Room B is open, Room A and Shed are picked
    ctrlClick("Room A");
    ctrlClick("Shed");
    const button = deleteButton();
    await userEvent.click(button);
    expect(remove.onDelete).toHaveBeenCalledTimes(1);
    // Room A takes Panel 1 with it, so the first row left after it is Room B.
    expect(remove.onDelete).toHaveBeenCalledWith([2, 6], button, 4);
    expect(vi.mocked(remove.onDelete).mock.calls[0][1]).toBe(button);
    expect(pickedNames()).toEqual(["Room A", "Shed"]);
  });

  it("takes the focus row from the rows on screen: a folded branch is skipped", async () => {
    const remove = removeApi();
    render(ui({ remove }));
    await userEvent.click(twisty("Site")); // Room A, Panel 1 and Room B are hidden
    ctrlClick("Yard"); // Yard and Shed go; nothing is left after them, so the row before: Site (unfolded it would be Room B)
    await userEvent.click(deleteButton());
    expect(remove.onDelete).toHaveBeenCalledWith([5], deleteButton(), 1);
  });

  it("takes the focus row from the rows on screen: a filter hides the rest", async () => {
    const remove = removeApi();
    render(ui({ remove }));
    await userEvent.type(screen.getByLabelText("Filter assets"), "room"); // Site, Room A, Room B
    ctrlClick("Room B"); // nothing on screen after it, so the row before: Room A (unfiltered the row after it would be Yard)
    await userEvent.click(deleteButton());
    expect(remove.onDelete).toHaveBeenCalledWith([4], deleteButton(), 2);
  });

  it("sends null when no row is left to take the focus", async () => {
    const remove = removeApi();
    render(ui({ remove, nodes: buildTree([a(1, null, "Only")]) }));
    ctrlClick("Only");
    await userEvent.click(deleteButton());
    expect(remove.onDelete).toHaveBeenCalledWith([1], deleteButton(), null);
  });

  it("reads the picks at the press, not as of an earlier render", async () => {
    const remove = removeApi();
    render(ui({ remove }));
    ctrlClick("Room A");
    ctrlClick("Yard");
    ctrlClick("Room A"); // off again
    await userEvent.click(deleteButton());
    expect(remove.onDelete).toHaveBeenCalledWith([5], deleteButton(), 4); // Yard and Shed go; the row before is Room B
  });

  it("keeps its focus and does nothing while the page is busy (aria-disabled, not disabled)", async () => {
    const remove = removeApi();
    render(ui({ remove, disabled: true }));
    ctrlClick("Room A");
    const button = deleteButton();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toBeEnabled(); // never the native attribute: a button that has the focus must not lose it
    button.focus();
    await userEvent.click(button);
    expect(remove.onDelete).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
  });

  it("is not aria-disabled while the page is free", () => {
    render(ui());
    ctrlClick("Room A");
    expect(deleteButton()).not.toHaveAttribute("aria-disabled");
  });
});

describe("the count and the open asset", () => {
  it("says the open asset is not counted when something is picked, an asset is open and it is not picked (title, and a sentence for screen readers)", () => {
    render(ui({ selectedId: 4 }));
    ctrlClick("Room A");
    expect(slot()).toHaveTextContent("1 picked");
    expect(within(slot()).getByText("1 picked")).toHaveAttribute("title", NOT_COUNTED);
    const sentence = within(slot()).getByText(notCountedSentence("Room B"));
    expect(sentence).toHaveClass("sr-only"); // read, not drawn
  });

  it("names the open asset as written", () => {
    render(ui({ selectedId: 5 }));
    ctrlClick("Shed");
    expect(within(slot()).getByText(notCountedSentence("Yard"))).toBeInTheDocument();
  });

  it("goes away when the open asset is picked too", () => {
    render(ui({ selectedId: 4 }));
    ctrlClick("Room A");
    expect(within(slot()).getByText(notCountedSentence("Room B"))).toBeInTheDocument();
    ctrlClick("Room B");
    expect(slot()).toHaveTextContent("2 picked");
    expect(within(slot()).queryByText(notCountedSentence("Room B"))).not.toBeInTheDocument();
    expect(within(slot()).getByText("2 picked")).not.toHaveAttribute("title");
  });

  it("is not there when nothing is picked (the hint is the text) or no asset is open", async () => {
    render(ui({ selectedId: 4 }));
    expect(slot()).toHaveTextContent("Ctrl-click to pick several");
    expect(slot().querySelector(".sr-only")).toBeNull();
    expect(slot().querySelector("[title]")?.getAttribute("title")).not.toBe(NOT_COUNTED);
    ctrlClick("Room A");
    await userEvent.click(within(slot()).getByRole("button", { name: "Clear" }));
    expect(slot().querySelector(".sr-only")).toBeNull();
  });

  it("is not there without an open asset", () => {
    render(ui({ selectedId: null }));
    ctrlClick("Room A");
    expect(slot().querySelector(".sr-only")).toBeNull();
    expect(within(slot()).getByText("1 picked")).not.toHaveAttribute("title");
  });

  it("follows a swap of one pick for another that leaves the count alone (the slot reads the whole pick state)", () => {
    render(ui({ selectedId: 4 }));
    ctrlClick("Yard"); // the anchor
    shiftClick("Room B"); // Room B (the open asset) and Yard
    expect(pickedNames()).toEqual(["Room B", "Yard"]);
    expect(slot()).toHaveTextContent("2 picked");
    expect(slot().querySelector(".sr-only")).toBeNull();
    shiftClick("Shed"); // Yard and Shed: still 2 picked, the open asset is no longer one of them
    expect(pickedNames()).toEqual(["Yard", "Shed"]);
    expect(slot()).toHaveTextContent("2 picked");
    expect(within(slot()).getByText(notCountedSentence("Room B"))).toBeInTheDocument();
    expect(within(slot()).getByText("2 picked")).toHaveAttribute("title", NOT_COUNTED);
  });
});

describe("has-delete: the slot that is two lines high in a narrow column", () => {
  it("is on the slot exactly when remove is given", () => {
    const view = render(ui());
    expect(slot()).toHaveClass("tree-slot", "has-delete");
    view.rerender(ui({ remove: undefined }));
    expect(slot()).toHaveClass("tree-slot");
    expect(slot()).not.toHaveClass("has-delete");
  });

  it("is on the skeleton's placeholder slot too, so the loading column is as high as the loaded one", () => {
    const view = render(ui({ nodes: [], loading: true }));
    const placeholder = screen.getByRole("status").querySelector(".tree-slot")!;
    expect(placeholder).toHaveClass("has-delete");
    expect(placeholder).toBeEmptyDOMElement();
    expect(placeholder).toHaveAttribute("aria-hidden", "true");
    view.rerender(ui({ nodes: [], loading: true, remove: undefined }));
    const plain = screen.getByRole("status").querySelector(".tree-slot")!;
    expect(plain).not.toHaveClass("has-delete");
  });

  it("is not on a placeholder that does not exist: no move, no slot", () => {
    render(ui({ nodes: [], loading: true, move: undefined }));
    expect(screen.getByRole("status").querySelector(".tree-slot")).toBeNull();
  });
});
