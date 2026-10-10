import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Asset, AssetIn } from "../api/types";
import { AssetForm } from "./AssetForm";

const asset = (id: number, kind: string): Asset => ({ id, parent_id: null, name: `Asset ${id}`, kind, sort_order: 0 });

function open(assets: Asset[], initial?: Partial<AssetIn>) {
  const onSubmit = vi.fn(async (_body: AssetIn) => undefined);
  const view = render(<AssetForm assets={assets} initial={initial} excludeIds={new Set()} onSubmit={onSubmit} onCancel={() => undefined} />);
  return { onSubmit, view };
}
const sent = (onSubmit: ReturnType<typeof open>["onSubmit"]) => onSubmit.mock.calls[0][0];
const optionTexts = () => within(screen.getByLabelText("Kind")).getAllByRole("option").map((o) => o.textContent);

describe("AssetForm Kind", () => {
  it("starts a new asset on generic and sends it when Kind is not touched", async () => {
    const { onSubmit } = open([asset(1, "Room")]);
    expect(screen.getByLabelText("Kind")).toHaveValue("generic");
    await userEvent.type(screen.getByLabelText("Name"), "Hall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).kind).toBe("generic");
  });

  it("starts a new asset on the default kind in the spelling already in use, so the select always shows its value", async () => {
    const { onSubmit } = open([asset(1, "Generic"), asset(2, "Generic")]);
    expect(screen.getByLabelText("Kind")).toHaveValue("Generic");
    await userEvent.type(screen.getByLabelText("Name"), "Hall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).kind).toBe("Generic");
  });

  it("offers the starters, the kinds in use and Other… last", () => {
    open([asset(1, "LV_Panel")]);
    const texts = optionTexts();
    expect(texts).toEqual(expect.arrayContaining(["generic", "Site", "Rack", "LV_Panel"]));
    expect(texts.at(-1)).toBe("Other…");
    expect(screen.queryByLabelText("New kind")).not.toBeInTheDocument();
  });

  it("sends the chosen kind", async () => {
    const { onSubmit } = open([]);
    await userEvent.type(screen.getByLabelText("Name"), "Hall");
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Room");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit)).toMatchObject({ name: "Hall", kind: "Room" });
  });

  it("reuses the spelling in use when Other… is typed with other case or blanks", async () => {
    const { onSubmit } = open([asset(1, "LV_Panel")]);
    await userEvent.type(screen.getByLabelText("Name"), "Panel 2");
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Other…");
    await userEvent.type(screen.getByLabelText("New kind"), "lv_panel ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).kind).toBe("LV_Panel");
  });

  it("stores a brand-new kind cleaned, and offers it the next time the form is built from assets that include it", async () => {
    const { onSubmit, view } = open([asset(1, "Room")]);
    await userEvent.type(screen.getByLabelText("Name"), "Hall");
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Other…");
    await userEvent.type(screen.getByLabelText("New kind"), "Aisle");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).kind).toBe("Aisle");
    expect(optionTexts()).not.toContain("Aisle");
    view.unmount();
    open([asset(1, "Room"), asset(2, "Aisle")]);
    expect(optionTexts()).toContain("Aisle");
  });

  it("refuses Other… with blank text and sends nothing", async () => {
    const { onSubmit } = open([]);
    await userEvent.type(screen.getByLabelText("Name"), "Hall");
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Other…");
    await userEvent.type(screen.getByLabelText("New kind"), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("type the new kind");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the typed text when the select is left on Other… and the user types more", async () => {
    open([]);
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Other…");
    await userEvent.type(screen.getByLabelText("New kind"), "Aisle");
    expect(screen.getByLabelText("New kind")).toHaveValue("Aisle");
    expect(screen.getByLabelText("Kind")).toHaveValue("");
  });

  it("sends the stored kind unchanged when an asset of kind room is saved untouched, even though Room is used more", async () => {
    const assets = [asset(1, "Room"), asset(2, "Room"), asset(3, "room")];
    const { onSubmit } = open(assets, { name: "Asset 3", parent_id: null, kind: "room", sort_order: 0 });
    expect(screen.getByLabelText("Kind")).toHaveValue("room");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).kind).toBe("room");
  });

  it("sends a stored kind with a trailing blank unchanged", async () => {
    const { onSubmit } = open([asset(1, "Row ")], { name: "Asset 1", parent_id: null, kind: "Row ", sort_order: 0 });
    expect(screen.getByLabelText("Kind")).toHaveValue("Row ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).kind).toBe("Row ");
  });

  it.each([[""], ["  "]])("opens an asset whose stored kind is %j on generic (the one case a save changes the kind)", async (stored) => {
    const { onSubmit } = open([asset(1, stored)], { name: "Asset 1", parent_id: null, kind: stored, sort_order: 0 });
    expect(screen.getByLabelText("Kind")).toHaveValue("generic");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).kind).toBe("generic");
  });
});
