import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../api/client";
import type { BillingCosts, CostFigure } from "../api/types";
import { ESTIMATED_TIP, PARTIAL_TIP } from "../components/Figure";
import { downloadCsv } from "../lib/download";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { BillingPage } from "./BillingPage";

vi.mock("../lib/download", () => ({ downloadCsv: vi.fn() }));

const fig = (kwh: number, cost: number | null, over: Partial<CostFigure> = {}): CostFigure => ({
  kwh, cost, estimated: false, partial: false, no_data: false, ...over,
});
/**
 * The clock below is 2026-10-15, so days 10-01..10-03 are all past days: the API gives an asset that has a meter a
 * figure for each of them (a day with nothing recorded is a muted zero, never null). Only an asset without a meter
 * (Spare) has null entries. LV Panel 1's rate starts on 10-02, so it is the one with a rate in effect today (0.12) and a
 * pre-rate day 1; Annex has no tariff at all, so it has no rate and every cost is a dash.
 */
const costs: BillingCosts = {
  month: "2026-10", timezone: "Asia/Qatar", currency: "QAR",
  days: ["2026-10-01", "2026-10-02", "2026-10-03"],
  assets: [
    { asset_id: 1, parent_id: null, name: "Site", path: "Site", rate_per_kwh: 0.12,
      days: [fig(30, 3.6), fig(20, 2.4), fig(0, 0, { no_data: true })], total: fig(50, 6) },
    { asset_id: 2, parent_id: 1, name: "MV2", path: "Site / MV2", rate_per_kwh: 0.12,
      days: [fig(18, 2.16, { estimated: true }), fig(12, 1.44, { estimated: true }), fig(0, 0, { no_data: true })],
      total: fig(30, 3.6, { estimated: true }) },
    { asset_id: 3, parent_id: 2, name: "LV Panel 1", path: "Site / MV2 / LV Panel 1", rate_per_kwh: 0.12,
      days: [fig(5, null, { partial: true }), fig(7.5, 0.9), fig(0, 0, { no_data: true })],
      total: fig(12.5, 0.9, { partial: true }) },
    { asset_id: 4, parent_id: 1, name: "Spare", path: "Site / Spare", rate_per_kwh: 0.12, days: [null, null, null], total: null },
    { asset_id: 5, parent_id: null, name: "Annex", path: "Annex", rate_per_kwh: null,
      days: [fig(4, null, { partial: true }), fig(3, null, { partial: true }), fig(0, null, { no_data: true })],
      total: fig(7, null, { partial: true }) },
  ],
};

let requested: (string | null)[];
const routes = (role: string, reply: { status?: number; body?: unknown }, zone: string): Routes => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role } },
  "GET /api/site": { body: { timezone: zone, currency: "QAR" } },
  "GET /api/billing/costs": ({ url }) => {
    requested.push(new URL(url, "http://x").searchParams.get("month"));
    return reply;
  },
});
const open = (role = "viewer", reply: { status?: number; body?: unknown } = { body: costs }, zone = "Asia/Qatar") => {
  mockFetch(routes(role, reply, zone));
  renderWithProviders(<BillingPage />, { route: "/billing", path: "/billing" });
};
const rowOf = (asset: string) => screen.getByRole("rowheader", { name: asset }).closest("tr")!;
const tdsOf = (asset: string) => Array.from(rowOf(asset).querySelectorAll("td"));
/** Text of every non-header cell of an asset's row; a figure cell reads "kWh|cost", an empty one "". */
const cellsOf = (asset: string) =>
  tdsOf(asset).map((td) => (td.children.length ? Array.from(td.children).map((c) => c.textContent).join("|") : td.textContent));

