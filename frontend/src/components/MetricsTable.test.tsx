import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SummaryMetric } from "../api/types";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { userFor } from "../test/users";
import { metricName, MetricsTable } from "./MetricsTable";

const row = (mapping_id: number, metric: SummaryMetric["metric"], over: Partial<SummaryMetric> = {}): SummaryMetric => ({
  mapping_id, point_id: mapping_id + 100, metric, unit: "kW", value: 1.5, ts: null, quality: 0, ...over,
});
const power = row(1, "active_power_kw");
const volts = row(2, "voltage_v", { unit: "V" });

const show = (metrics: SummaryMetric[], actions?: Parameters<typeof MetricsTable>[0]["actions"]) => {
  mockFetch({
    "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: userFor("admin") },
    "GET /api/site": { body: { timezone: "UTC", currency: null } },
  });
  return renderWithProviders(<MetricsTable metrics={metrics} live={new Map()} actions={actions} />);
};

describe("metricName", () => {
  it("is the metric, and for custom the metric with its unit: an asset can have several custom rows", () => {
    expect(metricName(power, [power, volts])).toBe("active_power_kw");
    const mw = row(3, "custom", { unit: "MW" });
    const kvar = row(4, "custom", { unit: "kvar" });
    expect(metricName(mw, [power, mw, kvar])).toBe("custom (MW)");
    expect(metricName(kvar, [power, mw, kvar])).toBe("custom (kvar)");
  });

  it("adds the point's number only when two rows would still read the same", () => {
    const a = row(3, "custom", { unit: "MW" });
    const b = row(4, "custom", { unit: "MW" });
    expect(metricName(a, [a, b])).toBe("custom (MW) #103");
    expect(metricName(b, [a, b])).toBe("custom (MW) #104");
    expect(metricName(a, [a])).toBe("custom (MW)");
  });

  it("is plain custom for a custom row with no unit text", () => {
    expect(metricName(row(3, "custom", { unit: "" }), [])).toBe("custom");
  });
});

describe("MetricsTable", () => {
  it("without actions it is the read-only table: four columns, no menu, no extra header cell", async () => {
    const { container } = show([power, volts]);
    await screen.findByText("active_power_kw");
    expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["Metric", "Value", "Unit", "Updated"]);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    for (const tr of container.querySelectorAll("tbody tr")) expect(tr.querySelectorAll("td")).toHaveLength(4);
    expect(container.querySelector("th.row-actions")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument();
  });

  it("with actions it has a fifth column: an empty header cell like the other tables', and a menu button on every row", async () => {
    const { container } = show([power, volts], { onUnmap: vi.fn(), onMove: vi.fn() });
    await screen.findByText("active_power_kw");
    const heads = container.querySelectorAll("thead th");
    expect(heads).toHaveLength(5);
    expect(heads[4]).toHaveClass("row-actions");
    expect(heads[4]).toBeEmptyDOMElement();
    for (const tr of container.querySelectorAll("tbody tr")) {
      expect(tr.querySelectorAll("td")).toHaveLength(5);
      expect(tr.querySelector("td:last-child")).toHaveClass("row-actions");
    }
    expect(screen.getAllByRole("button", { name: /^Actions for / }).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Actions for active_power_kw", "Actions for voltage_v",
    ]);
  });

  it("the menu is Unmap… (danger) and Move to another asset…, and each calls back with that row", async () => {
    const onUnmap = vi.fn();
    const onMove = vi.fn();
    show([power, volts], { onUnmap, onMove });
    await userEvent.click(await screen.findByRole("button", { name: "Actions for voltage_v" }));
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Unmap…", "Move to another asset…"]);
    expect(screen.getByRole("menuitem", { name: "Unmap…" })).toHaveClass("danger-item");
    expect(screen.getByRole("menuitem", { name: "Move to another asset…" })).not.toHaveClass("danger-item");
    await userEvent.click(screen.getByRole("menuitem", { name: "Unmap…" }));
    expect(onUnmap).toHaveBeenCalledWith(volts);
    expect(onMove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Actions for active_power_kw" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Move to another asset…" }));
    expect(onMove).toHaveBeenCalledWith(power);
  });

  it("names the custom rows by their unit, and by the point when the unit is the same", async () => {
    const a = row(3, "custom", { unit: "MW" });
    const b = row(4, "custom", { unit: "MW" });
    const c = row(5, "custom", { unit: "kvar" });
    show([a, b, c], { onUnmap: vi.fn(), onMove: vi.fn() });
    await screen.findAllByText("custom");
    expect(screen.getAllByRole("button", { name: /^Actions for / }).map((el) => el.getAttribute("aria-label"))).toEqual([
      "Actions for custom (MW) #103", "Actions for custom (MW) #104", "Actions for custom (kvar)",
    ]);
    // the cell itself still says what the table always said
    const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent(/^custom$/);
  });

  it("with no metrics it says so, with or without actions", async () => {
    show([], { onUnmap: vi.fn(), onMove: vi.fn() });
    expect(await screen.findByText("No metrics are mapped to this asset.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
