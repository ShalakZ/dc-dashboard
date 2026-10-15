import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Metric } from "../api/types";
import { MoveMappingsDialog } from "./MoveMappingsDialog";

// Site
//   Room 1 (room)
//     Panel 1 (panel)
//     Panel 2 (panel)
//   Aisle B (Aisle)
const ASSETS = [
  { id: 1, parent_id: null, name: "Site", kind: "site" },
  { id: 2, parent_id: 1, name: "Room 1", kind: "room" },
  { id: 3, parent_id: 2, name: "Panel 1", kind: "panel" },
  { id: 4, parent_id: 2, name: "Panel 2", kind: "panel" },
  { id: 5, parent_id: 1, name: "Aisle B", kind: "Aisle" },
];
const KINDS = [{ id: 1, name: "Aisle", icon: "row", asset_count: 1, starter: false }];
const row = (id: number, name: string, metric: Metric, assetId = 3) => ({ id, name, metric, assetId });

function setup(props: Partial<Parameters<typeof MoveMappingsDialog>[0]> = {}) {
  const onConfirm = vi.fn(async () => undefined);
  const onCancel = vi.fn();
  render(
    <MoveMappingsDialog
      assets={ASSETS} kinds={KINDS} rows={[row(10, "kW", "active_power_kw"), row(11, "V", "voltage_v")]}
      onConfirm={onConfirm} onCancel={onCancel} {...props}
    />,
  );
  const dialog = screen.getByRole("dialog");
  const select = () => within(dialog).getByLabelText("Move to") as HTMLSelectElement;
  const moveButton = () => within(dialog).getByRole("button", { name: "Move" });
  return { onConfirm, onCancel, dialog, select, moveButton };
}
// The indent is non-breaking spaces (AssetPicker's assetOptions): a browser strips the leading ordinary spaces of an option. Shown here as "_".
const NBSP = String.fromCodePoint(0xa0);
const optionTexts = (select: HTMLSelectElement) => Array.from(select.options).map((o) => o.textContent!.replace(new RegExp(`^${NBSP}+`), (lead) => "_".repeat(lead.length)));

