import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { Asset } from "../../api/types";
import { AssetPicker, assetLabels, assetOptions, pickerRows } from "./AssetPicker";

const tree: Asset[] = [
  { id: 1, parent_id: null, name: "Site", kind: "site", sort_order: 0 },
  { id: 2, parent_id: 1, name: "Room A", kind: "room", sort_order: 0 },
  { id: 3, parent_id: 2, name: "Panel", kind: "panel", sort_order: 0 },
  { id: 4, parent_id: 1, name: "Room B", kind: "room", sort_order: 1 },
  { id: 5, parent_id: 4, name: "Panel", kind: "panel", sort_order: 0 },
  { id: 6, parent_id: null, name: "Main", kind: "meter", sort_order: 1 },
];
const many = (n: number): Asset[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, parent_id: null, name: `Asset ${i + 1}`, kind: "generic", sort_order: i }));

function Harness({ assets, initial = [], single = false, max = 20, ...rest }: {
  assets: Asset[]; initial?: number[]; single?: boolean; max?: number; tree?: Asset[]; notes?: ReadonlyMap<number, string>;
}) {
  const [selected, setSelected] = useState<number[]>(initial);
  return (
    <>
      <AssetPicker assets={assets} selected={selected} onChange={setSelected} single={single} max={max} {...rest} />
      <output data-testid="selected">{selected.join(",")}</output>
    </>
  );
}

describe("pickerRows", () => {
  it("lists the tree parents first, with depth, the parent path, and a flag for names used twice", () => {
    expect(pickerRows(tree).map((r) => [r.id, r.depth, r.parentPath, r.duplicate])).toEqual([
      [1, 0, "", false], [2, 1, "Site", false], [3, 2, "Site / Room A", true],
      [4, 1, "Site", false], [5, 2, "Site / Room B", true], [6, 0, "", false],
    ]);
  });

  it("keeps the real parent path when only some assets are offered (they are not all top level)", () => {
    const panels = tree.filter((a) => a.name === "Panel");
    expect(pickerRows(panels, tree).map((r) => [r.id, r.depth, r.parentPath, r.duplicate])).toEqual([
      [3, 0, "Site / Room A", true], [5, 0, "Site / Room B", true],
    ]);
    // Without the whole tree to look at, both panels would read as top-level assets.
    expect(pickerRows(panels).map((r) => r.parentPath)).toEqual(["", ""]);
  });

  it("indents only below the ancestors that are offered", () => {
    const some = tree.filter((a) => a.id === 1 || a.id === 3 || a.id === 6);
    expect(pickerRows(some, tree).map((r) => [r.id, r.depth])).toEqual([[1, 0], [3, 1], [6, 0]]);
  });
});

describe("assetLabels", () => {
  it("names an asset by its name alone, and by its parent path when the name is used twice", () => {
    expect([...assetLabels(tree)]).toEqual([
      [1, "Site"], [2, "Room A"], [3, "Panel (Site / Room A)"], [4, "Room B"], [5, "Panel (Site / Room B)"], [6, "Main"],
    ]);
  });

  it("adds the id when two siblings share a name, because their paths are the same", () => {
    const twins: Asset[] = [
      { id: 1, parent_id: null, name: "Rack", kind: "rack", sort_order: 0 },
      { id: 7, parent_id: 1, name: "Meter", kind: "meter", sort_order: 0 },
      { id: 8, parent_id: 1, name: "Meter", kind: "meter", sort_order: 1 },
      { id: 9, parent_id: null, name: "Meter", kind: "meter", sort_order: 1 },
    ];
    expect([...assetLabels(twins)]).toEqual([
      [1, "Rack"], [7, "Meter (Rack) #7"], [8, "Meter (Rack) #8"], [9, "Meter (top level)"],
    ]);
  });
});

const asset = (id: number, name: string, parent_id: number | null = null, sort_order = 0) => ({ id, parent_id, name, kind: "x", sort_order });

