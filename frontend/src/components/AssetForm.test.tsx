import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Asset, AssetIn, AssetKind } from "../api/types";
import { ASSET_ICONS, kindIconId } from "../lib/assetIcons";
import { DEFAULT_KIND, STARTER_KINDS } from "../lib/kinds";
import { iconHtml } from "../test/iconHtml";
import { AssetForm } from "./AssetForm";
import { Modal } from "./Modal";

const asset = (id: number, kind: string): Asset => ({ id, parent_id: null, name: `Asset ${id}`, kind, sort_order: 0 });

/** A registry kind; the icon is the keyword guess unless given, as when the kind was created with the suggestion. */
const kind = (name: string, icon = kindIconId(name), id = 1): AssetKind => ({ id, name, icon, asset_count: 0 });
/** The registry as migration 0010 leaves it: the starter kinds and generic, each with the icon the guess gives. */
const SEEDED: AssetKind[] = [...STARTER_KINDS, DEFAULT_KIND].map((name, i) => kind(name, kindIconId(name), i + 1));

function open(assets: Asset[], initial?: Partial<AssetIn>, kinds: AssetKind[] = SEEDED) {
  const onSubmit = vi.fn(async (_body: AssetIn, _registerKind: boolean) => undefined);
  const view = render(<AssetForm assets={assets} kinds={kinds} initial={initial} excludeIds={new Set()} onSubmit={onSubmit} onCancel={() => undefined} />);
  return { onSubmit, view };
}
const sent = (onSubmit: ReturnType<typeof open>["onSubmit"]) => onSubmit.mock.calls[0][0];
/** Whether the save asked the page to add the kind to the registry (the second argument of onSubmit). */
const registers = (onSubmit: ReturnType<typeof open>["onSubmit"]) => onSubmit.mock.calls[0][1];
const NEW_KIND_NOTE = "New kind: added to Asset kinds.";
const optionTexts = () => within(screen.getByLabelText("Kind")).getAllByRole("option").map((o) => o.textContent);

