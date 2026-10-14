import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AssetKind, AssetKindIn, AssetKindPatch } from "../api/types";
import { iconHtml } from "../test/iconHtml";
import { pastSaveWindow, useSaveClock } from "../test/saveWindow";
import { KindForm } from "./KindForm";
import { Modal } from "./Modal";

const kind = (id: number, name: string, icon: string, asset_count = 0): AssetKind => ({ id, name, icon, asset_count });
const RACK = kind(1, "Rack", "rack", 3);
const PUMP = kind(2, "Pump", "pump");

type Submit = (body: AssetKindIn | AssetKindPatch) => Promise<void>;

function open({ initial, kinds = [RACK, PUMP], onSubmit = vi.fn<Submit>(async () => undefined) }: {
  initial?: AssetKind; kinds?: AssetKind[]; onSubmit?: ReturnType<typeof vi.fn<Submit>>;
} = {}) {
  const onCancel = vi.fn();
  const view = render(<KindForm initial={initial} kinds={kinds} onSubmit={onSubmit} onCancel={onCancel} />);
  return { onSubmit, onCancel, view };
}
const sent = (onSubmit: ReturnType<typeof vi.fn<Submit>>) => onSubmit.mock.calls[0][0];
const nameField = () => screen.getByLabelText("Name");
const save = () => userEvent.click(screen.getByRole("button", { name: "Save" }));
const field = () => screen.getByRole("group", { name: "Icon" });
const opener = () => screen.getByRole("button", { name: "Change icon" });
const grid = () => screen.getByRole("radiogroup", { hidden: true });
const cell = (name: string) => within(grid()).getByRole("radio", { name, hidden: true }) as HTMLInputElement;
const drawn = () => field().querySelector(".icon-preview svg")!.innerHTML;
const SUGGESTED = "Suggested from the name";
const emoji = (n: number) => String.fromCodePoint(0x1f600).repeat(n); // one code point, two UTF-16 units

useSaveClock(); // Save refuses a second click within 400 ms: a test that saves twice steps past that with pastSaveWindow()