beforeEach(() => {
  requested = [];
  // Only Date is faked, so React Query, user-event and waitFor keep their real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  vi.mocked(downloadCsv).mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("BillingPage", () => {
  it("says loading until the month arrives", () => {
    open();
    expect(screen.getByText("loading…")).toBeInTheDocument();
  });

  it("shows the asset tree by day with kWh over cost, month totals and the rate in effect", async () => {
    open();
    expect(await screen.findByRole("rowheader", { name: "LV Panel 1" })).toBeInTheDocument();
    expect(screen.getByText("October 2026")).toBeInTheDocument();
    expect(requested).toEqual(["2026-10"]);
    expect(screen.getByRole("columnheader", { name: "Rate (QAR/kWh)" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Month total" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "2" })).toHaveAttribute("title", "Fri 02 Oct");
    // rate, month total, then the three days
    expect(cellsOf("Site")).toEqual(["0.12", "50.0|6.00", "30.0|3.60", "20.0|2.40", "0.0|0.00"]);
  });

  it("indents each asset by its depth in the tree", async () => {
    open();
    const padding = async (name: string) => (await screen.findByRole("rowheader", { name })).style.paddingLeft;
    expect([await padding("Site"), await padding("MV2"), await padding("LV Panel 1"), await padding("Spare"), await padding("Annex")])
      .toEqual(["8px", "24px", "40px", "24px", "8px"]);
  });

  it("marks estimated figures with ~ and partial costs with *, with tooltips and a legend", async () => {
    open();
    await screen.findByRole("rowheader", { name: "MV2" });
    expect(cellsOf("MV2")).toEqual(["0.12", "~30.0|~3.60", "~18.0|~2.16", "~12.0|~1.44", "0.0|0.00"]);
    expect(cellsOf("LV Panel 1")[1]).toBe("12.5|0.90*");
    expect(screen.getAllByTitle(ESTIMATED_TIP).length).toBeGreaterThan(0);
    expect(screen.getAllByTitle(PARTIAL_TIP).length).toBeGreaterThan(0);
    expect(screen.getByText(/estimated from average power/i)).toBeInTheDocument();
    expect(screen.getByText(/partial: some consumption had no rate/i)).toBeInTheDocument();
  });

  it("explains every symbol in the legend: the dash means no rate, a shaded cell means no data, an empty cell means no figure", async () => {
    open();
    await screen.findByRole("rowheader", { name: "Site" });
    expect(screen.getByText("— no rate")).toBeInTheDocument();
    expect(screen.getByText("shaded cell: no data was recorded, so the 0 is not a measurement")).toBeInTheDocument();
    expect(screen.queryByText(/grey/i)).not.toBeInTheDocument(); // the cell is told apart by its shading, not by a colour name
    expect(screen.getByText(/empty cell: no meter, or the day has not been reached yet/i)).toBeInTheDocument();
  });

  it("shows a dash, never zero, where no rate applies, and points an admin to Tariffs (Review Focus 3, UI side)", async () => {
    open("admin");
    await screen.findByRole("rowheader", { name: "Annex" });
    expect(cellsOf("Annex")).toEqual(["—", "7.0|—", "4.0|—", "3.0|—", "0.0|—"]); // no rate in effect: the kWh show, the cost is a dash
    expect(cellsOf("LV Panel 1")[2]).toBe("5.0|—"); // the day before its rate starts
    expect(screen.getByRole("link", { name: /Set a rate on the Tariffs page/ })).toHaveAttribute("href", "/tariffs");
    // a partial total shows `*` and a missing one a dash: the banner names both
    expect(screen.getByRole("status")).toHaveTextContent("Some consumption has no rate (shown as — or *).");
    expect(screen.getByRole("status")).not.toHaveTextContent("shows a dash");
  });

  it("tells a viewer to ask an administrator instead of linking to Tariffs", async () => {
    open("viewer");
    await screen.findByRole("rowheader", { name: "LV Panel 1" });
    expect(screen.getByText(/ask an administrator/i)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Some consumption has no rate (shown as — or *). Ask an administrator to set one.");
    expect(screen.queryByRole("link", { name: /Tariffs/ })).not.toBeInTheDocument();
  });

  it("says nothing about rates when every cost is priced", async () => {
    open("admin", { body: { ...costs, assets: costs.assets.slice(0, 2) } });
    await screen.findByRole("rowheader", { name: "MV2" });
    expect(screen.queryByRole("link", { name: /Tariffs/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/ask an administrator/i)).not.toBeInTheDocument();
  });

  it("mutes a day and a month total that recorded nothing, but still shows their zeros", async () => {
    const silent = fig(0, 0, { estimated: true, no_data: true });
    open("viewer", {
      body: {
        ...costs,
        assets: [{ ...costs.assets[0], days: [silent, silent, silent], total: silent }, costs.assets[1]],
      },
    });
    await screen.findByRole("rowheader", { name: "MV2" });
    const [, total, d1, d2, d3] = tdsOf("Site");
    for (const td of [total, d1, d2, d3]) {
      expect(td).toHaveClass("muted");
      expect(td).toHaveAttribute("title", "no data");
      expect(td).toHaveTextContent("0.0");
    }
    expect(cellsOf("Site")[1]).toBe("~0.0|~0.00");
    const mv2 = tdsOf("MV2");
    expect(mv2[1]).not.toHaveClass("muted"); // MV2's total is a measurement
    expect(mv2[4]).toHaveClass("muted"); // its last day recorded nothing
    expect(mv2[4]).toHaveAttribute("title", "no data");
    expect(cellsOf("MV2")[4]).toBe("0.0|0.00");
    expect(mv2[2]).not.toHaveClass("muted");
    expect(mv2[2]).not.toHaveAttribute("title");
  });

  it("renders an asset without a meter as empty cells titled 'no meter', not as dashes", async () => {
    open();
    await screen.findByRole("rowheader", { name: "Spare" });
    expect(cellsOf("Spare")).toEqual(["0.12", "", "", "", ""]);
    const [, ...figures] = tdsOf("Spare");
    for (const td of figures) {
      expect(td).toHaveClass("muted");
      expect(td).toHaveAttribute("title", "no meter");
    }
    expect(rowOf("Spare")).not.toHaveTextContent("—");
  });

  it("renders a day that has not been reached yet as an empty cell titled 'not yet'", async () => {
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    const upToDay2 = (a: (typeof costs.assets)[number]) =>
      a.total === null ? a : { ...a, days: [a.days[0], a.days[1], null] };
    open("viewer", { body: { ...costs, assets: costs.assets.map(upToDay2) } });
    await screen.findByRole("rowheader", { name: "Site" });
    expect(requested).toEqual(["2026-10"]);
    expect(cellsOf("Site")).toEqual(["0.12", "50.0|6.00", "30.0|3.60", "20.0|2.40", ""]);
    const last = tdsOf("Site")[4];
    expect(last).toHaveClass("muted");
    expect(last).toHaveAttribute("title", "not yet");
    expect(tdsOf("Spare")[4]).toHaveAttribute("title", "no meter"); // an asset without a meter keeps its own title
  });

  it("defaults to the current month on the site's wall clock, not UTC", async () => {
    vi.setSystemTime(new Date("2026-10-31T22:30:00Z")); // 01:30 on 1 November in Asia/Qatar
    open("viewer", { body: { ...costs, month: "2026-11" } });
    expect(await screen.findByText("November 2026")).toBeInTheDocument();
    expect(requested).toEqual(["2026-11"]);
    expect(screen.getByRole("button", { name: "Next month" })).toBeDisabled(); // nothing lies after the current month
  });

  it("steps to the previous month and back, across a year end", async () => {
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    open("viewer", { body: costs }, "UTC");
    expect(await screen.findByText("January 2026")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(await screen.findByText("December 2025")).toBeInTheDocument();
    await waitFor(() => expect(requested).toEqual(["2026-01", "2025-12"]));
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(await screen.findByText("January 2026")).toBeInTheDocument();
  });

  it("downloads the month on screen as CSV", async () => {
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Download CSV" }));
    expect(downloadCsv).toHaveBeenCalledWith("/api/billing/costs.csv?month=2026-10");
  });

  it("shows why the export failed", async () => {
    vi.mocked(downloadCsv).mockRejectedValueOnce(new ApiError(409, "site timezone must have whole-hour UTC offsets"));
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Download CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("site timezone must have whole-hour UTC offsets");
  });

  it("shows the server's explanation when billing is refused", async () => {
    open("viewer", { status: 409, body: { detail: "site timezone must have a whole-hour UTC offset" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("site timezone must have a whole-hour UTC offset");
  });

  it("says so when there are no assets", async () => {
    open("viewer", { body: { ...costs, assets: [] } });
    expect(await screen.findByText("No assets yet.")).toBeInTheDocument();
  });

  it("says so when no asset has energy data in the month", async () => {
    const none = costs.assets.map((a) => ({ ...a, days: a.days.map(() => null), total: null }));
    open("viewer", { body: { ...costs, assets: none } });
    expect(await screen.findByText("No energy data for this month.")).toBeInTheDocument();
  });
});