describe("labels that tell equal names apart", () => {
  const tree = [asset(1, "Room"), asset(2, "Other room"), asset(3, "Meter", 1), asset(4, "Meter", 1), asset(5, "Panel", 1), asset(6, "Panel", 2)];

  it("adds the parent path for a shared name and the id for two siblings that share both", () => {
    const labels = assetLabels(tree);
    expect(labels.get(3)).toBe("Meter (Room) #3");
    expect(labels.get(4)).toBe("Meter (Room) #4");
    expect(labels.get(5)).toBe("Panel (Room)");
    expect(labels.get(6)).toBe("Panel (Other room)");
    expect(labels.get(1)).toBe("Room");
  });

  it("the dashboard picker shows the same labels (BL:86)", () => {
    render(<AssetPicker assets={tree} selected={[]} onChange={() => {}} single={false} max={5} />);
    expect(screen.getByLabelText("Meter (Room) #3")).toBeInTheDocument();
    expect(screen.getByLabelText("Meter (Room) #4")).toBeInTheDocument();
  });

  it("assetOptions lists the tree in order, indented, with those labels, and drops the excluded ids", () => {
    // Roots come in code-point name order ("Other room" before "Room"). With 5 excluded, the remaining "Panel" is no longer a
    // shared name among the offered rows, so it needs no path: the invariant is that no two offered options read alike.
    const options = assetOptions(tree, new Set([5]));
    expect(options.map((o) => o.text.replace(/\u00a0/g, "_"))).toEqual([
      "Other room", "__Panel", "Room", "__Meter (Room) #3", "__Meter (Room) #4",
    ]);
    expect(options.some((o) => o.id === 5)).toBe(false);
  });
});

