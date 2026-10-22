import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { EventFilters, EventOptions } from "../api/types";
import { NO_FILTERS } from "../lib/eventFilters";
import { EventFilterBar } from "./EventFilterBar";

const OPTIONS: EventOptions = {
  kinds: ["source.offline", "source.online", "check.finished", "brand.new"],
  sources: [{ id: 4, name: "Plant OPC" }, { id: 9, name: "deleted source #9" }],
};

type Extra = { exporting?: boolean; error?: string | null; options?: EventOptions | undefined };

function setup(initial: EventFilters = NO_FILTERS, extra: Extra = {}) {
  const onChange = vi.fn();
  const onExport = vi.fn();
  function Harness() {
    const [filters, setFilters] = useState(initial);
    return (
      <EventFilterBar
        filters={filters}
        onChange={(next) => { onChange(next); setFilters(next); }}
        options={"options" in extra ? extra.options : OPTIONS}
        onExport={onExport}
        exporting={extra.exporting ?? false}
        error={extra.error ?? null}
      />
    );
  }
  render(<Harness />);
  return { onChange, onExport, bar: screen.getByRole("search", { name: "Filter the system events" }) };
}
const last = (spy: ReturnType<typeof vi.fn>) => spy.mock.lastCall![0] as EventFilters;

describe("EventFilterBar (w32)", () => {
  it("is the one search landmark and keeps every labelled control in the order it is laid out", () => {
    const { bar } = setup();
    for (const name of ["Source", "Kind", "From", "To"]) expect(within(bar).getByLabelText(name)).toBeInTheDocument();
    expect(within(bar).getByRole("group", { name: "Level" })).toBeInTheDocument();
    const order = Array.from(bar.querySelectorAll<HTMLElement>("input, select, button")).map((el) => (el.id ? bar.querySelector(`label[for="${el.id}"]`)?.textContent : null) ?? el.textContent);
    expect(order).toEqual(["Source", "Kind", "Info", "Warning", "Error", "From", "To", "Open only", "Export CSV"]);
  });

  it("offers the sources and the kinds that occur, the kinds by their friendly names (a kind it does not know by its own)", () => {
    const { bar } = setup();
    expect(within(within(bar).getByLabelText("Source")).getAllByRole("option").map((o) => o.textContent)).toEqual(["All sources", "Plant OPC", "deleted source #9"]);
    expect(within(within(bar).getByLabelText("Kind")).getAllByRole("option").map((o) => o.textContent)).toEqual(
      ["All kinds", "Source went offline", "Source back online", "Connection check", "brand.new"],
    );
  });

  it("picks a source and a kind", async () => {
    const { onChange, bar } = setup();
    await userEvent.selectOptions(within(bar).getByLabelText("Source"), "4");
    expect(last(onChange)).toEqual({ ...NO_FILTERS, source: "4" });
    await userEvent.selectOptions(within(bar).getByLabelText("Kind"), "check.finished");
    expect(last(onChange)).toEqual({ ...NO_FILTERS, source: "4", kinds: ["check.finished"] });
    await userEvent.selectOptions(within(bar).getByLabelText("Kind"), "");
    expect(last(onChange).kinds).toEqual([]);
  });

  it("keeps a source or a kind from the address even when the options do not list it", () => {
    const { bar } = setup({ ...NO_FILTERS, source: "77", kinds: ["a.b"] });
    expect(within(bar).getByLabelText("Source")).toHaveValue("77");
    expect(within(within(bar).getByLabelText("Source")).getByRole("option", { name: "Source #77" })).toBeInTheDocument();
    expect(within(bar).getByLabelText("Kind")).toHaveValue("a.b");
  });

  it("shows several kinds from a link as one disabled option, so the select never says All kinds while a filter is on", () => {
    const { bar } = setup({ ...NO_FILTERS, kinds: ["source.offline", "source.online"] });
    const option = within(bar).getByRole("option", { name: "2 kinds (filter)" });
    expect(option).toBeDisabled();
    expect(within(bar).getByLabelText("Kind")).toHaveValue("*group");
  });

  it("toggles the levels, each pressed on its own and kept in the order info, warning, error", async () => {
    const { onChange, bar } = setup();
    const group = within(bar).getByRole("group", { name: "Level" });
    for (const name of ["Info", "Warning", "Error"]) expect(within(group).getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(within(group).getByRole("button", { name: "Error" }));
    await userEvent.click(within(group).getByRole("button", { name: "Info" }));
    expect(last(onChange).levels).toEqual(["info", "error"]);
    expect(within(group).getByRole("button", { name: "Error" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(group).getByRole("button", { name: "Error" }));
    expect(last(onChange).levels).toEqual(["info"]);
  });

  it("toggles Open only", async () => {
    const { onChange, bar } = setup();
    const open = within(bar).getByRole("button", { name: "Open only" });
    expect(open).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(open);
    expect(last(onChange).open).toBe(true);
    expect(open).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(open);
    expect(last(onChange).open).toBe(false);
  });

  it("sets the dates, each kept inside the other and inside the years the API holds", async () => {
    const { onChange, bar } = setup({ ...NO_FILTERS, from: "2026-10-01", to: "2026-10-20" });
    const from = within(bar).getByLabelText("From");
    const to = within(bar).getByLabelText("To");
    expect(from).toHaveAttribute("min", "1970-01-01");
    expect(from).toHaveAttribute("max", "2026-10-20");
    expect(to).toHaveAttribute("min", "2026-10-01");
    expect(to).toHaveAttribute("max", "2100-12-31");
    await userEvent.clear(from);
    expect(last(onChange).from).toBe("");
  });

  it("draws Clear filters only while a filter is set, and it clears every one", async () => {
    const { onChange, bar } = setup({ ...NO_FILTERS, source: "4", levels: ["error"], open: true });
    await userEvent.click(within(bar).getByRole("button", { name: "Clear filters" }));
    expect(last(onChange)).toEqual(NO_FILTERS);
    expect(within(bar).queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("exports the CSV, and waits while one is being written", async () => {
    const { onExport, bar } = setup();
    await userEvent.click(within(bar).getByRole("button", { name: "Export CSV" }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("disables the export while it runs", () => {
    const { bar } = setup(NO_FILTERS, { exporting: true });
    expect(within(bar).getByRole("button", { name: "Export CSV" })).toBeDisabled();
  });

  it("shows a problem as the one alert of the bar, and still lists the sources while the options are loading", () => {
    const { bar } = setup(NO_FILTERS, { error: "7 events match; the export holds at most 20,000. Narrow the date range and try again.", options: undefined });
    expect(within(bar).getByRole("alert")).toHaveTextContent("Narrow the date range");
    expect(within(within(bar).getByLabelText("Source")).getAllByRole("option")).toHaveLength(1);
  });
});
