import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FindEntry, FindResult } from "../../lib/graphFind";
import { Icon, type IconName } from "../Icon";
import { FindBox } from "./FindBox";

const entry = (id: string, kind: FindEntry["kind"], label: string, context: string, icon: IconName): FindEntry => ({ id, kind, label, context, icon, text: `${label} ${context}`.toLowerCase() });
const ENTRIES = [
  entry("src:1", "source", "Plant OPC", "source · opc.tcp://plc:4840", "protoOpcua"),
  entry("pt:3", "point", "LVP01 kW", "point in LVP01 · Plant OPC", "metricVoltage"),
  entry("asset:10", "asset", "LVP room", "asset · room", "kindRoom"),
];
/** The markup an icon draws, to compare with what an option shows. */
const drawn = (name: IconName) => {
  const { container, unmount } = render(<Icon name={name} />);
  const html = container.querySelector("svg")!.innerHTML;
  unmount();
  return html;
};
/** A search over ENTRIES: every term a substring of the entry's text; `more` is whatever the test says. */
const searcher = (more = 0) => (query: string): FindResult => ({
  items: ENTRIES.filter((e) => query.toLowerCase().split(/\s+/).every((term) => e.text.includes(term))),
  more,
});

function open(props: Partial<React.ComponentProps<typeof FindBox>> = {}) {
  const onChoose = vi.fn();
  const onClose = vi.fn();
  const view = render(<FindBox search={searcher()} onChoose={onChoose} onClose={onClose} {...props} />);
  return { onChoose, onClose, ...view, input: screen.getByRole("combobox") };
}
const options = () => screen.queryAllByRole("option");

// Elements a test puts on the body next to the rendered card: removed after every test, so a failing one cannot leak into the next.
const added: HTMLElement[] = [];
const add = (el: HTMLElement) => {
  document.body.append(el);
  added.push(el);
  return el;
};
afterEach(() => added.splice(0).forEach((el) => el.remove()));

