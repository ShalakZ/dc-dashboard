import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GraphModel, GraphPoint } from "../api/types";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { DiscoveryPage } from "./DiscoveryPage";

// What React Flow reports as overlapping the dropped node; set per test.
const flow = vi.hoisted(() => {
  const state = { intersecting: [] as { id: string; type?: string }[] };
  return { state, getIntersectingNodes: vi.fn((_node: unknown) => state.intersecting) };
});

// React Flow measures the DOM, which jsdom cannot do: render the nodes plainly and expose the props the page wires up.
// `drag-{id}` plays a whole drag as React Flow does it (start, the final position change, stop) and ends at 7,8.
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    useReactFlow: () => ({ getIntersectingNodes: flow.getIntersectingNodes }),
    ReactFlow: ({ nodes, nodeTypes, onNodeClick, onNodeDragStart, onNodeDragStop, onNodesChange }: any) => (
      <div data-testid="flow">
        {nodes.map((n: any) => {
          const Node = nodeTypes[n.type];
          const dropped = { ...n, position: { x: 7, y: 8 } };
          return (
            <div key={n.id} data-id={n.id} data-x={n.position.x} data-y={n.position.y} data-width={n.measured?.width} onClick={(e) => onNodeClick?.(e, n)}>
              <Node id={n.id} data={n.data} />
              <button data-testid={`measure-${n.id}`} onClick={() => onNodesChange?.([{ id: n.id, type: "dimensions", dimensions: { width: 100, height: 40 } }])} />
              <button data-testid={`dragstart-${n.id}`} onClick={(e) => onNodeDragStart?.(e, n, [n])} />
              <button
                data-testid={`drag-${n.id}`}
                onClick={(e) => {
                  onNodeDragStart?.(e, n, [n]);
                  onNodesChange?.([{ id: n.id, type: "position", position: { x: 7, y: 8 }, dragging: false }]);
                  onNodeDragStop?.(e, dropped, [dropped]);
                }}
              />
              <button
                data-testid={`dragwith-${n.id}`}
                onClick={(e) => {
                  const other = nodes.find((o: any) => o.id !== n.id);
                  const together = [dropped, { ...other, position: { x: 9, y: 9 } }];
                  onNodeDragStart?.(e, n, [n, other]);
                  onNodeDragStop?.(e, dropped, together);
                }}
              />
            </div>
          );
        })}
      </div>
    ),
    Background: () => null,
    Controls: () => null,
  };
});

const point = (id: number, name: string, extra: Partial<GraphPoint> = {}): GraphPoint => ({
  id, address: `a${id}`, name, unit_hint: null, mapping_id: null, asset_id: null, mapped_metric: null,
  suggestion: { metric: "custom", scale: 1, interval_seconds: 5, custom_unit: null }, ...extra,
});
const graph = (over: Partial<GraphModel> = {}): GraphModel => ({
  sources: [{
    id: 1, name: "Plant OPC", connector_type: "opcua", config: { endpoint: "opc.tcp://plc:4840" }, origin: "discovered", enabled: false,
    status: "unknown", last_error: null, has_secret: false, needs_credentials: false, point_count: 4,
    clusters: [{ key: "LVP01", points: [point(1, "LVP01 kW"), point(2, "LVP01 V")] }, { key: "LVP02", points: [point(3, "LVP02 kW")] }],
    ungrouped: [point(4, "Status")],
  }],
  unidentified: [{ host: "10.0.0.9", port: 8080, scan_id: 4 }],
  assets: [{ id: 10, parent_id: null, name: "Site", kind: "generic" }, { id: 11, parent_id: 10, name: "Panel 1", kind: "generic" }],
  layout: {}, ...over,
});
const routes = (role: string, model: GraphModel | (() => GraphModel) = graph()) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role } },
  "GET /api/discovery/graph": () => ({ body: typeof model === "function" ? model() : model }),
  "PUT /api/discovery/layout": { status: 204 },
});
const open = () => renderWithProviders(<DiscoveryPage />, { route: "/discovery", path: "/discovery" });
const node = (id: string) => document.querySelector(`[data-id="${id}"]`) as HTMLElement;

