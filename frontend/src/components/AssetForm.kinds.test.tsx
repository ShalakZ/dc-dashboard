import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AssetIn, AssetKind } from "../api/types";
import { AssetForm } from "./AssetForm";

// W7o: registering a typed kind needs "Manage asset kinds". The form never asks the account (its tests render it with no provider): the page
// tells it through `canRegister`, and the note under the icon and the answer it gives the page follow that one prop.

const REGISTRY: AssetKind[] = [{ id: 1, name: "Room", icon: "room", asset_count: 0 }];
const WITH = "New kind: added to Asset kinds.";
const WITHOUT = "Not in Asset kinds yet. Only someone who manages kinds can add it; this asset keeps the text.";

function open({ canRegister, initial }: { canRegister?: boolean; initial?: Partial<AssetIn> } = {}) {
  const onSubmit = vi.fn(async (_body: AssetIn, _registerKind: boolean) => undefined);
  const props = canRegister === undefined ? {} : { canRegister };
  render(<AssetForm assets={[]} kinds={REGISTRY} initial={initial} excludeIds={new Set()} onSubmit={onSubmit} onCancel={() => undefined} {...props} />);
  return { onSubmit };
}
async function typeKind(text: string) {
  await userEvent.selectOptions(screen.getByLabelText("Kind"), "Other…");
  await userEvent.type(screen.getByLabelText("New kind"), text);
}
async function save(name = "Pump 1") {
  await userEvent.type(screen.getByLabelText("Name"), name);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
}
/** The icon's description: its caption and, on a second line, the note. */
const description = () => screen.getByRole("group", { name: "Icon" });

describe("AssetForm and the right to add a kind", () => {
  it("with the right: a typed new kind shows the first note and asks the page to register it", async () => {
    const { onSubmit } = open({ canRegister: true });
    await typeKind("Pump");
    expect(description()).toHaveAccessibleDescription(expect.stringContaining(WITH));
    expect(description()).not.toHaveAccessibleDescription(expect.stringContaining("Not in Asset kinds yet"));
    await save();
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: "Pump 1", kind: "Pump" });
    expect(onSubmit.mock.calls[0][1]).toBe(true);
  });

  it("without the right: the same typed kind shows the second note, is still stored as text, and nothing is to be registered", async () => {
    const { onSubmit } = open({ canRegister: false });
    await typeKind("Pump");
    expect(description()).toHaveAccessibleDescription(expect.stringContaining(WITHOUT));
    expect(description()).not.toHaveAccessibleDescription(expect.stringContaining(WITH));
    await save();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: "Pump 1", kind: "Pump" }); // the asset keeps the text
    expect(onSubmit.mock.calls[0][1]).toBe(false);
  });

  it("leaves the right unasked (a form rendered on its own) as before: the first note, and a registration", async () => {
    const { onSubmit } = open();
    await typeKind("Pump");
    expect(description()).toHaveAccessibleDescription(expect.stringContaining(WITH));
    await save();
    expect(onSubmit.mock.calls[0][1]).toBe(true);
  });

  it.each([true, false])("says nothing about registering for a kind the registry has, chosen or typed in another case (canRegister %s)", async (canRegister) => {
    const { onSubmit } = open({ canRegister });
    await typeKind(" ROOM");
    expect(screen.queryByText(WITH)).not.toBeInTheDocument();
    expect(screen.queryByText(WITHOUT)).not.toBeInTheDocument();
    await save();
    expect(onSubmit.mock.calls[0][1]).toBe(false);
  });

  it("says nothing for the default kind", () => {
    open({ canRegister: false });
    expect(screen.queryByText(WITHOUT)).not.toBeInTheDocument(); // generic, untouched
    expect(screen.queryByText(WITH)).not.toBeInTheDocument();
  });

  it("says nothing for an edit that leaves the stored kind as it is, and registers nothing", async () => {
    const { onSubmit } = open({ canRegister: false, initial: { name: "Old", kind: "Aisle" } });
    expect(screen.queryByText(WITHOUT)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit.mock.calls[0][1]).toBe(false);
  });

  it("keeps the second note inside the icon's description and out of any live region (one announcer)", async () => {
    open({ canRegister: false });
    await typeKind("Pump");
    const note = screen.getByText(WITHOUT);
    expect(note.closest("[aria-live]")).toBeNull();
    expect(note.closest("[role=alert],[role=status]")).toBeNull();
  });
});