describe("AssetForm Kind", () => {
  it("starts a new asset on generic and sends it when Kind is not touched", async () => {
    const { onSubmit } = open([asset(1, "Room")]);
    expect(screen.getByLabelText("Kind")).toHaveValue("generic");
    await userEvent.type(screen.getByLabelText("Name"), "Hall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).kind).toBe("generic");
  });

  it("starts a new asset on the default kind in the registry's spelling, so the select always shows its value", async () => {
    const { onSubmit } = open([], undefined, [kind("Generic"), kind("Rack", "rack", 2)]);
    expect(screen.getByLabelText("Kind")).toHaveValue("Generic");
    await userEvent.type(screen.getByLabelText("Name"), "Hall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).kind).toBe("Generic");
  });

  it("offers the registry's kinds sorted by key, generic when the registry lacks it, and Other… last", () => {
    open([], undefined, [kind("Rack"), kind("LV_Panel", "panel", 2), kind("Aisle", "row", 3)]);
    expect(optionTexts()).toEqual(["Aisle", "generic", "LV_Panel", "Rack", "Other…"]);
    expect(screen.queryByLabelText("New kind")).not.toBeInTheDocument();
  });

  it("offers the seeded registry: the starters and generic, each once", () => {
    open([]);
    expect(optionTexts()).toEqual([...[...STARTER_KINDS, DEFAULT_KIND].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)), "Other…"]);
  });

  it("does not offer a kind that assets use but the registry lacks: typing it under Other… adds it", () => {
    open([asset(1, "LV_Panel"), asset(2, "Aisle")]);
    expect(optionTexts()).not.toContain("LV_Panel");
    expect(optionTexts()).not.toContain("Aisle");
  });

  it("offers the asset's own kind exactly as stored, even when the registry lacks it or spells it otherwise", () => {
    open([], { name: "Asset", parent_id: null, kind: "aisle ", sort_order: 0 });
    expect(optionTexts()).toContain("aisle ");
    expect(screen.getByLabelText("Kind")).toHaveValue("aisle ");
    expect(optionTexts().filter((t) => t!.trim().toLowerCase() === "aisle")).toHaveLength(1);
  });

  it("sends the chosen kind", async () => {
    const { onSubmit } = open([]);
    await userEvent.type(screen.getByLabelText("Name"), "Hall");
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Room");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit)).toMatchObject({ name: "Hall", kind: "Room" });
  });

  it("reuses the registry's spelling when Other… is typed with other case or blanks, and asks for no registration", async () => {
    const { onSubmit } = open([], undefined, [...SEEDED, kind("LV_Panel", "panel", 20)]);
    await userEvent.type(screen.getByLabelText("Name"), "Panel 2");
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Other…");
    await userEvent.type(screen.getByLabelText("New kind"), "lv_panel ");
    expect(screen.getByRole("group", { name: "Icon" })).toHaveAccessibleDescription("Automatic (Panel)"); // a kind the registry has: no note
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).kind).toBe("LV_Panel");
    expect(registers(onSubmit)).toBe(false);
  });

  it("stores a brand-new kind cleaned, asks the page to register it, and offers it once the registry includes it", async () => {
    const { onSubmit, view } = open([asset(1, "Room")]);
    await userEvent.type(screen.getByLabelText("Name"), "Hall");
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Other…");
    await userEvent.type(screen.getByLabelText("New kind"), "  New   Aisle ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).kind).toBe("New Aisle");
    expect(registers(onSubmit)).toBe(true);
    expect(optionTexts()).not.toContain("New Aisle");
    view.unmount();
    open([asset(1, "Room")], undefined, [...SEEDED, kind("New Aisle", "generic", 20)]);
    expect(optionTexts()).toContain("New Aisle");
  });

  it("asks for no registration when a registry kind is chosen, nor for the default kind", async () => {
    const { onSubmit } = open([]);
    await userEvent.type(screen.getByLabelText("Name"), "Hall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).kind).toBe("generic");
    expect(registers(onSubmit)).toBe(false);
    onSubmit.mockClear();
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Room");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).kind).toBe("Room");
    expect(registers(onSubmit)).toBe(false);
  });

  it("never asks to register the key generic, however it is typed, even when the registry lacks it", async () => {
    const { onSubmit } = open([], undefined, [kind("Rack")]);
    await userEvent.type(screen.getByLabelText("Name"), "Hall");
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Other…");
    await userEvent.type(screen.getByLabelText("New kind"), " GENERIC");
    expect(screen.getByRole("group", { name: "Icon" })).toHaveAccessibleDescription("Automatic (Generic)"); // no note either
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).kind).toBe("generic");
    expect(registers(onSubmit)).toBe(false);
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

  it("sends the stored kind unchanged when an asset of kind room is saved untouched, even though the registry spells it Room", async () => {
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

// The Icon field. user-event's arrow keys on a radio read window.CSS.escape, which jsdom 26 does not have: stub it here only.
describe("AssetForm Icon", () => {
  beforeEach(() => {
    vi.stubGlobal("CSS", { escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const field = () => screen.getByRole("group", { name: "Icon" });
  const opener = () => screen.getByRole("button", { name: "Change icon" });
  const grid = () => screen.getByRole("radiogroup", { hidden: true }); // a hidden element has no accessible name, so no name here
  const cells = () => within(grid()).getAllByRole("radio", { hidden: true }) as HTMLInputElement[];
  const cell = (name: string) => within(grid()).getByRole("radio", { name, hidden: true }) as HTMLInputElement;
  const preview = () => field().querySelector(".icon-preview")!;
  const drawn = () => preview().querySelector("svg")!.innerHTML;
  const named = { name: "Asset", parent_id: null, kind: "Room", sort_order: 0 };
  const submittedKeys = (onSubmit: ReturnType<typeof open>["onSubmit"]) => Object.keys(sent(onSubmit));

  it("sits after Kind and New kind, before Sort order", async () => {
    open([]);
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Other…");
    const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(screen.getByLabelText("New kind"), field())).toBe(true);
    expect(before(field(), screen.getByLabelText("Sort order"))).toBe(true);
  });

  it("starts on Automatic, drawn as the kind's icon, with the preview as decoration", () => {
    open([], { ...named, kind: "Panel" });
    expect(field()).toHaveAccessibleDescription("Automatic (Panel)");
    expect(preview()).toHaveAttribute("aria-hidden", "true");
    expect(preview()).toHaveClass("page-tile");
    expect(drawn()).toBe(iconHtml("kindPanel"));
    expect(cell("Automatic")).toBeChecked();
  });

  it("follows the Kind select, and the text typed under Other…, while it is Automatic", async () => {
    open([]);
    expect(field()).toHaveAccessibleDescription("Automatic (Generic)");
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Panel");
    expect(field()).toHaveAccessibleDescription("Automatic (Panel)");
    expect(drawn()).toBe(iconHtml("kindPanel"));
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Other…");
    expect(field()).toHaveAccessibleDescription("Automatic (Generic)"); // nothing typed yet: not the stale Panel
    expect(drawn()).toBe(iconHtml("kindGeneric"));
    await userEvent.type(screen.getByLabelText("New kind"), "UPS");
    expect(field()).toHaveAccessibleDescription(`Automatic (UPS) ${NEW_KIND_NOTE}`); // UPS is not in the seeded registry: a new kind, so the note joins the caption
    expect(drawn()).toBe(iconHtml("kindUps"));
    expect(cell("Automatic").closest("label")!.querySelector("svg")!.innerHTML).toBe(iconHtml("kindUps"));
  });

  it("keeps a chosen icon when the kind changes", async () => {
    open([]);
    await userEvent.click(opener());
    await userEvent.click(cell("Server"));
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Panel");
    expect(field()).toHaveAccessibleDescription("Server");
    expect(drawn()).toBe(iconHtml("kindServer"));
  });

  it("keeps the grid collapsed (out of the accessibility tree) until Change icon opens it, then puts focus on the checked cell", async () => {
    open([], { ...named, icon: "rack" });
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

  it("puts focus on Automatic when no icon is chosen", async () => {
    open([]);
    await userEvent.click(opener());
    expect(cell("Automatic")).toHaveFocus();
  });

  it("offers Automatic and the 48 icons, each named by its label and titled", () => {
    open([]);
    expect(cells().map((c) => c.closest("label")!.textContent)).toEqual(["Automatic", ...ASSET_ICONS.map((e) => e.label)]);
    for (const c of cells()) {
      const label = c.closest("label")!;
      expect(c).toHaveAccessibleName(label.textContent!);
      // Automatic says what it does; the others are titled with their name
      expect(label).toHaveAttribute("title", label.textContent === "Automatic" ? expect.stringMatching(/^Automatic: follows the kind \(/) : label.textContent!);
      expect(label.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
    expect(cells().map((c) => c.closest("label")!.querySelector("svg")!.innerHTML).slice(1)).toEqual(ASSET_ICONS.map((e) => iconHtml(e.icon)));
  });

  it("names the choice in the caption, shows its icon in the preview and sends its id", async () => {
    const { onSubmit } = open([]);
    await userEvent.type(screen.getByLabelText("Name"), "Hall");
    await userEvent.click(opener());
    await userEvent.click(cell("Network switch"));
    expect(cell("Network switch")).toBeChecked();
    expect(field()).toHaveAccessibleDescription("Network switch");
    expect(drawn()).toBe(iconHtml("kindSwitch"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit)).toMatchObject({ name: "Hall", kind: "generic", icon: "switch" });
  });

  it("stays open after a pick, and Automatic after a pick sends null on an edit", async () => {
    const { onSubmit } = open([], { ...named, icon: "rack" });
    await userEvent.click(opener());
    await userEvent.click(cell("Automatic"));
    expect(grid()).not.toHaveAttribute("hidden");
    expect(field()).toHaveAccessibleDescription("Automatic (Room)");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).icon).toBeNull();
    expect(submittedKeys(onSubmit)).toContain("icon");
  });

  it("omits icon when the asset ends where it began (a pick, then back to Automatic on a new asset)", async () => {
    const { onSubmit } = open([]);
    await userEvent.type(screen.getByLabelText("Name"), "Hall");
    await userEvent.click(opener());
    await userEvent.click(cell("Server"));
    await userEvent.click(cell("Automatic"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(submittedKeys(onSubmit)).not.toContain("icon");
  });

  it.each([[undefined], [null], ["server"]])("an edit of only the name sends no icon key (stored icon %j)", async (stored) => {
    const { onSubmit } = open([], { ...named, icon: stored });
    await userEvent.type(screen.getByLabelText("Name"), "!");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(submittedKeys(onSubmit)).not.toContain("icon");
  });

  it("sends the new id when an edit changes the icon", async () => {
    const { onSubmit } = open([], { ...named, icon: "server" });
    await userEvent.click(opener());
    await userEvent.click(cell("Fan"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).icon).toBe("fan");
  });

  it("shows an icon id it does not know as unknown: nothing checked, the kind's icon, and an untouched save leaves it alone", async () => {
    const { onSubmit } = open([], { ...named, icon: "xyz" });
    expect(field()).toHaveAccessibleDescription('Unknown icon "xyz"');
    expect(drawn()).toBe(iconHtml("kindRoom"));
    expect(cells().filter((c) => c.checked)).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(submittedKeys(onSubmit)).not.toContain("icon");
  });

  it("lets an unknown stored id be replaced, or cleared", async () => {
    const { onSubmit } = open([], { ...named, icon: "xyz" });
    await userEvent.click(opener());
    expect(cell("Automatic")).toHaveFocus(); // nothing is checked: the first cell takes the focus
    await userEvent.click(cell("Automatic"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).icon).toBeNull();
  });

  it("treats a blank stored icon as Automatic: the caption, the checked cell, nothing sent untouched, a pick still sent", async () => {
    const { onSubmit } = open([], { ...named, icon: "" });
    expect(field()).toHaveAccessibleDescription("Automatic (Room)");
    expect(cell("Automatic")).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(submittedKeys(onSubmit)).not.toContain("icon");
    onSubmit.mockClear();
    await userEvent.click(opener());
    await userEvent.click(cell("Fan"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent(onSubmit).icon).toBe("fan");
  });

  it("compares with the icon the dialog opened with: a refetched list that changes the stored icon does not make an untouched form send the old one", async () => {
    const { onSubmit, view } = open([], { ...named, icon: "server" });
    view.rerender(<AssetForm assets={[]} kinds={SEEDED} initial={{ ...named, icon: "leak" }} excludeIds={new Set()} onSubmit={onSubmit} onCancel={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(submittedKeys(onSubmit)).not.toContain("icon");
  });

  it("changes the choice, the caption, the preview and the payload with the arrow keys", async () => {
    const { onSubmit } = open([], { ...named, icon: "site" });
    await userEvent.click(opener());
    expect(cell("Site")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(cell("Building")).toBeChecked();
    expect(cell("Building")).toHaveFocus();
    expect(field()).toHaveAccessibleDescription("Building");
    expect(drawn()).toBe(iconHtml("kindBuilding"));
    await userEvent.keyboard("{ArrowRight}{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(cell("Automatic")).toBeChecked();
    expect(field()).toHaveAccessibleDescription("Automatic (Room)");
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(sent(onSubmit).icon).toBe("building");
  });

  it("does not save the form when Change icon is clicked", async () => {
    const { onSubmit } = open([]);
    await userEvent.type(screen.getByLabelText("Name"), "Hall");
    await userEvent.click(opener());
    await userEvent.click(opener());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not save the form when Enter is pressed on a cell", async () => {
    const { onSubmit } = open([]);
    await userEvent.type(screen.getByLabelText("Name"), "Hall");
    await userEvent.click(opener());
    await userEvent.keyboard("{ArrowRight}{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(grid()).not.toHaveAttribute("hidden");
    expect(cell("Site")).toBeChecked();
  });

  it("chooses the focused cell with Space, without saving", async () => {
    const { onSubmit } = open([], { ...named, icon: "xyz" });
    await userEvent.click(opener());
    expect(cell("Automatic")).toHaveFocus();
    expect(cell("Automatic")).not.toBeChecked();
    await userEvent.keyboard(" ");
    expect(cell("Automatic")).toBeChecked();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not stop Enter in the other fields from saving", async () => {
    const { onSubmit } = open([]);
    await userEvent.type(screen.getByLabelText("Name"), "Hall{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("closes only the grid on Escape, keeping the dialog and the typed name, and a second Escape closes the dialog", async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn(async () => undefined);
    render(<Modal title="Edit asset" onClose={onClose}><AssetForm assets={[]} kinds={SEEDED} initial={named} excludeIds={new Set()} onSubmit={onSubmit} onCancel={onClose} /></Modal>);
    expect(screen.getByLabelText("Name")).toHaveFocus();
    await userEvent.type(screen.getByLabelText("Name"), " 2");
    await userEvent.click(opener());
    await userEvent.keyboard("{ArrowRight}{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(grid()).toHaveAttribute("hidden");
    expect(opener()).toHaveAttribute("aria-expanded", "false");
    expect(opener()).toHaveFocus();
    expect(screen.getByLabelText("Name")).toHaveValue("Asset 2");
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// The registry decides what "Automatic" means for a kind, and a kind it lacks is added when the asset is saved.
describe("AssetForm and the registry", () => {
  const field = () => screen.getByRole("group", { name: "Icon" });
  const drawn = () => field().querySelector(".icon-preview svg")!.innerHTML;
  const grid = () => screen.getByRole("radiogroup", { hidden: true });
  const automaticCell = () => within(grid()).getByRole("radio", { name: "Automatic", hidden: true }).closest("label")!;
  const named = { name: "Asset", parent_id: null, sort_order: 0 };
  const typeKind = async (text: string) => {
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Other…");
    await userEvent.type(screen.getByLabelText("New kind"), text);
  };
  const save = () => userEvent.click(screen.getByRole("button", { name: "Save" }));

  it("names the registry's icon for a registered kind, whatever the keyword guess says", async () => {
    open([], { ...named, kind: "Pump" }, [kind("Pump", "server")]); // the guess for "Pump" is the pump
    expect(field()).toHaveAccessibleDescription("Automatic (Server)");
    expect(drawn()).toBe(iconHtml("kindServer"));
    expect(automaticCell().querySelector("svg")!.innerHTML).toBe(iconHtml("kindServer"));
    expect(automaticCell()).toHaveAttribute("title", "Automatic: follows the kind (Server)");
  });

  it("follows the Kind select to another registered kind's icon", async () => {
    open([], undefined, [kind("Pump", "server"), kind("Fan", "fan", 2)]);
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Pump");
    expect(field()).toHaveAccessibleDescription("Automatic (Server)");
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "Fan");
    expect(field()).toHaveAccessibleDescription("Automatic (Fan)");
    expect(drawn()).toBe(iconHtml("kindFan"));
  });

  it("draws the generic icon for a registry icon the catalogue lacks, not the keyword guess", () => {
    open([], { ...named, kind: "Pump" }, [kind("Pump", "zzz")]);
    expect(field()).toHaveAccessibleDescription("Automatic (Generic)");
    expect(drawn()).toBe(iconHtml("kindGeneric"));
  });

  it("lets the asset's own icon win in the preview and the caption", async () => {
    open([], { ...named, kind: "Pump", icon: "rack" }, [kind("Pump", "server")]);
    expect(field()).toHaveAccessibleDescription("Rack");
    expect(drawn()).toBe(iconHtml("kindRack"));
    expect(automaticCell().querySelector("svg")!.innerHTML).toBe(iconHtml("kindServer")); // Automatic still shows what the kind gives
  });

  describe("a typed kind the registry does not have", () => {
    it("shows the keyword guess as the icon, and says the kind is added with it", async () => {
      open([], undefined, SEEDED);
      await typeKind("Cooling Pump");
      expect(field()).toHaveAccessibleDescription(`Automatic (Pump) ${NEW_KIND_NOTE}`);
      expect(drawn()).toBe(iconHtml("kindPump"));
    });

    it("says nothing before anything is typed, and again nothing for a kind the registry has in another case", async () => {
      open([], undefined, [...SEEDED, kind("Aisle", "row", 20)]);
      await userEvent.selectOptions(screen.getByLabelText("Kind"), "Other…");
      expect(field()).toHaveAccessibleDescription("Automatic (Generic)");
      await userEvent.type(screen.getByLabelText("New kind"), "AISLE");
      expect(field()).toHaveAccessibleDescription("Automatic (Row of racks)"); // the registry's icon, no note
      expect(drawn()).toBe(iconHtml("kindRow"));
    });

    it("keeps the note while an icon of the asset's own is chosen: the kind is registered either way", async () => {
      open([]);
      await typeKind("Aisle");
      expect(field()).toHaveAccessibleDescription(expect.stringContaining(NEW_KIND_NOTE));
      await userEvent.click(screen.getByRole("button", { name: "Change icon" }));
      await userEvent.click(within(grid()).getByRole("radio", { name: "Server", hidden: true }));
      expect(field()).toHaveAccessibleDescription(`Server ${NEW_KIND_NOTE}`);
      await userEvent.click(within(grid()).getByRole("radio", { name: "Automatic", hidden: true }));
      expect(field()).toHaveAccessibleDescription(expect.stringContaining(NEW_KIND_NOTE));
    });

    it("keeps the note off an edit that leaves the kind alone, however unregistered the kind is", async () => {
      const { onSubmit } = open([], { ...named, kind: "Aisle" });
      expect(field()).toHaveAccessibleDescription("Automatic (Row of racks)"); // the guess for "Aisle", and no note
      await userEvent.type(screen.getByLabelText("Name"), "!");
      await save();
      expect(registers(onSubmit)).toBe(false);
    });

    it("asks the page to register the kind of an edit that changes it to a new one, and not one that does not change it", async () => {
      const first = open([], { ...named, kind: "Aisle" });
      await save();
      expect(registers(first.onSubmit)).toBe(false);
      first.view.unmount();
      const second = open([], { ...named, kind: "Aisle" });
      await typeKind("Corridor");
      await save();
      expect(sent(second.onSubmit).kind).toBe("Corridor");
      expect(registers(second.onSubmit)).toBe(true);
    });

    it("treats a blank stored kind as a new asset's: the default kind, so nothing to register, and a typed kind is registered", async () => {
      const blank = open([], { ...named, kind: "  " });
      await save();
      expect(sent(blank.onSubmit).kind).toBe("generic");
      expect(registers(blank.onSubmit)).toBe(false);
      blank.view.unmount();
      const typed = open([], { ...named, kind: "" });
      await typeKind("Corridor");
      await save();
      expect(registers(typed.onSubmit)).toBe(true);
    });
  });

  describe("the 60-character limit on a new kind", () => {
    const longest = "x".repeat(60);

    it("accepts 60 characters and refuses 61 with the server's words, sending nothing", async () => {
      const { onSubmit } = open([]);
      await userEvent.type(screen.getByLabelText("Name"), "Hall");
      await typeKind(`${longest}y`);
      await save();
      expect(screen.getByRole("alert")).toHaveTextContent("A kind name is at most 60 characters");
      expect(onSubmit).not.toHaveBeenCalled();
      await userEvent.clear(screen.getByLabelText("New kind"));
      await userEvent.type(screen.getByLabelText("New kind"), longest);
      await save();
      expect(sent(onSubmit).kind).toBe(longest);
      expect(registers(onSubmit)).toBe(true);
    });

    it("counts code points, not UTF-16 units: 60 emoji pass, 61 do not", async () => {
      const emoji = String.fromCodePoint(0x1f600);
      const { onSubmit } = open([]);
      await userEvent.type(screen.getByLabelText("Name"), "Hall");
      await userEvent.selectOptions(screen.getByLabelText("Kind"), "Other…");
      await userEvent.click(screen.getByLabelText("New kind"));
      await userEvent.paste(emoji.repeat(61));
      await save();
      expect(screen.getByRole("alert")).toHaveTextContent("A kind name is at most 60 characters");
      expect(onSubmit).not.toHaveBeenCalled();
      await userEvent.clear(screen.getByLabelText("New kind"));
      await userEvent.paste(emoji.repeat(60));
      await save();
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    it("counts the text as the server stores it (NFC): 60 letters with a combining accent are 60 characters", async () => {
      const decomposed = String.fromCodePoint(0x65, 0x301).repeat(60); // 120 code points as typed, 60 once composed
      const { onSubmit } = open([]);
      await userEvent.type(screen.getByLabelText("Name"), "Hall");
      await userEvent.selectOptions(screen.getByLabelText("Kind"), "Other…");
      await userEvent.click(screen.getByLabelText("New kind"));
      await userEvent.paste(decomposed);
      await save();
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    it("does not hold a name the registry already has to the limit: a seeded name can be longer", async () => {
      const seeded = "S".repeat(70);
      const { onSubmit } = open([], undefined, [...SEEDED, kind(seeded, "generic", 20)]);
      await userEvent.type(screen.getByLabelText("Name"), "Hall");
      await userEvent.selectOptions(screen.getByLabelText("Kind"), "Other…");
      await userEvent.click(screen.getByLabelText("New kind"));
      await userEvent.paste(seeded.toLowerCase());
      await save();
      expect(sent(onSubmit).kind).toBe(seeded);
      expect(registers(onSubmit)).toBe(false);
    });
  });
});
