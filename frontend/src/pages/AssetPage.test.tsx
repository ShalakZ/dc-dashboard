import { act, screen } from "@testing-library/react";
import { PARTIAL_TIP } from "../components/Figure";
import { mockFetch } from "../test/fetchMock";
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
  asset: { id: 4, name: "Panel 1", parent_id: 1, kind: "panel" },
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
const routes = (energy: unknown, cost?: unknown) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "v", role: "viewer" } },
  "GET /api/site": { body: { timezone: "Asia/Qatar", currency: "QAR" } },
  "GET /api/assets/4/summary": { body: summary(energy, cost) },
  "GET /api/assets/4/series": { body: { metric: "active_power_kw", unit: "kW", points: [] } },
});

beforeEach(() => vi.stubGlobal("EventSource", FakeEventSource));

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
    expect(screen.getByText(now.toLocaleTimeString())).toBeInTheDocument();
    expect(screen.queryByText(new Date(0).toLocaleTimeString())).not.toBeInTheDocument();
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
});