beforeEach(() => {
  // user-event's arrow keys on a radio read window.CSS.escape, which jsdom 26 does not have.
  vi.stubGlobal("CSS", { escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("KindForm, a new kind", () => {
  it("starts empty on the generic icon, with no Automatic cell, and sends the name and the icon", async () => {
    const { onSubmit } = open();
    expect(nameField()).toHaveValue("");
    expect(drawn()).toBe(iconHtml("kindGeneric"));
    expect(screen.queryByRole("radio", { name: "Automatic", hidden: true })).not.toBeInTheDocument();
    await userEvent.type(nameField(), "Hall");
    await save();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ name: "Hall", icon: "hall" }); // the keyword guess: "hall" has its own icon since W7o (it was "room")
  });

  it("follows the typed name with the keyword guess, saying so, until an icon is picked", async () => {
    const { onSubmit } = open();
    expect(screen.queryByText(SUGGESTED)).not.toBeInTheDocument(); // nothing typed, nothing suggested
    await userEvent.type(nameField(), "UPS");
    expect(field()).toHaveAccessibleDescription(`UPS ${SUGGESTED}`);
    expect(drawn()).toBe(iconHtml("kindUps"));
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "Rack");
    expect(field()).toHaveAccessibleDescription(`Rack ${SUGGESTED}`);
    expect(drawn()).toBe(iconHtml("kindRack"));
    expect(screen.getByText(SUGGESTED)).toBeInTheDocument();
    await userEvent.click(opener());
    expect(cell("Rack")).toBeChecked(); // the suggestion is the checked cell
    await userEvent.click(cell("Server"));
    expect(screen.queryByText(SUGGESTED)).not.toBeInTheDocument();
    expect(field()).toHaveAccessibleDescription("Server");
    await userEvent.type(nameField(), "s of the hall"); // the name goes on changing; the pick is the person's now
    expect(drawn()).toBe(iconHtml("kindServer"));
    await save();
    expect(sent(onSubmit)).toEqual({ name: "Racks of the hall", icon: "server" });
  });

  it("stops following even when the pick is the icon already suggested", async () => {
    const { onSubmit } = open();
    await userEvent.type(nameField(), "Rack");
    await userEvent.click(opener());
    await userEvent.click(cell("Rack"));
    expect(screen.queryByText(SUGGESTED)).not.toBeInTheDocument();
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "UPS");
    expect(drawn()).toBe(iconHtml("kindRack"));
    await save();
    expect(sent(onSubmit)).toEqual({ name: "UPS", icon: "rack" });
  });

  it("finds an icon with the search box and sends it; the dialog closes layer by layer on Escape: the typed text, the grid, then the dialog", async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn<Submit>(async () => undefined);
    render(<Modal title="New kind" onClose={onClose}><KindForm kinds={[]} onSubmit={onSubmit} onCancel={onClose} /></Modal>);
    await userEvent.type(nameField(), "Spare");
    await userEvent.click(opener());
    const search = screen.getByRole("searchbox", { name: "Search icons" });
    await userEvent.type(search, "firewall");
    expect(screen.getAllByRole("radio").map((c) => c.closest("label")!.textContent)).toEqual(["Firewall", "Generic"]); // Generic is the checked cell: it stays
    await userEvent.click(cell("Firewall"));
    await userEvent.type(search, "{Escape}");
    expect(search).toHaveValue("");
    expect(grid()).not.toHaveAttribute("hidden");
    await userEvent.keyboard("{Escape}");
    expect(grid()).toHaveAttribute("hidden");
    expect(opener()).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled(); // the name typed so far is still there
    expect(nameField()).toHaveValue("Spare");
    await save();
    expect(sent(onSubmit)).toEqual({ name: "Spare", icon: "firewall" });
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("sends the name as the server will store it: blanks tidied, NFC", async () => {
    const { onSubmit } = open();
    await userEvent.type(nameField(), `  Cooling${String.fromCodePoint(0xa0)}  Pump `); // a no-break space is blank to the server too
    await save();
    expect(sent(onSubmit).name).toBe("Cooling Pump");
    expect(sent(onSubmit).icon).toBe("pump");
  });

  it("refuses a blank name with the server's words and sends nothing", async () => {
    const { onSubmit } = open();
    await userEvent.type(nameField(), "   ");
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent("A kind needs a name");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("accepts 60 characters and refuses 61 with the server's words", async () => {
    const { onSubmit } = open();
    await userEvent.type(nameField(), "x".repeat(61));
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent("A kind name is at most 60 characters");
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.type(nameField(), "{Backspace}");
    pastSaveWindow();
    await save();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(sent(onSubmit).name).toBe("x".repeat(60));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // cleared by the new attempt
  });

  it("counts characters as the server does, in code points: 60 emoji pass (120 UTF-16 units), 61 do not", async () => {
    const { onSubmit } = open();
    await userEvent.type(nameField(), emoji(61));
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent("A kind name is at most 60 characters");
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), emoji(60));
    pastSaveWindow();
    await save();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(sent(onSubmit).name).toBe(emoji(60));
  });

  it("does not stop typing at 60: the limit is a message, so a pasted name is not cut in two without a word", async () => {
    open();
    await userEvent.type(nameField(), "y".repeat(75));
    expect(nameField()).toHaveValue("y".repeat(75));
  });

  it("refuses a name another kind already has (case and blanks do not matter), in the server's words, and sends nothing", async () => {
    const { onSubmit } = open();
    await userEvent.type(nameField(), " rack ");
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent('A kind named "Rack" already exists');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows what the server answers, keeps what was typed and lets the person try again", async () => {
    const onSubmit = vi.fn<Submit>().mockRejectedValueOnce(new Error('A kind named "Hall" already exists')).mockResolvedValue(undefined);
    open({ onSubmit });
    await userEvent.type(nameField(), "Hall");
    await save();
    expect(await screen.findByRole("alert")).toHaveTextContent('A kind named "Hall" already exists');
    expect(nameField()).toHaveValue("Hall");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    pastSaveWindow();
    await save();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("sends once when Save is clicked twice, and when Enter is pressed in the field while the first save runs", async () => {
    let finish!: () => void;
    const onSubmit = vi.fn<Submit>(() => new Promise<void>((resolve) => { finish = resolve; }));
    open({ onSubmit });
    await userEvent.type(nameField(), "Hall");
    await userEvent.dblClick(screen.getByRole("button", { name: "Save" }));
    await userEvent.type(nameField(), "{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => { finish(); });
  });

  it("saves with Enter in the name field", async () => {
    const { onSubmit } = open();
    await userEvent.type(nameField(), "Hall{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("keeps Escape from closing the dialog while a save is running, and closes it otherwise", async () => {
    let finish!: () => void;
    const onClose = vi.fn();
    const onSubmit = vi.fn<Submit>(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<Modal title="New kind" onClose={onClose}><KindForm kinds={[]} onSubmit={onSubmit} onCancel={onClose} /></Modal>);
    expect(nameField()).toHaveFocus();
    await userEvent.type(nameField(), "Hall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    await screen.findByRole("button", { name: "Save" });
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Cancel closes without a request", async () => {
    const { onSubmit, onCancel } = open();
    await userEvent.type(nameField(), "Hall");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("KindForm, an existing kind", () => {
  it("is filled in: the name, the icon checked, drawn and named, and no suggestion", async () => {
    open({ initial: RACK });
    expect(nameField()).toHaveValue("Rack");
    expect(drawn()).toBe(iconHtml("kindRack"));
    expect(field()).toHaveAccessibleDescription("Rack");
    expect(screen.queryByText(SUGGESTED)).not.toBeInTheDocument();
    await userEvent.click(opener());
    expect(cell("Rack")).toBeChecked();
    expect(cell("Rack")).toHaveFocus();
  });

  it("does not follow the name: renaming leaves the icon alone", async () => {
    const { onSubmit } = open({ initial: RACK });
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "UPS");
    expect(drawn()).toBe(iconHtml("kindRack"));
    await save();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ name: "UPS" });
  });

  it("sends only what changed: the icon", async () => {
    const { onSubmit } = open({ initial: RACK });
    await userEvent.click(opener());
    await userEvent.click(cell("Server"));
    await save();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ icon: "server" });
  });

  it("sends both when both changed", async () => {
    const { onSubmit } = open({ initial: RACK });
    await userEvent.type(nameField(), "s");
    await userEvent.click(opener());
    await userEvent.click(cell("Fan"));
    await save();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ name: "Racks", icon: "fan" });
  });

  it("closes without a request when nothing changed, also when the name differs only in blanks or Unicode form", async () => {
    const { onSubmit, onCancel } = open({ initial: kind(5, `Caf${String.fromCodePoint(0xe9)}`, "generic") }); // NFC, as the server stores it
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), ` Cafe${String.fromCodePoint(0x301)}  `); // NFD, with blanks around it
    await save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps a seeded name that is not in NFC as it is: an icon change sends the icon alone, and an untouched save closes without a request", async () => {
    const nfd = `Cafe${String.fromCodePoint(0x301)}`; // seeded names are tidied of blanks, not normalised
    const { onSubmit, onCancel } = open({ initial: kind(8, nfd, "generic") });
    expect(nameField()).toHaveValue(nfd);
    await userEvent.click(opener());
    await userEvent.click(cell("Pump"));
    await save();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ icon: "pump" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("closes an untouched save of a seeded name that is not in NFC without a request", async () => {
    const { onSubmit, onCancel } = open({ initial: kind(8, `Cafe${String.fromCodePoint(0x301)}`, "generic") });
    await save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("does not hold an untouched long seeded name that is not in NFC to the 60-character limit (62 code points, 31 letters with a mark)", async () => {
    const long = `e${String.fromCodePoint(0x301)}`.repeat(31); // 62 code points in NFD, 31 in NFC
    expect([...long]).toHaveLength(62);
    const { onSubmit } = open({ initial: kind(8, long, "generic") });
    await userEvent.click(opener());
    await userEvent.click(cell("Pump"));
    await save();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ icon: "pump" });
  });

  it("sends nothing for an icon picked and then picked back", async () => {
    const { onSubmit, onCancel } = open({ initial: RACK });
    await userEvent.click(opener());
    await userEvent.click(cell("Server"));
    await userEvent.click(cell("Rack"));
    await save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("lets a seeded name longer than 60 characters through when the name is not edited (an icon change sends the icon alone)", async () => {
    const long = `Long ${"x".repeat(70)}`;
    const { onSubmit } = open({ initial: kind(7, long, "generic") });
    expect(nameField()).toHaveValue(long);
    await userEvent.click(opener());
    await userEvent.click(cell("Pump"));
    await save();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ icon: "pump" });
  });

  it("holds a long name that was edited to the 60-character limit, and accepts the edit once it fits", async () => {
    const { onSubmit } = open({ initial: kind(7, `Long ${"x".repeat(70)}`, "generic") });
    await userEvent.type(nameField(), "!");
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent("A kind name is at most 60 characters");
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "Short");
    pastSaveWindow();
    await save();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ name: "Short" });
  });

  it("refuses an empty name on an existing kind", async () => {
    const { onSubmit } = open({ initial: RACK });
    await userEvent.clear(nameField());
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent("A kind needs a name");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("may change the case of its own name (its own key is not a clash), and still refuses another kind's", async () => {
    const { onSubmit } = open({ initial: RACK });
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "RACK");
    await save();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ name: "RACK" });
    onSubmit.mockClear();
    pastSaveWindow();
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "pump");
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent('A kind named "Pump" already exists');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows a stored icon the catalogue lacks as unknown, draws the generic one, checks nothing and leaves it alone", async () => {
    const { onSubmit, onCancel } = open({ initial: kind(9, "Odd", "zzz") });
    expect(field()).toHaveAccessibleDescription('Unknown icon "zzz"');
    expect(drawn()).toBe(iconHtml("kindGeneric"));
    await userEvent.click(opener());
    expect((within(grid()).getAllByRole("radio", { hidden: true }) as HTMLInputElement[]).filter((c) => c.checked)).toHaveLength(0);
    await save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("compares with the kind as it was when the dialog opened: a refetch that changes the stored icon does not make an untouched form send anything", async () => {
    const { onSubmit, onCancel, view } = open({ initial: RACK });
    view.rerender(<KindForm initial={{ ...RACK, icon: "fan" }} kinds={[RACK, PUMP]} onSubmit={onSubmit} onCancel={onCancel} />);
    await save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
