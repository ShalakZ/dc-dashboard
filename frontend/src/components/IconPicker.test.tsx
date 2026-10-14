import { readFileSync } from "node:fs";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ASSET_ICONS, ICON_GROUPS } from "../lib/assetIcons";
import { parseRules, stripComments } from "../test/cssTools";
import { iconHtml } from "../test/iconHtml";
import type { IconName } from "./Icon";
import { IconPicker } from "./IconPicker";
import { Modal } from "./Modal";

type Props = Partial<React.ComponentProps<typeof IconPicker>>;

/** The picker with the state a form gives it: `value` is the form's, `onChange` records and stores. */
function Harness({ initial = null, onChange, ...props }: Props & { initial?: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <IconPicker
      value={value}
      onChange={(next) => { onChange?.(next); setValue(next); }}
      previewIcon="kindGeneric"
      caption="The caption"
      {...props}
    />
  );
}

const AUTOMATIC = { icon: "kindPanel" as IconName, title: "Automatic: follows the kind (Panel)" };

// user-event's arrow keys on a radio read window.CSS.escape, which jsdom 26 does not have: stub it here only.
beforeEach(() => {
  vi.stubGlobal("CSS", { escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) });
});
afterEach(() => { vi.unstubAllGlobals(); });

const field = () => screen.getByRole("group", { name: "Icon" });
const opener = () => screen.getByRole("button", { name: "Change icon" });
const grid = () => screen.getByRole("radiogroup", { hidden: true }); // a hidden element has no accessible name, so no name here
const cells = () => within(grid()).getAllByRole("radio", { hidden: true }) as HTMLInputElement[];
const cell = (name: string) => within(grid()).getByRole("radio", { name, hidden: true }) as HTMLInputElement;
const search = () => screen.getByRole("searchbox", { name: "Search icons" }) as HTMLInputElement;
/** The cells a person can see (a filtered cell is `hidden`), by label, in order. */
const shown = () => screen.getAllByRole("radio").map((c) => c.closest("label")!.textContent);
const note = () => field().querySelector("[aria-live]")!;

