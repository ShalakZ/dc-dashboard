import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { graphCounts, graphSummary, type ActionState } from "../../lib/graphView";
import { parseRules, stripComments } from "../../test/cssTools";
import { model } from "../../test/graphFixtures";
import { GraphBar } from "./GraphBar";

const ok: ActionState = { enabled: true };
const none = (reason: string): ActionState => ({ enabled: false, reason });
const NOTHING = "Select a source, group or asset first.";

const COUNTS = { sources: 3, points: 120, mapped: 6, needing: 0, unmapped: 114 };

function bar(over: Partial<React.ComponentProps<typeof GraphBar>> = {}) {
  const findRef = createRef<HTMLButtonElement>();
  const refreshRef = createRef<HTMLButtonElement>();
  const props: React.ComponentProps<typeof GraphBar> = {
    summary: "3 sources, 120 points, 6 mapped", counts: COUNTS,
    collapsible: true, expandable: true, tidying: false, unmappedOnly: false,
    onUnmappedOnly: vi.fn(), onCollapseAll: vi.fn(), onExpandAll: vi.fn(), onTidy: vi.fn(),
    expandSelection: ok, collapseSelection: ok, expandBranch: ok, collapseBranch: ok,
    onExpandSelection: vi.fn(), onCollapseSelection: vi.fn(), onExpandBranch: vi.fn(), onCollapseBranch: vi.fn(),
    snap: true, onSnap: vi.fn(),
    find: { open: false, cardId: "find-card", onToggle: vi.fn(), buttonRef: findRef },
    onRefresh: vi.fn(), refreshRef,
    clear: { count: 3, onClear: vi.fn() },
    shortcuts: <button type="button" aria-label="Keyboard shortcuts and controls">?</button>,
    onFindKey: vi.fn(),
    ...over,
  };
  return { props, findRef, refreshRef, ...render(<GraphBar {...props} />) };
}
const root = () => document.querySelector(".graph-bar") as HTMLElement;
const collapseMore = () => screen.getByRole("button", { name: "More ways to collapse" });
const expandMore = () => screen.getByRole("button", { name: "More ways to expand" });
const overflow = () => screen.getByRole("button", { name: "More Discovery actions" });
const menuItems = () => screen.getAllByRole("menuitem");
const switchLabel = () => screen.getByRole("switch", { name: "Unmapped only" }).closest("label") as HTMLElement;

/** What the bar's CSS does to the three controls it hides in a narrow bar: jsdom has no stylesheet, so the test hides the inline copies itself. */
function hideNarrow(...names: Array<"Unmapped only" | "Tidy layout" | "Snap to grid">) {
  for (const name of names) {
    const copy = name === "Unmapped only" ? switchLabel() : screen.getByRole("button", { name });
    copy.style.display = "none";
  }
}

