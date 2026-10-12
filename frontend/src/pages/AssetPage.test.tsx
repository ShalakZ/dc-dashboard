import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { useAssets } from "../api/queries";
import { PARTIAL_TIP } from "../components/Figure";
import { formatSiteClock } from "../lib/siteTime";
import { mockFetch } from "../test/fetchMock";
import { iconHtml } from "../test/iconHtml";
import { renderWithProviders } from "../test/render";
import { AssetPage } from "./AssetPage";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.last = this; }
  close() { this.closed = true; }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent); }
}

/** `cost` defaults to what the API sends for the energy figure: both are null together and share `no_data` (API reference section 5). */
const summary = (energy: unknown, cost?: unknown) => ({
  asset: { id: 4, name: "Panel 1", parent_id: 3, kind: "panel" },
  metrics: [
    { mapping_id: 1, point_id: 7, metric: "active_power_kw", unit: "kW", value: 10.5, ts: "2026-10-07T10:00:00+00:00", quality: 0 },
    { mapping_id: 2, point_id: 8, metric: "voltage_v", unit: "V", value: null, ts: null, quality: null },
  ],
  energy_today: energy,
  cost_today: cost !== undefined ? cost : energy === null
    ? null
    : { cost: null, estimated: false, partial: false, no_data: (energy as { no_data: boolean }).no_data },
  currency: "QAR",
});
/** The asset list the crumb trail and the sub line read: Panel 1 (id 4) sits under MV2 / Hall 1 and has two sub-assets. */
const family = [
  { id: 1, parent_id: null, name: "MV2", kind: "site", sort_order: 0 },
  { id: 3, parent_id: 1, name: "Hall 1", kind: "room", sort_order: 0 },
  { id: 4, parent_id: 3, name: "Panel 1", kind: "panel", sort_order: 0 },
  { id: 5, parent_id: 4, name: "Rack A", kind: "rack", sort_order: 0 },
  { id: 6, parent_id: 4, name: "Rack B", kind: "rack", sort_order: 1 },
];
const routes = (energy: unknown, cost?: unknown) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "v", role: "viewer" } },
  "GET /api/site": { body: { timezone: "Asia/Qatar", currency: "QAR" } },
  "GET /api/assets": { body: family },
  "GET /api/assets/4/summary": { body: summary(energy, cost) },
  "GET /api/assets/4/series": { body: { metric: "active_power_kw", unit: "kW", points: [] } },
});