describe("IconPicker", () => {
  it("draws the group, the preview as decoration and the caption as its description", () => {
    render(<Harness previewIcon="kindRack" caption="Rack" />);
    const preview = field().querySelector(".icon-preview")!;
    expect(preview).toHaveAttribute("aria-hidden", "true");
    expect(preview).toHaveClass("page-tile");
    expect(preview.querySelector("svg")!.innerHTML).toBe(iconHtml("kindRack"));
    expect(field()).toHaveAccessibleDescription("Rack");
  });

  it("adds the hint to the description, on a line of its own", () => {
    render(<Harness caption="Pump" hint="Suggested from the name" />);
    expect(field()).toHaveAccessibleDescription("Pump Suggested from the name");
    expect(screen.getByText("Suggested from the name")).toHaveClass("icon-hint");
  });

  it("keeps the grid collapsed (out of the accessibility tree) until Change icon opens it, then puts focus on the checked cell", async () => {
    render(<Harness initial="rack" />);
    expect(opener()).toHaveAttribute("aria-expanded", "false");
    expect(opener()).toHaveAttribute("aria-controls", grid().id);
    expect(grid()).toHaveAttribute("hidden");
    expect(screen.queryByRole("radiogroup", { name: "Icon choices" })).not.toBeInTheDocument();
    await userEvent.click(opener());
    expect(opener()).toHaveAttribute("aria-expanded", "true");
    expect(grid()).not.toHaveAttribute("hidden");
    expect(screen.getByRole("radiogroup", { name: "Icon choices" })).toBe(grid());
    expect(cell("Rack")).toHaveFocus();
    await userEvent.click(opener());
    expect(grid()).toHaveAttribute("hidden");
    expect(opener()).toHaveFocus();
  });

  it("offers the 48 icons, each named by its label, titled with it and drawn as decoration", () => {
    render(<Harness />);
    expect(cells().map((c) => c.closest("label")!.textContent)).toEqual(ASSET_ICONS.map((e) => e.label));
    for (const c of cells()) {
      const label = c.closest("label")!;
      expect(c).toHaveAccessibleName(label.textContent!);
      expect(label).toHaveAttribute("title", label.textContent!);
      expect(label.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
    expect(cells().map((c) => c.closest("label")!.querySelector("svg")!.innerHTML)).toEqual(ASSET_ICONS.map((e) => iconHtml(e.icon)));
  });

  it("has no Automatic cell without the automatic prop, and none is checked for null", () => {
    render(<Harness />);
    expect(within(grid()).queryByRole("radio", { name: "Automatic", hidden: true })).not.toBeInTheDocument();
    expect(cells()).toHaveLength(ASSET_ICONS.length);
    expect(cells().filter((c) => c.checked)).toHaveLength(0);
  });

  it("with the automatic prop, the first cell is Automatic: titled as given, drawn with its icon, checked for null, and it selects null", async () => {
    const onChange = vi.fn();
    render(<Harness automatic={AUTOMATIC} onChange={onChange} />);
    expect(cells()).toHaveLength(ASSET_ICONS.length + 1);
    const auto = cells()[0].closest("label")!;
    expect(auto).toHaveTextContent("Automatic");
    expect(auto).toHaveAttribute("title", AUTOMATIC.title);
    expect(auto).toHaveClass("icon-cell-auto");
    expect(auto.querySelector("svg")!.innerHTML).toBe(iconHtml("kindPanel"));
    expect(cell("Automatic")).toBeChecked();
    await userEvent.click(opener());
    expect(cell("Automatic")).toHaveFocus(); // nothing else is checked: the first cell takes the focus
    await userEvent.click(cell("Server"));
    expect(onChange).toHaveBeenLastCalledWith("server");
    expect(cell("Automatic")).not.toBeChecked();
    await userEvent.click(cell("Automatic"));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(cell("Automatic")).toBeChecked();
  });

  it("stays open after a pick and checks the cell that was picked", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(opener());
    await userEvent.click(cell("Network switch"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("switch");
    expect(cell("Network switch")).toBeChecked();
    expect(grid()).not.toHaveAttribute("hidden");
  });

  it("tells the form about a click on the cell that is already checked, and about a click on another cell once", async () => {
    const onChange = vi.fn();
    render(<Harness initial="rack" automatic={AUTOMATIC} onChange={onChange} />);
    await userEvent.click(opener());
    await userEvent.click(cell("Rack"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("rack");
    onChange.mockClear();
    await userEvent.click(cell("Server"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("server");
    onChange.mockClear();
    await userEvent.click(cell("Server"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("server");
    onChange.mockClear();
    await userEvent.click(cell("Automatic"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
    onChange.mockClear();
    await userEvent.click(cell("Automatic"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("checks nothing for a stored id the catalogue lacks, and the focus goes to the first cell", async () => {
    render(<Harness initial="xyz" />);
    expect(cells().filter((c) => c.checked)).toHaveLength(0);
    await userEvent.click(opener());
    expect(cells()[0]).toHaveFocus();
  });

  it("changes the choice with the arrow keys and moves the focus with it", async () => {
    const onChange = vi.fn();
    render(<Harness initial="site" onChange={onChange} />);
    await userEvent.click(opener());
    expect(cell("Site")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(cell("Building")).toBeChecked();
    expect(cell("Building")).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith("building");
  });

  it("does not submit the form around it when Change icon is clicked or Enter is pressed on a cell; Enter in the other fields still does", async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(<form onSubmit={onSubmit}><input aria-label="Name" /><Harness /><button type="submit">Save</button></form>);
    await userEvent.click(opener());
    await userEvent.click(opener());
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.click(opener());
    await userEvent.keyboard("{ArrowRight}{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(grid()).not.toHaveAttribute("hidden");
    expect(cell("Building")).toBeChecked();
    await userEvent.type(screen.getByLabelText("Name"), "x{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("chooses the focused cell with Space, without submitting", async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(<form onSubmit={onSubmit}><Harness initial="xyz" /><button type="submit">Save</button></form>);
    await userEvent.click(opener());
    expect(cell("Site")).toHaveFocus();
    expect(cell("Site")).not.toBeChecked();
    await userEvent.keyboard(" ");
    expect(cell("Site")).toBeChecked();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("closes only the grid on Escape and gives the focus back to Change icon; a second Escape reaches the dialog", async () => {
    const onClose = vi.fn();
    render(<Modal title="Edit kind" onClose={onClose}><input aria-label="Name" /><Harness /></Modal>);
    await userEvent.click(opener());
    await userEvent.keyboard("{ArrowRight}{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(grid()).toHaveAttribute("hidden");
    expect(opener()).toHaveAttribute("aria-expanded", "false");
    expect(opener()).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("two pickers on one page are two radio groups: a pick in one leaves the other's choice alone", async () => {
    render(<><Harness initial="rack" /><Harness initial="fan" /></>);
    const groups = screen.getAllByRole("radiogroup", { hidden: true });
    expect(groups).toHaveLength(2);
    const names = groups.map((g) => (within(g).getAllByRole("radio", { hidden: true })[0] as HTMLInputElement).name);
    expect(names[0]).not.toBe("");
    expect(names[0]).not.toBe(names[1]);
    // One name per picker, shared by its own cells only.
    for (const [i, g] of groups.entries()) {
      for (const radio of within(g).getAllByRole("radio", { hidden: true }) as HTMLInputElement[]) expect(radio.name).toBe(names[i]);
    }
    await userEvent.click(screen.getAllByRole("button", { name: "Change icon" })[0]);
    await userEvent.click(within(groups[0]).getByRole("radio", { name: "Server", hidden: true }));
    expect(within(groups[0]).getByRole("radio", { name: "Server", hidden: true })).toBeChecked();
    expect(within(groups[0]).getByRole("radio", { name: "Rack", hidden: true })).not.toBeChecked();
    expect(within(groups[1]).getByRole("radio", { name: "Fan", hidden: true })).toBeChecked();
  });
});

describe("IconPicker groups", () => {
  const sections = () => within(grid()).getAllByRole("group", { hidden: true });

  it("has one labelled section per group, in the catalogue's order, holding exactly that group's icons", () => {
    render(<Harness />);
    expect(sections().map((s) => document.getElementById(s.getAttribute("aria-labelledby")!)?.textContent)).toEqual([...ICON_GROUPS]);
    for (const [i, section] of sections().entries()) {
      expect(section).toHaveAccessibleName(ICON_GROUPS[i]);
      const labels = within(section).getAllByRole("radio", { hidden: true }).map((r) => r.closest("label")!.textContent);
      expect(labels).toEqual(ASSET_ICONS.filter((e) => e.group === ICON_GROUPS[i]).map((e) => e.label));
    }
  });

  it("names the six groups as headings of the catalogue and uses no heading role for them", () => {
    render(<Harness />);
    expect(ICON_GROUPS).toEqual(["Structure", "Power", "Cooling", "IT and network", "Monitoring and safety", "Other"]);
    expect(screen.queryAllByRole("heading", { hidden: true })).toHaveLength(0); // a dialog's heading counts stay what they were
  });

  it("is still the one radiogroup, whose only radios sit in the sections; Automatic comes first and belongs to none", () => {
    render(<Harness automatic={AUTOMATIC} />);
    expect(screen.getAllByRole("radiogroup", { hidden: true })).toHaveLength(1);
    expect(grid()).toHaveAttribute("aria-label", "Icon choices");
    expect(within(grid()).getAllByRole("group", { hidden: true }).some((s) => s.contains(cell("Automatic")))).toBe(false);
    expect(cells().map((c) => c.closest("label")!.textContent)).toEqual(["Automatic", ...ASSET_ICONS.map((e) => e.label)]);
  });

  it("changes the choice with the arrow keys across a group boundary (no filter): Rack ends Structure, Panel starts Power", async () => {
    const onChange = vi.fn();
    render(<Harness initial="rack" onChange={onChange} />);
    await userEvent.click(opener());
    expect(cell("Rack")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(cell("Panel")).toBeChecked();
    expect(cell("Panel")).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith("panel");
    await userEvent.keyboard("{ArrowLeft}");
    expect(cell("Rack")).toBeChecked();
  });
});

describe("IconPicker search", () => {
  it("has a search box only while the grid is open: a labelled sibling just before the radiogroup, never inside it", async () => {
    render(<Harness />);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    await userEvent.click(opener());
    expect(search()).toHaveAttribute("type", "search");
    expect(search()).toHaveAttribute("aria-controls", grid().id);
    expect(grid()).not.toContainElement(search());
    expect(search().closest('[role="radiogroup"]')).toBeNull();
    expect(grid().previousElementSibling).toContainElement(search());
    expect(grid().parentElement).toBe(search().closest(".icon-field"));
    await userEvent.click(opener());
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("scrolls the dialog just far enough to show the whole field when the grid opens, and not at all when it closes", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView }); // jsdom has none
    try {
      render(<Harness />);
      await userEvent.click(opener());
      expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
      expect(scrollIntoView.mock.contexts[0]).toBe(field());
      await userEvent.click(opener());
      expect(scrollIntoView).toHaveBeenCalledOnce();
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("scrolls the box so that a checked cell far down the list is in view when the grid opens (and leaves a visible one alone)", async () => {
    // jsdom has no layout: the rectangles are the test's. The box is 100..340 px; Door (checked) sits at 500, Rack at 120.
    const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "radiogroup") return rect(100, 340);
      return this.textContent === "Door" ? rect(500, 532) : rect(120, 152);
    });
    try {
      const { unmount } = render(<Harness initial="door" />);
      Object.defineProperty(grid(), "clientHeight", { configurable: true, value: 240 });
      await userEvent.click(opener());
      expect(grid().scrollTop).toBe(500 - 100 - (240 - 32) / 2); // the cell is centred in the box
      unmount();
      render(<Harness initial="rack" />);
      await userEvent.click(opener());
      expect(grid().scrollTop).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("leaves the focus where W7g put it when the grid opens (the checked cell, else the first), not on the search box", async () => {
    render(<Harness initial="rack" />);
    await userEvent.click(opener());
    expect(cell("Rack")).toHaveFocus();
    expect(search()).not.toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(search()).toHaveFocus(); // one Shift+Tab away
    await userEvent.tab();
    expect(cell("Rack")).toHaveFocus();
  });

  it("shows every cell until something is typed, then those whose label or keywords have the typed words: 'transfer' finds the two transfer switches", async () => {
    render(<Harness />);
    await userEvent.click(opener());
    expect(shown()).toHaveLength(ASSET_ICONS.length);
    await userEvent.type(search(), "Transfer");
    expect(shown()).toEqual(["Automatic transfer switch", "Static transfer switch"]);
    await userEvent.clear(search());
    await userEvent.type(search(), "thyristor"); // a keyword, not in the label
    expect(shown()).toEqual(["Static transfer switch"]);
    await userEvent.clear(search());
    await userEvent.type(search(), "transfer static");
    expect(shown()).toEqual(["Static transfer switch"]);
    await userEvent.clear(search());
    expect(shown()).toHaveLength(ASSET_ICONS.length);
  });

  it("finds an icon by its abbreviation, which no keyword spells", async () => {
    render(<Harness />);
    await userEvent.click(opener());
    await userEvent.type(search(), "crac");
    expect(shown()).toEqual(["Cooling unit"]);
  });

  it("hides a group with no match together with its heading, and shows the others", async () => {
    render(<Harness />);
    await userEvent.click(opener());
    await userEvent.type(search(), "transfer");
    const names = within(grid()).getAllByRole("group").map((s) => s.getAttribute("aria-labelledby")).map((id) => document.getElementById(id!)!.textContent);
    expect(names).toEqual(["Power"]);
    // (a hidden element has no accessible name in the testing library, so the section is found by its heading)
    const cooling = within(grid()).getAllByRole("group", { hidden: true }).find((s) => document.getElementById(s.getAttribute("aria-labelledby")!)!.textContent === "Cooling")!;
    expect(cooling).toHaveAttribute("hidden");
    expect(within(grid()).queryAllByRole("group").includes(cooling)).toBe(false);
    await userEvent.clear(search());
    expect(within(grid()).getAllByRole("group")).toHaveLength(ICON_GROUPS.length);
  });

  it("marks a filtered-out cell hidden AND its radio disabled, so the arrow keys and the Tab key skip it everywhere", async () => {
    render(<Harness />);
    await userEvent.click(opener());
    await userEvent.type(search(), "transfer");
    const router = cells().find((c) => c.closest("label")!.textContent === "Router")!; // a hidden label gives its radio no accessible name
    expect(router.closest("label")).toHaveAttribute("hidden");
    expect(router).toBeDisabled();
    for (const name of ["Automatic transfer switch", "Static transfer switch"]) {
      expect(cell(name).closest("label")).not.toHaveAttribute("hidden");
      expect(cell(name)).toBeEnabled();
    }
  });

  it("walks the arrow keys over the cells that are left, from a checked cell the search would have hidden", async () => {
    const onChange = vi.fn();
    render(<Harness initial="ups" onChange={onChange} />);
    await userEvent.click(opener());
    await userEvent.type(search(), "transfer");
    expect(shown()).toEqual(["UPS", "Automatic transfer switch", "Static transfer switch"]); // UPS is checked: it stays
    cell("UPS").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(cell("Automatic transfer switch")).toBeChecked(); // Battery, PDU and the rest are skipped
    expect(cell("Automatic transfer switch")).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith("ats");
    await userEvent.keyboard("{ArrowRight}");
    expect(cell("Static transfer switch")).toBeChecked();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(cell("UPS")).toBeChecked();
  });

  it("never hides the checked cell or Automatic, and the heading of the checked cell's group stays", async () => {
    render(<Harness initial="rack" automatic={AUTOMATIC} />);
    await userEvent.click(opener());
    await userEvent.type(search(), "transfer");
    expect(shown()).toEqual(["Automatic", "Rack", "Automatic transfer switch", "Static transfer switch"]);
    expect(cell("Rack")).toBeEnabled();
    expect(cell("Automatic")).toBeEnabled();
    expect(within(grid()).getByRole("group", { name: "Structure" })).toBeVisible();
    await userEvent.clear(search());
    await userEvent.type(search(), "zzzz");
    expect(shown()).toEqual(["Automatic", "Rack"]);
  });

  it("decides which cell is kept when the text changes, not while the choice moves: the cell left behind does not vanish", async () => {
    render(<Harness initial="rack" />);
    await userEvent.click(opener());
    await userEvent.type(search(), "transfer");
    await userEvent.click(cell("Automatic transfer switch"));
    expect(shown()).toEqual(["Rack", "Automatic transfer switch", "Static transfer switch"]); // Rack was checked when the text changed
    await userEvent.type(search(), " sw"); // the text changes: ATS is the checked cell now, and Rack goes
    expect(shown()).toEqual(["Automatic transfer switch", "Static transfer switch"]);
  });

  it("says 'No icons match' in one role-less polite line when nothing matches, and nothing otherwise; the field's description stays the caption", async () => {
    render(<Harness caption="The caption" />);
    await userEvent.click(opener());
    expect(note()).toHaveAttribute("aria-live", "polite");
    expect(note()).not.toHaveAttribute("role");
    expect(grid()).not.toContainElement(note() as HTMLElement); // a radiogroup owns radios only
    expect(note()).toHaveTextContent("");
    await userEvent.type(search(), "transfer");
    expect(note()).toHaveTextContent("");
    await userEvent.type(search(), "zz");
    expect(note()).toHaveTextContent("No icons match");
    expect(field()).toHaveAccessibleDescription("The caption");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(field().querySelectorAll("[aria-live]")).toHaveLength(1);
    await userEvent.clear(search());
    expect(note()).toHaveTextContent("");
  });

  it("does not submit the form around it on Enter in the search box", async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(<form onSubmit={onSubmit}><Harness /><button type="submit">Save</button></form>);
    await userEvent.click(opener());
    await userEvent.type(search(), "rack{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(search()).toHaveValue("rack");
    expect(grid()).not.toHaveAttribute("hidden");
  });

  it("closes layer by layer on Escape: the typed text first, then the grid with the focus back on Change icon, then the dialog", async () => {
    const onClose = vi.fn();
    render(<Modal title="Edit kind" onClose={onClose}><input aria-label="Name" /><Harness /></Modal>);
    await userEvent.click(opener());
    await userEvent.type(search(), "rack");
    await userEvent.keyboard("{Escape}");
    expect(search()).toHaveValue("");
    expect(search()).toHaveFocus();
    expect(grid()).not.toHaveAttribute("hidden");
    expect(shown()).toHaveLength(ASSET_ICONS.length);
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(grid()).toHaveAttribute("hidden");
    expect(opener()).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("forgets the search when the grid closes, however it closes, so reopening shows every icon and focuses a cell that can take it", async () => {
    render(<Harness initial="rack" />);
    await userEvent.click(opener());
    await userEvent.type(search(), "transfer");
    await userEvent.click(opener());
    await userEvent.click(opener());
    expect(search()).toHaveValue("");
    expect(shown()).toHaveLength(ASSET_ICONS.length);
    expect(cell("Rack")).toHaveFocus();
    await userEvent.type(search(), "transfer");
    cell("Rack").focus();
    await userEvent.keyboard("{Escape}"); // Escape in the grid closes it too
    await userEvent.click(opener());
    expect(search()).toHaveValue("");
    expect(shown()).toHaveLength(ASSET_ICONS.length);
  });

  it("opens on a first cell that is not disabled when nothing is checked", async () => {
    render(<Harness initial="xyz" />);
    await userEvent.click(opener());
    await userEvent.type(search(), "transfer");
    await userEvent.click(opener());
    await userEvent.click(opener());
    expect(cells()[0]).toHaveFocus();
    expect(cells()[0]).toBeEnabled();
  });
});

// A stylesheet is read as text (vitest runs with css: false). These pin what jsdom cannot see: the filter has to work in a browser, where
// an author's `display: grid` outranks the `hidden` attribute, and a box that is filtered must keep its size so Save never moves.
describe("IconPicker styles", () => {
  const sheets = ["src/app.css", "src/styles/icon-picker.css"].map((file) => parseRules(stripComments(readFileSync(file, "utf8"))));
  const rules = sheets.flat();
  const selectors = (selector: string) => rules.filter((r) => r.selector.split(",").map((s) => s.trim()).includes(selector));
  const declares = (selector: string, property: RegExp) => selectors(selector).some((r) => property.test(r.body));

  it("lets `hidden` win over the display of a cell and of a section", () => {
    for (const selector of [".icon-grid .icon-cell[hidden]", ".icon-grid .icon-section[hidden]"]) {
      const found = selectors(selector);
      expect(found.length, selector).toBeGreaterThan(0);
      expect(found.every((r) => /display:\s*none/.test(r.body) && r.at.some((a) => a.startsWith("@layer"))), selector).toBe(true);
    }
  });

  it("gives the scroll box a fixed height (never max-height), scrolling, room for the focus ring and a steady width", () => {
    const box = selectors(".icon-grid").filter((r) => /(?:^|[;\s])height:/.test(r.body));
    expect(box).toHaveLength(1);
    expect(box[0].body).toMatch(/overflow:\s*auto/);
    expect(box[0].body).toMatch(/scrollbar-gutter:\s*stable/);
    expect(box[0].body).not.toMatch(/max-height/);
    const padding = /padding:\s*(\d+)px/.exec(box[0].body);
    expect(Number(padding?.[1]), "padding of the scroll box").toBeGreaterThanOrEqual(3); // the ring (2 px) and its offset (1 px) sit outside the cell
    expect(declares(".icon-grid", /max-height/)).toBe(false);
  });

  it("keeps the button row, and an error above it, at the bottom of the dialog while a grid is open, so Save never falls below the fold", () => {
    const row = selectors("form:has(.icon-grid:not([hidden])) > .row:last-child");
    expect(row).toHaveLength(1);
    expect(row[0].body).toMatch(/position:\s*sticky/);
    expect(row[0].body).toMatch(/bottom:\s*0/);
    expect(row[0].body).toMatch(/background:\s*var\(--bg\)/); // the fields scroll under it
    expect(row[0].at.some((a) => a.startsWith("@layer"))).toBe(true);
    const error = selectors("form:has(.icon-grid:not([hidden])) > .error");
    expect(error).toHaveLength(1);
    expect(error[0].body).toMatch(/position:\s*sticky/);
    // What Tab and the opening scroll bring into view must stay clear of that row: the dialog's scroll padding, not a margin on the field (the two add up)
    expect(declares(".dialog:has(.icon-grid:not([hidden]))", /scroll-padding-bottom:\s*calc\(var\(--btn-h\)\s*\+\s*22px/)).toBe(true);
    expect(declares(".icon-field", /scroll-margin/)).toBe(false);
  });

  it("makes the clipped radio as big as its cell, so focusing it scrolls the whole cell (not a 1 px corner) clear of the sticky buttons", () => {
    expect(declares(".icon-cell > input", /width:\s*100%/)).toBe(true);
    expect(declares(".icon-cell > input", /height:\s*100%/)).toBe(true);
    expect(declares(".icon-cell > input", /clip:\s*rect\(0 0 0 0\)/)).toBe(true); // still invisible
  });

  it("lays the cells out in ten columns inside each section, not in the scroll box itself", () => {
    expect(declares(".icon-cells", /grid-template-columns:\s*repeat\(10,\s*32px\)/)).toBe(true);
    expect(declares(".icon-grid", /grid-template-columns/)).toBe(false);
  });
});
