import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Asset, AssetIn, AssetKind } from "../../api/types";
import { kindIconId } from "../../lib/assetIcons";
import { DEFAULT_KIND, STARTER_KINDS } from "../../lib/kinds";
import { NewAssetDialog } from "./NewAssetDialog";

const asset = (id: number, name: string, parent_id: number | null = null): Asset => ({ id, parent_id, name, kind: "room", sort_order: 0 });
const ASSETS: Asset[] = [asset(1, "Site"), asset(2, "Room 1", 1)];
const KINDS: AssetKind[] = [...STARTER_KINDS, DEFAULT_KIND].map((name, i) => ({ id: i + 1, name, icon: kindIconId(name), asset_count: 0, starter: false }));
const CREATED: Asset = { id: 9, parent_id: 2, name: "Panel A", kind: "generic", sort_order: 0, icon: "panel" };
const NOTE = "Next you choose the points to map. Cancel keeps the new asset.";

function open(props: Partial<Parameters<typeof NewAssetDialog>[0]> = {}) {
  const create = vi.fn(async (_body: AssetIn, _registerKind: boolean) => CREATED);
  const onCreated = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <NewAssetDialog assets={ASSETS} kinds={KINDS} parentId={null} continues={false} canRegister create={create} onCreated={onCreated} onCancel={onCancel} {...props} />,
  );
  return { create, onCreated, onCancel, view };
}
const dialog = () => screen.getByRole("dialog", { name: "New asset" });

describe("NewAssetDialog", () => {
  it("hosts the real asset form: Name, Parent, Kind and the icon picker with its preview", () => {
    open();
    const d = within(dialog());
    expect(d.getByLabelText("Name")).toBeInTheDocument();
    expect(d.getByLabelText("Parent")).toBeInTheDocument();
    expect(d.getByLabelText("Kind")).toBeInTheDocument();
    const icon = d.getByRole("group", { name: "Icon" });
    expect(icon.querySelector(".icon-preview")).not.toBeNull();
    expect(d.getByRole("button", { name: "Change icon" })).toBeInTheDocument();
    expect(d.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("prefills the name and preselects the parent", () => {
    open({ name: "Row A", parentId: 2 });
    expect(screen.getByLabelText("Name")).toHaveValue("Row A");
    expect(screen.getByLabelText("Parent")).toHaveValue("2");
  });

  it("starts empty with no parent when it is given neither", () => {
    open();
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.getByLabelText("Parent")).toHaveValue("");
  });

  it("saves through create with the icon the picker chose, and hands the created asset on", async () => {
    const { create, onCreated } = open({ name: "Panel A", parentId: 2 });
    await userEvent.click(screen.getByRole("button", { name: "Change icon" }));
    await userEvent.click(screen.getByRole("radio", { name: "Panel", hidden: true }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(CREATED));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ name: "Panel A", parent_id: 2, kind: "generic", icon: "panel" });
    expect(create.mock.calls[0][1]).toBe(false);
  });

  it("passes the form's answer about a new kind on to create", async () => {
    const { create } = open({ name: "Pump 1" });
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Other…");
    await userEvent.type(screen.getByLabelText("New kind"), "Pump");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ name: "Pump 1", kind: "Pump" });
    expect(create.mock.calls[0][1]).toBe(true);
  });

  it("says a new kind stays text only when the person may not manage kinds", async () => {
    const { create } = open({ name: "Pump 1", canRegister: false });
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Other…");
    await userEvent.type(screen.getByLabelText("New kind"), "Pump");
    expect(screen.getByText(/Only someone who manages kinds can add it/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][1]).toBe(false);
  });

  it("keeps the dialog and shows the error in the form's own line when create fails, and does not call onCreated", async () => {
    const create = vi.fn(async () => { throw new Error("name is taken"); });
    const { onCreated } = open({ name: "Panel A", create });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("name is taken");
    expect(onCreated).not.toHaveBeenCalled();
    expect(dialog()).toBeInTheDocument();
  });

  it("Escape and Cancel call onCancel", async () => {
    const { onCancel } = open();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("tells that the review follows, in a plain line that is not a live region, only when it continues", () => {
    const { view } = open({ continues: true });
    const note = within(dialog()).getByText(NOTE);
    expect(note.tagName).toBe("P");
    expect(note.closest("[role='status'], [role='alert'], [aria-live]")).toBeNull();
    expect(dialog().querySelector("form")!.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy(); // above the form
    view.unmount();
    open({ continues: false });
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });

  it("mounts the form fresh when it is opened for another name or parent", async () => {
    const { view, create, onCreated, onCancel } = open({ name: "Row A", parentId: 1 });
    await userEvent.type(screen.getByLabelText("Name"), " extra");
    view.rerender(<NewAssetDialog assets={ASSETS} kinds={KINDS} name="Row B" parentId={2} continues={false} canRegister create={create} onCreated={onCreated} onCancel={onCancel} />);
    expect(screen.getByLabelText("Name")).toHaveValue("Row B");
    expect(screen.getByLabelText("Parent")).toHaveValue("2");
  });
});