describe("FindBox", () => {
  it("is an ARIA combobox named 'Search the graph' whose input takes the focus; no listbox and one live line while there is no query", () => {
    const { input } = open();
    expect(input).toHaveFocus();
    expect(screen.getByLabelText("Search the graph")).toBe(input);
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).not.toHaveAttribute("aria-controls");
    expect(input).not.toHaveAttribute("aria-activedescendant");
    expect(screen.queryByRole("listbox")).toBeNull();
    const live = document.querySelector("[aria-live]");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("");
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it("no control's name contains 'find' (Playwright matches names by substring)", () => {
    open();
    for (const name of [screen.getByRole("combobox").getAttribute("aria-label") ?? "", "Search the graph"]) expect(name.toLowerCase()).not.toContain("find");
    expect(screen.getByRole("search")).toHaveAccessibleName("Graph search");
  });

  it("typing lists the matches: the listbox appears, the combobox points at it and at the first option, and the live line counts them", async () => {
    const { input } = open();
    await userEvent.type(input, "lvp");
    expect(input).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("listbox");
    expect(input).toHaveAttribute("aria-controls", list.id);
    expect(options().map((o) => o.querySelector(".graph-find-label")?.textContent)).toEqual(["LVP01 kW", "LVP room"]);
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    expect(options()[1]).toHaveAttribute("aria-selected", "false");
    expect(input).toHaveAttribute("aria-activedescendant", options()[0].id);
    expect(document.querySelector("[aria-live]")).toHaveTextContent("2 results");
    expect(options()[0]).toHaveTextContent("point in LVP01 · Plant OPC"); // the muted second line
  });

  it("draws each option's own icon (its entry's, not one per kind), decorative", async () => {
    const { input } = open();
    await userEvent.type(input, "lvp");
    const [point, room] = options();
    expect(point.querySelector("svg")!.innerHTML).toBe(drawn("metricVoltage"));
    expect(room.querySelector("svg")!.innerHTML).toBe(drawn("kindRoom"));
    expect(point.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("takes the icon from the entry, so two points of one kind can differ", async () => {
    const two = [entry("pt:1", "point", "Alpha V", "x", "metricVoltage"), entry("pt:2", "point", "Alpha A", "x", "metricCurrent")];
    const { input } = open({ search: () => ({ items: two, more: 0 }) });
    await userEvent.type(input, "alpha");
    const [volts, amps] = options();
    expect(volts.querySelector("svg")!.innerHTML).toBe(drawn("metricVoltage"));
    expect(amps.querySelector("svg")!.innerHTML).toBe(drawn("metricCurrent"));
    expect(volts.querySelector("svg")!.innerHTML).not.toBe(amps.querySelector("svg")!.innerHTML);
  });

  it("says '1 result' for one, 'No match' for none, and how many more there are when the search cut the list off", async () => {
    const view = open();
    await userEvent.type(view.input, "plant opc");
    expect(document.querySelector("[aria-live]")).toHaveTextContent(/^2 results$/);
    await userEvent.clear(view.input);
    await userEvent.type(view.input, "plant opc lvp01");
    expect(document.querySelector("[aria-live]")).toHaveTextContent(/^1 result$/);
    await userEvent.clear(view.input);
    await userEvent.type(view.input, "zzz");
    expect(document.querySelector("[aria-live]")).toHaveTextContent("No match");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(view.input).toHaveAttribute("aria-expanded", "false");
    view.rerender(<FindBox search={searcher(74)} onChoose={view.onChoose} onClose={view.onClose} />);
    await userEvent.clear(view.input);
    await userEvent.type(view.input, "lvp");
    expect(document.querySelector("[aria-live]")).toHaveTextContent("2 results, 74 more not shown");
  });

  it("ArrowDown and ArrowUp move the active option and wrap round at both ends; the focus stays in the field", async () => {
    const { input } = open();
    await userEvent.type(input, "o"); // all three entries contain an o
    expect(options()).toHaveLength(3);
    const active = () => options().findIndex((o) => o.getAttribute("aria-selected") === "true");
    expect(active()).toBe(0);
    await userEvent.keyboard("{ArrowDown}");
    expect(active()).toBe(1);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(active()).toBe(0); // wrapped
    await userEvent.keyboard("{ArrowUp}");
    expect(active()).toBe(2); // wrapped the other way
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-activedescendant", options()[2].id);
  });

  it("Enter chooses the active option: the card closes first, then onChoose gets the entry", async () => {
    const order: string[] = [];
    const onChoose = vi.fn(() => order.push("choose"));
    const onClose = vi.fn(() => order.push("close"));
    const { input } = open({ onClose, onChoose });
    await userEvent.type(input, "lvp{ArrowDown}{Enter}");
    expect(onChoose).toHaveBeenCalledWith(ENTRIES[2]);
    expect(order).toEqual(["close", "choose"]);
  });

  it("Enter with no result does nothing; a click on an option chooses it", async () => {
    const { input, onChoose, onClose } = open();
    await userEvent.type(input, "zzz{Enter}");
    expect(onChoose).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, "lvp");
    await userEvent.click(options()[1]);
    expect(onChoose).toHaveBeenCalledWith(ENTRIES[2]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("choosing puts the focus back where it was before the box opened, before onChoose runs (never on <body> while the camera moves)", async () => {
    const elsewhere = document.createElement("button");
    elsewhere.textContent = "canvas";
    add(elsewhere);
    elsewhere.focus();
    let focusInChoose: Element | null = null;
    const { input } = open({ onChoose: vi.fn(() => { focusInChoose = document.activeElement; }) });
    expect(input).toHaveFocus();
    await userEvent.type(input, "plant{Enter}");
    expect(focusInChoose).toBe(elsewhere);
    elsewhere.remove();
  });

  it("Escape closes, gives the focus back to whatever had it, and is heard by nobody else (a dialog around it stays)", async () => {
    const before = document.createElement("button");
    before.textContent = "before";
    add(before);
    before.focus();
    const heard = vi.fn();
    const onDocument = (event: KeyboardEvent) => heard(event.key);
    document.addEventListener("keydown", onDocument);
    const parent = vi.fn();
    const { onClose, input } = open();
    document.body.addEventListener("keydown", parent);
    await userEvent.type(input, "lv{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(before).toHaveFocus();
    expect(heard).not.toHaveBeenCalledWith("Escape");
    document.removeEventListener("keydown", onDocument);
    document.body.removeEventListener("keydown", parent);
    before.remove();
  });

  it("with nothing sensible to go back to (the body had the focus) the focus goes to the trigger", async () => {
    const trigger = document.createElement("button");
    add(trigger);
    const { input, onClose } = open({ trigger: { current: trigger } });
    await userEvent.type(input, "{Escape}");
    expect(trigger).toHaveFocus();
    expect(onClose).toHaveBeenCalled();
    trigger.remove();
  });

  it("a press outside closes it; a press inside, or on the trigger (whose click toggles), does not", async () => {
    const trigger = document.createElement("button");
    add(trigger);
    const { input, onClose } = open({ trigger: { current: trigger } });
    fireEvent.pointerDown(input);
    fireEvent.pointerDown(trigger);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    trigger.remove();
  });

  it("the focus leaving for something outside closes it (Tab out); moving inside does not", async () => {
    const outside = document.createElement("button");
    add(outside);
    const { input, onClose } = open();
    fireEvent.blur(input, { relatedTarget: input });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.blur(input, { relatedTarget: outside });
    expect(onClose).toHaveBeenCalledTimes(1);
    outside.remove();
  });

  it("the active option survives a new search function that returns the same results (a graph refresh while the box is open)", async () => {
    const view = open();
    await userEvent.type(view.input, "o");
    await userEvent.keyboard("{ArrowDown}");
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    view.rerender(<FindBox search={searcher()} onChoose={view.onChoose} onClose={view.onClose} />);
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    expect(view.input).toHaveAttribute("aria-activedescendant", options()[1].id);
    view.rerender(<FindBox search={(q) => ({ items: searcher()(q).items.slice(2), more: 0 })} onChoose={view.onChoose} onClose={view.onClose} />);
    expect(options()).toHaveLength(1); // the active one is gone: the first option is active
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
  });

  it("a new query starts at the first option again", async () => {
    const { input } = open();
    await userEvent.type(input, "o{ArrowDown}{ArrowDown}");
    expect(options()[2]).toHaveAttribute("aria-selected", "true");
    await userEvent.type(input, "p");
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
  });

  it("Ctrl+K inside the box selects the text and goes no further (the top bar's quick find must not steal it)", async () => {
    const { input } = open();
    await userEvent.type(input, "lvp");
    const heard = vi.fn();
    document.addEventListener("keydown", heard);
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { input.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(heard).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).selectionStart).toBe(0);
    expect((input as HTMLInputElement).selectionEnd).toBe(3);
    document.removeEventListener("keydown", heard);
  });

  it("a press on an option does not take the focus from the field (the click would be lost)", async () => {
    const { input } = open();
    await userEvent.type(input, "lvp");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    options()[0].dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(input).toHaveFocus();
  });

  it("holds no button of its own: the options are list items, not buttons", async () => {
    const { input } = open();
    await userEvent.type(input, "lvp");
    expect(within(screen.getByRole("search")).queryAllByRole("button")).toHaveLength(0);
  });
});