describe("AssetPicker", () => {
  it("shows the path of assets whose name is used more than once", () => {
    render(<Harness assets={tree} />);
    expect(screen.getByRole("checkbox", { name: "Panel (Site / Room A)" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Panel (Site / Room B)" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Room A" })).toBeInTheDocument();
  });

  it("tells same-named assets apart even when their parents are not offered", () => {
    render(<Harness assets={tree.filter((a) => a.name === "Panel")} tree={tree} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: "Panel (Site / Room A)" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Panel (Site / Room B)" })).toBeInTheDocument();
  });

  it("appends a note to an asset that carries one", () => {
    render(<Harness assets={tree} initial={[6]} notes={new Map([[6, "no voltage_v"], [2, "no voltage_v"]])} />);
    expect(screen.getByRole("checkbox", { name: "Main (no voltage_v)" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Room A (no voltage_v)" })).not.toBeChecked();
  });

  it("toggles assets in and out of the selection", async () => {
    render(<Harness assets={tree} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Site" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Room A" }));
    expect(screen.getByTestId("selected")).toHaveTextContent("1,2");
    await userEvent.click(screen.getByRole("checkbox", { name: "Site" }));
    expect(screen.getByTestId("selected")).toHaveTextContent("2");
  });

  it("stops at the cap: the rest are disabled until something is unchecked", async () => {
    render(<Harness assets={many(25)} initial={Array.from({ length: 20 }, (_, i) => i + 1)} />);
    expect(screen.getByText("20 selected (up to 20)")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Asset 21" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Asset 1" })).toBeEnabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Asset 1" }));
    expect(screen.getByText("19 selected (up to 20)")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Asset 21" })).toBeEnabled();
  });

  it("in single mode shows radios and replaces the choice", async () => {
    render(<Harness assets={tree} single />);
    expect(screen.getAllByRole("radio")).toHaveLength(6);
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Main" }));
    expect(screen.getByTestId("selected")).toHaveTextContent("6");
    await userEvent.click(screen.getByRole("radio", { name: "Site" }));
    expect(screen.getByTestId("selected")).toHaveTextContent("1");
    expect(screen.getByRole("radio", { name: "Main" })).not.toBeChecked();
  });

  it("says so when there are no assets", () => {
    render(<Harness assets={[]} />);
    expect(screen.getByText("No assets yet.")).toBeInTheDocument();
  });

  it("can say something more specific when nothing is offered", () => {
    render(<AssetPicker assets={[]} tree={tree} selected={[]} onChange={() => {}} single={false} max={20} empty="No asset has a reading of this metric." />);
    expect(screen.getByText("No asset has a reading of this metric.")).toBeInTheDocument();
    expect(screen.queryByText("No assets yet.")).not.toBeInTheDocument();
  });
});

// ---- w23: search, kind filter, chips, fold, "Pick all under", context rows, the cap ----

const node = (id: number, parent_id: number | null, name: string, kind = "x"): Asset => ({ id, parent_id, name, kind, sort_order: id });
const checkboxNames = () => screen.getAllByRole("checkbox").map((box) => box.parentElement?.textContent);
const searchBox = () => screen.getByRole("searchbox", { name: "Search assets" });
const kindSelect = () => screen.getByRole("combobox", { name: "Filter by kind" });
const liveLine = () => document.querySelector("[aria-live]") as HTMLElement;
const chipTexts = () => within(screen.getByRole("list", { name: "Picked assets" })).getAllByRole("listitem").map((li) => li.textContent);

/** A site, 3 halls of 8 rows of 2 racks: 76 assets, so the picker opens folded to level 2. Ids run in tree order. */
function bigTree(): Asset[] {
  const out: Asset[] = [node(1, null, "Site", "site")];
  let id = 1;
  for (let h = 1; h <= 3; h++) {
    const hall = ++id;
    out.push(node(hall, 1, `Hall ${h}`, "hall"));
    for (let r = 1; r <= 8; r++) {
      const row = ++id;
      out.push(node(row, hall, `Row ${h}.${r}`, "row"));
      for (let k = 1; k <= 2; k++) out.push(node(++id, row, `Rack ${h}.${r}.${k}`, "rack"));
    }
  }
  return out;
}
const BIG = bigTree();
const idOf = (name: string) => BIG.find((a) => a.name === name)!.id;
/** A site, a hall, and racks up to `n` assets in all. */
const chain = (n: number): Asset[] => [node(1, null, "Site", "site"), node(2, 1, "Hall", "hall"), ...Array.from({ length: n - 2 }, (_, i) => node(i + 3, 2, `Rack ${i + 1}`, "rack"))];
/** Two halls: three racks under the first, one under the second. */
const smallHall: Asset[] = [
  node(1, null, "Site", "site"), node(2, 1, "Hall 1", "hall"), node(3, 2, "Rack A", "rack"), node(4, 2, "Rack B", "rack"),
  node(5, 2, "Rack C", "rack"), node(6, 1, "Hall 2", "hall"), node(7, 6, "Rack D", "rack"),
];
const smallLeaves = smallHall.filter((a) => a.kind === "rack");

describe("AssetPicker search", () => {
  it("narrows the rows to a typed name or kind, whatever the case, keeps the ancestors and counts the matches", async () => {
    render(<Harness assets={tree} />);
    expect(liveLine()).toBeEmptyDOMElement();
    await userEvent.type(searchBox(), "PANEL");
    expect(checkboxNames()).toEqual(["Site", "Room A", "Panel (Site / Room A)", "Room B", "Panel (Site / Room B)"]);
    expect(liveLine()).toHaveTextContent(/^2 match$/);
    await userEvent.clear(searchBox());
    await userEvent.type(searchBox(), "meter"); // a kind
    expect(checkboxNames()).toEqual(["Main"]);
    expect(liveLine()).toHaveTextContent(/^1 match$/);
    await userEvent.clear(searchBox());
    await userEvent.type(searchBox(), "room a"); // a parent: what is inside it is a match too
    expect(checkboxNames()).toEqual(["Site", "Room A", "Panel (Site / Room A)"]);
    expect(liveLine()).toHaveTextContent(/^2 match$/);
    await userEvent.clear(searchBox());
    expect(screen.getAllByRole("checkbox")).toHaveLength(6);
    expect(liveLine()).toBeEmptyDOMElement();
  });

  it("says so when nothing matches", async () => {
    render(<Harness assets={tree} />);
    await userEvent.type(searchBox(), "zzz");
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(liveLine()).toHaveTextContent(/^No match$/);
    expect(screen.getByText("No asset matches.")).toBeInTheDocument();
  });

  it("clears a typed search on the first Escape without letting the dialog see it, and lets the second one through", async () => {
    render(<Harness assets={tree} />);
    await userEvent.type(searchBox(), "pan");
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    try {
      await userEvent.keyboard("{Escape}");
      expect(searchBox()).toHaveValue("");
      expect(seen).not.toHaveBeenCalled();
      expect(screen.getAllByRole("checkbox")).toHaveLength(6);
      await userEvent.keyboard("{Escape}");
      expect(seen).toHaveBeenCalledTimes(1);
      expect(seen.mock.calls[0][0].key).toBe("Escape");
    } finally {
      document.removeEventListener("keydown", seen);
    }
  });
});

describe("AssetPicker kind filter", () => {
  const kindTree = [
    node(1, null, "Hall", "Hall"), node(2, 1, "R1", " rack "), node(3, 1, "R2", "Rack"), node(4, 1, "R3", "Rack"), node(5, 1, "F1", "Feed"), node(6, null, "Hidden", "Zone"),
  ];
  const offered = kindTree.filter((a) => a.id !== 6);
  const optionTexts = () => within(kindSelect()).getAllByRole("option").map((o) => o.textContent);

  it("lists the kinds of the offered assets, grouped whatever the spelling, sorted, with their counts", () => {
    render(<Harness assets={offered} tree={kindTree} />);
    expect(optionTexts()).toEqual(["All kinds", "Feed (1)", "Hall (1)", "Rack (3)"]);
    expect(kindSelect()).toHaveValue("");
  });

  it("narrows to a kind, combines with the search, and counts the results", async () => {
    render(<Harness assets={offered} tree={kindTree} />);
    await userEvent.selectOptions(kindSelect(), "rack");
    expect(checkboxNames()).toEqual(["Hall", "R1", "R2", "R3"]); // the hall stays as the way to the racks
    expect(liveLine()).toHaveTextContent(/^3 match$/);
    await userEvent.type(searchBox(), "r2");
    expect(checkboxNames()).toEqual(["Hall", "R2"]);
    expect(liveLine()).toHaveTextContent(/^1 match$/);
    await userEvent.clear(searchBox());
    await userEvent.selectOptions(kindSelect(), "");
    expect(screen.getAllByRole("checkbox")).toHaveLength(5);
  });

  it("falls back to all kinds when the chosen kind is no longer offered", async () => {
    const { rerender } = render(<Harness assets={offered} tree={kindTree} />);
    await userEvent.selectOptions(kindSelect(), "rack");
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
    rerender(<Harness assets={offered.filter((a) => a.kind !== "Rack" && a.kind !== " rack ")} tree={kindTree} />);
    expect(optionTexts()).toEqual(["All kinds", "Feed (1)", "Hall (1)"]);
    expect(kindSelect()).toHaveValue("");
    expect(checkboxNames()).toEqual(["Hall", "F1"]);
    expect(liveLine()).toBeEmptyDOMElement();
  });
});

describe("AssetPicker chips", () => {
  const remove = (name: string) => screen.getByRole("button", { name: `Remove ${name}` });

  it("shows the picks in the order they were made, one remove button each, and removes on a click", async () => {
    render(<Harness assets={tree} />);
    expect(screen.getByText("Nothing picked yet.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Room B" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Site" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Main" }));
    expect(chipTexts()).toEqual(["Room B", "Site", "Main"]);
    await userEvent.click(remove("Site"));
    expect(chipTexts()).toEqual(["Room B", "Main"]);
    expect(screen.getByTestId("selected")).toHaveTextContent("4,6");
    expect(screen.getByRole("checkbox", { name: "Site" })).not.toBeChecked();
  });

  it("moves the focus to the next chip's button after a removal from the keyboard, else the previous one, else the search box", async () => {
    render(<Harness assets={tree} initial={[1, 2, 6]} />);
    await userEvent.click(searchBox());
    await userEvent.tab(); // the kind filter
    await userEvent.tab();
    expect(remove("Site")).toHaveFocus();
    await userEvent.tab();
    expect(remove("Room A")).toHaveFocus();
    await userEvent.keyboard("{Enter}"); // the middle one: the next takes the focus
    expect(chipTexts()).toEqual(["Site", "Main"]);
    expect(remove("Main")).toHaveFocus();
    await userEvent.keyboard("{Enter}"); // the last one: the previous takes it
    expect(chipTexts()).toEqual(["Site"]);
    expect(remove("Site")).toHaveFocus();
    await userEvent.keyboard("{Enter}"); // the only one: the search box
    expect(screen.getByText("Nothing picked yet.")).toBeInTheDocument();
    expect(searchBox()).toHaveFocus();
  });

  it("shows a note in the chip, and an id that is not in the tree as Asset #id", () => {
    render(<Harness assets={tree} initial={[6, 99]} notes={new Map([[6, "no voltage_v"]])} />);
    expect(chipTexts()).toEqual(["Main (no voltage_v)", "Asset #99"]);
    expect(remove("Main")).toBeInTheDocument();
    expect(remove("Asset #99")).toBeInTheDocument();
  });

  it("draws the name and the end of a long path in the chip, and keeps the whole label in its title and in the remove button's name", () => {
    const E = String.fromCharCode(0x2026);
    const deep = [
      node(1, null, "Seeded pilot hall", "site"), node(2, 1, "Hall 1", "hall"), node(3, 2, "Pod A", "pod"), node(4, 3, "Row 1", "row"),
      node(5, 4, "Rack 05", "rack"), node(6, 4, "Rack 06", "rack"), node(7, 5, "Feed A", "feed"), node(8, 6, "Feed A", "feed"),
    ];
    const whole = "Feed A (Seeded pilot hall / Hall 1 / Pod A / Row 1 / Rack 05)";
    render(<Harness assets={deep.filter((a) => a.kind === "feed")} tree={deep} initial={[7]} notes={new Map([[7, "no voltage_v"]])} />);
    expect(chipTexts()).toEqual([`Feed A (${E} / Row 1 / Rack 05) (no voltage_v)`]);
    expect(remove(whole).closest("li")).toHaveAttribute("title", `${whole} (no voltage_v)`);
  });

  it("names a chip by the button label, which tells an asset apart from a context row of the same name elsewhere", () => {
    // Only Panel (id 5) and Meter 1 are offered; the other Panel (id 3) is a context row, so the checkbox reads "Panel" but the chip must not.
    const clash = [
      node(1, null, "Site", "site"), node(2, 1, "Room A", "room"), node(3, 2, "Panel", "panel"), node(4, 1, "Room B", "room"),
      node(5, 4, "Panel", "panel"), node(6, 3, "Meter 1", "meter"),
    ];
    render(<Harness assets={clash.filter((a) => a.id === 5 || a.id === 6)} tree={clash} initial={[5]} />);
    expect(screen.getByRole("checkbox", { name: "Panel" })).toBeChecked();
    expect(chipTexts()).toEqual(["Panel (Site / Room B)"]);
    expect(remove("Panel (Site / Room B)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Panel" })).not.toBeInTheDocument();
  });

  it("in single mode has one chip and no remove button, and a new pick replaces it", async () => {
    render(<Harness assets={tree} single initial={[6]} />);
    expect(chipTexts()).toEqual(["Main"]);
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Site" }));
    expect(chipTexts()).toEqual(["Site"]);
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it("in single mode lets the person drop the extra ids that came from outside", async () => {
    render(<Harness assets={tree} single initial={[1, 6]} />);
    expect(chipTexts()).toEqual(["Site", "Main"]);
    await userEvent.click(remove("Main"));
    expect(chipTexts()).toEqual(["Site"]);
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  });

  it("says so in single mode when nothing is picked", () => {
    render(<Harness assets={tree} single />);
    expect(screen.getByText("No asset picked yet.")).toBeInTheDocument();
  });
});

describe("AssetPicker fold", () => {
  const folded = (name: string) => screen.getByRole("button", { name: `Children of ${name}` });

  it("opens folded to level 2 when more than 60 rows are shown, and a click opens and closes a branch", async () => {
    render(<Harness assets={BIG} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(4); // the site and its 3 halls
    expect(folded("Hall 1")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("checkbox", { name: "Row 1.1" })).not.toBeInTheDocument();
    await userEvent.click(folded("Hall 1"));
    expect(folded("Hall 1")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("checkbox", { name: "Row 1.1" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Rack 1.1.1" })).not.toBeInTheDocument(); // the rows are folded too
    await userEvent.click(folded("Hall 1"));
    expect(screen.queryByRole("checkbox", { name: "Row 1.1" })).not.toBeInTheDocument();
  });

  it("opens fully at 60 rows and folds at 61", () => {
    const { unmount } = render(<Harness assets={chain(60)} />);
    expect(folded("Hall")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("checkbox", { name: "Rack 58" })).toBeInTheDocument();
    unmount();
    render(<Harness assets={chain(61)} />);
    expect(folded("Hall")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("checkbox", { name: "Rack 59" })).not.toBeInTheDocument();
  });

  it("keeps open the branch of a pick that was there at the start", () => {
    render(<Harness assets={BIG} initial={[idOf("Rack 2.3.1")]} />);
    expect(screen.getByRole("checkbox", { name: "Rack 2.3.1" })).toBeChecked();
    expect(folded("Hall 2")).toHaveAttribute("aria-expanded", "true");
    expect(folded("Row 2.3")).toHaveAttribute("aria-expanded", "true");
    expect(folded("Hall 1")).toHaveAttribute("aria-expanded", "false");
    expect(folded("Row 2.4")).toHaveAttribute("aria-expanded", "false");
  });

  it("leaves the branch open when a pick was made in a filtered list and the search is cleared", async () => {
    render(<Harness assets={BIG} />);
    await userEvent.type(searchBox(), "rack 3.2.1");
    await userEvent.click(screen.getByRole("checkbox", { name: "Rack 3.2.1" }));
    await userEvent.clear(searchBox());
    expect(screen.getByRole("checkbox", { name: "Rack 3.2.1" })).toBeChecked();
    expect(folded("Hall 3")).toHaveAttribute("aria-expanded", "true");
    expect(folded("Hall 1")).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(screen.getByRole("checkbox", { name: "Rack 3.2.1" })); // an unpick folds nothing
    expect(screen.getByRole("checkbox", { name: "Rack 3.2.1" })).not.toBeChecked();
    expect(folded("Hall 3")).toHaveAttribute("aria-expanded", "true");
  });

  it("never folds a branch or moves the focus off the row when a pick is undone", async () => {
    render(<Harness assets={BIG} initial={[idOf("Rack 1.4.2")]} />);
    const box = screen.getByRole("checkbox", { name: "Rack 1.4.2" });
    await userEvent.click(box);
    expect(box).not.toBeChecked();
    expect(box).toHaveFocus();
    expect(folded("Hall 1")).toHaveAttribute("aria-expanded", "true");
    expect(folded("Row 1.4")).toHaveAttribute("aria-expanded", "true");
  });

  it("while filtering, disables a fold button only on a row on the way to a match", async () => {
    render(<Harness assets={BIG} />);
    await userEvent.type(searchBox(), "hall 1");
    expect(folded("Site")).toBeDisabled(); // it leads to the match
    expect(folded("Hall 1")).toBeEnabled(); // it is the match: its rows can be folded away
    expect(screen.getByRole("checkbox", { name: "Row 1.1" })).toBeInTheDocument();
    await userEvent.click(folded("Hall 1"));
    expect(screen.queryByRole("checkbox", { name: "Row 1.1" })).not.toBeInTheDocument();
    expect(liveLine()).toHaveTextContent(/^25 match$/);
  });
});

describe("AssetPicker pick all under", () => {
  const pickAll = (name: string) => screen.getByRole("button", { name: `Pick all under ${name}` });

  it("picks the results below a row in tree order within the maximum, and opens the way to them", async () => {
    render(<Harness assets={BIG} max={30} />);
    await userEvent.click(pickAll("Hall 1"));
    const expected = BIG.filter((a) => /^(Row|Rack) 1\./.test(a.name)).map((a) => a.id);
    expect(expected).toHaveLength(24);
    expect(screen.getByTestId("selected")).toHaveTextContent(expected.join(","));
    expect(screen.getByText("24 selected (up to 30)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Children of Hall 1" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("checkbox", { name: "Rack 1.1.1" })).toBeChecked();
    expect(pickAll("Hall 1")).toHaveAttribute("aria-disabled", "true");
    expect(pickAll("Hall 1")).toHaveAttribute("title", "Everything under it is picked");
  });

  it("picks nothing over the maximum and says how many there were and how much room is left", async () => {
    render(<Harness assets={BIG} />);
    await userEvent.click(pickAll("Hall 1"));
    expect(screen.getByTestId("selected")).toHaveTextContent(/^$/);
    expect(liveLine()).toHaveTextContent(/^24 assets under Hall 1, room for 20: nothing was picked$/);
    expect(pickAll("Hall 1")).not.toHaveAttribute("aria-disabled");
    await userEvent.type(searchBox(), "r"); // the next keystroke replaces the refusal
    expect(liveLine()).not.toHaveTextContent(/nothing was picked/);
  });

  it("still answers at the maximum, in the singular, and keeps the other rows disabled", async () => {
    render(<Harness assets={smallHall} initial={[3]} max={1} />);
    await userEvent.click(pickAll("Hall 2"));
    expect(liveLine()).toHaveTextContent(/^1 asset under Hall 2, room for 0: nothing was picked$/);
    expect(screen.getByTestId("selected")).toHaveTextContent(/^3$/);
    expect(screen.getByRole("checkbox", { name: "Rack D" })).toBeDisabled();
  });

  it("picks what the search and the kind let through, and nothing else", async () => {
    render(<Harness assets={smallHall} />);
    await userEvent.type(searchBox(), "rack b");
    await userEvent.click(pickAll("Hall 1"));
    expect(screen.getByTestId("selected")).toHaveTextContent(/^4$/);
    await userEvent.clear(searchBox());
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    const mixed = [node(1, null, "Hall", "hall"), node(2, 1, "R1", "rack"), node(3, 1, "R2", "rack"), node(4, 1, "F1", "feed")];
    cleanup();
    render(<Harness assets={mixed} />);
    await userEvent.selectOptions(kindSelect(), "rack");
    await userEvent.click(pickAll("Hall"));
    expect(screen.getByTestId("selected")).toHaveTextContent(/^2,3$/);
  });

  it("is disabled in the aria sense, and does nothing, when everything below is picked", async () => {
    render(<Harness assets={smallHall} initial={[3, 4, 5]} />);
    expect(pickAll("Hall 1")).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(pickAll("Hall 1"));
    expect(screen.getByTestId("selected")).toHaveTextContent(/^3,4,5$/);
    expect(liveLine()).toBeEmptyDOMElement();
    expect(pickAll("Site")).not.toHaveAttribute("aria-disabled"); // Hall 2's rack is not picked
  });

  it("is not drawn for a leaf, nor in single mode", () => {
    const { unmount } = render(<Harness assets={smallHall} />);
    expect(screen.queryByRole("button", { name: "Pick all under Rack A" })).not.toBeInTheDocument();
    expect(pickAll("Hall 1")).toBeInTheDocument();
    unmount();
    render(<Harness assets={smallHall} single />);
    expect(screen.queryAllByRole("button", { name: /Pick all under/ })).toHaveLength(0);
  });

  it("Clear all empties the picks, is aria-disabled with none, and keeps the focus", async () => {
    render(<Harness assets={smallHall} initial={[3, 4]} />);
    const clear = screen.getByRole("button", { name: "Clear all" });
    expect(clear).not.toHaveAttribute("aria-disabled");
    await userEvent.click(clear);
    expect(screen.getByTestId("selected")).toHaveTextContent(/^$/);
    expect(screen.getByText("0 selected (up to 20)")).toBeInTheDocument();
    expect(clear).toHaveAttribute("aria-disabled", "true");
    expect(clear).not.toBeDisabled();
    expect(clear).toHaveFocus();
    await userEvent.click(clear);
    expect(screen.getByTestId("selected")).toHaveTextContent(/^$/);
  });

  it("does not show Clear all or a count in single mode", () => {
    render(<Harness assets={smallHall} single />);
    expect(screen.queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
  });
});

describe("AssetPicker context rows", () => {
  // A metric widget offers only the leaves; the tree gives the rest, which show as rows without an input.
  const open = () => render(<Harness assets={smallLeaves} tree={smallHall} />);

  it("draws the ancestors as rows without an input but with a fold button and Pick all under", () => {
    open();
    expect(checkboxNames()).toEqual(["Rack A", "Rack B", "Rack C", "Rack D"]);
    const hallRow = screen.getByText("Hall 1").closest("li")!;
    expect(hallRow).toHaveAttribute("data-context", "true");
    expect(hallRow.querySelector("input, label")).toBeNull();
    expect(within(hallRow).getByRole("button", { name: "Children of Hall 1" })).toHaveAttribute("aria-expanded", "true");
    expect(within(hallRow).getByRole("button", { name: "Pick all under Hall 1" })).toBeInTheDocument();
    expect(screen.getByText("Rack A").closest("li")).not.toHaveAttribute("data-context");
  });

  it("picks only offered assets, and the counts of inputs do not change with the context rows", async () => {
    open();
    await userEvent.click(screen.getByRole("button", { name: "Pick all under Site" }));
    expect(screen.getByTestId("selected")).toHaveTextContent(/^3,4,5,7$/);
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
  });

  it("filters through them: a search for a context row's name lists the offered assets inside it", async () => {
    open();
    await userEvent.type(searchBox(), "hall 2");
    expect(checkboxNames()).toEqual(["Rack D"]);
    expect(liveLine()).toHaveTextContent(/^1 match$/);
  });
});

describe("AssetPicker contract", () => {
  it("names a checkbox by its whole label, draws the name alone and keeps the path for a screen reader", () => {
    render(<Harness assets={tree} />);
    const box = screen.getByRole("checkbox", { name: "Panel (Site / Room A)" });
    const label = box.parentElement!;
    expect(label.tagName).toBe("LABEL");
    expect(label.textContent).toBe("Panel (Site / Room A)");
    const own = [...label.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join("");
    expect(own).toBe("Panel");
    expect(label.querySelector("button")).toBeNull();
    expect(screen.getAllByText("Panel")).toHaveLength(2);
  });

  it("draws a trailing #id and a note, and names the input by all of it", () => {
    const twins = [node(1, null, "Rack"), node(7, 1, "Meter"), node(8, 1, "Meter")];
    render(<Harness assets={twins} notes={new Map([[8, "no voltage_v"]])} />);
    expect(screen.getByRole("checkbox", { name: "Meter (Rack) #7" }).parentElement!.textContent).toBe("Meter (Rack) #7");
    const noted = screen.getByRole("checkbox", { name: "Meter (Rack) #8 (no voltage_v)" }).parentElement!;
    const own = [...noted.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join("");
    expect(own).toBe("Meter #8 (no voltage_v)");
  });

  it("has one live line without a role, every button is type=button, and the legend can be set", () => {
    const { container } = render(<AssetPicker assets={smallHall} selected={[3]} onChange={() => {}} single={false} max={20} label="Racks to add" />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(liveLine()).not.toHaveAttribute("role");
    for (const button of container.querySelectorAll("button")) expect(button).toHaveAttribute("type", "button");
    expect(screen.getByRole("group", { name: "Racks to add" })).toBeInTheDocument();
  });

  it("uses Asset and Assets as the default legends", () => {
    const { unmount } = render(<Harness assets={tree} />);
    expect(screen.getByRole("group", { name: "Assets" })).toBeInTheDocument();
    unmount();
    render(<Harness assets={tree} single />);
    expect(screen.getByRole("group", { name: "Asset" })).toBeInTheDocument();
  });

  it("disables only the unpicked checkboxes at the maximum", () => {
    const { container, unmount } = render(<Harness assets={many(25)} initial={Array.from({ length: 20 }, (_, i) => i + 1)} />);
    expect(container.querySelectorAll("input:disabled")).toHaveLength(5);
    expect(screen.getByRole("checkbox", { name: "Asset 1" })).toBeEnabled();
    unmount();
    const fewer = render(<Harness assets={many(25)} initial={[1, 2, 3]} />);
    expect(fewer.container.querySelectorAll("input:disabled")).toHaveLength(0);
  });

  it("does not rebuild its rows for an equal list of assets (the editor passes a new array on every pick)", async () => {
    const { rerender } = render(<Harness assets={tree} />);
    const before = screen.getByRole("checkbox", { name: "Site" });
    rerender(<Harness assets={tree.map((a) => ({ ...a }))} />);
    expect(screen.getByRole("checkbox", { name: "Site" })).toBe(before);
  });
});

describe("AssetPicker row cap", () => {
  it("draws 200 rows with the count and a button for more, which moves the focus to the first new row", async () => {
    render(<Harness assets={many(250)} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(200);
    expect(screen.getByText("Showing 200 of 250")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show 50 more" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(250);
    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Asset 201" })).toHaveFocus();
  });

  it("goes back to 200 rows when the search changes", async () => {
    render(<Harness assets={many(450)} />);
    await userEvent.click(screen.getByRole("button", { name: "Show 200 more" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(400);
    expect(screen.getByText("Showing 400 of 450")).toBeInTheDocument();
    await userEvent.type(searchBox(), "a");
    expect(screen.getAllByRole("checkbox")).toHaveLength(200);
    expect(screen.getByText("Showing 200 of 450")).toBeInTheDocument();
  });
});

describe("AssetPicker focus", () => {
  it("puts the focus on the search box when the row that had it is no longer offered", async () => {
    const noted = new Map([[6, "no voltage_v"]]);
    const { rerender } = render(<Harness assets={tree} initial={[6]} notes={noted} />);
    const box = screen.getByRole("checkbox", { name: "Main (no voltage_v)" });
    await userEvent.click(box); // unpicked: in the editor a "no <metric>" row then drops out of the offer
    expect(box).toHaveFocus();
    rerender(<Harness assets={tree.filter((a) => a.id !== 6)} initial={[6]} notes={noted} />);
    expect(box).not.toBeInTheDocument();
    expect(searchBox()).toHaveFocus();
  });

  /** A site, a hall, `n` racks each with a Feed A and a Feed B. A search for "feed a" shows 2 + 2n rows, and the site, the hall and every rack are locked branches. */
  function feedHall(n: number): Asset[] {
    const out = [node(1, null, "Site", "site"), node(2, 1, "Hall", "hall")];
    for (let k = 1; k <= n; k++) out.push(node(3 * k, 2, `Rack ${k}`, "rack"), node(3 * k + 1, 3 * k, "Feed A", "feed"), node(3 * k + 2, 3 * k, "Feed B", "feed"));
    return out;
  }

  it("keeps the focus in the picker after Show more when the first new row is a locked branch, also when the button goes away", async () => {
    render(<Harness assets={feedHall(250)} />);
    await userEvent.type(searchBox(), "feed a");
    expect(screen.getByText("Showing 200 of 502")).toBeInTheDocument();
    const picker = screen.getByRole("group", { name: "Assets" });
    expect(screen.getByRole("button", { name: "Children of Rack 99" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Show 200 more" }));
    expect(screen.getByText("Showing 400 of 502")).toBeInTheDocument();
    expect(picker).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByRole("checkbox", { name: "Rack 100" })).toHaveFocus(); // the first new row: its fold button is disabled, its checkbox is not
    await userEvent.click(screen.getByRole("button", { name: "Show 102 more" })); // the last chunk: the button unmounts
    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("checkbox", { name: "Rack 200" })).toHaveFocus();
  });

  it("puts the focus on a button of the first new row when that row has no enabled input (a context row with a locked fold)", async () => {
    const hall = feedHall(250);
    render(<Harness assets={hall.filter((a) => a.kind === "feed")} tree={hall} />);
    await userEvent.type(searchBox(), "feed a");
    await userEvent.click(screen.getByRole("button", { name: "Show 200 more" }));
    expect(screen.getByRole("button", { name: "Children of Rack 100" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pick all under Rack 100" })).toHaveFocus();
  });

  it("puts the focus on the search box when no new row has an enabled control", async () => {
    render(<Harness assets={many(250)} initial={[1]} max={1} />);
    await userEvent.click(screen.getByRole("button", { name: "Show 50 more" }));
    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
    expect(searchBox()).toHaveFocus();
  });
});
