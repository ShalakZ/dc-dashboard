import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ASSET_ICONS } from "../lib/assetIcons";
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

  it("offers the 28 icons, each named by its label, titled with it and drawn as decoration", () => {
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