beforeEach(() => {
  FakeEventSource.last = null;
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("AssetPage", () => {
  it("renders live value from stream and dash for null", async () => {
    mockFetch(routes({ kwh: 3.25, estimated: false, no_data: false }));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    expect(await screen.findByRole("heading", { name: "Panel 1" })).toBeInTheDocument();
    expect(screen.getByText("10.50")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(FakeEventSource.last?.url).toBe("/api/stream");
    act(() => FakeEventSource.last!.emit([[7, Date.now() / 1000, 11.25, 0], [99, 1, 1, 0]]));
    expect(screen.getByText("11.25")).toBeInTheDocument();
    act(() => FakeEventSource.last!.emit([[7, Date.now() / 1000, null, 1]]));
    expect(screen.queryByText("11.25")).not.toBeInTheDocument();
    expect(screen.queryByText("10.50")).not.toBeInTheDocument();
    expect(screen.getByText("— kW")).toBeInTheDocument();
    expect(screen.getByText("bad quality")).toBeInTheDocument();
  });

  it("shows the stream's epoch timestamp as a current time, not 1970", async () => {
    mockFetch(routes(null));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    await screen.findByRole("heading", { name: "Panel 1" });
    const now = new Date(2026, 9, 7, 13, 45, 30);
    act(() => FakeEventSource.last!.emit([[7, now.getTime() / 1000, 11.25, 0]]));
    // findBy: the site zone is fetched when the table mounts, so the clock appears a moment after the heading.
    expect(await screen.findByText(formatSiteClock(now.toISOString(), "Asia/Qatar"))).toBeInTheDocument();
    expect(screen.queryByText(formatSiteClock(new Date(0).toISOString(), "Asia/Qatar"))).not.toBeInTheDocument();
  });

  describe("the Updated column follows the site zone", () => {
    const stamped = (ts: string) => ({
      "GET /api/assets/4/summary": { body: { ...summary(null), metrics: [{ ...summary(null).metrics[0], ts }] } },
    });
    const updatedCell = async () => within(await screen.findByRole("row", { name: /^active_power_kw / })).getAllByRole("cell")[3];

    it("prints the reading's time on the wall clock of the zone GET /api/site reports", async () => {
      mockFetch({ ...routes(null), ...stamped("2026-10-07T10:00:05+00:00") });
      renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
      const cell = await updatedCell();
      await waitFor(() => expect(cell).toHaveTextContent(/^13:00:05$/)); // Asia/Qatar is UTC+3
    });

    it("shows a dash, not a time in the browser's zone, when the site zone cannot be read", async () => {
      const calls = mockFetch({ ...routes(null), ...stamped("2026-10-07T10:00:05+00:00"), "GET /api/site": { status: 500, body: { detail: "site unavailable" } } });
      renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
      const cell = await updatedCell();
      await waitFor(() => expect(calls.some((c) => c.path === "/api/site")).toBe(true));
      expect(cell).toHaveTextContent(/^—$/);
    });
  });

  describe("the page header: crumb trail, sub line and the id in the URL", () => {
    const where = () => screen.getByTestId("where").textContent;
    const Where = () => <span data-testid="where">{useLocation().pathname}</span>;
    /** The asset list's state as text, read from the page's own query: a test waits for it to leave "pending" before it asserts on the list's absence. */
    const ListState = () => <span data-testid="list-state">{useAssets().status}</span>;
    const listSettled = (state: "success" | "error") => waitFor(() => expect(screen.getByTestId("list-state")).toHaveTextContent(state));
    const crumbNames = (nav: Element) => [...nav.querySelectorAll("li > :not(.sep)")].map((el) => el.textContent);

    it("opens with a page header: the trail Assets / the asset's ancestors / the asset (a link each but the last), then the one h1", async () => {
      mockFetch(routes(null));
      renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
      const h1 = await screen.findByRole("heading", { name: "Panel 1", level: 1 });
      const head = h1.closest("header")!;
      expect(head).toHaveClass("page-head");
      const crumb = head.querySelector(".crumbs") as HTMLElement;
      expect(crumb.tagName).toBe("NAV");
      expect(crumb).toHaveAccessibleName("Breadcrumb");
      // The list arrives after the summary: until it does, the trail is Assets / Panel 1.
      await waitFor(() => expect(crumbNames(crumb)).toEqual(["Assets", "MV2", "Hall 1", "Panel 1"]));
      expect(within(crumb).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
        ["Assets", "/assets"], ["MV2", "/assets/1"], ["Hall 1", "/assets/3"],
      ]);
      expect(within(crumb).getByText("Panel 1")).toHaveAttribute("aria-current", "page");
      expect(within(crumb).queryByRole("link", { name: "Panel 1" })).not.toBeInTheDocument();
      expect(screen.getAllByRole("link")).toHaveLength(3);
      expect(screen.getAllByRole("navigation")).toHaveLength(1);
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    });

    it("goes to the asset or to the summary when a crumb is clicked", async () => {
      const hall = { ...summary(null), asset: { id: 3, name: "Hall 1", parent_id: 1, kind: "room" }, metrics: [] };
      mockFetch({ ...routes(null), "GET /api/assets/3/summary": { body: hall } });
      renderWithProviders(<><Routes><Route path="/assets/:id" element={<AssetPage />} /></Routes><Where /></>, { route: "/assets/4" });
      await userEvent.click(await screen.findByRole("link", { name: "Hall 1" }));
      expect(where()).toBe("/assets/3");
      const h1 = await screen.findByRole("heading", { name: "Hall 1", level: 1 });
      const crumb = h1.closest("header")!.querySelector(".crumbs") as HTMLElement;
      await waitFor(() => expect(crumbNames(crumb)).toEqual(["Assets", "MV2", "Hall 1"]));
      await userEvent.click(within(crumb).getByRole("link", { name: "Assets" }));
      expect(where()).toBe("/assets");
    });

    it.each([
      ["the list has not caught up with the asset (a create just now)", { body: [family[0]] }, "success"],
      ["the list is empty", { body: [] }, "success"],
      ["the list could not be read", { status: 500, body: { detail: "list unavailable" } }, "error"],
    ] as const)("keeps the asset itself in the trail when %s: Assets / the asset's name", async (_why, list, settled) => {
      mockFetch({ ...routes(null), "GET /api/assets": list });
      renderWithProviders(<><AssetPage /><ListState /></>, { route: "/assets/4", path: "/assets/:id" });
      const h1 = await screen.findByRole("heading", { name: "Panel 1", level: 1 });
      await listSettled(settled); // the answer is in, not just the summary
      const crumb = h1.closest("header")!.querySelector(".crumbs") as HTMLElement;
      expect(crumbNames(crumb)).toEqual(["Assets", "Panel 1"]);
      expect(within(crumb).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/assets"]);
      expect(within(crumb).getByText("Panel 1")).toHaveAttribute("aria-current", "page");
    });

    it("shows a root asset as Assets / the asset", async () => {
      const root = { ...summary(null), asset: { id: 1, name: "MV2", parent_id: null, kind: "site" } };
      mockFetch({ ...routes(null), "GET /api/assets/1/summary": { body: root } });
      renderWithProviders(<AssetPage />, { route: "/assets/1", path: "/assets/:id" });
      const h1 = await screen.findByRole("heading", { name: "MV2", level: 1 });
      const crumb = h1.closest("header")!.querySelector(".crumbs") as HTMLElement;
      await screen.findByText("site · 1 sub-asset"); // the list is in: the trail is final
      expect(crumbNames(crumb)).toEqual(["Assets", "MV2"]);
      expect(within(crumb).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/assets"]);
    });

    it("keeps a 46-character ancestor name whole in its crumb (the CSS wraps it)", async () => {
      const long = "Main medium-voltage switchgear, hall 2, bay 11";
      expect(long).toHaveLength(46);
      const list = family.map((a) => (a.id === 3 ? { ...a, name: long } : a));
      mockFetch({ ...routes(null), "GET /api/assets": { body: list } });
      renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
      const crumb = (await screen.findByRole("heading", { name: "Panel 1", level: 1 })).closest("header")!.querySelector(".crumbs") as HTMLElement;
      expect(await within(crumb).findByRole("link", { name: long })).toHaveAttribute("href", "/assets/3");
    });

    it("says what the asset is and how many sub-assets it has, in the header's sub line", async () => {
      mockFetch(routes(null));
      renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
      const sub = await screen.findByText("panel · 2 sub-assets");
      expect(sub.tagName).toBe("P");
      expect(sub).toHaveClass("sub");
      expect(sub.closest("header")).toHaveClass("page-head");
    });

    it.each([
      ["one sub-asset", [family[2], family[4]], "panel · 1 sub-asset"],
      ["no sub-asset", [family[2]], "panel · 0 sub-assets"],
    ])("counts the direct sub-assets only: %s", async (_name, list, text) => {
      mockFetch({ ...routes(null), "GET /api/assets": { body: list } });
      renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
      expect(await screen.findByText(text)).toBeInTheDocument();
    });

    it("counts a sub-asset's own children for the parent only, not the whole branch", async () => {
      const list = [...family, { id: 7, parent_id: 5, name: "Server 1", kind: "server", sort_order: 0 }];
      mockFetch({ ...routes(null), "GET /api/assets": { body: list } });
      renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
      expect(await screen.findByText("panel · 2 sub-assets")).toBeInTheDocument();
    });

    it.each([
      ["lacks the asset", { body: [] }, "success"],
      ["could not be read", { status: 500, body: { detail: "list unavailable" } }, "error"],
    ] as const)("shows the kind alone when the list %s: a count of 0 would be a guess", async (_why, list, settled) => {
      mockFetch({ ...routes(null), "GET /api/assets": list });
      renderWithProviders(<><AssetPage /><ListState /></>, { route: "/assets/4", path: "/assets/:id" });
      const sub = await screen.findByText("panel");
      await listSettled(settled);
      expect(sub).toHaveClass("sub");
      expect(screen.getByText("panel")).toBe(sub);
      expect(screen.queryByText(/sub-asset/)).not.toBeInTheDocument();
    });

    it.each(["abc", "12abc", "0", "007", "-1", "2147483648", "99999999999"])(
      "answers /assets/%s with 'Asset not found.' in the pane and sends no request for it",
      async (raw) => {
        const calls = mockFetch(routes(null));
        renderWithProviders(<AssetPage />, { route: `/assets/${raw}`, path: "/assets/:id" });
        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent(/^Asset not found\.$/);
        expect(alert).toHaveClass("error");
        expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
        expect(calls.filter((c) => c.path.startsWith("/api/assets") || c.path === "/api/stream")).toEqual([]);
        expect(FakeEventSource.last).toBeNull();
      },
    );

    it("answers an unknown asset (404) with the same sentence as an id that cannot be one, whatever the API's own text", async () => {
      mockFetch({ ...routes(null), "GET /api/assets/4/summary": { status: 404, body: { detail: "no such thing here" } } });
      renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/^Asset not found\.$/); // detected by the status, not by the words
      expect(alert).toHaveClass("error");
      expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    });

    it("keeps the API's message for a failure that is not a 404", async () => {
      mockFetch({ ...routes(null), "GET /api/assets/4/summary": { status: 500, body: { detail: "summary unavailable" } } });
      renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
      expect(await screen.findByRole("alert")).toHaveTextContent(/^summary unavailable$/);
    });
  });

  it("puts the icon of the asset's kind in a tile beside the title, and an icon in each tile caption", async () => {
    mockFetch(routes({ kwh: 3.25, estimated: false, no_data: false }));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    const heading = await screen.findByRole("heading", { name: "Panel 1" });
    expect(heading.parentElement).toHaveClass("page-title");
    expect(heading.previousElementSibling).toHaveClass("page-tile");
    expect(heading.previousElementSibling!.querySelector("svg")!.innerHTML).toBe(iconHtml("kindPanel"));
    await screen.findByText("Cost today");
    const captions = Array.from(screen.getByText("Live power").closest(".tiles")!.children).map((tile) => tile.firstElementChild!);
    expect(captions.map((c) => c.textContent)).toEqual(["Live power", "Energy today", "Cost today"]);
    expect(captions.map((c) => c.className)).toEqual(Array(3).fill("muted tile-label"));
    expect(captions.map((c) => c.querySelector("svg")!.innerHTML)).toEqual([iconHtml("rate"), iconHtml("energy"), iconHtml("currency")]);
  });

  it("lays the three tiles out in one .tiles grid, in the order Live power, Energy today, Cost today", async () => {
    mockFetch(routes({ kwh: 3.25, estimated: false, no_data: false }));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    await screen.findByText("Cost today");
    const grid = screen.getByText("Live power").closest(".tiles")!;
    expect(screen.getByText("Energy today").closest(".tiles")).toBe(grid);
    expect(screen.getByText("Cost today").closest(".tiles")).toBe(grid);
    expect([...grid.children].map((tile) => tile.firstElementChild?.textContent)).toEqual(["Live power", "Energy today", "Cost today"]);
    expect([...grid.children].every((tile) => tile.classList.contains("tile"))).toBe(true);
  });

  it("draws the stream state as a status chip: live is ok, reconnecting is a warning, and the word stays in its own element", async () => {
    mockFetch(routes(null));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    await screen.findByRole("heading", { name: "Panel 1" });
    expect(screen.getByText("reconnecting…")).toHaveClass("chip", "chip-warn");
    act(() => FakeEventSource.last!.onopen?.());
    expect(screen.getByText("live")).toHaveClass("chip", "chip-ok");
  });

  it("puts the metrics in a .table-wrap, the value column right-aligned and a bad reading as a bad chip", async () => {
    mockFetch(routes(null));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    const row = await screen.findByRole("row", { name: /^active_power_kw / });
    expect(row.closest(".table-wrap")).not.toBeNull();
    const cells = within(row).getAllByRole("cell");
    expect(cells).toHaveLength(4);
    expect(cells[0]).toHaveTextContent(/^active_power_kw$/);
    expect(cells[1]).toHaveTextContent(/^10\.50$/);
    expect(cells[1]).toHaveClass("num");
    expect(screen.getByRole("columnheader", { name: "Value" })).toHaveClass("num");
    act(() => FakeEventSource.last!.emit([[7, Date.now() / 1000, null, 1]]));
    expect(screen.getByText("bad quality")).toHaveClass("chip", "chip-bad");
  });

  it("says in an .empty block that no metrics are mapped, without a heading (a heading with 'metrics' in it would clash with h2 Metrics in e2e)", async () => {
    mockFetch({ ...routes(null), "GET /api/assets/4/summary": { body: { ...summary(null), metrics: [] } } });
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    const note = await screen.findByText("No metrics are mapped to this asset.");
    expect(note.closest(".empty")).not.toBeNull();
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Panel 1", "Trend", "Metrics"]);
  });

  it("shows the stream state next to the heading", async () => {
    mockFetch(routes(null));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    await screen.findByRole("heading", { name: "Panel 1" });
    act(() => FakeEventSource.last!.onopen?.());
    expect(screen.getByText("live")).toBeInTheDocument();
    act(() => FakeEventSource.last!.onerror?.());
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
  });

  it("says neither live nor reconnecting for an asset without points, which opens no stream", async () => {
    mockFetch({ ...routes(null), "GET /api/assets/4/summary": { body: { ...summary(null), metrics: [] } } });
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    await screen.findByRole("heading", { name: "Panel 1" });
    expect(screen.queryByText("live")).not.toBeInTheDocument();
    expect(screen.queryByText("reconnecting…")).not.toBeInTheDocument();
  });

  it("says reconnecting for an asset with points until the stream opens", async () => {
    mockFetch(routes(null));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    await screen.findByRole("heading", { name: "Panel 1" });
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
    expect(screen.queryByText("live")).not.toBeInTheDocument();
    act(() => FakeEventSource.last!.onopen?.());
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.queryByText("reconnecting…")).not.toBeInTheDocument();
  });

  it("labels estimated energy and handles missing energy", async () => {
    mockFetch(routes({ kwh: 3.25, estimated: true, no_data: false }));
    const { unmount } = renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    expect(await screen.findByText(/3\.25 kWh/)).toHaveTextContent("estimated");
    unmount();
    expect(FakeEventSource.last?.closed).toBe(true);
    mockFetch(routes(null));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    expect(await screen.findByText("no energy data")).toBeInTheDocument();
  });

  it("shows today's cost next to the energy tile, with the currency and the partial mark", async () => {
    mockFetch(routes(
      { kwh: 3.25, estimated: false, no_data: false },
      { cost: 0.39, estimated: false, partial: true, no_data: false },
    ));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    expect(await screen.findByText("Cost today")).toBeInTheDocument();
    expect(screen.getByText("0.39")).toBeInTheDocument();
    expect(screen.getByText("QAR")).toBeInTheDocument();
    expect(screen.getByTitle(PARTIAL_TIP)).toBeInTheDocument();
    expect(screen.getByText("Energy today")).toBeInTheDocument();
  });

  it("shows a dash for the cost when no rate is set", async () => {
    mockFetch(routes({ kwh: 3.25, estimated: false, no_data: false }, { cost: null, estimated: false, partial: false, no_data: false }));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    expect(await screen.findByText("no rate set")).toBeInTheDocument();
  });

  it("shows no cost data for an asset without an energy figure", async () => {
    mockFetch(routes(null));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    expect(await screen.findByText("no cost data")).toBeInTheDocument();
    expect(screen.getByText("no energy data")).toBeInTheDocument();
    // the same words for the same situation, and no dash: a dash means "no rate" only
    const tile = screen.getByText("Cost today").closest(".tile")!;
    expect(tile.querySelector(".big")).toHaveTextContent(/^no cost data$/);
    expect(tile).not.toHaveTextContent("—");
  });

  it("mutes the energy and cost tiles when nothing was recorded today", async () => {
    mockFetch(routes(
      { kwh: 0, estimated: false, no_data: true },
      { cost: 0, estimated: false, partial: false, no_data: true },
    ));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    await screen.findByText("Cost today");
    for (const label of ["Energy today", "Cost today"]) {
      const figure = screen.getByText(label).closest(".tile")!.querySelector(".big")!;
      expect(figure).toHaveClass("muted");
      expect(figure).toHaveAttribute("title", "no data");
    }
    expect(screen.getByText("0.00 kWh")).toBeInTheDocument();
  });

  it("leaves the tiles unmuted when today has data", async () => {
    mockFetch(routes({ kwh: 3.25, estimated: false, no_data: false }, { cost: 0.39, estimated: false, partial: false, no_data: false }));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    await screen.findByText("Cost today");
    for (const label of ["Energy today", "Cost today"]) {
      expect(screen.getByText(label).closest(".tile")!.querySelector(".big")).not.toHaveClass("muted");
    }
  });

  describe("a parent without a power meter of its own shows the sum of the meters below it (S4-9)", () => {
    const TIP = "This asset has no power meter of its own: the figure is the sum of its sub-assets' meters.";
    const rollupSource = (id: number, name: string, value: number | null, over: Record<string, unknown> = {}) => ({
      asset_id: id, name, path: `Site / Hall / ${name}`, point_id: 20 + id, value, ts: value === null ? null : "2026-10-07T10:00:00+00:00",
      stale: false, ...over,
    });
    const parent = (sources: unknown[] | null, over: Record<string, unknown> = {}) => ({
      ...routes(null),
      "GET /api/assets/4/summary": {
        body: { ...summary(null), metrics: [], power_rollup: sources === null ? null : { sources }, ...over },
      },
    });
    const render = async (sources: unknown[] | null, over: Record<string, unknown> = {}) => {
      mockFetch(parent(sources, over));
      renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
      await screen.findByRole("heading", { name: "Panel 1" });
    };
    const tile = () => screen.getByText("Live power").closest(".tile")!;
    const figure = () => tile().querySelector(".big")!;
    const two = () => [rollupSource(1, "Rack A", 3), rollupSource(2, "Rack B", 4.5)];

    it("shows the sum and says how many meters it is made of", async () => {
      await render(two());
      expect(figure()).toHaveTextContent(/^7\.50 kW$/);
      expect(figure()).toHaveClass("big");
      const note = screen.getByText("Sum of the live power of 2 meters below");
      expect(tile()).toContainElement(note);
      expect(note).toHaveClass("muted");
      expect(note.getAttribute("title")!.startsWith(TIP)).toBe(true);
    });

    it("says meter, not meters, for exactly one", async () => {
      await render([rollupSource(1, "Rack A", 3)]);
      expect(figure()).toHaveTextContent(/^3\.00 kW$/);
      expect(screen.getByText("Sum of the live power of 1 meter below")).toBeInTheDocument();
    });

    it("sums the meters that report and names the others in the tooltip", async () => {
      await render([...two(), rollupSource(3, "Rack C", 9, { stale: true })]);
      expect(figure()).toHaveTextContent(/^7\.50 kW$/);
      const note = screen.getByText("Sum of 2 of 3 meters below; the other is not reporting");
      expect(note.getAttribute("title")).toContain("Site / Hall / Rack C");
      expect(note.getAttribute("title")).not.toContain("Rack A");
      expect(note.getAttribute("title")!.startsWith(TIP)).toBe(true);
    });

    it("names the silent meters in a visible line, not only in the tooltip", async () => {
      await render([...two(), rollupSource(3, "Rack C", 9, { stale: true }), rollupSource(4, "Rack D", null)]);
      const line = screen.getByText("Not reporting: Site / Hall / Rack C, Site / Hall / Rack D");
      expect(tile()).toContainElement(line);
      expect(line.closest(".muted")).not.toBeNull();
      expect(screen.getByText("Sum of 2 of 4 meters below; the others are not reporting")).toBeInTheDocument();
    });

    it("shows no such line when every meter reports, or none does", async () => {
      await render(two());
      expect(screen.queryByText(/^Not reporting:/)).not.toBeInTheDocument();
    });

    it("shows a dash, never 0.00, when no meter reports", async () => {
      await render([rollupSource(1, "Rack A", 3, { stale: true }), rollupSource(2, "Rack B", null)]);
      expect(figure()).toHaveTextContent(/^—$/);
      const note = screen.getByText("None of the 2 meters below is reporting");
      expect(note.getAttribute("title")).toContain("Rack A");
      expect(note.getAttribute("title")).toContain("Rack B");
      expect(tile()).not.toHaveTextContent("0.00");
    });

    it("says it in the singular when the only meter below is not reporting", async () => {
      await render([rollupSource(1, "Rack A", null)]);
      expect(figure()).toHaveTextContent(/^—$/);
      expect(screen.getByText("The meter below is not reporting")).toBeInTheDocument();
    });

    it("follows the stream, which is asked for the meters' points and reports live", async () => {
      await render(two());
      expect(screen.getByText("reconnecting…")).toBeInTheDocument();
      act(() => FakeEventSource.last!.onopen?.());
      expect(screen.getByText("live")).toBeInTheDocument();
      // point 21 is Rack A, 22 is Rack B; an entry is only taken when the page asked for its point
      act(() => FakeEventSource.last!.emit([[21, Date.now() / 1000, 10, 0], [99, Date.now() / 1000, 500, 0]]));
      expect(figure()).toHaveTextContent(/^14\.50 kW$/);
      act(() => FakeEventSource.last!.emit([[22, Date.now() / 1000, null, 1]]));
      expect(figure()).toHaveTextContent(/^10\.00 kW$/);
      expect(screen.getByText("Sum of 1 of 2 meters below; the other is not reporting")).toBeInTheDocument();
      expect(screen.getByText("Not reporting: Site / Hall / Rack B")).toBeInTheDocument();
    });

    it("lets a streamed value revive a meter that was stale when the page loaded", async () => {
      await render([rollupSource(1, "Rack A", 3), rollupSource(2, "Rack B", 4, { stale: true })]);
      expect(figure()).toHaveTextContent(/^3\.00 kW$/);
      act(() => FakeEventSource.last!.emit([[22, Date.now() / 1000, 6, 0]]));
      expect(figure()).toHaveTextContent(/^9\.00 kW$/);
      expect(screen.getByText("Sum of the live power of 2 meters below")).toBeInTheDocument();
    });

    it("ignores the roll-up when the asset has a power meter of its own", async () => {
      mockFetch({
        ...routes(null),
        "GET /api/assets/4/summary": { body: { ...summary(null), power_rollup: { sources: two() } } },
      });
      renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
      await screen.findByRole("heading", { name: "Panel 1" });
      expect(figure()).toHaveTextContent(/^10\.50 kW$/);
      expect(screen.queryByText(/meters? below/)).not.toBeInTheDocument();
      // the roll-up's points are not streamed either: an update for one of them changes nothing
      act(() => FakeEventSource.last!.emit([[21, Date.now() / 1000, 100, 0]]));
      expect(figure()).toHaveTextContent(/^10\.50 kW$/);
    });

    it("still shows a dash and no note for an asset with neither a meter nor a roll-up", async () => {
      await render(null);
      expect(figure()).toHaveTextContent(/^—$/);
      expect(screen.queryByText(/meters? below/)).not.toBeInTheDocument();
      expect(screen.queryByText(/not reporting/)).not.toBeInTheDocument();
    });

    it("still shows a dash when the summary has no power_rollup key at all", async () => {
      mockFetch({ ...routes(null), "GET /api/assets/4/summary": { body: { ...summary(null), metrics: [] } } });
      renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
      await screen.findByRole("heading", { name: "Panel 1" });
      expect(figure()).toHaveTextContent(/^—$/);
    });
  });
});
