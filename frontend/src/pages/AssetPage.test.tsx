import { act, screen } from "@testing-library/react";
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

const summary = (energy: unknown) => ({
  asset: { id: 4, name: "Panel 1", parent_id: 1, kind: "panel" },
  metrics: [
    { mapping_id: 1, point_id: 7, metric: "active_power_kw", unit: "kW", value: 10.5, ts: "2026-10-07T10:00:00+00:00", quality: 0 },
    { mapping_id: 2, point_id: 8, metric: "voltage_v", unit: "V", value: null, ts: null, quality: null },
  ],
  energy_today: energy,
});
const routes = (energy: unknown) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "v", role: "viewer" } },
  "GET /api/assets/4/summary": { body: summary(energy) },
  "GET /api/assets/4/series": { body: { metric: "active_power_kw", unit: "kW", points: [] } },
});

beforeEach(() => vi.stubGlobal("EventSource", FakeEventSource));

describe("AssetPage", () => {
  it("renders live value from stream and dash for null", async () => {
    mockFetch(routes({ kwh: 3.25, estimated: false }));
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

  it("labels estimated energy and handles missing energy", async () => {
    mockFetch(routes({ kwh: 3.25, estimated: true }));
    const { unmount } = renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    expect(await screen.findByText(/3\.25 kWh/)).toHaveTextContent("estimated");
    unmount();
    expect(FakeEventSource.last?.closed).toBe(true);
    mockFetch(routes(null));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    expect(await screen.findByText("no energy data")).toBeInTheDocument();
  });
});
