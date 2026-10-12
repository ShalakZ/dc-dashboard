import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Asset, AssetIn } from "../api/types";
import { ASSET_ICONS } from "../lib/assetIcons";
import { iconHtml } from "../test/iconHtml";
import { AssetForm } from "./AssetForm";
import { Modal } from "./Modal";

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
    expect(field()).toHaveAccessibleDescription("Automatic (UPS)");
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

  it("offers Automatic and the 28 icons, each named by its label and titled", () => {
    open([]);
    expect(cells().map((c) => c.closest("label")!.textContent)).toEqual(["Automatic", ...ASSET_ICONS.map((e) => e.label)]);
    for (const c of cells()) {
      const label = c.closest("label")!;
      expect(c).toHaveAccessibleName(label.textContent!);
      expect(label).toHaveAttribute("title", label.textContent!);
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

  it("closes the dialog on Escape with the grid open, leaving nothing behind", async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn(async () => undefined);
    render(<Modal title="Edit asset" onClose={onClose}><AssetForm assets={[]} initial={named} excludeIds={new Set()} onSubmit={onSubmit} onCancel={onClose} /></Modal>);
    expect(screen.getByLabelText("Name")).toHaveFocus();
    await userEvent.click(opener());
    await userEvent.keyboard("{ArrowRight}{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
