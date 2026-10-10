import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Asset } from "../api/types";
import { MappingForm, type MappingBody } from "./MappingForm";

const assets: Asset[] = [{ id: 4, parent_id: null, name: "Panel 1", kind: "Panel", sort_order: 0 }];

function open(unitHint?: string | null) {
  const onSubmit = vi.fn(async (_body: MappingBody) => undefined);
  render(<MappingForm assets={assets} unitHint={unitHint} onSubmit={onSubmit} onCancel={() => undefined} />);
  return { onSubmit };
}

describe("MappingForm unit warning", () => {
  it("warns while the metric does not fit the unit hint, follows the select, and still saves", async () => {
    const { onSubmit } = open("V");
    // the form opens on active_power_kw, and a V point does not fit it
    expect(screen.getByRole("status")).toHaveTextContent(`unit hint is "V", which is a voltage_v unit, not active_power_kw`);
    await userEvent.selectOptions(screen.getByLabelText("Metric"), "energy_kwh");
    expect(screen.getByRole("status")).toHaveTextContent("not energy_kwh");
    await userEvent.selectOptions(screen.getByLabelText("Metric"), "voltage_v");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Metric"), "energy_kwh");
    expect(screen.getByRole("status")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ asset_id: 4, metric: "energy_kwh" });
  });

  it("does not warn when the point has no hint", () => {
    open(null);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not warn for a hint of the metric the form opens on", () => {
    open("kW");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not warn when the hint is unknown", () => {
    open("degC");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("puts the warning outside every label, so the Asset and Metric labels keep their names", () => {
    open("V");
    expect(screen.getByLabelText("Asset")).toBeInTheDocument();
    expect(screen.getByLabelText("Metric")).toBeInTheDocument();
    expect(screen.getByRole("status").closest("label")).toBeNull();
  });
});
