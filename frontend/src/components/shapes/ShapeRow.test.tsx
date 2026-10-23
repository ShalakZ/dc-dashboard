import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_CHOICE } from "../../lib/shapes";
import { shape } from "../../test/shapesFixtures";
import { ShapeRow } from "./ShapeRow";

function setup(over: Partial<React.ComponentProps<typeof ShapeRow>> = {}) {
  const props = {
    shape: shape(), choice: DEFAULT_CHOICE, canDecide: true, similarText: "Same decision for PDUB#_PM0_PENRG", ticked: false, highlighted: false,
    onChoice: vi.fn(), onTick: vi.fn(), ...over,
  };
  const view = render(<ShapeRow {...props} />);
  const row = screen.getByRole("group", { name: "Shape PDUA#_PM0_PENRG" });
  return { ...props, ...view, row };
}

describe("ShapeRow", () => {
  it("says what the shape is: label, tag count, three examples, the unit and the suggestion in words, as a guess", () => {
    const { row } = setup();
    expect(within(row).getByText("PDUA#_PM0_PENRG")).toBeInTheDocument();
    expect(row).toHaveTextContent("200 tags");
    expect(row).toHaveTextContent("For example PDUA01_PM0_PENRG, PDUA02_PM0_PENRG, PDUA03_PM0_PENRG");
    expect(within(row).getByText("PDUA01_PM0_PENRG")).toHaveAttribute("title", "ns=3;s=20403:Site.PDUA01_PM0_PENRG");
    expect(row).toHaveTextContent("Unit kWh. Suggested: kWh counter, a guess from the unit kWh.");
  });

  it("never writes the label in a monospace face (a normal text)", () => {
    const { row } = setup();
    expect(row.querySelector("code, kbd, samp, pre, tt")).toBeNull();
  });

  it("starts at Ignore and offers Map as the suggestion first, then the other metrics", () => {
    setup();
    const decision = screen.getByRole("combobox", { name: "Decision for PDUA#_PM0_PENRG" });
    expect(decision).toHaveValue("");
    const options = within(decision).getAllByRole("option").map((o) => o.textContent);
    expect(options.slice(0, 3)).toEqual(["Ignore", "Map as energy counter", "Map as active power"]);
    expect(options).toHaveLength(10);
  });

  it("reports a choice of Map as and of Ignore", async () => {
    const { onChoice } = setup();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Decision for PDUA#_PM0_PENRG" }), "Map as energy counter");
    expect(onChoice).toHaveBeenLastCalledWith({ metric: "energy_kwh" });
  });

  it("reports Ignore as a null metric", async () => {
    const { onChoice } = setup({ choice: { metric: "energy_kwh", nameFrom: "part1" } });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Decision for PDUA#_PM0_PENRG" }), "Ignore");
    expect(onChoice).toHaveBeenLastCalledWith({ metric: null });
  });

  it("shows the asset the first example gets, and changes it with the name select", async () => {
    const { onChoice, rerender, ...rest } = setup();
    expect(screen.getByText("Asset: PDUA01")).toBeInTheDocument();
    const name = screen.getByRole("combobox", { name: "Asset name for PDUA#_PM0_PENRG" });
    expect(within(name).getAllByRole("option").map((o) => o.textContent)).toEqual(["part 1", "parts 1 and 2", "part 1 / part 2"]);
    await userEvent.selectOptions(name, "parts 1 and 2");
    expect(onChoice).toHaveBeenLastCalledWith({ nameFrom: "parts12" });
    rerender(<ShapeRow {...rest} shape={shape()} choice={{ metric: null, nameFrom: "part1_part2" }} onChoice={onChoice} />);
    expect(screen.getByText("Asset: PDUA01 / PM0")).toBeInTheDocument();
  });

  it("has the similar tick, off by default, and reports it", async () => {
    const { onTick } = setup();
    const tickBox = screen.getByRole("checkbox", { name: "Same decision for PDUB#_PM0_PENRG" });
    expect(tickBox).not.toBeChecked();
    await userEvent.click(tickBox);
    expect(onTick).toHaveBeenLastCalledWith(true);
  });

  it("has no tick for a shape without a similar one", () => {
    setup({ similarText: null });
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("keeps a slot for warnings under every row, empty when there is none (a warning moves nothing)", () => {
    const { row } = setup();
    const slot = row.querySelector(".shape-warn");
    expect(slot).not.toBeNull();
    expect(slot).toBeEmptyDOMElement();
  });

  it("puts the warnings of mixed units and of renumbered duplicates in that slot", () => {
    const { row } = setup({ shape: shape({ unit_hints: ["kWh", "Wh"], mixed_units: true, duplicates: 200 }) });
    const slot = row.querySelector(".shape-warn")!;
    expect(slot).toHaveTextContent("This shape has the units kWh and Wh");
    expect(slot).toHaveTextContent("200 tags of this shape appear twice (the SCADA renumbered them)");
  });

  it("warns, in that slot, when the chosen asset name needs two parts and the example has one", () => {
    const solo = shape({ examples: [{ name: "Solo", address: "a" }] });
    const { row } = setup({ shape: solo, choice: { metric: "energy_kwh", nameFrom: "parts12" } });
    expect(row.querySelector(".shape-warn")).toHaveTextContent('The example Solo has only one part, so "parts 1 and 2" does not fit');
    expect(screen.getByText("Asset: (no name from this example)")).toBeInTheDocument();
  });

  it("counts the tags that are mapped already", () => {
    const { row } = setup({ shape: shape({ mapped: 12 }) });
    expect(row).toHaveTextContent("200 tags, 12 already mapped");
  });

  it("is found by its data-shape value (a key with #), can take focus by script and shows when it is the one looked for", () => {
    const { row } = setup({ highlighted: true });
    expect(row.dataset.shape).toBe("pdua#_pm#_penrg");
    expect(row).toHaveAttribute("tabindex", "-1");
    expect(row).toHaveAttribute("data-focus", "true");
    row.focus();
    expect(row).toHaveFocus();
  });

  it("is plain text without the right to decide: no select, no tick, the decision and the asset as text", () => {
    const { row } = setup({ canDecide: false });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(row).toHaveTextContent("Decision: Ignore");
    expect(row).toHaveTextContent("Asset: PDUA01");
  });
});