describe("GraphBar", () => {
  it("is three named groups, View, Canvas and Page controls, behind the chips, with the buttons in order and the switch among the view controls", () => {
    bar();
    expect(root()).toHaveClass("graph-bar");
    const names = (el: HTMLElement) => within(el).queryAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
    const view = screen.getByRole("group", { name: "View controls" });
    const canvas = screen.getByRole("group", { name: "Canvas controls" });
    const page = screen.getByRole("group", { name: "Page controls" });
    expect(names(view)).toEqual(["Collapse all", "More ways to collapse", "Expand all", "More ways to expand", "Tidy layout"]);
    expect(within(view).getByRole("switch", { name: "Unmapped only" })).toBeInTheDocument();
    expect(names(canvas)).toEqual(["Find", "Snap to grid"]);
    expect(names(page)).toEqual(["Refresh", "Keyboard shortcuts and controls", "More Discovery actions"]);
    // left to right: chips, view, canvas, page
    const order = [root().querySelector(".gbar-chips"), view, canvas, page] as HTMLElement[];
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const button of within(root()).getAllByRole("button")) expect(button).toHaveAttribute("type", "button");
    expect(screen.queryByRole("checkbox")).toBeNull(); // a switch, not a checkbox
  });

  it("the dividers between the groups are decoration: aria-hidden, three of them", () => {
    bar();
    const dividers = root().querySelectorAll(".gbar-divider");
    expect(dividers).toHaveLength(3);
    for (const divider of dividers) expect(divider).toHaveAttribute("aria-hidden", "true");
  });

  it("the summary is the one polite announcer (no role), whole in its title, and no other element of the bar is a live region", () => {
    bar();
    const live = root().querySelectorAll("[aria-live], [role='status'], [role='alert']");
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveClass("graph-summary");
    expect(live[0].tagName).toBe("P");
    expect(live[0]).toHaveAttribute("aria-live", "polite");
    expect(live[0]).toHaveAttribute("aria-atomic", "true");
    expect(live[0]).not.toHaveAttribute("role");
    expect(live[0]).not.toHaveAttribute("aria-hidden");
    expect(live[0]).toHaveAttribute("title", "3 sources, 120 points, 6 mapped");
    expect(live[0]).toHaveTextContent("3 sources, 120 points, 6 mapped");
  });

  describe("the chips", () => {
    const chips = () => Array.from(root().querySelectorAll<HTMLElement>(".gbar-chip"));

    it("show the counts: sources, points and mapped, each decoration (aria-hidden) with its words in its title", () => {
      bar();
      expect(chips().map((c) => c.getAttribute("title"))).toEqual(["3 sources", "120 points", "6 mapped"]);
      expect(chips().map((c) => c.querySelector(".gbar-chip-num")?.textContent)).toEqual(["3", "120", "6"]);
      expect(chips().map((c) => c.querySelector(".gbar-chip-word")?.textContent)).toEqual(["sources", "points", "mapped"]);
      for (const chip of chips()) {
        expect(chip).toHaveAttribute("aria-hidden", "true");
        expect(chip.querySelector("svg.i")).not.toBeNull();
      }
    });

    it("say one source and one point in the singular", () => {
      bar({ counts: { sources: 1, points: 1, mapped: 0, needing: 0, unmapped: 1 } });
      expect(chips().map((c) => c.getAttribute("title"))).toEqual(["1 source", "1 point", "0 mapped"]);
    });

    it("gain a chip for sources that need credentials, in the summary's words", () => {
      const one = bar({ counts: { ...COUNTS, needing: 1 } });
      expect(chips().map((c) => c.getAttribute("title"))).toEqual(["3 sources", "120 points", "6 mapped", "1 needs credentials"]);
      one.unmount();
      bar({ counts: { ...COUNTS, needing: 2 } });
      expect(chips()[3]).toHaveAttribute("title", "2 need credentials");
    });

    it("with the Unmapped only filter on, the points chip says how many points that leaves", () => {
      bar({ unmappedOnly: true, counts: { ...COUNTS, unmapped: 42 } });
      expect(chips()[1]).toHaveAttribute("title", "42 of 120 points");
      expect(chips()[1].querySelector(".gbar-chip-num")).toHaveTextContent("42 of 120");
      expect(chips()[1].querySelector(".gbar-chip-word")).toHaveTextContent("points");
    });

    it("are \"wide\" (gbar-chips-wide on the row) when a credentials chip is drawn or a count has four digits, and plain otherwise", () => {
      const wide = () => root().querySelector(".gbar-chips")!.classList.contains("gbar-chips-wide");
      const cases: Array<[string, Partial<typeof COUNTS>, boolean]> = [
        ["the typical set", {}, false],
        ["the dev data (4 sources, 180 points, 62 mapped)", { sources: 4, points: 180, mapped: 62 }, false],
        ["the widest normal set (999 of each)", { sources: 999, points: 999, mapped: 999 }, false],
        ["one source needing credentials", { needing: 1 }, true],
        ["two sources needing credentials", { needing: 2 }, true],
        ["1,000 sources", { sources: 1000 }, true],
        ["1,000 points", { points: 1000 }, true],
        ["1,000 mapped", { mapped: 1000 }, true],
      ];
      for (const [name, over, expected] of cases) {
        const { unmount } = bar({ counts: { ...COUNTS, ...over } });
        expect(wide(), name).toBe(expected);
        unmount();
      }
    });

    it("the class never comes from the \"N of M\" text: turning Unmapped only on or off leaves it as it was", () => {
      const wide = () => root().querySelector(".gbar-chips")!.classList.contains("gbar-chips-wide");
      for (const counts of [{ ...COUNTS, points: 999, unmapped: 999 }, { ...COUNTS, points: 1500, unmapped: 1200 }]) {
        const off = bar({ counts, unmappedOnly: false });
        const before = wide();
        off.unmount();
        const on = bar({ counts, unmappedOnly: true });
        expect(wide(), `${counts.points} points`).toBe(before);
        on.unmount();
      }
    });

    it("are the numbers of the summary sentence, whatever the graph and the filter", () => {
      const m = model();
      for (const unmappedOnly of [false, true]) {
        const view = { unmappedOnly } as never;
        const summary = graphSummary(m, view);
        const { unmount } = bar({ summary, counts: graphCounts(m, view), unmappedOnly });
        for (const chip of chips()) expect(summary, `"${chip.getAttribute("title")}" is in "${summary}"`).toContain(chip.getAttribute("title"));
        unmount();
      }
    });
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
      expect(screen.getByRole("button", { name })).toHaveAttribute("title", name); // a tooltip for the bar that has lost its words
    }
    view.unmount();

    const idle = bar({ collapsible: false, expandable: false, tidying: true });
    for (const [name, title] of [["Collapse all", "Nothing is open"], ["Expand all", "Everything is open"], ["Tidy layout", "Tidy layout"]] as const) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).not.toBeDisabled();
      expect(button).toHaveAttribute("title", title);
      await userEvent.click(button);
    }
    expect(idle.props.onCollapseAll).not.toHaveBeenCalled();
    expect(idle.props.onExpandAll).not.toHaveBeenCalled();
    expect(idle.props.onTidy).not.toHaveBeenCalled();
  });

  it("every word of a control sits in a span the CSS can hide visually, so an icon-only bar keeps every name", () => {
    bar();
    const words = ["Collapse all", "Expand all", "Tidy layout", "Find", "Snap to grid", "Unmapped only"];
    for (const word of words) {
      const control = word === "Unmapped only" ? switchLabel() : screen.getByRole("button", { name: word });
      expect(control.querySelector(".gbar-lbl"), word).toHaveTextContent(word);
      expect(control.querySelector("svg.i"), `${word} has an icon`).not.toBeNull();
    }
  });

  it("each word has its own class, so the stylesheet can take the words out one control at a time, and every such control keeps a tooltip with them", () => {
    bar();
    const classes = {
      "Snap to grid": "gbar-lbl-snap", "Find": "gbar-lbl-find", "Tidy layout": "gbar-lbl-tidy",
      "Unmapped only": "gbar-lbl-unmapped", "Collapse all": "gbar-lbl-fold", "Expand all": "gbar-lbl-fold",
    } as const;
    for (const [word, cls] of Object.entries(classes)) {
      const control = word === "Unmapped only" ? switchLabel() : screen.getByRole("button", { name: word });
      const span = control.querySelector(".gbar-lbl") as HTMLElement;
      expect(span, word).toHaveClass(cls);
      expect(control.getAttribute("title"), `${word} has a tooltip`).toContain(word);
      // the classes that mean "this word is dropped" belong to this one word: nothing else in the control carries one
      expect([...control.querySelectorAll("[class*='gbar-lbl-']")], word).toEqual([span]);
    }
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

  describe("Snap to grid", () => {
    it.each([[true], [false]])("reports its state in aria-pressed (snap=%s) and a click asks for the opposite", async (on) => {
      const { props } = bar({ snap: on });
      const snap = screen.getByRole("button", { name: "Snap to grid" });
      expect(snap).toHaveAttribute("aria-pressed", String(on));
      await userEvent.click(snap);
      expect(props.onSnap).toHaveBeenCalledWith(!on);
    });

    it.each([[true], [false]])("keeps the title \"Snap to grid\" whichever its state (snap=%s): the state is aria-pressed's, a title that differs from the name would be read twice", (on) => {
      bar({ snap: on });
      expect(screen.getByRole("button", { name: "Snap to grid" })).toHaveAttribute("title", "Snap to grid");
    });
  });

  describe("Find", () => {
    it("is the Find button with the page's open state and card id, and a click asks for a toggle", async () => {
      const closed = bar();
      const find = screen.getByRole("button", { name: "Find" });
      expect(find).toHaveAttribute("aria-expanded", "false");
      expect(find).not.toHaveAttribute("aria-controls");
      expect(closed.findRef.current).toBe(find);
      await userEvent.click(find);
      expect(closed.props.find.onToggle).toHaveBeenCalledTimes(1);
      closed.unmount();

      bar({ find: { open: true, cardId: "the-card", onToggle: vi.fn(), buttonRef: createRef() } });
      expect(screen.getByRole("button", { name: "Find" })).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("button", { name: "Find" })).toHaveAttribute("aria-controls", "the-card");
    });

    it("Ctrl+K and Cmd+K on the bar call onFindKey and are consumed (the top bar's quick find must not also open)", () => {
      const { props } = bar();
      const button = screen.getByRole("button", { name: "Tidy layout" });
      expect(fireEvent.keyDown(button, { key: "k", ctrlKey: true })).toBe(false);
      expect(fireEvent.keyDown(button, { key: "K", metaKey: true })).toBe(false);
      expect(props.onFindKey).toHaveBeenCalledTimes(2);
    });

    it("other keys, Ctrl+Shift+K and Ctrl+Alt+K are left alone", () => {
      const { props } = bar();
      const button = screen.getByRole("button", { name: "Tidy layout" });
      expect(fireEvent.keyDown(button, { key: "k" })).toBe(true);
      expect(fireEvent.keyDown(button, { key: "j", ctrlKey: true })).toBe(true);
      expect(fireEvent.keyDown(button, { key: "k", ctrlKey: true, shiftKey: true })).toBe(true);
      expect(fireEvent.keyDown(button, { key: "k", ctrlKey: true, altKey: true })).toBe(true);
      expect(props.onFindKey).not.toHaveBeenCalled();
    });

    it("is not heard from inside the Find card or a menu: those keep their own Ctrl+K", async () => {
      const { props } = bar({ shortcuts: <div className="graph-find"><input aria-label="inside the card" /></div> });
      expect(fireEvent.keyDown(screen.getByLabelText("inside the card"), { key: "k", ctrlKey: true })).toBe(true);
      await userEvent.click(collapseMore());
      expect(fireEvent.keyDown(menuItems()[0], { key: "k", ctrlKey: true })).toBe(true);
      expect(props.onFindKey).not.toHaveBeenCalled();
    });
  });

  describe("Refresh", () => {
    it("is an icon button named Refresh, reached by the page's ref, and a click calls back", async () => {
      const { props, refreshRef } = bar();
      const refresh = screen.getByRole("button", { name: "Refresh" });
      expect(refresh).toHaveAttribute("type", "button");
      expect(refresh).toHaveTextContent("");
      expect(refresh.querySelector("svg.i")).not.toBeNull();
      expect(refreshRef.current).toBe(refresh);
      await userEvent.click(refresh);
      expect(props.onRefresh).toHaveBeenCalledTimes(1);
    });
  });

  it("the page's shortcuts control is drawn among the page controls", () => {
    bar();
    expect(within(screen.getByRole("group", { name: "Page controls" })).getByRole("button", { name: "Keyboard shortcuts and controls" })).toBeInTheDocument();
  });

  describe("the overflow menu", () => {
    it("is a menu button named More Discovery actions; a role that may clear unmapped sees it at every width (no narrow-only class)", () => {
      bar();
      expect(overflow()).toHaveAttribute("aria-haspopup", "menu");
      expect(overflow()).toHaveAttribute("aria-expanded", "false");
      expect(overflow()).toHaveAttribute("type", "button");
      expect(overflow()).toHaveClass("gbar-overflow");
      expect(overflow()).not.toHaveClass("gbar-overflow-narrow");
      expect(overflow().querySelector("svg.i")).not.toBeNull();
    });

    it("holds Clear unmapped (N) for the role that has it, and only that while every control is drawn in the bar", async () => {
      bar();
      await userEvent.click(overflow());
      expect(screen.getByRole("menu", { name: "Discovery actions" })).toBeInTheDocument();
      expect(menuItems().map((i) => i.textContent)).toEqual(["Clear unmapped (3)"]);
    });

    it("Clear unmapped calls back after the focus is back on the overflow button (so the dialog it opens gives the focus back there)", async () => {
      const seen: Array<Element | null> = [];
      const onClear = vi.fn(() => { seen.push(document.activeElement); });
      bar({ clear: { count: 3, onClear } });
      await userEvent.click(overflow());
      await userEvent.click(screen.getByRole("menuitem", { name: "Clear unmapped (3)" }));
      expect(onClear).toHaveBeenCalledTimes(1);
      expect(seen[0]).toBe(overflow());
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("with nothing to clear the item is aria-disabled with its reason, and a click does nothing", async () => {
      const onClear = vi.fn();
      bar({ clear: { count: 0, onClear } });
      await userEvent.click(overflow());
      const item = screen.getByRole("menuitem", { name: /Clear unmapped \(0\)/ });
      expect(item).toHaveAttribute("aria-disabled", "true");
      expect(item).toHaveAttribute("title", "Nothing to clear");
      expect(item).toHaveTextContent("Nothing to clear");
      await userEvent.click(item);
      expect(onClear).not.toHaveBeenCalled();
    });

    it("a role without Clear unmapped gets the narrow-only modifier class on the button, so a reader at a wide bar sees a button that opens nothing nowhere", () => {
      bar({ clear: undefined });
      expect(overflow()).toHaveClass("gbar-overflow", "gbar-overflow-narrow");
    });

    it("a role without Clear unmapped and a bar that draws everything opens no menu", async () => {
      bar({ clear: undefined });
      await userEvent.click(overflow());
      expect(screen.queryByRole("menu")).toBeNull();
      expect(overflow()).toHaveFocus();
    });

    it("lists a narrow control only when its copy in the bar is not drawn (display: none), each in exactly one place", async () => {
      bar({ clear: undefined, snap: false });
      hideNarrow("Tidy layout");
      await userEvent.click(overflow());
      expect(menuItems().map((i) => i.textContent)).toEqual(["Tidy layout"]);
      await userEvent.keyboard("{Escape}");

      hideNarrow("Unmapped only", "Snap to grid");
      await userEvent.click(overflow());
      expect(menuItems().map((i) => i.textContent)).toEqual(["Turn on Unmapped only", "Tidy layout", "Turn on Snap to grid"]);
    });

    it("the narrow items come before Clear unmapped, which is last", async () => {
      bar({ snap: false });
      hideNarrow("Unmapped only", "Tidy layout", "Snap to grid");
      await userEvent.click(overflow());
      expect(menuItems().map((i) => i.textContent)).toEqual(["Turn on Unmapped only", "Tidy layout", "Turn on Snap to grid", "Clear unmapped (3)"]);
    });

    it("the toggles say the state in their words and flip it: Turn off while it is on", async () => {
      const view = bar({ unmappedOnly: true, snap: true });
      hideNarrow("Unmapped only", "Snap to grid");
      await userEvent.click(overflow());
      expect(menuItems().map((i) => i.textContent)).toEqual(["Turn off Unmapped only", "Turn off Snap to grid", "Clear unmapped (3)"]);
      await userEvent.click(menuItems()[0]);
      expect(view.props.onUnmappedOnly).toHaveBeenCalledWith(false);
      await userEvent.click(overflow());
      await userEvent.click(screen.getByRole("menuitem", { name: "Turn off Snap to grid" }));
      expect(view.props.onSnap).toHaveBeenCalledWith(false);
    });

    it("the toggles turn the other way while they are off", async () => {
      const view = bar({ unmappedOnly: false, snap: false });
      hideNarrow("Unmapped only", "Snap to grid");
      await userEvent.click(overflow());
      await userEvent.click(screen.getByRole("menuitem", { name: "Turn on Unmapped only" }));
      expect(view.props.onUnmappedOnly).toHaveBeenCalledWith(true);
      await userEvent.click(overflow());
      await userEvent.click(screen.getByRole("menuitem", { name: "Turn on Snap to grid" }));
      expect(view.props.onSnap).toHaveBeenCalledWith(true);
    });

    it("the Tidy layout item calls back, and while tidying it is aria-disabled and does nothing", async () => {
      const idle = bar({ clear: undefined });
      hideNarrow("Tidy layout");
      await userEvent.click(overflow());
      await userEvent.click(screen.getByRole("menuitem", { name: "Tidy layout" }));
      expect(idle.props.onTidy).toHaveBeenCalledTimes(1);
      idle.unmount();

      const busy = bar({ clear: undefined, tidying: true });
      hideNarrow("Tidy layout");
      await userEvent.click(overflow());
      const item = screen.getByRole("menuitem", { name: "Tidy layout" });
      expect(item).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(item);
      expect(busy.props.onTidy).not.toHaveBeenCalled();
    });
  });

  // (w33) Sources the newest scan of their range did not find: two more items at the END of the overflow menu, offered only while some source is marked (the filter to every role, Remove not
  // seen only with `onRemove`), and one more chip while the filter is on. Nothing is drawn for the bar while it is off, so the measured width tiers pinned above stand.
  describe("not seen: Turn on Not seen lately and Remove not seen (w33)", () => {
    const notSeen = (over: Partial<NonNullable<React.ComponentProps<typeof GraphBar>["notSeen"]>> = {}) => ({
      count: 3, filtered: false, onFilter: vi.fn(), removable: 2, onRemove: vi.fn(), ...over,
    });

    it("come after Clear unmapped, last in the menu", async () => {
      bar({ snap: false, notSeen: notSeen() });
      hideNarrow("Unmapped only", "Tidy layout", "Snap to grid");
      await userEvent.click(overflow());
      expect(menuItems().map((i) => i.textContent)).toEqual([
        "Turn on Unmapped only", "Tidy layout", "Turn on Snap to grid", "Clear unmapped (3)", "Turn on Not seen lately", "Remove not seen (2)...",
      ]);
    });

    it("are not there while nothing is marked not seen (so the menu is the one it always was), or without the prop", async () => {
      bar({ notSeen: notSeen({ count: 0, removable: 0 }) });
      await userEvent.click(overflow());
      expect(menuItems().map((i) => i.textContent)).toEqual(["Clear unmapped (3)"]);
    });

    it("a role that may not clear unmapped sources (and so not remove) still gets the filter: its menu holds that item alone, and the overflow button is drawn at every width", async () => {
      bar({ clear: undefined, notSeen: notSeen({ removable: undefined, onRemove: undefined }) });
      expect(overflow()).toHaveClass("gbar-overflow");
      expect(overflow()).not.toHaveClass("gbar-overflow-narrow");
      await userEvent.click(overflow());
      expect(menuItems().map((i) => i.textContent)).toEqual(["Turn on Not seen lately"]);
    });

    it("without the prop, or with nothing marked and no filter on, that role's menu stays empty and its button stays narrow-only", async () => {
      bar({ clear: undefined });
      expect(overflow()).toHaveClass("gbar-overflow", "gbar-overflow-narrow");
      await userEvent.click(overflow());
      expect(screen.queryByRole("menu")).toBeNull();
      cleanup();
      bar({ clear: undefined, notSeen: notSeen({ count: 0, removable: 0, onRemove: undefined }) });
      expect(overflow()).toHaveClass("gbar-overflow-narrow");
    });

    it("Remove not seen is offered only with onRemove, after the filter, to a role that may clear unmapped sources", async () => {
      bar({ notSeen: notSeen({ onRemove: undefined }) });
      await userEvent.click(overflow());
      expect(menuItems().map((i) => i.textContent)).toEqual(["Clear unmapped (3)", "Turn on Not seen lately"]);
    });

    it("the filter item says the state in its words and flips it, and the menu gives the focus back to the button first", async () => {
      const seen: Array<Element | null> = [];
      const onFilter = vi.fn(() => { seen.push(document.activeElement); });
      const off = bar({ notSeen: notSeen({ onFilter }) });
      await userEvent.click(overflow());
      await userEvent.click(screen.getByRole("menuitem", { name: "Turn on Not seen lately" }));
      expect(onFilter).toHaveBeenCalledWith(true);
      expect(seen[0]).toBe(overflow());
      expect(screen.queryByRole("menu")).toBeNull();
      off.unmount();

      bar({ notSeen: notSeen({ filtered: true, onFilter }) });
      await userEvent.click(overflow());
      await userEvent.click(screen.getByRole("menuitem", { name: "Turn off Not seen lately" }));
      expect(onFilter).toHaveBeenLastCalledWith(false);
    });

    it("Remove not seen (N)... counts the sources it could remove, which may be fewer than the ones marked, and calls back once the focus is on the overflow button", async () => {
      const seen: Array<Element | null> = [];
      const onRemove = vi.fn(() => { seen.push(document.activeElement); });
      bar({ notSeen: notSeen({ count: 5, removable: 4, onRemove }) });
      await userEvent.click(overflow());
      const item = screen.getByRole("menuitem", { name: "Remove not seen (4)..." });
      expect(item).not.toHaveAttribute("aria-disabled");
      await userEvent.click(item);
      expect(onRemove).toHaveBeenCalledTimes(1);
      expect(seen[0]).toBe(overflow());
    });

    it("with marked sources that all have something mapped the item keeps its place, is aria-disabled with the reason, and does nothing", async () => {
      const onRemove = vi.fn();
      bar({ notSeen: notSeen({ count: 2, removable: 0, onRemove }) });
      await userEvent.click(overflow());
      const item = screen.getByRole("menuitem", { name: /Remove not seen \(0\)\.\.\./ });
      expect(item).toHaveAttribute("aria-disabled", "true");
      expect(item).toHaveAttribute("title", "Nothing to remove");
      expect(item).toHaveTextContent("Nothing to remove");
      await userEvent.click(item);
      expect(onRemove).not.toHaveBeenCalled();
      // the filter item is still usable: the marked sources can be looked at
      expect(screen.getByRole("menuitem", { name: "Turn on Not seen lately" })).not.toHaveAttribute("aria-disabled");
    });

    it("a filter that is on keeps its item while the count is 0 (the page switches it off by itself, but the item never vanishes under a person who just used it)", async () => {
      bar({ notSeen: notSeen({ count: 0, removable: 0, filtered: true }) });
      await userEvent.click(overflow());
      expect(menuItems().map((i) => i.textContent)).toEqual(["Clear unmapped (3)", "Turn off Not seen lately"]);
    });

    it("changes nothing the bar draws while the filter is off: the same markup with or without the prop, so no width tier moves", () => {
      const markup = () => root().innerHTML.replace(/_r_[0-9a-z]+_/g, "_id_"); // React's generated ids differ from one mount to the next
      const without = bar();
      const html = markup();
      without.unmount();
      bar({ notSeen: notSeen() });
      expect(markup()).toBe(html);
    });

    describe("the chip while the filter is on", () => {
      const chip = () => root().querySelector(".gbar-chip-filter") as HTMLElement | null;

      it("draws `Only not seen lately (2)` as the last chip, in decoration (aria-hidden), with the whole sentence in its title, and the count chips stay as they were", () => {
        bar({ notSeen: notSeen({ count: 2, filtered: true }) });
        const shown = chip()!;
        expect(shown).not.toBeNull();
        expect(shown).toHaveTextContent("Only not seen lately (2)");
        expect(shown).toHaveAttribute("title", "Only not seen lately (2)");
        expect(shown).toHaveAttribute("aria-hidden", "true");
        expect(shown.classList.contains("gbar-chip")).toBe(true);
        expect(shown.querySelector("svg.i")).not.toBeNull();
        const all = [...root().querySelectorAll(".gbar-chip")];
        expect(all[all.length - 1]).toBe(shown);
        expect(all.slice(0, 3).map((c) => c.getAttribute("title"))).toEqual(["3 sources", "120 points", "6 mapped"]);
      });

      it("is one run of text made of parts the stylesheet takes out as the bar narrows: `Only` and `lately` first, then `not seen` and the brackets, and the icon and the number stay", () => {
        bar({ notSeen: notSeen({ count: 12, filtered: true }) });
        expect(chip()).toHaveTextContent("Only not seen lately (12)"); // read in order, with no word twice
        expect(chip()!.querySelector(".gbar-chip-num")).toHaveTextContent("12");
        expect([...chip()!.querySelectorAll(".gbar-chip-fword")].map((w) => w.textContent)).toEqual(["Only ", " lately"]);
        expect([...chip()!.querySelectorAll(".gbar-chip-mword")].map((w) => w.textContent)).toEqual(["not seen", " (", ")"]);
      });

      it("gives the chips row gbar-chips-filtered (the count chips lose their words earlier, so the new chip is not starved) and keeps gbar-chips-wide as it was", () => {
        bar({ notSeen: notSeen({ filtered: true }), counts: { ...COUNTS, needing: 1 } });
        const row = root().querySelector(".gbar-chips")!;
        expect(row).toHaveClass("gbar-chips", "gbar-chips-wide", "gbar-chips-filtered");
      });

      it("is not drawn while the filter is off, however many sources are marked, and adds no live region: the summary stays the one announcer", () => {
        bar({ notSeen: notSeen({ count: 5, filtered: false }) });
        expect(chip()).toBeNull();
        expect(root().querySelector(".gbar-chips")).not.toHaveClass("gbar-chips-filtered");
        cleanup();
        bar({ notSeen: notSeen({ filtered: true }) });
        expect(root().querySelectorAll("[aria-live], [role='status'], [role='alert']")).toHaveLength(1);
      });

      it("is drawn for a role that holds no clear, too", () => {
        bar({ clear: undefined, notSeen: notSeen({ filtered: true, removable: undefined, onRemove: undefined }) });
        expect(chip()).not.toBeNull();
      });
    });
  });

  describe("the Collapse all and Expand all chevrons (the old MoreWays, now BarMenu)", () => {
    it("each is a menu button, collapsed until pressed, beside its button", () => {
      bar();
      for (const chevron of [collapseMore(), expandMore()]) {
        expect(chevron).toHaveClass("graph-bar-more");
        expect(chevron).toHaveAttribute("aria-haspopup", "menu");
        expect(chevron).toHaveAttribute("aria-expanded", "false");
        expect(chevron).not.toHaveAttribute("aria-disabled");
        expect(chevron.querySelector("svg.i")).not.toBeNull();
        expect(chevron).toHaveTextContent(""); // its name is the aria-label
      }
      expect(collapseMore().previousElementSibling).toBe(screen.getByRole("button", { name: "Collapse all" }));
      expect(expandMore().previousElementSibling).toBe(screen.getByRole("button", { name: "Expand all" }));
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("the collapse chevron opens Collapse selection and Collapse this branch, which call back, close the menu and leave the focus on the chevron", async () => {
      const view = bar();
      await userEvent.click(collapseMore());
      expect(screen.getByRole("menu", { name: "Collapse options" })).toBeInTheDocument();
      expect(menuItems().map((i) => i.textContent)).toEqual(["Collapse selection", "Collapse this branch"]);
      await userEvent.keyboard("{ArrowDown}{Enter}");
      expect(view.props.onCollapseBranch).toHaveBeenCalledTimes(1);
      expect(view.props.onCollapseSelection).not.toHaveBeenCalled();
      expect(collapseMore()).toHaveFocus();
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
    });

    it("a second press closes the menu, a press elsewhere closes it too", async () => {
      bar();
      await userEvent.click(collapseMore());
      await userEvent.click(collapseMore());
      expect(screen.queryByRole("menu")).toBeNull();
      await userEvent.click(expandMore());
      await userEvent.click(screen.getByRole("switch", { name: "Unmapped only" }));
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("an item that cannot be used says why; a chevron with nothing to offer is aria-disabled with the reason in its title", async () => {
      bar({ collapseSelection: none(NOTHING), expandSelection: none(NOTHING), expandBranch: none("Nothing selected opens or closes.") });
      await userEvent.click(collapseMore());
      expect(menuItems()[0]).toHaveAttribute("aria-disabled", "true");
      expect(menuItems()[0].querySelector(".graph-menu-reason")).toHaveTextContent(NOTHING);
      await userEvent.keyboard("{Escape}");
      expect(expandMore()).toHaveAttribute("aria-disabled", "true");
      expect(expandMore()).toHaveAttribute("title", NOTHING);
      expect(expandMore()).not.toBeDisabled();
      expect(collapseMore()).not.toHaveAttribute("aria-disabled");
    });
  });
});

// jsdom has no stylesheet (vitest runs with css: false), so the bar's tiers cannot be seen here: Playwright measures them. What can be pinned is the
// stylesheet's own promises, read as text: the bar's height, the container it queries, the words that are hidden visually and never removed.
describe("the bar's stylesheet (discovery-tidy.css)", () => {
  const raw = readFileSync("src/styles/discovery-tidy.css", "utf8");
  const rules = parseRules(stripComments(raw));
  const body = (selector: string, at: string[] = ["@layer w6"]) => {
    const found = rules.filter((r) => r.selector === selector && r.at.join(" > ") === at.join(" > "));
    expect(found, `exactly one rule for "${selector}" in ${at.join(" > ")}`).toHaveLength(1);
    return found[0].body;
  };
  const tiers = rules.filter((r) => r.at.some((a) => a.startsWith("@container")));
  const widthOf = (r: { at: string[] }) => Number(/max-width:\s*(\d+)px/.exec(r.at.find((a) => a.startsWith("@container")) ?? "")?.[1]);

  it("the bar and the place held for it are one rule: 36px, border-box, 8px under it", () => {
    const shared = body(".graph-bar, .graph-bar-space");
    expect(shared).toMatch(/height:\s*36px/);
    expect(shared).toMatch(/box-sizing:\s*border-box/);
    expect(shared).toMatch(/margin-bottom:\s*8px/);
    expect(shared).toMatch(/flex:\s*none/);
  });

  it("the bar is a size container in one row that never wraps; the place held for it is not", () => {
    const bar = body(".graph-bar");
    expect(bar).toMatch(/container-type:\s*inline-size/);
    expect(bar).toMatch(/display:\s*flex/);
    expect(bar).not.toMatch(/flex-wrap:\s*wrap/);
    expect(rules.filter((r) => /container-type/.test(r.body)).map((r) => r.selector)).toEqual([".graph-bar"]);
  });

  // Words leave the bar one control at a time as it narrows, in this order; each has its own class so one @container rule takes it out.
  const DROPS = [
    [".gbar-lbl-snap", "Snap to grid"], [".gbar-lbl-find", "Find"], [".gbar-lbl-tidy", "Tidy layout"], [".gbar-lbl-unmapped", "Unmapped only"], [".gbar-lbl-fold", "Collapse all and Expand all"],
  ] as const;

  // Two families of chips (GraphBar gives the row `gbar-chips-wide` for the credentials chip or a four-digit count): the wide chips lose their words at their own early tier, before any control word goes;
  // the normal chips keep theirs until every control has lost its word, and only then fall to icon and number.
  const WIDE_WORDS = ".gbar-chips-wide .gbar-chip-word";
  const NORMAL_WORDS = ".gbar-chip-word";
  // w33: while the Not seen lately filter is on (the row has `gbar-chips-filtered`), every count chip is icon and number up to a wider bar, and the filter chip's own words go lower down.
  const FILTERED_WORDS = ".gbar-chips-filtered .gbar-chip-word";
  const FILTER_CHIP_WORDS = ".gbar-chip-fword";
  const FILTER_CHIP_MORE = ".gbar-chip-mword";
  const at = (selector: string) => {
    const tier = tiers.find((r) => r.selector === selector);
    expect(tier, `a tier rule for ${selector}`).toBeDefined();
    return widthOf(tier!);
  };

  it("holds the @container tiers in priority order: the wide chips lose their words first, then Snap to grid, Find, Tidy layout, Unmapped only and Collapse/Expand all lose theirs, then the normal chips, then three controls go to the menu", () => {
    const order = [WIDE_WORDS, ...DROPS.map(([selector]) => selector), NORMAL_WORDS, ".gbar-narrow"];
    const widths = order.map(at);
    for (let i = 1; i < widths.length; i++) expect(widths[i - 1], `${order[i - 1]} leaves before ${order[i]}`).toBeGreaterThan(widths[i]);
    expect(widths[widths.length - 1]).toBeGreaterThan(400); // below the smallest bar the page makes (an 800px window, the sidebar open) there is nothing more to take away
    expect(widths[0]).toBeLessThan(2000);
    // the measured table at the top of the rules names the thresholds that are used
    for (const width of widths) expect(raw, `the comment states ${width}`).toContain(String(width));
    expect(raw).toMatch(/worst/i);
  });

  it("each tier is at least the need of the state it leaves, measured in Chromium: the control tiers and the normal chips' words from the WIDEST normal set with its words (999 sources, 999 of 999 points, 999 mapped), the wide chips' words from the worst set, the overflow tier from the worst chips as icon and number (a chip is never dropped whole while a word could go)", () => {
    // Measured widths in px (admin; the reader's bar is 36 narrower): controls in each state and the chips of each family, plus the 8px gap between the chips and the controls.
    const CONTROLS = { everyWord: 961.3, snapGone: 863.8, findGone: 819.1, tidyGone: 729.3, unmappedGone: 620.5, allIcons: 442 };
    const CHIPS = { normalWords: 381, wideWords: 539, wideIcons: 267 };
    const GAP = 8;
    const need = (controls: number, chips: number) => controls + GAP + chips;
    expect(at(WIDE_WORDS), "wide chips keep their words only while every control word and the worst chips fit").toBeGreaterThanOrEqual(need(CONTROLS.everyWord, CHIPS.wideWords));
    expect(at(".gbar-lbl-snap")).toBeGreaterThanOrEqual(need(CONTROLS.everyWord, CHIPS.normalWords));
    expect(at(".gbar-lbl-find")).toBeGreaterThanOrEqual(need(CONTROLS.snapGone, CHIPS.normalWords));
    expect(at(".gbar-lbl-tidy")).toBeGreaterThanOrEqual(need(CONTROLS.findGone, CHIPS.normalWords));
    expect(at(".gbar-lbl-unmapped")).toBeGreaterThanOrEqual(need(CONTROLS.tidyGone, CHIPS.normalWords));
    expect(at(".gbar-lbl-fold")).toBeGreaterThanOrEqual(need(CONTROLS.unmappedGone, CHIPS.normalWords));
    expect(at(NORMAL_WORDS), "normal chips keep their words while every control is an icon and they still fit").toBeGreaterThanOrEqual(need(CONTROLS.allIcons, CHIPS.normalWords));
    expect(at(".gbar-narrow"), "three controls go to the menu only when even the worst chips as icon and number do not fit beside all-icon controls").toBeGreaterThanOrEqual(need(CONTROLS.allIcons, CHIPS.wideIcons));
    // and no tier is wasteful: each is within 10px of the need it is derived from (rounded up to a multiple of 10)
    expect(at(".gbar-narrow")).toBeLessThanOrEqual(need(CONTROLS.allIcons, CHIPS.wideIcons) + 10);
    expect(at(NORMAL_WORDS)).toBeLessThanOrEqual(need(CONTROLS.allIcons, CHIPS.normalWords) + 10);
    expect(at(".gbar-lbl-snap")).toBeLessThanOrEqual(need(CONTROLS.everyWord, CHIPS.normalWords) + 10);
  });

  it("the words stay while there is room for them: at a 1148px bar (a 1440px window, the sidebar open) the counts keep their words and only Snap to grid, Find and Tidy layout have lost theirs; at a 744px bar (1024px) the words have gone from every control and the counts, and the controls are still in the bar", () => {
    // a tier applies when the bar is at most its threshold wide
    expect(at(NORMAL_WORDS), "the counts keep their words at 1148").toBeLessThan(1148);
    expect(at(WIDE_WORDS), "the wide counts (credentials, four digits) have lost theirs at 1148").toBeGreaterThanOrEqual(1148);
    for (const gone of [".gbar-lbl-snap", ".gbar-lbl-find", ".gbar-lbl-tidy"]) expect(at(gone), `${gone} has gone at 1148`).toBeGreaterThanOrEqual(1148);
    for (const keep of [".gbar-lbl-unmapped", ".gbar-lbl-fold"]) expect(at(keep), `${keep} is still drawn at 1148`).toBeLessThan(1148);
    for (const [selector, word] of DROPS) expect(at(selector), `${word} has gone at 744`).toBeGreaterThanOrEqual(744);
    expect(at(NORMAL_WORDS), "the counts are icon and number at 744").toBeGreaterThanOrEqual(744);
    expect(at(".gbar-narrow"), "Unmapped only, Tidy layout and Snap to grid are still in the bar at 744").toBeLessThan(744);
    expect(at(".gbar-lbl-fold")).toBeGreaterThan(at(".gbar-narrow")); // the overflow tier is the last of all
  });

  it("an icon-only control keeps its words in the accessibility tree: the clip pattern, never display: none or visibility: hidden", () => {
    for (const [selector, word] of DROPS) {
      const tier = tiers.find((r) => r.selector === selector)!;
      const clip = body(selector, tier.at);
      expect(clip, word).toMatch(/position:\s*absolute/);
      expect(clip, word).toMatch(/width:\s*1px/);
      expect(clip, word).toMatch(/height:\s*1px/);
      expect(clip, word).toMatch(/overflow:\s*hidden/);
      expect(clip, word).toMatch(/clip:\s*rect\(0 0 0 0\)/);
    }
    for (const r of rules.filter((x) => /\.(gbar-lbl[\w-]*|graph-summary)(?![\w-])/.test(x.selector))) {
      expect(r.body, `"${r.selector}"`).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    }
    expect(body(".graph-summary")).toMatch(/clip:\s*rect\(0 0 0 0\)/); // the one live sentence is read, not drawn
  });

  it("a button that loses its word loses the padding the word needed in the same tier, so it is as wide as the icon-only buttons beside it", () => {
    for (const [selector, word] of DROPS.filter(([selector]) => selector !== ".gbar-lbl-unmapped")) { // the switch is a label: it has no button padding
      const tier = tiers.find((r) => r.selector === selector)!;
      const padding = tiers.filter((r) => r.at.join() === tier.at.join() && r.selector !== selector && r.selector.includes(selector));
      expect(padding.map((r) => r.selector), word).toEqual([`.gbar-group button:has(> ${selector})`]);
      expect(padding[0].body, word).toMatch(/padding:\s*0 8px/);
    }
  });

  it("display: none is used for three things only: chip words in their tiers (decoration: the two families, and the filter chip's own words and the others' while it is on), the three narrow controls (their menu twins carry the names) and the narrow-only overflow button", () => {
    const hidden = rules.filter((r) => /display:\s*none/.test(r.body)).map((r) => `${r.at.filter((a) => a.startsWith("@container")).join("")}|${r.selector}`);
    expect(hidden.sort()).toEqual([
      `|.graph-bar .gbar-overflow-narrow`,
      `@container (max-width: ${at(".gbar-narrow")}px)|.gbar-narrow`,
      `@container (max-width: ${at(NORMAL_WORDS)}px)|${NORMAL_WORDS}`,
      `@container (max-width: ${at(WIDE_WORDS)}px)|${WIDE_WORDS}`,
      `@container (max-width: ${at(FILTERED_WORDS)}px)|${FILTERED_WORDS}`,
      `@container (max-width: ${at(FILTER_CHIP_WORDS)}px)|${FILTER_CHIP_WORDS}`,
      `@container (max-width: ${at(FILTER_CHIP_MORE)}px)|${FILTER_CHIP_MORE}`,
    ].sort());
    expect(body(".graph-bar .gbar-overflow-narrow", tiers.find((r) => r.selector === ".gbar-narrow")!.at)).toMatch(/display:\s*grid/); // and the narrowest tier draws it, as the .icon-btn grid it is
  });

  it("the chips draw whole chips on one line and take the free room, so the controls never move", () => {
    const chips = body(".gbar-chips");
    expect(chips).toMatch(/flex:\s*1 1 0/);
    expect(chips).toMatch(/min-width:\s*0/);
    expect(chips).toMatch(/overflow:\s*hidden/);
    expect(chips).toMatch(/height:\s*20px/);
  });

  it("the filter chip (w33): the count chips are icon and number up to a 1700px bar while it is on, `Only` and `lately` go from 1440px down, `not seen` and the brackets from 840px down, where the gap between the chips is 6px; the tiers above are not moved", () => {
    // measured: 961 + 8 + 539 + 14 + 175 = 1697 (every word of the worst set and the full chip); the worst chips as icon and number beside the full chip need 1425 on paper and 1437 in the sweep
    expect(at(FILTERED_WORDS), "every word fits only above 1697").toBeGreaterThanOrEqual(1697);
    expect(at(FILTERED_WORDS)).toBeLessThanOrEqual(1707);
    expect(at(FILTER_CHIP_WORDS), "the chip's words fit only above 1437").toBeGreaterThanOrEqual(1437);
    expect(at(FILTER_CHIP_WORDS)).toBeLessThanOrEqual(1447);
    expect(at(FILTER_CHIP_WORDS)).toBeLessThan(at(FILTERED_WORDS)); // the others' words leave first, then the chip's own
    expect(at(FILTER_CHIP_MORE), "icon and number from the tier where the normal chips lose their words").toBe(at(NORMAL_WORDS));
    const gap = tiers.find((r) => r.selector === ".gbar-chips-filtered" && /column-gap/.test(r.body));
    expect(gap, "a tighter gap while the filter is on").toBeDefined();
    expect(gap!.body).toMatch(/column-gap:\s*6px/);
    expect(widthOf(gap!)).toBe(at(NORMAL_WORDS)); // the tier where every control is an icon and the counts have just lost their words
    // the existing tiers are where they were
    expect([at(WIDE_WORDS), at(".gbar-lbl-snap"), at(".gbar-lbl-find"), at(".gbar-lbl-tidy"), at(".gbar-lbl-unmapped"), at(".gbar-lbl-fold"), at(NORMAL_WORDS), at(".gbar-narrow")]).toEqual(
      [1520, 1360, 1260, 1210, 1120, 1010, 840, 720],
    );
  });

  it("the filter chip's icon wears the accent and its words are kept in the markup (the stylesheet hides them, nothing removes them): no rule makes the chip hide or wrap", () => {
    expect(body(".gbar-chip-filter svg.i")).toMatch(/color:\s*var\(--accent\)/);
    for (const r of rules.filter((x) => /gbar-chip-filter|gbar-chip-fword/.test(x.selector) && !/display:\s*none/.test(x.body))) {
      expect(r.body, r.selector).not.toMatch(/visibility|position:\s*absolute|flex-wrap/);
    }
  });

  it("an ON control of the bar (Snap to grid, aria-pressed) differs from the focus ring: a neutral border, the accent tint and ink, and an inset accent line at the foot, beating the base rule by specificity", () => {
    const on = body('.graph-bar button[aria-pressed="true"]');
    expect(on).toMatch(/border-color:\s*var\(--border-strong\)/);
    expect(on).toMatch(/background:\s*var\(--accent-tint\)/);
    expect(on).toMatch(/color:\s*var\(--accent-ink\)/);
    expect(on).toMatch(/box-shadow:\s*inset 0 -2px 0 var\(--accent\)/);
    expect(on).not.toMatch(/!important/);
    expect(on).not.toMatch(/border-color:\s*var\(--accent\)/); // the accent border is what looked like the outside focus ring (outline: 2px solid var(--ring))
    expect(on).not.toMatch(/outline/); // and the outside outline stays the focus ring's alone
    // `.graph-bar button[...]` (one class, one element, one attribute) outranks app.css's `button[aria-pressed="true"]` (one element, one attribute)
    expect(readFileSync("src/app.css", "utf8")).toMatch(/\n\s*button\[aria-pressed="true"\] \{ border-color: var\(--accent\)/);
  });

  it("the rules of the old header actions and the old source node lines are gone (they moved to the bar and the source card)", () => {
    for (const gone of ["graph-actions-space", "discovery-clear", "gnode-actions", "gnode-remove", "gnode-seen"]) {
      expect(rules.filter((r) => r.selector.includes(gone)).map((r) => r.selector), gone).toEqual([]);
    }
    const tools = parseRules(stripComments(readFileSync("src/styles/graph-tools.css", "utf8")));
    for (const gone of ["graph-tools-bar", "graph-hint-list", "graph-find-btn", "graph-snap-btn"]) {
      expect(tools.filter((r) => r.selector.includes(gone)).map((r) => r.selector), gone).toEqual([]);
    }
    expect(tools.some((r) => r.selector === ".graph-find"), "the Find card keeps its rules").toBe(true);
  });
});
