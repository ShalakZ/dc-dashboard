import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { Asset } from "../../api/types";
import { AssetPicker, pickerRows } from "./AssetPicker";

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
    expect(screen.getByText("20 of 20 selected")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Asset 21" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Asset 1" })).toBeEnabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Asset 1" }));
    expect(screen.getByText("19 of 20 selected")).toBeInTheDocument();
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