describe("DiscoveryPage", () => {
  it("renders sources, assets and unidentified services collapsed", async () => {
    mockFetch(routes("operator"));
    open();
    expect(await screen.findByText("Plant OPC")).toBeInTheDocument();
    expect(screen.getByText("Site")).toBeInTheDocument();
    expect(screen.getByText("Panel 1")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.9:8080 — unidentified service")).toBeInTheDocument();
    expect(screen.queryByText("LVP01 (2)")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("expanding a source shows its clusters, and a cluster shows its points", async () => {
    mockFetch(routes("operator"));
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Expand Plant OPC" }));
    expect(screen.getByText("LVP01 (2)")).toBeInTheDocument();
    expect(screen.getByText("LVP02 (1)")).toBeInTheDocument();
    expect(screen.getByText("Ungrouped (1)")).toBeInTheDocument();
    expect(screen.queryByText("LVP01 kW")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Expand LVP01" }));
    expect(screen.getByText("LVP01 kW")).toBeInTheDocument();
    expect(screen.getByText("LVP01 V")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Collapse LVP01" }));
    expect(screen.queryByText("LVP01 kW")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Collapse Plant OPC" }));
    expect(screen.queryByText("LVP01 (2)")).not.toBeInTheDocument();
  });

  it("toggling does not also open the side panel", async () => {
    mockFetch(routes("operator"));
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Expand Plant OPC" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("clicking a source opens its panel, and Close dismisses it", async () => {
    mockFetch(routes("operator"));
    open();
    await userEvent.click(await screen.findByText("Plant OPC"));
    const panel = await screen.findByRole("complementary", { name: "Source details" });
    expect(within(panel).getByRole("heading", { name: "Plant OPC" })).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Browse again" })).not.toBeInTheDocument(); // operators cannot edit
    await userEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("clicking anything other than a source leaves the panel closed", async () => {
    mockFetch(routes("operator"));
    open();
    await userEvent.click(await screen.findByText("Site"));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("an admin sees the browse action in the panel", async () => {
    mockFetch(routes("admin"));
    open();
    await userEvent.click(await screen.findByText("Plant OPC"));
    const panel = await screen.findByRole("complementary", { name: "Source details" });
    expect(within(panel).getByRole("button", { name: "Browse again" })).toBeInTheDocument();
  });

  it("the open panel follows the refreshed graph", async () => {
    let creds = false;
    mockFetch(routes("operator", () => {
      const model = graph();
      model.sources[0].needs_credentials = creds;
      return model;
    }));
    open();
    await userEvent.click(await screen.findByText("Plant OPC"));
    const panel = await screen.findByRole("complementary", { name: "Source details" });
    expect(within(panel).queryByText(/needs credentials/i)).not.toBeInTheDocument();
    creds = true;
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(within(screen.getByRole("complementary", { name: "Source details" })).getByText(/needs credentials/i)).toBeInTheDocument());
  });

  it("Refresh reads the graph again", async () => {
    const calls = mockFetch(routes("operator"));
    open();
    await screen.findByText("Plant OPC");
    const reads = () => calls.filter((c) => c.method === "GET" && c.path === "/api/discovery/graph").length;
    expect(reads()).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(reads()).toBe(2));
  });

  it("an operator's drag moves nothing on the server", async () => {
    const calls = mockFetch(routes("operator"));
    open();
    await screen.findByText("Plant OPC");
    await userEvent.click(screen.getByTestId("drag-src:1"));
    await userEvent.click(screen.getByTestId("drag-asset:10"));
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("an admin's drag saves the moved nodes", async () => {
    const calls = mockFetch(routes("admin"));
    open();
    await screen.findByText("Plant OPC");
    await userEvent.click(screen.getByTestId("drag-src:1"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({
      path: "/api/discovery/layout", body: { nodes: [{ node_id: "src:1", x: 7, y: 8 }] },
    });
  });

  it("shows the server's reason when saving the layout fails", async () => {
    mockFetch({ ...routes("admin"), "PUT /api/discovery/layout": { status: 422, body: { detail: "too many nodes" } } });
    open();
    await screen.findByText("Plant OPC");
    await userEvent.click(screen.getByTestId("drag-src:1"));
    expect(await screen.findByRole("alert")).toHaveTextContent("too many nodes");
  });

  it("a node the user moved keeps its place when the graph is rebuilt", async () => {
    mockFetch(routes("operator"));
    open();
    await screen.findByText("Plant OPC");
    await userEvent.click(screen.getByTestId("drag-src:1")); // the mock reports it moved to 7,8
    await userEvent.click(screen.getByRole("button", { name: "Expand Plant OPC" }));
    await screen.findByText("LVP01 (2)");
    expect(node("src:1")).toHaveAttribute("data-x", "7");
    expect(node("src:1")).toHaveAttribute("data-y", "8");
    expect(node("asset:10")).not.toHaveAttribute("data-x", "7"); // nodes that were not moved are laid out afresh
  });

  it("a rebuild keeps the sizes React Flow has measured, so nodes do not blink out while it measures again", async () => {
    mockFetch(routes("operator"));
    open();
    await screen.findByText("Plant OPC");
    await userEvent.click(screen.getByTestId("measure-src:1"));
    expect(node("src:1")).toHaveAttribute("data-width", "100");
    await userEvent.click(screen.getByRole("button", { name: "Expand Plant OPC" }));
    await screen.findByText("LVP01 (2)");
    expect(node("src:1")).toHaveAttribute("data-width", "100");
    expect(node("cluster:1:LVP01")).not.toHaveAttribute("data-width"); // new nodes are measured when they appear
  });

  it("starts nodes at their saved position", async () => {
    mockFetch(routes("operator", graph({ layout: { "src:1": { x: 55, y: 66 } } })));
    open();
    await screen.findByText("Plant OPC");
    expect(node("src:1")).toHaveAttribute("data-x", "55");
    expect(node("src:1")).toHaveAttribute("data-y", "66");
  });

  it("with nothing discovered, points the operator at the scans page", async () => {
    mockFetch(routes("operator", { sources: [], unidentified: [], assets: [], layout: {} }));
    open();
    expect(await screen.findByText(/Nothing discovered yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "run a scan" })).toHaveAttribute("href", "/scans");
    expect(screen.queryByTestId("flow")).not.toBeInTheDocument();
  });

  it("shows the server's error when the graph cannot be loaded", async () => {
    mockFetch({ ...routes("operator"), "GET /api/discovery/graph": { status: 500, body: { detail: "database down" } } });
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("database down");
  });
});

describe("DiscoveryPage mapping", () => {
  beforeEach(() => {
    flow.state.intersecting = [];
    flow.getIntersectingNodes.mockClear();
  });

  // Source 1 is open with LVP01 expanded; LVP02 is fully mapped already.
  const mappedLvp02 = () => {
    const model = graph();
    model.sources[0].clusters[1].points = [point(3, "LVP02 kW", { asset_id: 10, mapping_id: 7, mapped_metric: "active_power_kw" })];
    return model;
  };
  const start = async (role: string, model: GraphModel | (() => GraphModel) = graph(), extra: Record<string, unknown> = {}) => {
    const calls = mockFetch({ ...routes(role, model), ...extra });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Expand Plant OPC" }));
    await userEvent.click(screen.getByRole("button", { name: "Expand LVP01" }));
    return calls;
  };
  const puts = <T extends { method: string }>(calls: T[]) => calls.filter((c) => c.method === "PUT");
  const dialog = () => screen.findByRole("dialog", { name: "Review mappings" });

  it("a cluster dropped on an asset opens the review dialog on that asset, snaps back, and saves no layout", async () => {
    const calls = await start("admin");
    const [x, y] = [node("cluster:1:LVP01").dataset.x, node("cluster:1:LVP01").dataset.y];
    flow.state.intersecting = [{ id: "src:1", type: "source" }, { id: "asset:11", type: "asset" }];
    await userEvent.click(screen.getByTestId("drag-cluster:1:LVP01"));
    const review = await dialog();
    expect(within(review).getByLabelText("Asset")).toHaveValue("11");
    expect(within(review).getAllByRole("checkbox")).toHaveLength(2); // LVP01 kW and LVP01 V
    expect(flow.getIntersectingNodes).toHaveBeenCalledWith(expect.objectContaining({ id: "cluster:1:LVP01" }));
    expect(puts(calls)).toHaveLength(0);
    expect(node("cluster:1:LVP01")).toHaveAttribute("data-x", x);
    expect(node("cluster:1:LVP01")).toHaveAttribute("data-y", y);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    // The drop position was not remembered either: after the dialog goes away a rebuild still puts the node at its start.
    await userEvent.click(within(review).getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Collapse LVP01" }));
    expect(node("cluster:1:LVP01")).toHaveAttribute("data-x", x);
  });

  it("a point dropped on an asset opens the dialog with just that point", async () => {
    flow.state.intersecting = [{ id: "asset:10", type: "asset" }];
    const calls = await start("admin");
    await userEvent.click(screen.getByTestId("drag-point:1"));
    const review = await dialog();
    expect(within(review).getByRole("checkbox", { name: "Map LVP01 kW" })).toBeChecked();
    expect(within(review).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(review).getByLabelText("Asset")).toHaveValue("10");
    expect(puts(calls)).toHaveLength(0);
  });

  it("a cluster dropped on empty canvas saves its position and offers to create an asset from it", async () => {
    const calls = await start("admin");
    await userEvent.click(screen.getByTestId("drag-cluster:1:LVP01"));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]).toMatchObject({ path: "/api/discovery/layout", body: { nodes: [{ node_id: "cluster:1:LVP01", x: 7, y: 8 }] } });
    expect(screen.getByRole("status")).toHaveTextContent('Create asset "LVP01" from this cluster?');
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "Create asset…" }));
    const review = await dialog();
    expect(within(review).getByRole("radio", { name: "New asset" })).toBeChecked();
    expect(within(review).getByLabelText("New asset name")).toHaveValue("LVP01");
    expect(within(review).getByLabelText("Parent asset")).toHaveValue("");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("Dismiss removes the offer", async () => {
    await start("admin");
    await userEvent.click(screen.getByTestId("drag-cluster:1:LVP01"));
    await userEvent.click(within(await screen.findByRole("status")).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("starting another drag removes the offer", async () => {
    await start("admin");
    await userEvent.click(screen.getByTestId("drag-cluster:1:LVP01"));
    await screen.findByRole("status");
    await userEvent.click(screen.getByTestId("dragstart-asset:10"));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("the offer goes away by itself after ten seconds, and a newer offer gets its own ten", async () => {
    await start("admin");
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId("drag-cluster:1:LVP01"));
      expect(screen.getByRole("status")).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(6_000));
      fireEvent.click(screen.getByTestId("drag-cluster:1:LVP02")); // replaces the offer: the old timer must not cut it short
      await act(() => vi.advanceTimersByTimeAsync(6_000));
      expect(screen.getByRole("status")).toHaveTextContent('Create asset "LVP02"');
      await act(() => vi.advanceTimersByTimeAsync(4_000));
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("no offer for a point, the Ungrouped bag or a cluster with nothing left to map; their position is still saved", async () => {
    const calls = await start("admin", mappedLvp02());
    await userEvent.click(screen.getByTestId("drag-point:1"));
    await userEvent.click(screen.getByTestId("drag-cluster:1:LVP02")); // fully mapped
    await userEvent.click(screen.getByTestId("drag-cluster:1:__ungrouped__"));
    await waitFor(() => expect(puts(calls)).toHaveLength(3));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("dropping something that cannot be mapped onto an asset just moves it", async () => {
    flow.state.intersecting = [{ id: "asset:11", type: "asset" }];
    const calls = await start("admin");
    await userEvent.click(screen.getByTestId("drag-src:1"));
    await userEvent.click(screen.getByTestId("drag-cluster:1:__ungrouped__"));
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(node("src:1")).toHaveAttribute("data-x", "7");
  });

  it("dragging several nodes together only moves them", async () => {
    flow.state.intersecting = [{ id: "asset:11", type: "asset" }];
    const calls = await start("admin");
    await userEvent.click(screen.getByTestId("dragwith-cluster:1:LVP01"));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect((puts(calls)[0].body as { nodes: unknown[] }).nodes).toHaveLength(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("the Map button opens the dialog with no asset chosen yet", async () => {
    await start("admin");
    await userEvent.click(screen.getByRole("button", { name: "Map LVP01 to asset…" }));
    const review = await dialog();
    expect(within(review).getByRole("radio", { name: "Existing asset" })).toBeChecked();
    expect(within(review).getByLabelText("Asset")).toHaveValue("");
    expect(within(review).getByRole("button", { name: "Create mappings" })).toBeDisabled();
    expect(within(review).getAllByRole("checkbox")).toHaveLength(2);
  });

  it("the New asset button opens the dialog on a new asset named after the cluster", async () => {
    await start("admin");
    await userEvent.click(screen.getByRole("button", { name: "New asset from LVP01…" }));
    const review = await dialog();
    expect(within(review).getByRole("radio", { name: "New asset" })).toBeChecked();
    expect(within(review).getByLabelText("New asset name")).toHaveValue("LVP01");
  });

  it("a point has a Map button but no New asset button, and the Ungrouped bag and a fully mapped cluster have neither", async () => {
    await start("admin", mappedLvp02());
    await userEvent.click(screen.getByRole("button", { name: "Map LVP01 kW to asset…" }));
    expect(within(await dialog()).getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "New asset from LVP01 kW…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Map|New asset from) Ungrouped/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Map LVP02 to asset…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New asset from LVP02…" })).not.toBeInTheDocument();
  });

  it("a mapped point has no Map button", async () => {
    const model = graph();
    model.sources[0].clusters[0].points[0] = point(1, "LVP01 kW", { asset_id: 11, mapping_id: 4, mapped_metric: "active_power_kw" });
    await start("admin", model);
    expect(screen.queryByRole("button", { name: "Map LVP01 kW to asset…" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Map LVP01 V to asset…" })).toBeInTheDocument();
  });

  it("creating the mappings closes the dialog and shows the refreshed graph", async () => {
    let mapped = false;
    const model = () => {
      const m = graph();
      if (mapped) m.sources[0].clusters[0].points = m.sources[0].clusters[0].points.map((p) => ({ ...p, asset_id: 11, mapping_id: p.id + 100, mapped_metric: "voltage_v" as const }));
      return m;
    };
    const calls = await start("admin", model, {
      "POST /api/discovery/accept": () => { mapped = true; return { status: 201, body: { asset_id: 11, mapping_ids: [101, 102] } }; },
    });
    await userEvent.click(screen.getByRole("button", { name: "Map LVP01 to asset…" }));
    const review = await dialog();
    await userEvent.selectOptions(within(review).getByLabelText("Asset"), "11");
    await userEvent.click(within(review).getByRole("button", { name: "Create mappings" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === "POST")[0].body).toMatchObject({ source_id: 1, asset_id: 11 });
    expect(await screen.findByText("2 mapped")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Map LVP01 to asset…" })).not.toBeInTheDocument(); // nothing left to map
  });

  it("an operator gets no map buttons, no dialog, no offer and nothing saved", async () => {
    flow.state.intersecting = [{ id: "asset:11", type: "asset" }];
    const calls = await start("operator");
    expect(screen.queryByRole("button", { name: /to asset…/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New asset from/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("drag-cluster:1:LVP01")); // onto an asset
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(node("cluster:1:LVP01")).toHaveAttribute("data-x", "7"); // moved for this operator only
    flow.state.intersecting = [];
    await userEvent.click(screen.getByTestId("drag-cluster:1:LVP02")); // onto empty canvas
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT" || c.method === "POST")).toBe(false);
  });
});
