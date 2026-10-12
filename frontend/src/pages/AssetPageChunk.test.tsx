import { screen, waitFor } from "@testing-library/react";
import { progress } from "../lib/progress";
import { holdFetch } from "../test/holdFetch";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { AssetPage } from "./AssetPage";

// The chart's chunk, held: the factory runs when the page first imports the module and the module arrives when the gate opens.
const chunk = vi.hoisted(() => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return { gate, open, imports: 0 };
});
vi.mock("../components/TrendChart", async () => {
  chunk.imports += 1;
  await chunk.gate;
  return { TrendChart: () => <p>the chart</p> };
});

class FakeEventSource {
  close() {}
  onmessage = null;
}

const summary = {
  asset: { id: 4, name: "Panel 1", parent_id: null, kind: "panel" },
  metrics: [], energy_today: null, cost_today: null, currency: "QAR",
};
const routes = {
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "v", role: "viewer" } },
  "GET /api/site": { body: { timezone: "Asia/Qatar", currency: "QAR" } },
  "GET /api/assets": { body: [{ id: 4, parent_id: null, name: "Panel 1", kind: "panel", sort_order: 0 }] },
  "GET /api/assets/4/summary": { body: summary },
};

beforeEach(() => vi.stubGlobal("EventSource", FakeEventSource));

describe("AssetPage while the chart's chunk loads", () => {
  it("starts the chunk with the page, before the summary has arrived", async () => {
    mockFetch(routes);
    const held = holdFetch((_method, path) => path === "/api/assets/4/summary");
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    await waitFor(() => expect(chunk.imports).toBe(1));
    expect(screen.queryByRole("heading", { name: "Panel 1" })).not.toBeInTheDocument(); // the summary is still held
    held.release();
    await screen.findByRole("heading", { name: "Panel 1" });
  });

  it("falls back to the trend frame's skeleton, one status region, with the loading bar counting it; then the chart", async () => {
    mockFetch(routes);
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    await screen.findByRole("heading", { name: "Panel 1", level: 1 });
    const region = screen.getByText("Loading the chart").parentElement!;
    expect(region).toHaveAttribute("role", "status");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(region.querySelector(".trend-frame")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("heading", { name: "Trend", level: 2 })).toBeInTheDocument(); // the page's own heading stays outside the fallback
    expect(progress.getCount("pending")).toBe(1); // Pending is in the fallback, next to the skeleton and not inside the region
    chunk.open();
    expect(await screen.findByText("the chart")).toBeInTheDocument();
    expect(screen.queryByText("Loading the chart")).not.toBeInTheDocument();
    expect(progress.getCount("pending")).toBe(0);
  });
});
