import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import type { Asset, WidgetData } from "../../api/types";
import { config, valueRow, valuesData } from "../../test/dashboardFixtures";
import { mockFetch } from "../../test/fetchMock";
import { holdFetch } from "../../test/holdFetch";
import { FocusContext, type FocusState } from "./FocusContext";
import { WidgetView, type WidgetViewProps } from "./WidgetView";

// w27 R6: the card and its Details panel name a repeated asset name by its parent, from the asset list the top bar holds, only with `assets.view`, only when the answer
// repeats a name, and the text changes at most once while the list loads.
const held = { ids: new Set<string>(["assets.view"]) };
vi.mock("../../auth/AuthProvider", () => ({ useAuth: () => ({ can: (id: string) => held.ids.has(id) }) }));
vi.mock("../../lib/download", () => ({ downloadCsv: vi.fn() }));
vi.mock("echarts-for-react", () => ({
  default: (props: { option: unknown }) => <pre data-testid="chart">{JSON.stringify(props.option)}</pre>,
}));

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
const ctxOf = (allowed: boolean): FocusState => ({ focus: null, allowed, assets: undefined, name: null, notice: null, anyFollowing: false, setFocus: vi.fn(), reportGone: vi.fn() });

const asset = (id: number, parent_id: number | null, name: string): Asset => ({ id, parent_id, name, kind: "rack", sort_order: id });
const LIST: Asset[] = [asset(1, null, "Site"), asset(2, 1, "Hall 2"), asset(3, 1, "Hall 3"), asset(12, 2, "Rack 04"), asset(13, 3, "Rack 04"), asset(20, 2, "Main")];
const answer = (...rows: [number, string][]): WidgetData => valuesData({
  type: "table", source: "energy", metric: null, unit: "kWh", values: rows.map(([id, name], i) => valueRow({ asset_id: id, name, value: 10 + i, point_id: null })),
});
const TWINS = answer([12, "Rack 04"], [13, "Rack 04"]);

const props = (over: Partial<WidgetViewProps> = {}): WidgetViewProps => ({
  widgetKey: "w1", type: "table", title: "Hall", config: config({ assets: [12, 13], source: "energy", metric: null, aggregation: "sum" }), dashboardRange: "24h", timezone: "Asia/Qatar", ...over,
});
const show = (allowed: boolean, over: Partial<WidgetViewProps> = {}) =>
  render(<FocusContext.Provider value={ctxOf(allowed)}><WidgetView {...props(over)} /></FocusContext.Provider>, { wrapper });
const names = (): string[] => screen.queryAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent ?? "");
const listCalls = (calls: { method: string; path: string }[]) => calls.filter((c) => c.path === "/api/assets");

beforeEach(() => {
  client.clear();
  held.ids = new Set(["assets.view"]);
});

describe("a card that repeats an asset name", () => {
  it("names the assets by their parent in the table and in the Details panel, with one request for the list", async () => {
    const calls = mockFetch({ "POST /api/widget-data": { body: TWINS }, "GET /api/assets": { body: LIST } });
    show(true);
    await waitFor(() => expect(names()).toEqual(["Hall 2 / Rack 04", "Hall 3 / Rack 04"]));
    expect(listCalls(calls)).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Details for Hall" }));
    const dialog = screen.getByRole("dialog", { name: "Details: Hall" });
    expect(within(dialog).getAllByText("Hall 2 / Rack 04").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Hall 3 / Rack 04").length).toBeGreaterThan(0);
    expect(within(dialog).queryByText(/\(#/)).not.toBeInTheDocument();
  });

  it("says the same on the axis of a bar chart as in the table", async () => {
    mockFetch({ "POST /api/widget-data": { body: { ...TWINS, type: "bar" } }, "GET /api/assets": { body: LIST } });
    show(true, { type: "bar" });
    await waitFor(() => expect(screen.getByTestId("chart").textContent).toContain("Hall 2 / Rack 04"));
    const option = JSON.parse(screen.getByTestId("chart").textContent!) as { xAxis: { data: string[] } };
    expect(option.xAxis.data).toEqual(["Hall 2 / Rack 04", "Hall 3 / Rack 04"]);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Hall 2 / Rack 04, Hall 3 / Rack 04");
  });

  it("is exactly today's text, and asks for no list, without assets.view", async () => {
    held.ids = new Set();
    const calls = mockFetch({ "POST /api/widget-data": { body: TWINS }, "GET /api/assets": { body: LIST } });
    show(false);
    await waitFor(() => expect(names()).toEqual(["Rack 04 (#12)", "Rack 04 (#13)"]));
    await userEvent.click(screen.getByRole("button", { name: "Details for Hall" }));
    expect(within(screen.getByRole("dialog", { name: "Details: Hall" })).getAllByText("Rack 04 (#12)").length).toBeGreaterThan(0);
    expect(listCalls(calls)).toHaveLength(0);
  });

  it("shows today's text until the list is here, then the parents, and passes through no third form", async () => {
    const calls = mockFetch({ "POST /api/widget-data": { body: TWINS }, "GET /api/assets": { body: LIST } });
    const gate = holdFetch((method, path) => method === "GET" && path === "/api/assets");
    const seen: string[][] = [];
    const watch = new MutationObserver(() => {
      const now = names();
      if (now.length > 0 && JSON.stringify(now) !== JSON.stringify(seen.at(-1))) seen.push(now);
    });
    watch.observe(document.body, { childList: true, subtree: true, characterData: true });
    show(true);
    await waitFor(() => expect(names()).toEqual(["Rack 04 (#12)", "Rack 04 (#13)"]));
    await waitFor(() => expect(client.isFetching({ queryKey: ["assets"] })).toBe(1)); // the list is asked for and held
    expect(listCalls(calls)).toHaveLength(0);
    gate.release();
    await waitFor(() => expect(names()).toEqual(["Hall 2 / Rack 04", "Hall 3 / Rack 04"]));
    watch.disconnect();
    expect(seen).toEqual([["Rack 04 (#12)", "Rack 04 (#13)"], ["Hall 2 / Rack 04", "Hall 3 / Rack 04"]]);
  });

  it("stays on today's text when the list cannot be loaded", async () => {
    mockFetch({ "POST /api/widget-data": { body: TWINS }, "GET /api/assets": { status: 500, body: { detail: "down" } } });
    show(true);
    await waitFor(() => expect(names()).toEqual(["Rack 04 (#12)", "Rack 04 (#13)"]));
    await waitFor(() => expect(client.getQueryState(["assets"])?.status).toBe("error"));
    expect(names()).toEqual(["Rack 04 (#12)", "Rack 04 (#13)"]);
  });
});

describe("a card whose names are all different", () => {
  it("is untouched and never asks for the list", async () => {
    const calls = mockFetch({ "POST /api/widget-data": { body: answer([12, "Rack 04"], [20, "Main"]) }, "GET /api/assets": { body: LIST } });
    show(true);
    await waitFor(() => expect(names()).toEqual(["Rack 04", "Main"]));
    expect(listCalls(calls)).toHaveLength(0);
  });
});
