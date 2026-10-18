import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../api/client";
import type { BillingAssetRow, BillingClosed, BillingCosts, BillingLive, CostFigure, User } from "../api/types";
import { ESTIMATED_TIP, PARTIAL_TIP } from "../components/Figure";
import { downloadCsv } from "../lib/download";
import { mockFetch, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { accountKnown, SignedIn } from "../test/signedIn";
import { spyToasts } from "../test/toasts";
import type { ToastApi } from "../components/Toasts";
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
  closed: null,
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
  toasts?: ToastApi,
) => {
  mockFetch(routes(role, reply, zone, months === "pending" ? {} : months));
  if (months === "pending") {
    const answered = fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/api/billing/months") ? new Promise<Response>(() => {}) : answered(input, init));
  }
  const held = hold ? holdFetch(hold) : { release: () => {} };
  renderWithProviders(<BillingPage />, { route: "/billing", path: "/billing", toasts });
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
      const bar = document.querySelector(".billing-toolbar > .row.billing-bar")!; // and the month bar's place, with its selects' height
      expect(bar).toHaveAttribute("aria-hidden", "true");
      expect((bar.firstElementChild as HTMLElement).style.height).toBe("34px");
      expect(bar.querySelector("button, select")).toBeNull();
      expect(bar.parentElement).toHaveClass("billing-toolbar"); // the first child of the toolbar, with the controls bar's inert copy beside it
      expect(bar).toBe(bar.parentElement!.firstElementChild);
      expect(bar.nextElementSibling).toHaveClass("billing-tools", "is-idle");
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
      expect(document.querySelector(".billing-toolbar")).toBeNull(); // no toolbar when the site failed
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

  it("downloads the month on screen as CSV and says so with one toast, after the file came back", async () => {
    const toasts = spyToasts();
    open("viewer", { body: costs }, "Asia/Qatar", { body: { first_month: null } }, undefined, toasts.api);
    await userEvent.click(await screen.findByRole("button", { name: "Download CSV" }));
    expect(downloadCsv).toHaveBeenCalledWith("/api/billing/costs.csv?month=2026-10");
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "info", text: "CSV downloaded" }]));
  });

  it("shows why the export failed", async () => {
    vi.mocked(downloadCsv).mockRejectedValueOnce(new ApiError(409, "site timezone must have whole-hour UTC offsets"));
    const toasts = spyToasts();
    open("viewer", { body: costs }, "Asia/Qatar", { body: { first_month: null } }, undefined, toasts.api);
    await userEvent.click(await screen.findByRole("button", { name: "Download CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("site timezone must have whole-hour UTC offsets");
    expect(toasts.calls).toEqual([]); // a failed export keeps its inline line and raises no toast
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

describe("BillingPage closed months and the Close and Reopen controls", () => {
  const CLOSED: BillingClosed = { id: 7, closed_name: "Dana", closed_at: "2026-10-14T21:30:00Z", note: "First official bill", total_kwh: 50, total_cost: 6 }; // 00:30 on 15 October in Doha
  const SAME: BillingLive = { total_kwh: 50, total_cost: 6, delta_kwh: 0, delta_cost: 0, differs: false, changed_assets: 0, currency: "QAR" };
  const september: BillingCosts = { ...costs, month: "2026-09", closed: null };
  const closedSeptember = (over: Partial<BillingCosts> = {}): BillingCosts => ({ ...september, closed: CLOSED, live: SAME, ...over });
  const customUser = (...permissions: PermissionId[]) => userFor("custom", { permissions: ["billing.view", ...permissions] });

  /** The page on October 2026 (the current month) for `user`, with `bodies` as the answers per month; the account is known when this returns. */
  async function show(user: User, bodies: Record<string, unknown> = {}, extra: Routes = {}, hold?: (method: string, path: string) => boolean, toasts?: ToastApi) {
    const calls = mockFetch({
      "GET /api/setup": { body: { needed: false } },
      "GET /api/me": { body: user },
      "GET /api/site": { body: { timezone: "Asia/Qatar", currency: "QAR" } },
      "GET /api/billing/months": { body: { first_month: null } },
      "GET /api/billing/costs": ({ url }) => {
        const month = new URL(url, "http://x").searchParams.get("month")!;
        return { body: bodies[month] ?? (month === "2026-09" ? september : costs) };
      },
      ...extra,
    });
    const held = hold ? holdFetch(hold) : { release: () => {} };
    renderWithProviders(<><BillingPage /><SignedIn /></>, { route: "/billing", path: "/billing", toasts });
    await accountKnown();
    return { calls, held };
  }
  const toSeptember = async () => {
    await userEvent.click(await screen.findByRole("button", { name: "Previous month" }));
    await screen.findByText("September 2026");
    await screen.findByRole("rowheader", { name: "Site" });
  };
  const actions = () => document.querySelector("header.page-head > .actions");
  const closeButton = () => screen.queryByRole("button", { name: "Close month…" });
  const reopenButton = () => screen.queryByRole("button", { name: "Reopen month…" });

  describe("the header buttons", () => {
    it("offers Close month… on a finished open month, left of Download CSV, so the download button keeps its place; the page keeps one primary button", async () => {
      await show(userFor("admin"));
      await screen.findByRole("rowheader", { name: "Site" });
      expect(closeButton()).not.toBeInTheDocument(); // October is the current month
      await toSeptember();
      const names = Array.from(actions()!.children).map((el) => el.textContent);
      expect(names).toEqual(["Close month…", "Download CSV"]);
      expect(screen.getByRole("button", { name: "Close month…" })).toHaveAttribute("type", "button");
      expect(document.querySelectorAll(".primary")).toHaveLength(1);
      expect(reopenButton()).not.toBeInTheDocument();
    });

    it("never offers Close month… for the current month, however late in it", async () => {
      vi.setSystemTime(new Date("2026-10-31T20:59:00Z")); // 23:59 on 31 October in Doha
      await show(userFor("admin"));
      await screen.findByRole("rowheader", { name: "Site" });
      expect(closeButton()).not.toBeInTheDocument();
      expect(reopenButton()).not.toBeInTheDocument();
    });

    it("offers Close month… for the previous month in the first minutes of the new one, by the site's clock and not UTC", async () => {
      vi.setSystemTime(new Date("2026-10-31T21:05:00Z")); // 00:05 on 1 November in Doha
      await show(userFor("admin"));
      expect(await screen.findByText("November 2026")).toBeInTheDocument();
      await screen.findByRole("rowheader", { name: "Site" });
      expect(closeButton()).not.toBeInTheDocument(); // the site is already in November
      await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
      expect(await screen.findByText("October 2026")).toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Close month…" })).toBeInTheDocument();
    });

    it.each([
      ["a viewer", userFor("viewer")],
      ["a role with billing.view and billing.export only", customUser("billing.export")],
      ["a role with billing.view only", customUser()],
    ])("shows neither Close nor Reopen to %s, on an open month or a closed one", async (_who, user) => {
      await show(user, { "2026-09": september });
      await toSeptember();
      expect(closeButton()).not.toBeInTheDocument();
      expect(reopenButton()).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
      await screen.findByText("August 2026");
    });

    it("shows neither to a role that cannot close when the month is closed", async () => {
      await show(userFor("viewer"), { "2026-09": closedSeptember() });
      await toSeptember();
      expect(await screen.findByText(/Closed by Dana/)).toBeInTheDocument();
      expect(closeButton()).not.toBeInTheDocument();
      expect(reopenButton()).not.toBeInTheDocument();
    });

    it("offers Reopen month… instead of Close month… on a closed month", async () => {
      await show(userFor("admin"), { "2026-09": closedSeptember() });
      await toSeptember();
      expect(await screen.findByRole("button", { name: "Reopen month…" })).toHaveAttribute("type", "button");
      expect(closeButton()).not.toBeInTheDocument();
      expect(Array.from(actions()!.children).map((el) => el.textContent)).toEqual(["Reopen month…", "Download CSV"]);
      expect(document.querySelectorAll(".primary")).toHaveLength(1);
    });

    it("offers Reopen month… even for the current month, if the server says it is closed", async () => {
      await show(userFor("admin"), { "2026-10": { ...costs, closed: CLOSED, live: SAME } });
      expect(await screen.findByRole("button", { name: "Reopen month…" })).toBeInTheDocument();
    });

    it("shows neither while the costs load, and the header keeps its height for a role that may close but not export", async () => {
      const { held } = await show(customUser("billing.close"), {}, {}, (_method, path) => path === "/api/billing/costs");
      await screen.findByText("October 2026");
      expect(closeButton()).not.toBeInTheDocument();
      expect(reopenButton()).not.toBeInTheDocument();
      expect(actions()!.children).toHaveLength(1);
      expect(actions()!.firstElementChild).toHaveAttribute("aria-hidden", "true"); // the room of a button
      held.release();
      await screen.findByRole("rowheader", { name: "Site" });
      expect(actions()!.firstElementChild).toHaveAttribute("aria-hidden", "true"); // the current month has nothing to close: the room stays, the header does not jump
      await toSeptember();
      expect(Array.from(actions()!.children).map((el) => el.textContent)).toEqual(["Close month…"]);
    });

    it("gives a role with neither permission no actions at all", async () => {
      await show(customUser());
      await screen.findByRole("rowheader", { name: "Site" });
      expect(actions()).toBeNull();
    });
  });

  describe("a closed month on screen", () => {
    it("shows the chip beside the month name, in a room that is there for open months too", async () => {
      await show(userFor("admin"), { "2026-09": closedSeptember() });
      await screen.findByRole("rowheader", { name: "Site" });
      const label = document.querySelector(".month-label")!;
      const room = label.nextElementSibling!;
      expect(room).toHaveClass("month-state");
      expect(room.textContent).toBe(""); // October is open
      expect(room.querySelector(".chip")).toBeNull();
      await toSeptember();
      expect(label.nextElementSibling).toBe(room);
      expect(within(room as HTMLElement).getByText("Closed")).toHaveClass("chip");
      expect(label).toHaveTextContent("September 2026"); // the chip is not part of the announced month
      expect(label).not.toHaveTextContent("Closed");
    });

    it("says who closed it and on what day (the site's wall clock, not UTC), with the note on its own line, in the same render as the table", async () => {
      await show(userFor("admin"), { "2026-09": closedSeptember() });
      await toSeptember();
      // (toSeptember returned once the table was there: the banner is already in the page, not on its way)
      const banner = screen.getByText("Closed by Dana on Thu 15 Oct 2026.").closest(".banner")!;
      expect(banner).toHaveClass("banner-info");
      expect(banner.compareDocumentPosition(screen.getByRole("table")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // above the table
      const note = screen.getByText("First official bill");
      expect(note.closest(".banner")).toBe(banner);
      expect(note.previousElementSibling).toHaveTextContent("Closed by Dana");
      expect(banner.getAttribute("role")).toBeNull();
      expect(banner.closest("[role]")).toBeNull();
    });

    it("leaves the note line out when there is none", async () => {
      await show(userFor("admin"), { "2026-09": closedSeptember({ closed: { ...CLOSED, note: "" } }) });
      await toSeptember();
      const banner = screen.getByText(/Closed by Dana on/).closest(".banner")!;
      expect(banner.querySelectorAll(".closed-line")).toHaveLength(1);
    });

    it("adds no second status: the missing-rate banner stays the page's one, and for a closed month it does not send anyone to Tariffs", async () => {
      await show(userFor("admin"), { "2026-09": closedSeptember() });
      await toSeptember();
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(screen.getByRole("status")).toHaveTextContent("Some consumption has no rate (shown as — or *). This month is closed, so a rate set now changes it only if the month is reopened.");
      expect(screen.queryByRole("link", { name: /Tariffs/ })).not.toBeInTheDocument();
    });

    it("shows nothing about closing for an open month", async () => {
      await show(userFor("admin"));
      await toSeptember();
      expect(screen.queryByText(/Closed by/)).not.toBeInTheDocument();
      expect(document.querySelector(".chip")).toBeNull();
      expect(screen.getByRole("link", { name: /Set a rate on the Tariffs page/ })).toBeInTheDocument();
    });

    it("downloads the closed month through the same URL (the server names the file)", async () => {
      await show(userFor("admin"), { "2026-09": closedSeptember() });
      await toSeptember();
      await userEvent.click(screen.getByRole("button", { name: "Download CSV" }));
      expect(downloadCsv).toHaveBeenCalledWith("/api/billing/costs.csv?month=2026-09");
    });

    describe("the line about today's figures", () => {
      const delta = () => document.querySelector(".live-delta");
      const showWith = async (live: BillingLive | null | undefined, closed: BillingClosed = CLOSED) => {
        await show(userFor("viewer"), { "2026-09": closedSeptember({ closed, live }) });
        await toSeptember();
      };

      it("is quiet and muted under the banner, with what today would give and the change", async () => {
        await showWith({ ...SAME, total_kwh: 80, total_cost: 16.5, delta_kwh: 30, delta_cost: 10.5, differs: true });
        expect(delta()).toHaveTextContent("Today's tree and rates would give 16.50 QAR (+10.50).");
        expect(delta()).toHaveClass("muted");
        expect(delta()).not.toHaveAttribute("role");
        expect(delta()!.previousElementSibling).toHaveClass("banner");
      });

      it("names the assets that differ when the totals agree", async () => {
        await showWith({ ...SAME, changed_assets: 2, differs: true });
        expect(delta()).toHaveTextContent("Today's tree and rates give the same total, but 2 assets differ.");
      });

      it("says there is no cost when today has no rate", async () => {
        await showWith({ ...SAME, total_cost: null, delta_cost: null, differs: true });
        expect(delta()).toHaveTextContent("Today's tree and rates would give no cost, because there is no rate today.");
      });

      it("says the kWh when only they differ", async () => {
        await showWith({ ...SAME, total_kwh: 62.5, delta_kwh: 12.5, differs: true });
        expect(delta()).toHaveTextContent("Today's tree and rates would give 62.5 kWh (+12.5).");
      });

      it("says the figures are the same when nothing differs, so the line is there either way", async () => {
        await showWith(SAME);
        expect(delta()).toHaveTextContent("Today's tree and rates give the same figures.");
        expect(delta()).toHaveClass("muted");
        expect(delta()).not.toHaveAttribute("role");
        expect(screen.getAllByRole("status")).toHaveLength(1); // still only the missing-rate banner
      });

      it.each([
        ["today's tree could not be priced (live is null)", null],
        ["the server sent no live part", undefined],
      ])("keeps an empty line, never 'the same figures', when %s", async (_why, live) => {
        await showWith(live);
        expect(delta()).not.toBeNull();
        expect(delta()!.textContent).toBe(""); // its room is the CSS min-height of 1lh
        expect(delta()!.previousElementSibling).toHaveClass("banner");
        expect(screen.queryByText(/same figures/)).not.toBeInTheDocument();
        expect(screen.getByText(/Closed by Dana/)).toBeInTheDocument();
      });

      it("keeps the one line in the page (same element, same place) when a later answer changes its words", async () => {
        let live: BillingLive | null = SAME;
        await show(userFor("viewer"), {}, {
          "GET /api/billing/costs": ({ url }) => {
            const month = new URL(url, "http://x").searchParams.get("month")!;
            return { body: month === "2026-09" ? closedSeptember({ live }) : costs };
          },
        });
        await toSeptember();
        const line = delta()!;
        const box = line.parentElement!;
        expect(line).toHaveTextContent("give the same figures");
        live = { ...SAME, total_kwh: 80, total_cost: 16.5, delta_kwh: 30, delta_cost: 10.5, differs: true };
        act(() => { document.dispatchEvent(new Event("visibilitychange", { bubbles: true })); }); // a refetch, as the 60 s poll would make
        await waitFor(() => expect(delta()).toHaveTextContent("would give 16.50 QAR (+10.50)"));
        expect(delta()).toBe(line);
        expect(line.parentElement).toBe(box);
        expect(box.children).toHaveLength(2); // the banner and the line: nothing was added or taken away
        live = null;
        act(() => { document.dispatchEvent(new Event("visibilitychange", { bubbles: true })); }); // a refetch, as the 60 s poll would make
        await waitFor(() => expect(delta()!.textContent).toBe(""));
        expect(box.children).toHaveLength(2);
      });

      it("words a currency change after the close with both currencies and no signed change (the page's currency is the one it was closed in)", async () => {
        await showWith({ ...SAME, total_cost: 14.5, delta_cost: null, differs: true, changed_assets: 3, currency: "EUR" });
        expect(delta()).toHaveTextContent("Today's tree and rates would give 14.50 EUR (closed in QAR), 3 assets differ.");
      });

      it("has no line on an open month", async () => {
        await show(userFor("viewer"));
        await toSeptember();
        expect(delta()).toBeNull();
      });
    });
  });

  describe("closing and reopening", () => {
    /** The server's side of a close and a reopen for September: the costs answer follows what was posted. */
    function server() {
      const state = { closed: false, note: "" };
      const routes: Routes = {
        "GET /api/billing/costs": ({ url }) => {
          const month = new URL(url, "http://x").searchParams.get("month")!;
          if (month !== "2026-09") return { body: costs };
          return { body: state.closed ? closedSeptember({ closed: { ...CLOSED, note: state.note } }) : september };
        },
        "POST /api/billing/months/2026-09/close": ({ body }) => { state.closed = true; state.note = (body as { note: string }).note; return { status: 201, body: {} }; },
        "POST /api/billing/months/2026-09/reopen": () => { state.closed = false; return { body: { month: "2026-09", reopened_at: "2026-10-15T10:00:00Z" } }; },
      };
      return { state, routes };
    }
    const heading = () => screen.getByRole("heading", { level: 1, name: "Billing" });

    it("Close month… opens the dialog; confirming posts the note, toasts, shows the closed month, and puts the focus on the page heading because the opener is gone", async () => {
      const { routes } = server();
      const toasts = spyToasts();
      const { calls } = await show(userFor("admin"), {}, routes, undefined, toasts.api);
      await toSeptember();
      await userEvent.click(screen.getByRole("button", { name: "Close month…" }));
      expect(screen.getByRole("dialog", { name: "Close September 2026" })).toBeInTheDocument();
      await userEvent.type(screen.getByRole("textbox", { name: "Note (optional)" }), "First official bill");
      await userEvent.click(screen.getByRole("button", { name: "Close month" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([["/api/billing/months/2026-09/close", { note: "First official bill" }]]);
      expect(toasts.calls).toEqual([{ kind: "success", text: "September 2026 closed" }]);
      expect(screen.getByText("Closed by Dana on Thu 15 Oct 2026.")).toBeInTheDocument(); // already read again when the dialog went
      expect(screen.getByRole("button", { name: "Reopen month…" })).toBeInTheDocument();
      expect(closeButton()).not.toBeInTheDocument();
      expect(heading()).toHaveFocus();
    });

    it("Reopen month… needs a reason, posts it, shows live figures again and puts the focus on the heading", async () => {
      const { routes, state } = server();
      state.closed = true;
      const toasts = spyToasts();
      const { calls } = await show(userFor("admin"), {}, routes, undefined, toasts.api);
      await toSeptember();
      await userEvent.click(await screen.findByRole("button", { name: "Reopen month…" }));
      await userEvent.type(screen.getByRole("textbox", { name: "Reason" }), "Meter fixed");
      await userEvent.click(screen.getByRole("button", { name: "Reopen month" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([["/api/billing/months/2026-09/reopen", { note: "Meter fixed" }]]);
      expect(toasts.calls).toEqual([{ kind: "success", text: "September 2026 reopened" }]);
      expect(screen.queryByText(/Closed by/)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Close month…" })).toBeInTheDocument();
      expect(heading()).toHaveFocus();
    });

    describe("the Reopen dialog says how far today's figures are from the billed ones, with the page's own sentence", () => {
      const DIFFERS: BillingLive = { ...SAME, total_kwh: 80, total_cost: 16.5, delta_kwh: 30, delta_cost: 10.5, differs: true, changed_assets: 2 };
      const openDialog = async (live: BillingLive | null, currency: string | null = "QAR") => {
        await show(userFor("admin"), { "2026-09": closedSeptember({ live, currency }) });
        await toSeptember();
        await userEvent.click(await screen.findByRole("button", { name: "Reopen month…" }));
        return screen.getByRole("dialog", { name: "Reopen September 2026" });
      };

      it("shows the difference in a second paragraph, the same words as the line behind it", async () => {
        const dialog = await openDialog(DIFFERS);
        const sentence = "Today's tree and rates would give 16.50 QAR (+10.50), 2 assets differ.";
        expect(within(dialog).getByText(sentence)).toHaveClass("month-extra");
        expect(document.querySelector(".live-delta")).toHaveTextContent(sentence);
        expect(dialog).toHaveTextContent("download the CSV first if you need them");
      });

      it("says today's tree cannot be priced when the server could not", async () => {
        const dialog = await openDialog(null);
        expect(within(dialog).getByText("Today's tree and rates cannot be priced right now.")).toHaveClass("month-extra");
      });

      it("uses the currency the month was closed in for a currency change", async () => {
        const dialog = await openDialog({ ...DIFFERS, delta_cost: null, currency: "EUR", changed_assets: 0 });
        expect(within(dialog).getByText("Today's tree and rates would give 16.50 EUR (closed in QAR).")).toBeInTheDocument();
      });

      it("adds nothing when the figures are the same", async () => {
        const dialog = await openDialog(SAME);
        expect(dialog.querySelector(".month-extra")).toBeNull();
      });

      it("keeps what it said at the click when the page behind refetches, and while the reopen turns the month open", async () => {
        let live: BillingLive | null = DIFFERS;
        await show(userFor("admin"), {}, {
          "GET /api/billing/costs": ({ url }) => {
            const month = new URL(url, "http://x").searchParams.get("month")!;
            return { body: month === "2026-09" ? closedSeptember({ live }) : costs };
          },
        });
        await toSeptember();
        await userEvent.click(await screen.findByRole("button", { name: "Reopen month…" }));
        const dialog = screen.getByRole("dialog");
        const extra = dialog.querySelector(".month-extra")!;
        expect(extra).toHaveTextContent("16.50 QAR (+10.50)");
        live = SAME;
        act(() => { document.dispatchEvent(new Event("visibilitychange", { bubbles: true })); });
        await waitFor(() => expect(document.querySelector(".live-delta")).toHaveTextContent("give the same figures"));
        expect(dialog.querySelector(".month-extra")).toBe(extra); // not removed, not reworded: the dialog does not move under the person
        expect(extra).toHaveTextContent("16.50 QAR (+10.50)");
      });
    });

    it("a refusal stays in the dialog; Cancel then gives the focus back to the opener, which is still there", async () => {
      const { routes } = server();
      await show(userFor("admin"), {}, {
        ...routes, "POST /api/billing/months/2026-09/close": { status: 409, body: { detail: "that month is not over yet" } },
      });
      await toSeptember();
      const opener = screen.getByRole("button", { name: "Close month…" });
      await userEvent.click(opener);
      await userEvent.click(screen.getByRole("button", { name: "Close month" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("that month is not over yet");
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
      expect(heading()).not.toHaveFocus();
    });

    it("Escape closes the dialog only, and the focus goes back to the opener", async () => {
      const { routes } = server();
      await show(userFor("admin"), {}, routes);
      await toSeptember();
      const opener = screen.getByRole("button", { name: "Close month…" });
      await userEvent.click(opener);
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByText("September 2026")).toBeInTheDocument();
      expect(opener).toHaveFocus();
    });
  });
});

describe("BillingPage folding and filtering", () => {
  const KEY = "dcdash.billingFolded";
  /** 70 rows in tree order, depth 3: Site > 4 halls > 4 racks each > 3 feeds each, and a second root, Spare. Every cost is priced (no banner). */
  const big = (): BillingCosts => {
    const assets: BillingAssetRow[] = [];
    const add = (parent: number | null, name: string): number => {
      const id = assets.length + 1;
      assets.push({
        asset_id: id, parent_id: parent, name, path: name, rate_per_kwh: 0.12,
        days: [fig(id, id * 0.12), fig(id + 1, (id + 1) * 0.12), fig(id + 2, (id + 2) * 0.12)],
        total: fig(id * 3 + 3, (id * 3 + 3) * 0.12),
      });
      return id;
    };
    const site = add(null, "Site");
    for (let h = 1; h <= 4; h++) {
      const hall = add(site, `Hall ${h}`);
      for (let r = 1; r <= 4; r++) {
        const rack = add(hall, `Rack ${h}.${r}`);
        for (let f = 1; f <= 3; f++) add(rack, `Feed ${h}.${r}.${f}`);
      }
    }
    add(null, "Spare");
    return { ...costs, assets };
  };
  /** The names on the screen, in order. */
  const rowNames = () => Array.from(document.querySelectorAll("tbody th[scope='row'] .bill-label")).map((el) => el.textContent);
  const line = () => document.querySelector(".tools-count")!.textContent;
  const filterBox = () => screen.getByRole("searchbox", { name: "Filter assets" });
  const levels = () => screen.getByRole("combobox", { name: "Show levels" });
  const collapseAll = () => screen.getByRole("button", { name: "Collapse all" });
  const expandAll = () => screen.getByRole("button", { name: "Expand all" });
  const twisty = (name: string, below: number, open = true) =>
    screen.getByRole("button", { name: `${open ? "Collapse" : "Expand"} ${name}, ${below} ${below === 1 ? "row" : "rows"} below` });
  const showBig = async (stored?: string) => {
    if (stored !== undefined) localStorage.setItem(KEY, stored);
    open("viewer", { body: big() });
    await screen.findByRole("rowheader", { name: "Site" });
  };

  describe("the first look", () => {
    it("opens a long month folded to the deepest level that keeps 60 rows or fewer, and a visit writes nothing", async () => {
      await showBig();
      expect(big().assets).toHaveLength(70);
      expect(rowNames()).toHaveLength(22);
      expect(rowNames().slice(0, 3)).toEqual(["Site", "Hall 1", "Rack 1.1"]);
      expect(rowNames().at(-1)).toBe("Spare");
      expect(line()).toBe("Showing 22 of 70 rows");
      expect(levels()).toHaveValue("3");
      expect(screen.queryByRole("rowheader", { name: "Feed 1.1.1" })).not.toBeInTheDocument();
      expect(twisty("Rack 1.1", 3, false)).toHaveAttribute("aria-expanded", "false");
      expect(localStorage.getItem(KEY)).toBeNull();
    });

    it("opens a short month with every row, and writes nothing either", async () => {
      open();
      await screen.findByRole("rowheader", { name: "Site" });
      expect(rowNames()).toEqual(["Site", "MV2", "LV Panel 1", "Spare", "Annex"]);
      expect(line()).toBe("All 5 rows shown");
      expect(levels()).toHaveValue("all");
      expect(Array.from(levels().querySelectorAll("option")).map((o) => o.textContent)).toEqual(["1", "2", "All"]);
      expect(localStorage.getItem(KEY)).toBeNull();
    });

    it("keeps the row header's name the asset's name, with the twisty inside it", async () => {
      open();
      const header = await screen.findByRole("rowheader", { name: "Site" });
      expect(within(header).getByRole("button", { name: "Collapse Site, 3 rows below" })).toBeInTheDocument();
      expect(header).toHaveAttribute("title", "Site");
      expect(header.style.paddingLeft).toBe("8px");
      expect(screen.getByRole("rowheader", { name: "LV Panel 1" }).style.paddingLeft).toBe("40px");
    });

    it("gives a twisty only to a row that has rows below it", async () => {
      open();
      await screen.findByRole("rowheader", { name: "Site" });
      expect(Array.from(document.querySelectorAll("tbody button.twisty")).map((b) => b.getAttribute("aria-label")))
        .toEqual(["Collapse Site, 3 rows below", "Collapse MV2, 1 row below"]);
      expect(within(screen.getByRole("rowheader", { name: "Annex" })).queryByRole("button")).not.toBeInTheDocument();
    });
  });

  describe("a twisty", () => {
    it("folds its branch, keeps the focus on the same button and leaves the parent's figures as they were", async () => {
      open();
      await screen.findByRole("rowheader", { name: "Site" });
      const before = cellsOf("Site");
      const button = twisty("Site", 3);
      expect(button).toHaveAttribute("aria-expanded", "true");
      await userEvent.click(button);
      expect(twisty("Site", 3, false)).toBe(button);
      expect(button).toHaveAttribute("aria-expanded", "false");
      expect(document.activeElement).toBe(button);
      expect(rowNames()).toEqual(["Site", "Annex"]);
      expect(screen.queryByRole("rowheader", { name: "MV2" })).not.toBeInTheDocument(); // removed, not hidden
      expect(document.querySelectorAll("tbody tr")).toHaveLength(2);
      expect(cellsOf("Site")).toEqual(before);
      expect(line()).toBe("Showing 2 of 5 rows");
      await userEvent.click(button);
      expect(twisty("Site", 3)).toBe(button);
      expect(document.activeElement).toBe(button);
      expect(rowNames()).toHaveLength(5);
      expect(line()).toBe("All 5 rows shown");
    });

    it("answers Enter and Space, and the focus stays", async () => {
      open();
      await screen.findByRole("rowheader", { name: "Site" });
      const button = twisty("MV2", 1);
      button.focus();
      await userEvent.keyboard("{Enter}");
      expect(button).toHaveAttribute("aria-expanded", "false");
      expect(button).toHaveFocus();
      expect(rowNames()).toEqual(["Site", "MV2", "Spare", "Annex"]);
      await userEvent.keyboard(" ");
      expect(button).toHaveAttribute("aria-expanded", "true");
      expect(button).toHaveFocus();
      expect(rowNames()).toHaveLength(5);
    });

    it("the fold of one branch leaves the figures of every row on screen alone (a month of 70 rows)", async () => {
      await showBig();
      const before = ["Site", "Hall 2", "Spare"].map(cellsOf);
      await userEvent.click(twisty("Hall 2", 16));
      expect(["Site", "Hall 2", "Spare"].map(cellsOf)).toEqual(before);
      expect(rowNames()).toHaveLength(18);
      expect(line()).toBe("Showing 18 of 70 rows");
    });
  });

  describe("Collapse all, Expand all and Show levels", () => {
    it("Collapse all shows the top level, Expand all shows everything, and the select follows", async () => {
      await showBig();
      await userEvent.click(collapseAll());
      expect(rowNames()).toEqual(["Site", "Spare"]);
      expect(line()).toBe("Showing 2 of 70 rows");
      expect(levels()).toHaveValue("1");
      expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(21); // Site, 4 halls, 16 racks
      await userEvent.click(expandAll());
      expect(rowNames()).toHaveLength(70);
      expect(line()).toBe("All 70 rows shown");
      expect(levels()).toHaveValue("all");
      expect(localStorage.getItem(KEY)).toBe("none");
    });

    it("Show levels folds to that level, and a manual change after it reads Custom until a level is chosen again", async () => {
      await showBig();
      expect(Array.from(levels().querySelectorAll("option")).map((o) => o.textContent)).toEqual(["1", "2", "3", "All"]);
      await userEvent.selectOptions(levels(), "2");
      expect(rowNames()).toEqual(["Site", "Hall 1", "Hall 2", "Hall 3", "Hall 4", "Spare"]);
      expect(levels()).toHaveValue("2");
      expect(within(levels()).queryByRole("option", { name: "Custom" })).not.toBeInTheDocument();
      await userEvent.click(twisty("Hall 1", 16, false));
      expect(rowNames()).toHaveLength(10); // Hall 1 opens one level: its four racks, still folded
      expect(levels()).toHaveValue("custom");
      expect(within(levels()).getByRole("option", { name: "Custom" })).toBeDisabled();
      await userEvent.selectOptions(levels(), "All");
      expect(rowNames()).toHaveLength(70);
      expect(levels()).toHaveValue("all");
      expect(within(levels()).queryByRole("option", { name: "Custom" })).not.toBeInTheDocument();
      await userEvent.selectOptions(levels(), "3");
      expect(rowNames()).toHaveLength(22);
      expect(levels()).toHaveValue("3");
    });
  });

  describe("the filter", () => {
    it("shows the matching rows with the rows above them, says how many match, and has no twisty to tab to", async () => {
      await showBig();
      await userEvent.type(filterBox(), "rack 3.");
      await waitFor(() => expect(line()).toBe("4 of 70 rows match"));
      expect(rowNames()).toEqual(["Site", "Hall 3", "Rack 3.1", "Rack 3.2", "Rack 3.3", "Rack 3.4"]);
      expect(screen.getByText("Site")).toHaveClass("bill-label", "is-context");
      expect(screen.getByText("Hall 3")).toHaveClass("is-context");
      expect(screen.getByText("Rack 3.1")).not.toHaveClass("is-context");
      expect(document.querySelectorAll("tbody button.twisty")).toHaveLength(0);
      const site = screen.getByRole("rowheader", { name: "Site" });
      expect(site.querySelector(".bill-caret")).toHaveAttribute("aria-hidden", "true");
      expect(screen.getByRole("rowheader", { name: "Rack 3.1" }).querySelector(".bill-caret")).toBeNull();
    });

    it("turns Collapse all, Expand all and Show levels off while there is text, and back on after", async () => {
      await showBig();
      await userEvent.type(filterBox(), "hall");
      expect(collapseAll()).toBeDisabled();
      expect(expandAll()).toBeDisabled();
      expect(levels()).toBeDisabled();
      await userEvent.clear(filterBox());
      expect(collapseAll()).toBeEnabled();
      expect(expandAll()).toBeEnabled();
      expect(levels()).toBeEnabled();
    });

    it("Escape clears the text and the focus stays in the box", async () => {
      await showBig();
      await userEvent.type(filterBox(), "hall");
      await waitFor(() => expect(line()).toBe("4 of 70 rows match"));
      await userEvent.keyboard("{Escape}");
      expect(filterBox()).toHaveValue("");
      expect(filterBox()).toHaveFocus();
      await waitFor(() => expect(line()).toBe("Showing 22 of 70 rows"));
      expect(rowNames()).toHaveLength(22);
    });

    it("Clear filter appears only with text, clears it and puts the focus in the box", async () => {
      await showBig();
      expect(screen.queryByRole("button", { name: "Clear filter" })).not.toBeInTheDocument();
      await userEvent.type(filterBox(), "hall");
      await userEvent.click(screen.getByRole("button", { name: "Clear filter" }));
      expect(filterBox()).toHaveValue("");
      expect(filterBox()).toHaveFocus();
      expect(screen.queryByRole("button", { name: "Clear filter" })).not.toBeInTheDocument();
      await waitFor(() => expect(rowNames()).toHaveLength(22));
    });

    it("a filter that matches nothing shows one row that says so, under the header", async () => {
      await showBig();
      await userEvent.type(filterBox(), "xyz");
      expect(await screen.findByText('No assets match "xyz".')).toBeInTheDocument();
      expect(line()).toBe("No rows match");
      expect(screen.queryAllByRole("rowheader")).toHaveLength(0);
      const body = document.querySelectorAll("tbody tr");
      expect(body).toHaveLength(1);
      const cell = body[0].querySelector("td")!;
      expect(body[0].querySelectorAll("td")).toHaveLength(1);
      expect(cell.colSpan).toBe(6); // Asset, Rate, Month total and the three days
      expect(cell.querySelector(".bill-nomatch")).toHaveTextContent('No assets match "xyz".');
      expect(screen.getByRole("columnheader", { name: "Month total" })).toBeInTheDocument();
    });

    it("finds a row inside a branch that was folded, and the fold is back after the text is cleared", async () => {
      await showBig();
      await userEvent.type(filterBox(), "Feed 1.1.1");
      await waitFor(() => expect(line()).toBe("1 of 70 rows match"));
      expect(rowNames()).toEqual(["Site", "Hall 1", "Rack 1.1", "Feed 1.1.1"]);
      await userEvent.clear(filterBox());
      await waitFor(() => expect(rowNames()).toHaveLength(22));
      expect(twisty("Rack 1.1", 3, false)).toBeInTheDocument();
      expect(screen.queryByRole("rowheader", { name: "Feed 1.1.1" })).not.toBeInTheDocument();
      expect(localStorage.getItem(KEY)).toBeNull(); // filtering is not remembered and does not touch the fold
    });

    it("matches the name only, never the path, and ignores case", async () => {
      const month = big();
      month.assets = month.assets.map((a) => (a.name === "Spare" ? { ...a, path: "Site / Hall 1 / Spare" } : a));
      mockFetch(routes("viewer", { body: month }, "Asia/Qatar", { body: { first_month: null } }));
      renderWithProviders(<BillingPage />, { route: "/billing", path: "/billing" });
      await screen.findByRole("rowheader", { name: "Site" });
      await userEvent.type(filterBox(), "hall 1 /");
      expect(await screen.findByText('No assets match "hall 1 /".')).toBeInTheDocument();
      await userEvent.clear(filterBox());
      await userEvent.type(filterBox(), "SPARE");
      await waitFor(() => expect(rowNames()).toEqual(["Spare"]));
    });

    it("sets the scroll box back to the top when the text changes, and not when a branch folds", async () => {
      await showBig();
      const box = document.querySelector<HTMLElement>(".table-scroll")!;
      Object.defineProperty(box, "scrollTop", { value: 300, writable: true, configurable: true });
      await userEvent.click(twisty("Hall 1", 16));
      expect(box.scrollTop).toBe(300);
      await userEvent.type(filterBox(), "r");
      await waitFor(() => expect(box.scrollTop).toBe(0));
    });
  });

  describe("the remembered fold", () => {
    it("is written under dcdash.billingFolded after a click and read again on the next visit", async () => {
      open();
      await screen.findByRole("rowheader", { name: "Site" });
      await userEvent.click(twisty("Site", 3));
      expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([1]);
      cleanup();
      open();
      expect(await screen.findByRole("button", { name: "Expand Site, 3 rows below" })).toBeInTheDocument();
      expect(rowNames()).toEqual(["Site", "Annex"]);
    });

    it("a stored fold beats the size default, and ids that are not in the month are ignored", async () => {
      await showBig("[2, 9999]");
      expect(rowNames()).toHaveLength(54); // only Hall 1 is folded: 70 - 16
      expect(line()).toBe("Showing 54 of 70 rows");
      expect(levels()).toHaveValue("custom");
    });

    it("a stored 'none' opens a long month fully", async () => {
      await showBig("none");
      expect(rowNames()).toHaveLength(70);
      expect(line()).toBe("All 70 rows shown");
      expect(levels()).toHaveValue("all");
    });

    it("a stored [] (what the Assets Tree used to write on every visit) is the same as nothing: the size default", async () => {
      await showBig("[]");
      expect(rowNames()).toHaveLength(22);
      expect(line()).toBe("Showing 22 of 70 rows");
    });

    it("a stored value that is junk is the same as nothing", async () => {
      await showBig("{not json");
      expect(rowNames()).toHaveLength(22);
    });

    it("a month change keeps the fold and the text of the filter, and the bar comes back with them", async () => {
      open("viewer", { body: big() });
      await screen.findByRole("rowheader", { name: "Site" });
      await userEvent.click(collapseAll());
      await userEvent.type(filterBox(), "Hall 2");
      await waitFor(() => expect(line()).toBe("1 of 70 rows match"));
      const held = holdFetch((_method, path) => path === "/api/billing/costs");
      await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
      expect(await screen.findByText("September 2026")).toBeInTheDocument();
      expect(screen.getByText("Loading billing")).toBeInTheDocument();
      held.release();
      await screen.findByRole("rowheader", { name: "Hall 2" });
      expect(filterBox()).toHaveValue("Hall 2");
      expect(rowNames()).toEqual(["Site", "Hall 2"]);
      await userEvent.clear(filterBox());
      await waitFor(() => expect(rowNames()).toEqual(["Site", "Spare"]));
      expect(line()).toBe("Showing 2 of 70 rows");
    });
  });

  describe("the bar's room", () => {
    it("is held by an inert copy while the costs load, outside the skeleton, and the real bar replaces it", async () => {
      const held = open("viewer", { body: big() }, "Asia/Qatar", { body: { first_month: null } }, (_method, path) => path === "/api/billing/costs");
      expect(await screen.findByText("October 2026")).toBeInTheDocument();
      const idle = document.querySelector(".billing-tools")!;
      expect(idle).toHaveClass("is-idle");
      expect(idle).toHaveAttribute("inert");
      expect(idle).toHaveAttribute("aria-hidden", "true");
      expect(screen.queryByRole("button", { name: "Collapse all" })).not.toBeInTheDocument();
      expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
      expect(screen.getByText("Loading billing").parentElement!.querySelector(".billing-tools")).toBeNull();
      expect(idle.parentElement).toHaveClass("billing-toolbar"); // beside the month bar, in the toolbar
      held.release();
      expect(await screen.findByRole("button", { name: "Collapse all" })).toBeInTheDocument();
      expect(document.querySelectorAll(".billing-tools")).toHaveLength(1);
      expect(document.querySelector(".billing-tools")).toBe(idle); // one slot: the real bar is the same element, so nothing moves
      expect(document.querySelector(".billing-tools.is-idle")).toBeNull();
      expect(document.querySelector(".billing-tools")).not.toHaveAttribute("inert");
    });

    it("is held while the site is unknown too, and it is gone when the site cannot be read", async () => {
      const held = open("viewer", { body: big() }, "Asia/Qatar", { body: { first_month: null } }, (_method, path) => path === "/api/site");
      await waitFor(() => expect(document.querySelector(".billing-tools.is-idle")).not.toBeNull());
      held.release();
      expect(await screen.findByRole("button", { name: "Collapse all" })).toBeInTheDocument();
      cleanup();
      mockFetch({ ...routes("viewer", { body: costs }, "Asia/Qatar", { body: { first_month: null } }), "GET /api/site": { status: 500, body: { detail: "no site" } } });
      renderWithProviders(<BillingPage />, { route: "/billing", path: "/billing" });
      expect(await screen.findByText("no site")).toBeInTheDocument();
      expect(document.querySelector(".billing-tools")).toBeNull();
    });

    it("is held while the costs fail to load, beside the month bar, above the error", async () => {
      open("viewer", { status: 500, body: { detail: "costs are down" } });
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("costs are down");
      const idle = document.querySelector(".billing-tools.is-idle")!;
      expect(idle.previousElementSibling).toHaveClass("billing-bar");
      expect(idle.parentElement).toHaveClass("billing-toolbar");
      expect(idle.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Collapse all" })).not.toBeInTheDocument();
    });

    it("is held, inert, above the empty states", async () => {
      open("viewer", { body: { ...costs, assets: [] } });
      const empty = (await screen.findByText("No assets yet.")).closest(".empty")!;
      const idle = document.querySelector(".billing-tools.is-idle")!;
      expect(idle).not.toBeNull();
      expect(idle.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
      cleanup();
      const none = costs.assets.map((a) => ({ ...a, days: a.days.map(() => null), total: null }));
      open("viewer", { body: { ...costs, assets: none } });
      const quiet = (await screen.findByText("No energy data for this month.")).closest(".empty")!;
      expect(document.querySelectorAll(".billing-tools.is-idle")).toHaveLength(1);
      expect(document.querySelector(".billing-tools")!.compareDocumentPosition(quiet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe("the toolbar", () => {
    const toolbar = () => document.querySelector(".billing-toolbar")!;
    const tip = () => screen.getByRole("button", { name: "What does this mean?" });
    const previous = () => screen.getByRole("button", { name: "Previous month" });
    const nextMonth = () => screen.getByRole("button", { name: "Next month" });
    /** The page on the current month with the five-row costs, and the table drawn. */
    const shown = async (role = "viewer") => {
      open(role);
      await screen.findByRole("rowheader", { name: "Site" });
    };
    /** Tab from `from` through `count` stops and return what was focused at each. */
    const tabFrom = async (from: HTMLElement, count: number) => {
      from.focus();
      const seen: Element[] = [];
      for (let i = 0; i < count; i++) {
        await userEvent.tab();
        seen.push(document.activeElement!);
      }
      return seen;
    };

    it("puts the month bar and the controls bar in one toolbar, the month group first", async () => {
      await shown("admin");
      expect(Array.from(toolbar().children).map((el) => el.className)).toEqual(["row billing-bar", "billing-tools"]);
      const main = document.querySelectorAll(".billing-main");
      expect(main).toHaveLength(1);
      expect(main[0].contains(toolbar())).toBe(true);
      expect(main[0].contains(document.querySelector("table.billing"))).toBe(true);
      expect(main[0].parentElement).toHaveClass("billing-page");
      // the dialogs are siblings after the content, never inside the size container
      await userEvent.click(previous());
      await screen.findByText("September 2026");
      await userEvent.click(await screen.findByRole("button", { name: "Close month…" }));
      const dialog = screen.getByRole("dialog", { name: "Close September 2026" });
      expect(main[0].contains(dialog)).toBe(false);
    });

    it("Tab walks the month group, then the table group", async () => {
      await shown();
      // On the current month Next month is natively disabled, so Tab skips it.
      expect(nextMonth()).toBeDisabled();
      expect(await tabFrom(previous(), 7)).toEqual([yearSelect(), monthSelect(), filterBox(), collapseAll(), expandAll(), levels(), tip()]);
      await userEvent.click(previous());
      await screen.findByText("September 2026");
      await screen.findByRole("rowheader", { name: "Site" });
      expect(nextMonth()).toBeEnabled();
      expect(await tabFrom(previous(), 8)).toEqual([nextMonth(), yearSelect(), monthSelect(), filterBox(), collapseAll(), expandAll(), levels(), tip()]);
    });

    it("the rows line is a polite live region inside the table's caption, without a role", async () => {
      await shown();
      const count = document.querySelector(".tools-count")!;
      expect(document.querySelectorAll(".tools-count")).toHaveLength(1);
      expect(count.closest("table.billing caption")).not.toBeNull();
      expect(count.closest(".billing-tools")).toBeNull();
      expect(count).toHaveAttribute("aria-live", "polite");
      expect(count).not.toHaveAttribute("role");
      expect(count).toHaveTextContent("All 5 rows shown");
      await userEvent.type(filterBox(), "ann");
      await waitFor(() => expect(count).toHaveTextContent("1 of 5 rows match"));
      expect(document.querySelector(".tools-count")).toBe(count); // the same element, so the one change is spoken once
    });

    it("names the table by the how-to-read sentence only", async () => {
      await shown();
      const sentence = /^Each cell shows kWh above and cost in QAR below\.$/;
      const table = screen.getByRole("table", { name: sentence });
      expect(table).toHaveAttribute("aria-labelledby");
      expect(table.querySelector("caption .cap-text")?.id).toBe(table.getAttribute("aria-labelledby"));
      await userEvent.type(filterBox(), "ann");
      await waitFor(() => expect(document.querySelector(".tools-count")).toHaveTextContent("1 of 5 rows match"));
      expect(screen.getByRole("table", { name: sentence })).toBe(table);
      expect(screen.queryByRole("table", { name: /match/ })).not.toBeInTheDocument();
    });

    it("shows no second bar for the empty states: the toolbar's one inert copy, before the empty answer", async () => {
      open("viewer", { body: { ...costs, assets: [] } });
      let empty = (await screen.findByText("No assets yet.")).closest(".empty")!;
      expect(document.querySelectorAll(".billing-tools")).toHaveLength(1);
      expect(document.querySelector(".billing-tools")).toHaveClass("is-idle");
      expect(document.querySelector(".billing-tools")!.parentElement).toBe(toolbar());
      expect(toolbar().compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(document.querySelector(".tools-count")).toBeNull();
      cleanup();
      const none = costs.assets.map((a) => ({ ...a, days: a.days.map(() => null), total: null }));
      open("viewer", { body: { ...costs, assets: none } });
      empty = (await screen.findByText("No energy data for this month.")).closest(".empty")!;
      expect(document.querySelectorAll(".billing-tools")).toHaveLength(1);
      expect(document.querySelector(".billing-tools")).toHaveClass("is-idle");
      expect(toolbar().compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(document.querySelector(".tools-count")).toBeNull();
    });

    it("keeps the order for a closed month: toolbar, the closed box, then the table", async () => {
      const closed: BillingClosed = { id: 7, closed_name: "Dana", closed_at: "2026-10-14T21:30:00Z", note: "", total_kwh: 50, total_cost: 6 };
      open("viewer", { body: { ...costs, closed, live: null } });
      const box = (await screen.findByText(/Closed by Dana/)).closest(".closed-box")!;
      expect(toolbar().compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(box.compareDocumentPosition(document.querySelector(".table-scroll")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe("the rest of the page", () => {
    it("exports the same file whatever is folded or filtered", async () => {
      await showBig();
      await userEvent.click(collapseAll());
      await userEvent.type(filterBox(), "Hall");
      await userEvent.click(await screen.findByRole("button", { name: "Download CSV" }));
      expect(downloadCsv).toHaveBeenCalledTimes(1);
      expect(downloadCsv).toHaveBeenCalledWith("/api/billing/costs.csv?month=2026-10");
    });

    it("keeps the toolbar first, then the missing-rate banner, then the table, and the page's one primary button", async () => {
      open("admin");
      await screen.findByRole("rowheader", { name: "Annex" });
      const banner = screen.getByRole("status");
      const bar = document.querySelector(".billing-tools")!;
      expect(bar.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(banner.compareDocumentPosition(document.querySelector(".table-scroll")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(document.querySelectorAll(".primary")).toHaveLength(1);
      expect(screen.getAllByRole("status")).toHaveLength(1); // the rows line is a polite live region of its own, not a status
      expect(document.querySelector(".tools-count")).toHaveAttribute("aria-live", "polite");
      expect(document.querySelector(".tools-count")).not.toHaveAttribute("role");
    });

    it("tabs through the bar in its order: filter, Collapse all, Expand all, Show levels, the tip; with text: filter, Clear filter, the tip", async () => {
      await showBig();
      filterBox().focus();
      const seen: Element[] = [];
      for (let i = 0; i < 4; i++) {
        await userEvent.tab();
        seen.push(document.activeElement!);
      }
      const tip = screen.getByRole("button", { name: "What does this mean?" });
      expect(seen).toEqual([collapseAll(), expandAll(), levels(), tip]);
      await userEvent.type(filterBox(), "rack");
      expect(filterBox()).toHaveFocus();
      await userEvent.tab();
      expect(screen.getByRole("button", { name: "Clear filter" })).toHaveFocus();
      await userEvent.tab();
      expect(tip).toHaveFocus(); // the three disabled controls are skipped
    });

    it("explains the folded totals in the tip's bubble", async () => {
      await showBig();
      await userEvent.click(screen.getByRole("button", { name: "What does this mean?" }));
      expect(screen.getByRole("note")).toHaveTextContent("A folded row still shows its own totals, which already include everything below it.");
    });
  });
});
