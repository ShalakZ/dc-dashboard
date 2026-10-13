import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../api/client";
import type { BillingCosts, CostFigure } from "../api/types";
import { ESTIMATED_TIP, PARTIAL_TIP } from "../components/Figure";
import { downloadCsv } from "../lib/download";
import { mockFetch, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { accountKnown, SignedIn } from "../test/signedIn";
import { BUILTIN_PERMISSIONS, userFor } from "../test/users";
import type { PermissionId } from "../lib/permissions";
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
const routes = (role: string, reply: { status?: number; body?: unknown }, zone: string, months: { status?: number; body?: unknown }): Routes => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor(role) },
  "GET /api/site": { body: { timezone: zone, currency: "QAR" } },
  "GET /api/billing/costs": ({ url }) => {
    requested.push(new URL(url, "http://x").searchParams.get("month"));
    return reply;
  },
  "GET /api/billing/months": months,
});
/** `months` is the answer of the first-month request, or "pending" for one that never answers. */
const open = (
  role = "viewer",
  reply: { status?: number; body?: unknown } = { body: costs },
  zone = "Asia/Qatar",
  months: { status?: number; body?: unknown } | "pending" = { body: { first_month: null } },
  hold?: (method: string, path: string) => boolean, // requests kept back until release() (installed before the page mounts)
) => {
  mockFetch(routes(role, reply, zone, months === "pending" ? {} : months));
  if (months === "pending") {
    const answered = fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/api/billing/months") ? new Promise<Response>(() => {}) : answered(input, init));
  }
  const held = hold ? holdFetch(hold) : { release: () => {} };
  renderWithProviders(<BillingPage />, { route: "/billing", path: "/billing" });
  return held;
};
const yearSelect = () => screen.getByRole("combobox", { name: "Year" });
const monthSelect = () => screen.getByRole("combobox", { name: "Month" });
const optionTexts = (select: HTMLElement) => within(select).getAllByRole("option").map((o) => o.textContent);
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
  describe("while the month loads", () => {
    const LABEL = "Loading billing";
    const region = () => screen.getByText(LABEL).parentElement!;

    it("shows a table skeleton until the month arrives, then the table and no region", async () => {
      open();
      expect(region()).toHaveAttribute("role", "status");
      expect(region().querySelector(".sk-table")).not.toBeNull();
      expect(screen.queryByText("loading…")).not.toBeInTheDocument();
      expect(screen.queryByRole("rowheader")).not.toBeInTheDocument(); // the placeholder rows are not in the accessibility tree
      expect(await screen.findByRole("rowheader", { name: "LV Panel 1" })).toBeInTheDocument();
      expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
      expect(document.querySelector(".sk-region")).toBeNull(); // (the missing-rate banner is a status of its own)
    });

    it("draws the how-to-read caption row of the table (a line placeholder in a muted caption), so the first row sits where it will land", async () => {
      open();
      const caption = region().querySelector(".sk-table caption")!;
      expect(caption).toHaveClass("muted");
      expect(caption.querySelector(".sk-line")).not.toBeNull();
      expect(caption.textContent).toBe("");
      expect(caption.nextElementSibling?.tagName, "the caption comes first in the table, then the head").toBe("THEAD");
      await screen.findByRole("rowheader", { name: "LV Panel 1" });
    });

    it("keeps a 34px gap in the header's actions slot and the month bar's place while the site is unknown, and the real ones take their place", async () => {
      const held = open("viewer", { body: costs }, "Asia/Qatar", { body: { first_month: null } }, (_method, path) => path === "/api/site");
      await waitFor(() => expect(document.querySelector("header.page-head > .actions")).not.toBeNull()); // (the permissions arrive with /api/me, a moment after the first render; in the app the page mounts after them)
      const actions = document.querySelector("header.page-head > .actions")!;
      expect(actions).not.toBeNull();
      const gap = actions.firstElementChild as HTMLElement;
      expect(gap).toHaveAttribute("aria-hidden", "true");
      expect(gap.style.height).toBe("34px");
      expect(screen.queryByRole("button", { name: "Download CSV" })).not.toBeInTheDocument();
      const bar = document.querySelector(".billing-page > .row.billing-bar")!; // and the month bar's place, with its selects' height
      expect(bar).toHaveAttribute("aria-hidden", "true");
      expect((bar.firstElementChild as HTMLElement).style.height).toBe("38px");
      expect(bar.querySelector("button, select")).toBeNull();
      held.release();
      expect(await screen.findByRole("button", { name: "Download CSV" })).toBeInTheDocument();
      expect(document.querySelectorAll("header.page-head > .actions > *")).toHaveLength(1); // the button, and the gap is gone
      expect(document.querySelectorAll(".billing-page .billing-bar")).toHaveLength(1); // the real bar only
      expect(document.querySelector(".billing-bar[aria-hidden]")).toBeNull();
    });

    it("keeps no gap when the site could not be read (there is no button or bar to come)", async () => {
      mockFetch({ ...routes("viewer", { body: costs }, "Asia/Qatar", { body: { first_month: null } }), "GET /api/site": { status: 500, body: { detail: "no site" } } });
      renderWithProviders(<BillingPage />, { route: "/billing", path: "/billing" });
      expect(await screen.findByText("no site")).toBeInTheDocument();
      expect(document.querySelector("header.page-head > .actions")).toBeNull();
      expect(document.querySelector(".billing-bar")).toBeNull();
    });

    it("keeps the pickers and shows the skeleton in the table's place while the month's costs are held", async () => {
      const held = open("viewer", { body: costs }, "Asia/Qatar", { body: { first_month: null } }, (_method, path) => path === "/api/billing/costs");
      expect(await screen.findByText("October 2026")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Previous month" })).toBeInTheDocument();
      expect(screen.getByText(LABEL)).toBeInTheDocument();
      expect(screen.queryByText("loading…")).not.toBeInTheDocument();
      held.release();
      expect(await screen.findByRole("rowheader", { name: "Site" })).toBeInTheDocument();
      expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    });

    it("shows the skeleton again for a month that has not been fetched, and not on a refetch of one that has", async () => {
      open();
      await screen.findByRole("rowheader", { name: "Site" });
      const held = holdFetch((_method, path) => path === "/api/billing/costs");
      await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
      expect(await screen.findByText("September 2026")).toBeInTheDocument();
      expect(screen.getByText(LABEL)).toBeInTheDocument(); // a month with no data yet
      expect(screen.queryByRole("rowheader")).not.toBeInTheDocument();
      held.release();
      await screen.findByRole("rowheader", { name: "Site" });
      expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    });

    it("ends with the error as an alert, no region, when the costs cannot be loaded", async () => {
      open("viewer", { status: 500, body: { detail: "costs are down" } });
      expect(await screen.findByRole("alert")).toHaveTextContent("costs are down");
      expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("ends with the empty state for a site with no assets", async () => {
      open("viewer", { body: { ...costs, assets: [] } });
      expect(await screen.findByText("No assets yet.")).toBeInTheDocument();
      expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    });

    it("a costs request that failed never brings the skeleton back when it is tried again: today's muted line shows, then the error", async () => {
      open("viewer", { status: 500, body: { detail: "costs are down" } });
      await screen.findByRole("alert");
      const held = holdFetch((_method, path) => path === "/api/billing/costs");
      act(() => { document.dispatchEvent(new Event("visibilitychange", { bubbles: true })); }); // a refetch, as the 60 s poll would make
      expect(await screen.findByText("loading…")).toHaveClass("muted");
      expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      held.release();
      expect(await screen.findByRole("alert")).toHaveTextContent("costs are down");
      expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    });
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

  it("steps across a year end just the same when the first-month request fails, and shows no error for it", async () => {
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    open("viewer", { body: costs }, "UTC", { status: 500, body: { detail: "months are down" } });
    expect(await screen.findByText("January 2026")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(await screen.findByText("December 2025")).toBeInTheDocument();
    await waitFor(() => expect(requested).toEqual(["2026-01", "2025-12"]));
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(await screen.findByText("January 2026")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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

  it("opens with the shared page header (one h1 in a .page-head) over one table in a .table-wrap", async () => {
    open();
    await screen.findByRole("rowheader", { name: "Site" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Billing" }).closest("header")).toHaveClass("page-head");
    expect(screen.getByRole("table").closest(".table-scroll")).toHaveClass("table-wrap");
    // exactly one table, and the figure cell keeps its two bare divs (e2e reads the first and the last)
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(tdsOf("Site")[1].querySelectorAll(":scope > div")).toHaveLength(2);
  });

  it("makes Download CSV the page's one primary button and numbers right-aligned", async () => {
    open();
    await screen.findByRole("rowheader", { name: "Site" });
    expect(document.querySelectorAll(".primary")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Download CSV" })).toHaveClass("primary");
    expect(screen.getByRole("columnheader", { name: "Month total" })).toHaveClass("num");
    expect(screen.getByRole("columnheader", { name: "2" })).toHaveClass("num");
  });

  it("shows the admin's missing-rate note as a warning banner", async () => {
    open("admin");
    await screen.findByRole("rowheader", { name: "Annex" });
    expect(screen.getByRole("status")).toHaveClass("banner", "banner-warn");
  });

  it("shows the viewer's missing-rate note as a warning banner too", async () => {
    open("viewer");
    await screen.findByRole("rowheader", { name: "Annex" });
    expect(screen.getByRole("status")).toHaveClass("banner", "banner-warn");
  });

  it("says so when there are no assets", async () => {
    open("viewer", { body: { ...costs, assets: [] } });
    expect(await screen.findByText("No assets yet.")).toBeInTheDocument();
    expect(screen.getByText("No assets yet.").closest(".empty")).not.toBeNull();
  });

  it("says so when no asset has energy data in the month", async () => {
    const none = costs.assets.map((a) => ({ ...a, days: a.days.map(() => null), total: null }));
    open("viewer", { body: { ...costs, assets: none } });
    expect(await screen.findByText("No energy data for this month.")).toBeInTheDocument();
    expect(screen.getByText("No energy data for this month.").closest(".empty")).not.toBeNull();
  });
  describe("the Year and Month selects", () => {
    const FIRST = { body: { first_month: "2025-03" } };
    const MONTHS_2026 = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October"];

    it("show the current month, offer the years from the first month with data and the months inside the bounds", async () => {
      open("viewer", { body: costs }, "Asia/Qatar", FIRST);
      await screen.findByRole("rowheader", { name: "Site" });
      expect(yearSelect()).toHaveValue("2026");
      expect(monthSelect()).toHaveValue("10");
      expect(optionTexts(yearSelect())).toEqual(["2025", "2026"]);
      expect(optionTexts(monthSelect())).toEqual(MONTHS_2026); // nothing after the current month
      expect(screen.getByText("Year").tagName).toBe("LABEL");
      expect(screen.getByText("Month", { selector: "label" })).toHaveAttribute("for", monthSelect().id);
    });

    it.each([
      ["has not answered yet", "pending"],
      ["failed", { status: 500, body: { detail: "down" } }],
      ["found no data at all", { body: { first_month: null } }],
    ] as const)("offer only the current month, and leave Previous enabled, when the first-month request %s", async (_state, months) => {
      open("viewer", { body: costs }, "Asia/Qatar", months);
      await screen.findByRole("rowheader", { name: "Site" });
      expect(optionTexts(yearSelect())).toEqual(["2026"]);
      expect(optionTexts(monthSelect())).toEqual(["October"]);
      expect(screen.getByRole("button", { name: "Previous month" })).toBeEnabled(); // exactly as before the picker existed
    });

    it("jump to a month far back: pick the year, then the month", async () => {
      open("viewer", { body: costs }, "Asia/Qatar", FIRST);
      await screen.findByRole("rowheader", { name: "Site" });
      await userEvent.selectOptions(yearSelect(), "2025");
      expect(screen.getByText("October 2025")).toBeInTheDocument(); // the month number is kept when it fits
      expect(optionTexts(monthSelect())).toEqual(MONTHS_2026.slice(2).concat("November", "December")); // March to December
      await userEvent.selectOptions(monthSelect(), "March");
      expect(await screen.findByText("March 2025")).toBeInTheDocument();
      await waitFor(() => expect(requested).toEqual(["2026-10", "2025-10", "2025-03"]));
      expect(screen.getByRole("button", { name: "Previous month" })).toBeDisabled(); // nothing lies before the first month
      expect(screen.getByRole("button", { name: "Next month" })).toBeEnabled();
    });

    it("pull the month back into range when the year changes", async () => {
      open("viewer", { body: costs }, "Asia/Qatar", FIRST);
      await screen.findByRole("rowheader", { name: "Site" });
      await userEvent.selectOptions(monthSelect(), "January");
      expect(await screen.findByText("January 2026")).toBeInTheDocument();
      await userEvent.selectOptions(yearSelect(), "2025"); // January 2025 is before the first month
      expect(await screen.findByText("March 2025")).toBeInTheDocument();
      expect(monthSelect()).toHaveValue("3");
      await userEvent.selectOptions(monthSelect(), "December");
      await userEvent.selectOptions(yearSelect(), "2026"); // December 2026 is after the current month
      expect(await screen.findByText("October 2026")).toBeInTheDocument();
      expect(monthSelect()).toHaveValue("10");
      expect(screen.getByRole("button", { name: "Next month" })).toBeDisabled();
    });

    it("keep Previous and the selects in step with each other", async () => {
      open("viewer", { body: costs }, "Asia/Qatar", { body: { first_month: "2026-09" } });
      await screen.findByRole("rowheader", { name: "Site" });
      expect(screen.getByRole("button", { name: "Previous month" })).toBeEnabled();
      await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
      expect(await screen.findByText("September 2026")).toBeInTheDocument();
      expect(monthSelect()).toHaveValue("9");
      expect(screen.getByRole("button", { name: "Previous month" })).toBeDisabled(); // September is the first month with data
      expect(optionTexts(monthSelect())).toEqual(["September", "October"]);
    });

    it("disable Previous once the answer says the month on screen is the first one", async () => {
      open("viewer", { body: costs }, "Asia/Qatar", { body: { first_month: "2026-10" } });
      await waitFor(() => expect(screen.getByRole("button", { name: "Previous month" })).toBeDisabled());
      expect(screen.getByRole("button", { name: "Next month" })).toBeDisabled();
    });

    it("always contain the month on screen, even when the first month is later than the current one", async () => {
      open("viewer", { body: costs }, "Asia/Qatar", { body: { first_month: "2027-02" } }); // e.g. the site time zone moved back
      await waitFor(() => expect(screen.getByRole("button", { name: "Previous month" })).toBeDisabled());
      expect(yearSelect()).toHaveValue("2026");
      expect(monthSelect()).toHaveValue("10");
      expect(optionTexts(yearSelect())).toEqual(["2026"]);
    });

    it("are reached by Tab, and keep the focus while the new month loads", async () => {
      open("viewer", { body: costs }, "Asia/Qatar", FIRST);
      await screen.findByRole("rowheader", { name: "Site" });
      screen.getByRole("button", { name: "Previous month" }).focus();
      await userEvent.tab(); // Next month is disabled at the current month, so it is skipped
      expect(yearSelect()).toHaveFocus();
      await userEvent.tab();
      expect(monthSelect()).toHaveFocus();
      const before = monthSelect();
      await userEvent.selectOptions(monthSelect(), "June");
      expect(await screen.findByText("June 2026")).toBeInTheDocument();
      await screen.findByRole("rowheader", { name: "Site" });
      expect(monthSelect()).toBe(before);
      expect(monthSelect()).toHaveFocus();
    });
  });
});

describe("BillingPage controls follow the permissions of the role (a custom role)", () => {
  /** A role called "custom" that holds billing.view and `permissions`; the costs are on screen and the account is known when this returns. */
  const show = async (permissions: PermissionId[], reply: { status?: number; body?: unknown } = { body: costs }) => {
    mockFetch({
      ...routes("custom", reply, "Asia/Qatar", { body: { first_month: null } }),
      "GET /api/me": { body: userFor("custom", { permissions: ["billing.view", ...permissions] }) },
    });
    renderWithProviders(<><BillingPage /><SignedIn /></>, { route: "/billing", path: "/billing" });
    await screen.findByRole("rowheader", { name: "Annex" });
    await accountKnown();
  };

  it("billing.view alone: the table, the month bar, no Download CSV and no gap where it was, and no link to Tariffs", async () => {
    await show([]);
    expect(screen.queryByRole("button", { name: "Download CSV" })).not.toBeInTheDocument();
    expect(document.querySelector("header.page-head > .actions")).toBeNull();
    expect(screen.getByRole("button", { name: "Previous month" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Tariffs/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Ask an administrator to set one.");
  });

  it("billing.export: Download CSV downloads the month on screen", async () => {
    await show(["billing.export"]);
    await userEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(downloadCsv).toHaveBeenCalledWith("/api/billing/costs.csv?month=2026-10");
  });

  it("tariffs.edit alone is not enough for the link: the Tariffs page also needs the assets, so the note says to ask", async () => {
    await show(["tariffs.edit"]);
    expect(screen.queryByRole("link", { name: /Tariffs/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Ask an administrator to set one.");
  });

  it("tariffs.edit, tariffs.view and assets.view: the link to the Tariffs page, the page the person may open and change", async () => {
    await show(["tariffs.edit", "tariffs.view", "assets.view"]);
    expect(screen.getByRole("link", { name: /Set a rate on the Tariffs page/ })).toHaveAttribute("href", "/tariffs");
    expect(screen.queryByRole("button", { name: "Download CSV" })).not.toBeInTheDocument(); // billing.export is separate
  });

  // W9b: the Tariffs page opens read-only for tariffs.view, but nothing can be set there without tariffs.edit, so the note must not send the person to it.
  it("tariffs.view and assets.view without tariffs.edit: the page opens, but the note still says to ask and has no link", async () => {
    await show(["tariffs.view", "assets.view"]);
    expect(screen.queryByRole("link", { name: /Tariffs/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Some consumption has no rate (shown as — or *). Ask an administrator to set one.");
  });

  it("the built-in Operator holds tariffs.view and assets.view but not tariffs.edit: Ask an administrator, no link (unchanged by W9b)", async () => {
    await show(BUILTIN_PERMISSIONS.operator);
    expect(screen.queryByRole("link", { name: /Tariffs/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Some consumption has no rate (shown as — or *). Ask an administrator to set one.");
  });
});