describe("MoveMappingsDialog", () => {
  it("is a primary confirmation with the title, the billing sentence and a labelled select of the assets in tree order, indented", () => {
    const { dialog, select } = setup();
    expect(dialog).toHaveAccessibleName("Move 2 points to another asset");
    expect(dialog).toHaveTextContent("Billing for months that are still open is recalculated with them under the asset you choose; closed months keep their billed figures.");
    // Panel 1 is where the rows are now, so it is not offered; the tree order and the indent by depth stay.
    expect(optionTexts(select())).toEqual(["(choose)", "Site", "__Room 1", "____Panel 2", "__Aisle B"]);
    expect(within(dialog).getByRole("button", { name: "Move" })).toHaveClass("primary");
  });

  it("tells two assets of the same name apart, as the other asset pickers do (the parent path, then the id), and keeps the choice by value", async () => {
    const twin = [
      { id: 1, parent_id: null, name: "Room 1", kind: "room" },
      { id: 2, parent_id: null, name: "Room 2", kind: "room" },
      { id: 3, parent_id: 1, name: "Panel", kind: "panel" },
      { id: 4, parent_id: 2, name: "Panel", kind: "panel" },
    ];
    const { select, onConfirm, moveButton } = setup({ assets: twin, rows: [row(10, "kW", "active_power_kw", 1)] });
    // Room 1 is where the row is, so it is not offered; its Panel keeps its indent.
    expect(optionTexts(select())).toEqual(["(choose)", "__Panel (Room 1)", "Room 2", "__Panel (Room 2)"]);
    await userEvent.selectOptions(select(), "4");
    await userEvent.click(moveButton());
    expect(onConfirm).toHaveBeenCalledWith(4);
  });

  it("names a single point and a given subject in the title", () => {
    setup({ rows: [row(10, "kW", "active_power_kw")] });
    expect(screen.getByRole("dialog")).toHaveAccessibleName('Move "kW" to another asset');
  });

  it("uses the subject the caller gives (a group)", () => {
    setup({ what: 'the group "LVP01"' });
    expect(screen.getByRole("dialog")).toHaveAccessibleName('Move the group "LVP01" to another asset');
  });

  it("leaves nothing out when the rows are on different assets, and Move waits for a choice", async () => {
    const { select, moveButton, onConfirm } = setup({ rows: [row(10, "kW", "active_power_kw", 3), row(11, "V", "voltage_v", 4)] });
    expect(optionTexts(select())).toEqual(["(choose)", "Site", "__Room 1", "____Panel 1", "____Panel 2", "__Aisle B"]);
    expect(moveButton()).toBeDisabled();
    await userEvent.click(moveButton());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("starts with the Cancel button focused, the select reachable by Tab, and Escape closes", async () => {
    const { select, onCancel } = setup();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.tab({ shift: true }); // the select comes before the buttons
    expect(select()).toHaveFocus();
    await userEvent.tab({ shift: true }); // and Tab wraps round inside the dialog: Move is off, so the last control is Cancel
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.tab();
    expect(select()).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("confirming with a choice calls onConfirm with the asset id", async () => {
    const { select, moveButton, onConfirm } = setup();
    await userEvent.selectOptions(select(), "4");
    expect(moveButton()).toBeEnabled();
    await userEvent.click(moveButton());
    expect(onConfirm).toHaveBeenCalledWith(4);
  });

  it("a metric the target already has turns Move off and says why, in a slot that is always there", async () => {
    const takenFor = (assetId: number): ReadonlySet<Metric> => new Set<Metric>(assetId === 4 ? ["voltage_v"] : []);
    const { dialog, select, moveButton } = setup({ takenFor });
    const slot = dialog.querySelector(".mapmove-slot");
    expect(slot, "the reserved slot exists before anything is chosen").not.toBeNull();
    await userEvent.selectOptions(select(), "4");
    expect(moveButton()).toBeDisabled();
    expect(within(slot as HTMLElement).getByRole("alert")).toHaveTextContent('"V" would clash: Panel 2 already has that metric.');
    await userEvent.selectOptions(select(), "1");
    expect(moveButton()).toBeEnabled();
    expect(within(slot as HTMLElement).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("two rows that map the same metric clash with each other", async () => {
    const { select, moveButton, dialog } = setup({ rows: [row(10, "kW 1", "active_power_kw"), row(11, "kW 2", "active_power_kw")] });
    await userEvent.selectOptions(select(), "4");
    expect(moveButton()).toBeDisabled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent('"kW 1", "kW 2" would clash: they map the same metric');
  });

  it("custom never clashes", async () => {
    const takenFor = () => new Set<Metric>(["custom"]);
    const { select, moveButton } = setup({ rows: [row(10, "X", "custom"), row(11, "Y", "custom")], takenFor });
    await userEvent.selectOptions(select(), "4");
    expect(moveButton()).toBeEnabled();
  });

  it("a row that is on the target already is not moved and does not clash with itself", async () => {
    // V is on Panel 2 now (so Panel 2 has voltage_v), kW is on Panel 1: moving both to Panel 2 moves kW only.
    const takenFor = (assetId: number): ReadonlySet<Metric> => new Set<Metric>(assetId === 4 ? ["voltage_v"] : []);
    const { select, moveButton } = setup({ rows: [row(10, "kW", "active_power_kw", 3), row(11, "V", "voltage_v", 4)], takenFor });
    await userEvent.selectOptions(select(), "4");
    expect(moveButton()).toBeEnabled();
  });

  it("a place that holds equipment is told in a note that never blocks, and the select is described by it", async () => {
    const { dialog, select, moveButton } = setup();
    const slot = dialog.querySelector(".mapmove-slot") as HTMLElement;
    expect(select()).not.toHaveAttribute("aria-describedby");
    await userEvent.selectOptions(select(), "2");
    const note = "Room 1 is a room; meters usually belong to a Panel or Rack. Move here anyway?";
    expect(within(slot).getByText(note)).toBeInTheDocument();
    expect(select()).toHaveAccessibleDescription(note);
    expect(within(slot).queryByRole("alert")).not.toBeInTheDocument(); // silent until read: the live region is the toast
    expect(moveButton()).toBeEnabled();
    await userEvent.selectOptions(select(), "5"); // a registered kind: the registry's icon (a row) makes it a place
    expect(within(slot).getByText("Aisle B is an aisle; meters usually belong to a Panel or Rack. Move here anyway?")).toBeInTheDocument();
    await userEvent.selectOptions(select(), "4");
    expect(slot).toBeEmptyDOMElement();
  });

  it("a clash wins the slot over the note", async () => {
    const takenFor = (assetId: number): ReadonlySet<Metric> => new Set<Metric>(assetId === 2 ? ["voltage_v"] : []);
    const { dialog, select } = setup({ takenFor });
    await userEvent.selectOptions(select(), "2");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("would clash");
    expect(within(dialog).queryByText(/meters usually belong/)).not.toBeInTheDocument();
  });

  it("Cancel calls onCancel", async () => {
    const { onCancel } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
