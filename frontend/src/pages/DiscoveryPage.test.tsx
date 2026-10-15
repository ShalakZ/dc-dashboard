import { readFileSync } from "node:fs";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GraphModel, GraphPoint, GraphSource } from "../api/types";
import { mockFetch } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { spyToasts } from "../test/toasts";
import { accountKnown, SignedIn } from "../test/signedIn";
import { userFor } from "../test/users";
import type { PermissionId } from "../lib/permissions";
import { DiscoveryPage } from "./DiscoveryPage";

// The bulk-create dialog is another piece (its own tests): here it only has to be mounted with the right props and closed through onClose.
const bulk = vi.hoisted(() => ({ props: [] as { model: GraphModel; source: GraphSource; onClose: () => void }[] }));
vi.mock("../components/graph/BulkCreateDialog", () => ({
  BulkCreateDialog: (props: { model: GraphModel; source: GraphSource; onClose: () => void }) => {
    bulk.props.push(props);
    return <div role="dialog" aria-label="Create assets stub"><button type="button" onClick={props.onClose}>Close stub</button></div>;
  },
}));

// What React Flow reports as overlapping the dropped node, the nodes it was last given (`getNodes`), where a played drag ends and, for
// `dragwith`, which node is dragged along with it, and the viewport the camera starts from; set per test.
const flow = vi.hoisted(() => {
  const state = {
    intersecting: [] as { id: string; type?: string }[], nodes: [] as any[], dropAt: { x: 7, y: 8 }, partner: null as string | null,
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  return {
    state, getIntersectingNodes: vi.fn((_node: unknown) => state.intersecting), getNodes: vi.fn(() => state.nodes), fitView: vi.fn(),
    // The camera: a move resolves as the library's does (true when it happened).
    setViewport: vi.fn(async (_view: unknown, _options?: unknown) => true), getViewport: vi.fn(() => state.viewport),
    setCenter: vi.fn(async (_x: number, _y: number, _options?: unknown) => true), getZoom: vi.fn(() => state.viewport.zoom),
  };
});

// The minimap is its own piece (its own tests): here it only has to be drawn inside the canvas.
vi.mock("../components/graph/GraphMiniMap", () => ({ GraphMiniMap: () => <div data-testid="minimap" /> }));

// React Flow measures the DOM, which jsdom cannot do: render the nodes plainly and expose the props the page wires up.
// `data-draggable` is React Flow's own rule for one node (a node's `draggable` beats the canvas-wide `nodesDraggable`; undefined follows it).
// `drag-{id}` plays a whole drag as React Flow does it (start, a move, the final position change, stop) and ends at `flow.state.dropAt` (7,8 unless a test says otherwise).
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    useReactFlow: () => ({
      getIntersectingNodes: flow.getIntersectingNodes, getNodes: flow.getNodes, fitView: flow.fitView,
      setViewport: flow.setViewport, getViewport: flow.getViewport, setCenter: flow.setCenter, getZoom: flow.getZoom,
    }),
    ReactFlow: ({
      nodes, edges, nodeTypes, colorMode, edgesFocusable, nodesDraggable, snapToGrid, snapGrid, selectionKeyCode, multiSelectionKeyCode, children,
      onNodeClick, onNodeDragStart, onNodeDrag, onNodeDragStop, onNodesChange, onNodeMouseEnter, onNodeMouseLeave,
    }: any) => {
      flow.state.nodes = nodes;
      return (
        <div
          data-testid="flow" data-color-mode={colorMode} data-edges-focusable={String(edgesFocusable)} data-nodes-draggable={String(nodesDraggable)}
          data-snap={String(snapToGrid)} data-snap-grid={snapGrid?.join(",")} data-selection-key={String(selectionKeyCode)} data-multi-key={String(multiSelectionKeyCode)}
        >
          {edges.map((e: any) => <i key={e.id} data-edge={e.id} data-animated={String(!!e.animated)} data-class={e.className ?? ""} />)}
          {nodes.map((n: any) => {
            const Node = nodeTypes[n.type];
            const dropped = () => ({ ...n, position: flow.state.dropAt });
            return (
              <div key={n.id} className="react-flow__node" data-id={n.id} data-x={n.position.x} data-y={n.position.y} data-width={n.measured?.width} data-selected={String(!!n.selected)} data-class={n.className ?? ""} data-draggable={String(!!(n.draggable || (nodesDraggable && typeof n.draggable === "undefined")))} onClick={(e) => onNodeClick?.(e, n)}>
                <Node id={n.id} data={n.data} />
                <button data-testid={`measure-${n.id}`} onClick={() => onNodesChange?.([{ id: n.id, type: "dimensions", dimensions: { width: 100, height: 40 } }])} />
                <button data-testid={`select-${n.id}`} onClick={() => onNodesChange?.([{ id: n.id, type: "select", selected: true }])} />
                <button data-testid={`enter-${n.id}`} onClick={(e) => onNodeMouseEnter?.(e, n)} />
                <button data-testid={`leave-${n.id}`} onClick={(e) => onNodeMouseLeave?.(e, n)} />
                <button data-testid={`dragstart-${n.id}`} onClick={(e) => onNodeDragStart?.(e, n, [n])} />
                <button
                  data-testid={`drag-${n.id}`}
                  onClick={(e) => {
                    onNodeDragStart?.(e, n, [n]);
                    onNodeDrag?.(e, dropped(), [dropped()]);
                    onNodesChange?.([{ id: n.id, type: "position", position: flow.state.dropAt, dragging: false }]);
                    onNodeDragStop?.(e, dropped(), [dropped()]);
                  }}
                />
                <button
                  data-testid={`dragwith-${n.id}`}
                  onClick={(e) => {
                    const other = nodes.find((o: any) => o.id === flow.state.partner) ?? nodes.find((o: any) => o.id !== n.id);
                    const at = flow.state.dropAt;
                    // A named partner moves by the same distance, as React Flow moves every node of a selection; the default one lands at 9,9.
                    const along = flow.state.partner
                      ? { x: other.position.x + at.x - n.position.x, y: other.position.y + at.y - n.position.y }
                      : { x: 9, y: 9 };
                    const together = [dropped(), { ...other, position: along }];
                    onNodeDragStart?.(e, n, [n, other]);
                    onNodeDrag?.(e, dropped(), together);
                    onNodeDragStop?.(e, dropped(), together);
                  }}
                />
              </div>
            );
          })}
          {children}
        </div>
      );
    },
    Background: () => null,
    Controls: ({ fitViewOptions }: any) => <div data-testid="controls" data-fit-duration={String(fitViewOptions?.duration)} />,
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
  "GET /api/me": { body: userFor(role) },
  "GET /api/discovery/graph": () => ({ body: typeof model === "function" ? model() : model }),
  "PUT /api/discovery/layout": { status: 204 },
  "DELETE /api/discovery/layout": { status: 204 },
});
const open = () => renderWithProviders(<><DiscoveryPage /><SignedIn /></>, { route: "/discovery", path: "/discovery" });
const node = (id: string) => document.querySelector(`[data-id="${id}"]`) as HTMLElement;

beforeEach(() => {
  flow.state.dropAt = { x: 7, y: 8 };
  flow.state.partner = null;
  flow.state.viewport = { x: 0, y: 0, zoom: 1 };
  flow.fitView.mockClear();
  flow.setViewport.mockClear();
  flow.setCenter.mockClear();
  window.localStorage.removeItem("dcdash.discovery.snap");
});

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

  it("hands React Flow the account's mode, so the graph's own controls and labels follow the page", async () => {
    mockFetch(routes("operator"));
    open();
    await screen.findByText("Plant OPC");
    expect(screen.getByTestId("flow")).toHaveAttribute("data-color-mode", "light");
  });

  it("keeps the edges out of the tab order (they have no visible focus ring); the nodes stay focusable", async () => {
    mockFetch(routes("operator"));
    open();
    await screen.findByText("Plant OPC");
    expect(screen.getByTestId("flow")).toHaveAttribute("data-edges-focusable", "false");
  });

  it("hands React Flow the dark colour mode when the account chose dark", async () => {
    mockFetch({ ...routes("operator"), "GET /api/me": { body: userFor("operator", { preferences: { mode: "dark", theme: "navy-gold" } }) } });
    open();
    await screen.findByText("Plant OPC");
    await waitFor(() => expect(screen.getByTestId("flow")).toHaveAttribute("data-color-mode", "dark"));
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

  it("a source's Details button opens the panel with focus on its heading; Escape and Close hand focus back to the button", async () => {
    mockFetch(routes("operator"));
    open();
    const details = await screen.findByRole("button", { name: "Details for Plant OPC" });
    act(() => details.focus()); // inside act: the wrapper's onFocus updates the highlight
    await userEvent.keyboard("{Enter}");
    const panel = await screen.findByRole("complementary", { name: "Source details" });
    expect(within(panel).getByRole("heading", { name: "Plant OPC" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Details for Plant OPC" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Details for Plant OPC" }));
    await userEvent.click(within(await screen.findByRole("complementary")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Details for Plant OPC" })).toHaveFocus();
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

  it("never sends a node whose id is longer than the server accepts, so one long cluster name cannot sink a save", async () => {
    const longKey = "K".repeat(600);
    const model = graph();
    model.sources[0].clusters.push({ key: longKey, points: [point(7, "K a"), point(8, "K b")] });
    const calls = mockFetch(routes("admin", model));
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Expand Plant OPC" }));
    await userEvent.click(screen.getByTestId(`drag-cluster:1:${longKey}`));
    expect(calls.some((c) => c.method === "PUT")).toBe(false); // nothing left to send
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(node(`cluster:1:${longKey}`)).toHaveAttribute("data-x", "7"); // it still moved on screen
    await userEvent.click(screen.getByTestId(`dragwith-cluster:1:${longKey}`)); // together with another node
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const sent = (calls.find((c) => c.method === "PUT")!.body as { nodes: { node_id: string }[] }).nodes;
    expect(sent).toHaveLength(1);
    expect(sent.every((n) => n.node_id.length <= 512)).toBe(true);
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

  it("the offer does not go away by itself (WCAG 2.2.1): it stays until dismissed, used, or another drag starts", async () => {
    await start("admin");
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId("drag-cluster:1:LVP01"));
      expect(screen.getByRole("status")).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
      expect(screen.getByRole("status")).toHaveTextContent('Create asset "LVP01"');
      fireEvent.click(screen.getByTestId("drag-cluster:1:LVP02")); // a newer offer replaces it
      await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
      expect(screen.getByRole("status")).toHaveTextContent('Create asset "LVP02"');
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
      // These points map as `custom`; the dialog needs a unit for them and prefills it from the point's hint.
      m.sources[0].clusters[0].points = m.sources[0].clusters[0].points.map((p) => ({ ...p, unit_hint: "degC" }));
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

describe("DiscoveryPage look (W6)", () => {
  it("has one h1 in a page header with the hint as its sub line and Refresh in its actions", async () => {
    mockFetch(routes("operator"));
    open();
    await screen.findByText("Plant OPC"); // (the header is there while the graph loads; look at it once the graph is in)
    const title = await screen.findByRole("heading", { level: 1, name: "Discovery" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const header = title.closest("header")!;
    expect(header).toHaveClass("page-head");
    expect(within(header).getByText(/Dashed: discovered/)).toHaveClass("sub");
    expect(within(header.querySelector(".actions") as HTMLElement).getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("with nothing discovered, still has the page's h1 and shows the empty look with the link to Scans", async () => {
    mockFetch(routes("operator", { sources: [], unidentified: [], assets: [], layout: {} }));
    open();
    expect(await screen.findByText(/Nothing discovered yet/)).toBeInTheDocument(); // (the header is there while the graph loads)
    expect(screen.getByRole("heading", { level: 1, name: "Discovery" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing discovered yet/).closest(".empty")).not.toBeNull();
    expect(screen.getByRole("link", { name: "run a scan" })).toHaveAttribute("href", "/scans");
  });
});

describe("DiscoveryPage while the graph loads", () => {
  const LABEL = "Loading the graph";
  const openHeld = (over: Record<string, unknown> = {}) => {
    mockFetch({ ...routes("operator"), ...over } as ReturnType<typeof routes>);
    const held = holdFetch((_method, path) => path === "/api/discovery/graph");
    open();
    return held;
  };

  it("shows the page's own header and the canvas skeleton inside .graph-page with the graph held, then the graph and no region", async () => {
    const page = openHeld();
    const wrapper = document.querySelector(".graph-page")!; // (the shell's 100vh rules key on it)
    expect(wrapper).not.toBeNull();
    const title = screen.getByRole("heading", { level: 1, name: "Discovery" });
    expect(wrapper.contains(title)).toBe(true);
    expect(title.closest("header")).toHaveClass("page-head");
    expect(screen.getByText(/Dashed: discovered/)).toHaveClass("sub");
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument(); // a gap holds its place until the graph is in
    const region = screen.getByText(LABEL).parentElement!;
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveClass("graph-layout");
    expect(wrapper.contains(region)).toBe(true);
    expect(screen.queryByTestId("flow")).not.toBeInTheDocument();
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    page.release();
    expect(await screen.findByText("Plant OPC")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
    expect(document.querySelector(".graph-page")).not.toBeNull();
  });

  it("holds the header's actions column at its real width: the words of the real buttons, hidden, not focusable, not read out, gone when the graph is in", async () => {
    const page = openHeld({}); // an operator has no discovery.edit: Refresh only
    const space = document.querySelector(".page-head .actions .graph-actions-space") as HTMLElement;
    expect(space).not.toBeNull();
    expect(space).toHaveAttribute("aria-hidden", "true");
    expect([...space.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Refresh"]);
    expect([...space.querySelectorAll("button")].every((b) => b.tabIndex === -1)).toBe(true);
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
    page.release();
    await screen.findByText("Plant OPC");
    expect(document.querySelector(".graph-actions-space")).toBeNull();
  });

  it("with discovery.edit the placeholder holds Clear unmapped's words too", async () => {
    mockFetch(routes("admin"));
    const held = holdFetch((_method, path) => path === "/api/discovery/graph");
    open();
    await waitFor(() => { // the permissions arrive while the graph is still held
      const space = document.querySelector(".graph-actions-space") as HTMLElement;
      expect([...space.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Refresh", "Clear unmapped (0)"]);
    });
    held.release();
    await screen.findByText("Plant OPC");
  });

  it("the placeholder is invisible and takes no focus (visibility hidden), so its buttons never show", () => {
    const css = readFileSync("src/styles/discovery-tidy.css", "utf8");
    const rule = /\.graph-actions-space\s*\{([^}]*)\}/.exec(css);
    expect(rule, "a rule for the placeholder").not.toBeNull();
    expect(rule![1]).toMatch(/visibility:\s*hidden/);
    expect(rule![1]).toMatch(/display:\s*flex/);
    expect(rule![1]).toMatch(/gap:\s*8px/);
  });

  it("ends in the error, no region left, when the graph cannot be loaded", async () => {
    mockFetch({ ...routes("operator"), "GET /api/discovery/graph": { status: 500, body: { detail: "graph failed" } } });
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("graph failed");
    expect(document.querySelector(".sk-region")).toBeNull();
  });

  it("ends in the empty state, no region left, when nothing has been discovered", async () => {
    mockFetch(routes("operator", { sources: [], unidentified: [], assets: [], layout: {} }));
    open();
    expect(await screen.findByText(/Nothing discovered yet/)).toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
  });
});

describe("DiscoveryPage controls follow the permissions of the role (a custom role)", () => {
  beforeEach(() => {
    flow.state.intersecting = [];
    flow.getIntersectingNodes.mockClear();
  });

  /** A role called "custom" that holds discovery.view and `permissions`; the graph is up with Plant OPC and LVP01 open and the account is known. */
  const start = async (permissions: PermissionId[]) => {
    const calls = mockFetch({ ...routes("custom"), "GET /api/me": { body: userFor("custom", { permissions: ["discovery.view", ...permissions] }) } });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Expand Plant OPC" }));
    await userEvent.click(screen.getByRole("button", { name: "Expand LVP01" }));
    await accountKnown();
    return calls;
  };
  const drop = async (id: string, onto: { id: string; type: string }[]) => {
    flow.state.intersecting = onto;
    await userEvent.click(screen.getByTestId(`drag-${id}`));
  };
  const puts = (calls: { method: string }[]) => calls.filter((c) => c.method === "PUT");

  it("discovery.view alone: arranges the graph for itself, maps nothing, saves nothing, and its source panel has no Browse", async () => {
    const calls = await start([]);
    expect(screen.queryByRole("button", { name: /to asset…|New asset from/ })).not.toBeInTheDocument();
    await drop("cluster:1:LVP01", [{ id: "asset:11", type: "asset" }]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(node("cluster:1:LVP01")).toHaveAttribute("data-x", "7");
    await drop("cluster:1:LVP02", []);
    expect(screen.queryByRole("status")).not.toBeInTheDocument(); // no "Create asset" offer
    await userEvent.click(screen.getByText("Plant OPC"));
    expect(within(await screen.findByRole("complementary", { name: "Source details" })).queryByRole("button", { name: "Browse again" })).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT" || c.method === "POST")).toBe(false);
  });

  it("discovery.edit: a drag saves the layout, and nothing maps", async () => {
    const calls = await start(["discovery.edit"]);
    expect(screen.queryByRole("button", { name: /to asset…|New asset from/ })).not.toBeInTheDocument();
    await drop("cluster:1:LVP01", [{ id: "asset:11", type: "asset" }]); // onto an asset: only a move, since it cannot map
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]).toMatchObject({ path: "/api/discovery/layout", body: { nodes: [{ node_id: "cluster:1:LVP01", x: 7, y: 8 }] } });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await drop("cluster:1:LVP02", []);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("discovery.accept: the map buttons, the review on a drop and the offer, and no layout save", async () => {
    const calls = await start(["discovery.accept"]);
    expect(screen.getByRole("button", { name: "Map LVP01 to asset…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New asset from LVP01…" })).toBeInTheDocument();
    await drop("cluster:1:LVP01", [{ id: "asset:11", type: "asset" }]);
    expect(await screen.findByRole("dialog", { name: "Review mappings" })).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await drop("cluster:1:LVP02", []);
    expect(await screen.findByRole("status")).toHaveTextContent('Create asset "LVP02" from this cluster?');
    expect(puts(calls)).toHaveLength(0); // a role that may accept results may not change the shared layout
  });

  it("sources.edit: Browse again in the source's panel, and nothing else of the page's admin controls", async () => {
    const calls = await start(["sources.edit"]);
    expect(screen.queryByRole("button", { name: /to asset…|New asset from/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("Plant OPC"));
    const panel = await screen.findByRole("complementary", { name: "Source details" });
    expect(within(panel).getByRole("button", { name: "Browse again" })).toBeInTheDocument();
    await drop("cluster:1:LVP01", []);
    expect(puts(calls)).toHaveLength(0);
  });

  it("all of them: what an administrator has", async () => {
    const calls = await start(["discovery.edit", "discovery.accept", "sources.edit"]);
    expect(screen.getByRole("button", { name: "Map LVP01 to asset…" })).toBeInTheDocument();
    await userEvent.click(screen.getByText("Plant OPC"));
    expect(within(await screen.findByRole("complementary", { name: "Source details" })).getByRole("button", { name: "Browse again" })).toBeInTheDocument();
    await drop("cluster:1:LVP02", []);
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });
});

// ---- W7r: remove and clear unmapped discovered sources, last seen, the click path to create assets ----

const HINT = "Dashed: discovered. Solid: assets. Drag a group onto an asset or press New asset… A node takes its open children along; Alt or Option moves it alone.";
const kw = (id: number, name: string, extra: Partial<GraphPoint> = {}) =>
  point(id, name, { suggestion: { metric: "active_power_kw", scale: 1, interval_seconds: 5, custom_unit: null }, ...extra });
const srcOf = (id: number, name: string, over: Partial<GraphSource> = {}): GraphSource => ({
  id, name, connector_type: "modbus", config: {}, origin: "discovered", enabled: false, status: "unknown", last_error: null, has_secret: false,
  needs_credentials: false, point_count: 2, clusters: [{ key: `${name} A`, points: [kw(id * 10, `${name} kW`)] }], ungrouped: [], ...over,
});
const mappedSource = (id: number, name: string) =>
  srcOf(id, name, { clusters: [{ key: `${name} A`, points: [kw(id * 10, `${name} kW`, { asset_id: 10, mapping_id: id, mapped_metric: "active_power_kw" })] }] });
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const world = (sources: GraphSource[], over: Partial<GraphModel> = {}): GraphModel => ({
  sources, unidentified: [], assets: [{ id: 10, parent_id: null, name: "Site", kind: "generic" }], layout: {}, ...over,
});
/** A page that lets the test change the server's graph and answers the remove route the way the server does (only unmapped discovered sources go). */
function serverWith(role: string, initial: GraphSource[], over: Partial<GraphModel> = {}, extra: Record<string, unknown> = {}) {
  const state = { sources: initial, over };
  const calls = mockFetch({
    ...routes(role, () => world(state.sources, state.over)),
    "GET /api/site": { body: { timezone: "UTC", currency: null } },
    "POST /api/discovery/sources/remove": ({ body }) => {
      const ids = (body as { source_ids: number[] }).source_ids;
      const removed: { id: number; name: string }[] = [];
      const skipped: { id: number; name: string | null; reason: "mapped" | "manual" | "gone" }[] = [];
      for (const id of ids) {
        const s = state.sources.find((x) => x.id === id);
        if (!s) skipped.push({ id, name: null, reason: "gone" });
        else if (s.origin !== "discovered") skipped.push({ id, name: s.name, reason: "manual" });
        else if (s.clusters.some((c) => c.points.some((p) => p.mapping_id !== null))) skipped.push({ id, name: s.name, reason: "mapped" });
        else removed.push({ id, name: s.name });
      }
      state.sources = state.sources.filter((s) => !removed.some((r) => r.id === s.id));
      return { body: { removed, skipped } };
    },
    ...extra,
  });
  return { state, calls };
}
const openToasts = (route = "/discovery") => {
  const toasts = spyToasts();
  const view = renderWithProviders(<><main id="main" tabIndex={-1} /><DiscoveryPage /><SignedIn /></>, { route, path: "/discovery", toasts: toasts.api });
  return { ...view, toasts };
};
const removeButton = (name: string) => screen.findByRole("button", { name: `Remove ${name} from Discovery` });
const clearButton = (n: number) => screen.getByRole("button", { name: `Clear unmapped (${n})` });
const confirmDialog = (name: string) => screen.findByRole("dialog", { name });
const removeCalls = (calls: { method: string; path: string; body?: unknown }[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/discovery/sources/remove");

describe("DiscoveryPage hint and last seen (W7r)", () => {
  it("the sub line says to drag a group onto an asset or press New asset…, that a node takes its open children along and that Alt or Option moves it alone", async () => {
    serverWith("operator", [srcOf(1, "Plant OPC")]);
    openToasts();
    await screen.findByText("Plant OPC");
    expect(screen.getByText(/Dashed: discovered/)).toHaveTextContent(HINT);
  });

  it("the hint is short (at most 150 characters, so it keeps to a line or two under the title) and names the Alt and Option keys", () => {
    expect(HINT.length).toBeLessThanOrEqual(150);
    expect(HINT).toContain("Alt or Option");
  });

  it("every source says when it was last seen: the scan and how long ago, added by hand, or not seen yet", async () => {
    serverWith("operator", [
      srcOf(1, "Plant OPC", { last_scan: { scan_id: 6, at: minutesAgo(10) } }),
      srcOf(2, "Bench", { origin: "manual", last_scan: { scan_id: 6, at: minutesAgo(10) } }),
      srcOf(3, "Rack 7", { last_scan: null }),
      srcOf(4, "Old", { last_scan: { scan_id: 2, at: "2026-01-01T00:00:00Z" } }),
    ]);
    openToasts();
    await screen.findByText("Plant OPC");
    expect(within(node("src:1")).getByText("Seen in scan #6, 10 min ago")).toHaveClass("gnode-seen");
    expect(within(node("src:2")).getByText("Added by hand")).toBeInTheDocument();
    expect(within(node("src:3")).getByText("Not seen in a scan yet")).toBeInTheDocument();
    expect(within(node("src:4")).getByText("Seen in scan #2")).toBeInTheDocument(); // over two weeks: the scan, no ago part
  });

  it("the source panel shows the same line", async () => {
    serverWith("operator", [srcOf(1, "Plant OPC", { last_scan: { scan_id: 6, at: minutesAgo(10) } })]);
    openToasts();
    await userEvent.click(await screen.findByRole("button", { name: "Details for Plant OPC" }));
    const panel = await screen.findByRole("complementary", { name: "Source details" });
    expect(within(panel).getByText("Seen in scan #6, 10 min ago")).toBeInTheDocument();
  });

  it("counts the time on the site's clock (a time zone the site was set to)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T00:10:00Z"));
    try {
      mockFetch({ ...routes("operator", world([srcOf(1, "Plant OPC", { last_scan: { scan_id: 6, at: "2026-10-14T23:50:00Z" } })])), "GET /api/site": { body: { timezone: "Asia/Dubai", currency: null } } });
      openToasts();
      // 23:50 UTC is 03:50 on the 15th in Dubai and 00:10 UTC is 04:10 the same day: 20 minutes, not "yesterday"
      expect(await screen.findByText("Seen in scan #6, 20 min ago")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DiscoveryPage Remove (W7r)", () => {
  const two = () => [srcOf(1, "Plant OPC"), srcOf(2, "Rack 7")];

  it("a role that may edit the graph sees Remove on a discovered source with nothing mapped, and no one else does", async () => {
    serverWith("admin", [srcOf(1, "Plant OPC"), mappedSource(2, "Lab"), srcOf(3, "Bench", { origin: "manual" })]);
    openToasts();
    const remove = await removeButton("Plant OPC");
    expect(remove.textContent).toBe(""); // the bin alone: its name is the label, its tooltip the title
    expect(remove).toHaveAttribute("title", "Remove");
    expect(remove.querySelector("svg.i")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Lab from Discovery" })).not.toBeInTheDocument(); // something is mapped
    expect(screen.queryByRole("button", { name: "Remove Bench from Discovery" })).not.toBeInTheDocument(); // added by hand
  });

  it.each([
    ["operator (discovery.view)", "operator", undefined],
    ["discovery.accept alone", "custom", ["discovery.view", "discovery.accept"] as PermissionId[]],
    ["sources.edit alone", "custom", ["discovery.view", "sources.edit"] as PermissionId[]],
  ])("%s sees neither Remove nor Clear unmapped", async (_name, role, permissions) => {
    mockFetch({
      ...routes(role, world([srcOf(1, "Plant OPC")])),
      ...(permissions ? { "GET /api/me": { body: userFor(role, { permissions }) } } : {}),
      "GET /api/site": { body: { timezone: "UTC", currency: null } },
    });
    openToasts();
    await screen.findByText("Plant OPC");
    await accountKnown();
    expect(screen.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Clear unmapped/ })).not.toBeInTheDocument();
  });

  it("discovery.edit alone sees Remove and Clear unmapped, but not Create assets", async () => {
    mockFetch({
      ...routes("custom", world([srcOf(1, "Plant OPC")])),
      "GET /api/me": { body: userFor("custom", { permissions: ["discovery.view", "discovery.edit"] }) },
      "GET /api/site": { body: { timezone: "UTC", currency: null } },
    });
    openToasts();
    expect(await removeButton("Plant OPC")).toBeInTheDocument();
    expect(clearButton(1)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Create assets/ })).not.toBeInTheDocument();
  });

  it("asks first, in the delete dialog: what it takes, that nothing depends on it, and that a scan can find it again", async () => {
    const { calls } = serverWith("admin", two());
    openToasts();
    await userEvent.click(await removeButton("Plant OPC"));
    const dialog = await confirmDialog('Remove "Plant OPC" from Discovery?');
    expect(dialog).toHaveTextContent("It has nothing mapped, so no asset, billing figure or dashboard depends on it. A scan can find it again.");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(removeCalls(calls)).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(removeCalls(calls)).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Remove Plant OPC from Discovery" })).toHaveFocus(); // Cancel hands the focus back to the button
  });

  it("confirming sends the one id, takes the node away, toasts, closes the dialog and puts the focus on Refresh", async () => {
    const { calls } = serverWith("admin", two());
    const { toasts } = openToasts();
    await userEvent.click(await removeButton("Plant OPC"));
    await userEvent.click(within(await confirmDialog('Remove "Plant OPC" from Discovery?')).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(removeCalls(calls)[0].body).toEqual({ source_ids: [1] });
    expect(screen.queryByText("Plant OPC")).not.toBeInTheDocument();
    expect(screen.getByText("Rack 7")).toBeInTheDocument();
    expect(toasts.calls).toEqual([{ kind: "success", text: "Removed 1 source" }]);
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveFocus();
    // the graph, the sources list and the audit log were read again (the graph at least: the node is gone)
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/discovery/graph")).toHaveLength(2);
  });

  it("a removed source closes its open panel", async () => {
    serverWith("admin", two());
    openToasts();
    await userEvent.click(await screen.findByRole("button", { name: "Details for Plant OPC" }));
    expect(await screen.findByRole("complementary", { name: "Source details" })).toBeInTheDocument();
    await userEvent.click(await removeButton("Plant OPC"));
    await userEvent.click(within(await confirmDialog('Remove "Plant OPC" from Discovery?')).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("complementary")).not.toBeInTheDocument());
  });

  it("Escape closes only the dialog: the source panel behind it stays open", async () => {
    serverWith("admin", two());
    openToasts();
    await userEvent.click(await screen.findByRole("button", { name: "Details for Plant OPC" }));
    await screen.findByRole("complementary", { name: "Source details" });
    await userEvent.click(await removeButton("Plant OPC"));
    await confirmDialog('Remove "Plant OPC" from Discovery?');
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Source details" })).toBeInTheDocument();
  });

  it("a source that gained a mapping meanwhile is kept: the dialog closes with an error toast that says why", async () => {
    const { state } = serverWith("admin", [srcOf(1, "Plant OPC")]);
    const { toasts } = openToasts();
    await userEvent.click(await removeButton("Plant OPC"));
    const dialog = await confirmDialog('Remove "Plant OPC" from Discovery?');
    state.sources = [mappedSource(1, "Plant OPC"), srcOf(2, "Rack 7")]; // the other tab mapped it, and a second source is there now
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    // nothing was removed: the dialog stays open and says so as its error, with no toast
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Nothing was removed. 1 was kept: it has a mapped point now.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(toasts.calls).toEqual([]);
    expect(screen.getByText("Rack 7")).toBeInTheDocument();
  });

  it("a running scan (409) is the dialog's error line, and nothing is removed", async () => {
    const { state } = serverWith("admin", two(), {}, {
      "POST /api/discovery/sources/remove": { status: 409, body: { detail: "A scan is running. Remove discovered sources when it has finished." } },
    });
    const { toasts } = openToasts();
    await userEvent.click(await removeButton("Plant OPC"));
    const dialog = await confirmDialog('Remove "Plant OPC" from Discovery?');
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A scan is running. Remove discovered sources when it has finished.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(toasts.calls).toEqual([]);
    expect(state.sources).toHaveLength(2);
    expect(screen.getByText("Plant OPC")).toBeInTheDocument();
  });
});

describe("DiscoveryPage Clear unmapped (W7r)", () => {
  const some = () => [srcOf(1, "Plant OPC"), srcOf(2, "Rack 7"), mappedSource(3, "Lab"), srcOf(4, "Bench", { origin: "manual" })];

  it("sits beside Refresh in the header and counts the sources it would remove", async () => {
    serverWith("admin", some());
    openToasts();
    await screen.findByText("Plant OPC");
    const actions = document.querySelector(".page-head .actions") as HTMLElement;
    expect(within(actions).getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: "Clear unmapped (2)" })).toHaveAttribute("type", "button");
  });

  it("with nothing to clear it keeps its place, is aria-disabled with a title, never natively disabled, and opens nothing", async () => {
    serverWith("admin", [mappedSource(3, "Lab")]);
    openToasts();
    await screen.findByText("Lab");
    const clear = clearButton(0);
    expect(clear).toHaveAttribute("aria-disabled", "true");
    expect(clear).toHaveAttribute("title", "Nothing to clear");
    expect(clear).not.toBeDisabled();
    await userEvent.click(clear);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    clear.focus();
    expect(clear).toHaveFocus();
  });

  it("lists the first five names and the rest as a count, and says that mapped sources are never touched", async () => {
    const seven = Array.from({ length: 7 }, (_, i) => srcOf(i + 1, `Unit ${i + 1}`));
    serverWith("admin", seven);
    openToasts();
    await screen.findByText("Unit 1");
    await userEvent.click(clearButton(7));
    const dialog = await confirmDialog("Remove 7 unmapped sources?");
    expect(dialog).toHaveTextContent("Unit 1, Unit 2, Unit 3, Unit 4, Unit 5 and 2 more.");
    expect(dialog).toHaveTextContent("Sources with a mapped point are never touched. A scan can find these again.");
    expect(dialog).not.toHaveTextContent("Unit 6");
  });

  it("two sources are named in full", async () => {
    serverWith("admin", [srcOf(1, "Plant OPC"), srcOf(2, "Rack 7")]);
    openToasts();
    await userEvent.click(await screen.findByRole("button", { name: "Clear unmapped (2)" }));
    expect(await confirmDialog("Remove 2 unmapped sources?")).toHaveTextContent("Plant OPC and Rack 7.");
  });

  it("sends the ids it listed when the dialog opened: a source a scan adds afterwards is never in the request", async () => {
    const { state, calls } = serverWith("admin", [srcOf(1, "Plant OPC"), srcOf(2, "Rack 7")]);
    openToasts();
    await userEvent.click(await screen.findByRole("button", { name: "Clear unmapped (2)" }));
    const dialog = await confirmDialog("Remove 2 unmapped sources?");
    state.sources = [...state.sources, srcOf(9, "Found later")];
    await userEvent.click(screen.getByRole("button", { name: "Refresh" })); // the graph is read again behind the dialog
    await screen.findByText("Found later");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(removeCalls(calls)[0].body).toEqual({ source_ids: [1, 2] });
    expect(screen.getByText("Found later")).toBeInTheDocument();
  });

  it("removes them, says how many, and hands the focus back to the Clear button (now aria-disabled)", async () => {
    const { calls } = serverWith("admin", some());
    const { toasts } = openToasts();
    await userEvent.click(await screen.findByRole("button", { name: "Clear unmapped (2)" }));
    await userEvent.click(within(await confirmDialog("Remove 2 unmapped sources?")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(removeCalls(calls)[0].body).toEqual({ source_ids: [1, 2] });
    expect(toasts.calls).toEqual([{ kind: "success", text: "Removed 2 sources" }]);
    expect(screen.queryByText("Plant OPC")).not.toBeInTheDocument();
    expect(screen.getByText("Lab")).toBeInTheDocument();
    const clear = clearButton(0);
    expect(clear).toHaveAttribute("aria-disabled", "true");
    expect(clear).toHaveFocus();
  });

  it("when one of them gained a mapping meanwhile, the rest go, and an error toast says why one stayed", async () => {
    const { state } = serverWith("admin", [srcOf(1, "Plant OPC"), srcOf(2, "Rack 7")]);
    const { toasts } = openToasts();
    await userEvent.click(await screen.findByRole("button", { name: "Clear unmapped (2)" }));
    const dialog = await confirmDialog("Remove 2 unmapped sources?");
    state.sources = [mappedSource(1, "Plant OPC"), srcOf(2, "Rack 7")];
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(toasts.calls).toEqual([{ kind: "error", text: "Removed 1 source. 1 was kept: it has a mapped point now." }]);
    expect(screen.queryByText("Rack 7")).not.toBeInTheDocument();
    expect(screen.getByText("Plant OPC")).toBeInTheDocument();
  });

  it("Escape and Cancel remove nothing", async () => {
    const { calls } = serverWith("admin", some());
    openToasts();
    await userEvent.click(await screen.findByRole("button", { name: "Clear unmapped (2)" }));
    await confirmDialog("Remove 2 unmapped sources?");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(removeCalls(calls)).toHaveLength(0);
    expect(clearButton(2)).toHaveFocus();
  });

  it("a clear that empties the graph leaves the empty page, and the focus goes to the main area without scrolling", async () => {
    serverWith("admin", [srcOf(1, "Plant OPC")]);
    openToasts();
    const main = document.getElementById("main") as HTMLElement;
    const focus = vi.spyOn(main, "focus");
    await userEvent.click(await screen.findByRole("button", { name: "Clear unmapped (1)" }));
    await userEvent.click(within(await confirmDialog('Remove "Plant OPC" from Discovery?')).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText(/Nothing discovered yet/)).toBeInTheDocument();
    await waitFor(() => expect(main).toHaveFocus());
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not move the focus to the main area when the page was empty from the start", async () => {
    serverWith("admin", []);
    openToasts();
    expect(await screen.findByText(/Nothing discovered yet/)).toBeInTheDocument();
    expect(document.getElementById("main")).not.toHaveFocus();
  });
});

describe("DiscoveryPage Create assets (W7r)", () => {
  const three = () => srcOf(1, "Plant OPC", { clusters: [
    { key: "LVP01", points: [kw(11, "LVP01 kW")] }, { key: "LVP02", points: [kw(12, "LVP02 kW")] }, { key: "LVP03", points: [kw(13, "LVP03 kW")] },
  ] });
  beforeEach(() => { bulk.props.length = 0; });

  it("a collapsed source offers Create assets… with its number of groups, and it opens the dialog for that source", async () => {
    serverWith("admin", [three()]);
    openToasts();
    const button = await screen.findByRole("button", { name: "Create assets for 3 groups of Plant OPC" });
    expect(button).toHaveTextContent("Create assets…");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(await screen.findByRole("dialog", { name: "Create assets stub" })).toBeInTheDocument();
    const props = bulk.props[bulk.props.length - 1];
    expect(props.source.id).toBe(1);
    expect(props.source.clusters.map((c) => c.key)).toEqual(["LVP01", "LVP02", "LVP03"]);
    expect(props.model.sources.map((s) => s.id)).toEqual([1]);
  });

  it("is not offered to a role without discovery.accept, even for a source with groups to map", async () => {
    mockFetch({
      ...routes("custom", world([three()])),
      "GET /api/me": { body: userFor("custom", { permissions: ["discovery.view", "discovery.edit"] }) },
      "GET /api/site": { body: { timezone: "UTC", currency: null } },
    });
    openToasts();
    await screen.findByText("Plant OPC");
    await accountKnown();
    expect(screen.queryByRole("button", { name: /^Create assets/ })).not.toBeInTheDocument();
  });

  it("is not offered when no group is left to map (Ungrouped only, a custom guess with no unit, or everything mapped)", async () => {
    serverWith("admin", [
      srcOf(1, "Ungrouped only", { clusters: [], ungrouped: [kw(21, "loose kW")] }),
      srcOf(2, "No unit", { clusters: [{ key: "G", points: [point(22, "G a")] }] }), // custom, no unit: the dialog would refuse the whole group
      mappedSource(3, "Lab"),
    ]);
    openToasts();
    await screen.findByText("Ungrouped only");
    expect(screen.queryByRole("button", { name: /^Create assets/ })).not.toBeInTheDocument();
  });

  it("closing the dialog puts the focus back on the Create assets… button", async () => {
    serverWith("admin", [three()]);
    openToasts();
    await userEvent.click(await screen.findByRole("button", { name: "Create assets for 3 groups of Plant OPC" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Create assets stub" })).getByRole("button", { name: "Close stub" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create assets for 3 groups of Plant OPC" })).toHaveFocus();
  });

  it("when every group has been made into an asset the button is gone, and the focus goes to the node's Details button", async () => {
    const { state } = serverWith("admin", [three()]);
    openToasts();
    await userEvent.click(await screen.findByRole("button", { name: "Create assets for 3 groups of Plant OPC" }));
    const dialog = await screen.findByRole("dialog", { name: "Create assets stub" });
    state.sources = [srcOf(1, "Plant OPC", { clusters: three().clusters.map((c) => ({ key: c.key, points: c.points.map((p) => ({ ...p, asset_id: 10, mapping_id: p.id, mapped_metric: "active_power_kw" as const })) })) })];
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Create assets/ })).not.toBeInTheDocument());
    await userEvent.click(within(dialog).getByRole("button", { name: "Close stub" }));
    expect(screen.getByRole("button", { name: "Details for Plant OPC" })).toHaveFocus();
  });
});

// ---- W7t: children follow their parent, Alt, Tidy layout, the summary bar, collapse and expand all ----

describe("DiscoveryPage children, Alt and the places that follow (W7t)", () => {
  /** Source 1 stands at 10,20; its group LVP02 and that group's point 3 have places of their own (500,300 and 800,340). */
  const placed = () => graph({ layout: { "src:1": { x: 10, y: 20 }, "cluster:1:LVP02": { x: 500, y: 300 }, "point:3": { x: 800, y: 340 } } });
  const puts = <T extends { method: string }>(calls: T[]) => calls.filter((c) => c.method === "PUT");
  const at = (id: string) => [Number(node(id).dataset.x), Number(node(id).dataset.y)];
  const expand = async (name: string) => userEvent.click(await screen.findByRole("button", { name: `Expand ${name}` }));
  const body = (call: { body?: unknown }) => (call.body as { nodes: { node_id: string; x: number; y: number }[] }).nodes;

  it("dragging a source takes its open group and points along by the same distance; only the source is saved (the rest follow by the rule)", async () => {
    const calls = mockFetch(routes("admin"));
    open();
    await expand("Plant OPC");
    await expand("LVP01");
    const before = ["cluster:1:LVP01", "cluster:1:LVP02", "cluster:1:__ungrouped__", "point:1", "point:2", "asset:10", "unid:10.0.0.9:8080"].map(at);
    flow.state.dropAt = { x: 100, y: 50 }; // the source stood at 0,0
    await userEvent.click(screen.getByTestId("drag-src:1"));
    const after = ["cluster:1:LVP01", "cluster:1:LVP02", "cluster:1:__ungrouped__", "point:1", "point:2", "asset:10", "unid:10.0.0.9:8080"].map(at);
    expect(after.slice(0, 5)).toEqual(before.slice(0, 5).map(([x, y]) => [x + 100, y + 50]));
    expect(after.slice(5)).toEqual(before.slice(5)); // nodes that are not under it stay
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(body(puts(calls)[0])).toEqual([{ node_id: "src:1", x: 100, y: 50 }]);
  });

  it("the followers keep their offset when the graph is rebuilt afterwards (collapse, expand): the rule puts them beside their parent", async () => {
    mockFetch(routes("operator"));
    open();
    await expand("Plant OPC");
    await expand("LVP01");
    const before = at("point:1");
    flow.state.dropAt = { x: 100, y: 50 };
    await userEvent.click(screen.getByTestId("drag-src:1"));
    await userEvent.click(screen.getByRole("button", { name: "Collapse LVP01" }));
    await userEvent.click(screen.getByRole("button", { name: "Expand LVP01" }));
    expect(at("point:1")).toEqual([before[0] + 100, before[1] + 50]);
  });

  it("the places of children that are hidden or saved move with it, in ONE request (the dragged node first)", async () => {
    const calls = mockFetch(routes("admin", placed()));
    open();
    await expand("Plant OPC"); // the groups are drawn, their points are not: point 3 is hidden and has a place of its own
    await userEvent.click(screen.getByTestId("drag-src:1")); // 10,20 -> 7,8: by -3,-12
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(body(puts(calls)[0])).toEqual([
      { node_id: "src:1", x: 7, y: 8 }, { node_id: "cluster:1:LVP02", x: 497, y: 288 }, { node_id: "point:3", x: 797, y: 328 },
    ]);
    expect(at("cluster:1:LVP02")).toEqual([497, 288]); // the drawn one moved on screen too
  });

  it("a role that may not change the shared layout sends nothing, but remembers the hidden places: opening the group puts its point beside it", async () => {
    const calls = mockFetch(routes("operator", placed()));
    open();
    await expand("Plant OPC");
    await userEvent.click(screen.getByTestId("drag-src:1"));
    await expand("LVP02");
    expect(at("point:3")).toEqual([797, 328]);
    expect(at("cluster:1:LVP02")).toEqual([497, 288]);
    expect(puts(calls)).toHaveLength(0);
  });

  it("two drags in a row with no re-read in between: the second works from where the first left every place", async () => {
    const calls = mockFetch(routes("admin", placed()));
    open();
    await expand("Plant OPC");
    await userEvent.click(screen.getByTestId("drag-src:1")); // 10,20 -> 7,8
    flow.state.dropAt = { x: 0, y: 0 };
    await userEvent.click(screen.getByTestId("drag-src:1")); // 7,8 -> 0,0: by -7,-8
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(body(puts(calls)[1])).toEqual([
      { node_id: "src:1", x: 0, y: 0 }, { node_id: "cluster:1:LVP02", x: 490, y: 280 }, { node_id: "point:3", x: 790, y: 320 },
    ]);
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/discovery/graph")).toHaveLength(1);
    await expand("LVP02");
    expect(at("point:3")).toEqual([790, 320]); // opening the group later puts the point where the second drag left it
  });

  it("a source dragged together with its own group shifts every place once, and each is sent once", async () => {
    const calls = mockFetch(routes("admin", placed()));
    open();
    await expand("Plant OPC");
    flow.state.partner = "cluster:1:LVP02";
    await userEvent.click(screen.getByTestId("dragwith-src:1")); // both move by -3,-12
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    const sent = body(puts(calls)[0]);
    expect(sent.map((n) => n.node_id).sort()).toEqual(["cluster:1:LVP02", "point:3", "src:1"]);
    expect(sent.find((n) => n.node_id === "point:3")).toEqual({ node_id: "point:3", x: 797, y: 328 }); // not 794,316
    expect(sent.find((n) => n.node_id === "cluster:1:LVP02")).toEqual({ node_id: "cluster:1:LVP02", x: 497, y: 288 });
  });

  it("dragging a group never moves its source, and a group dragged away keeps its place when the source is dragged later", async () => {
    const calls = mockFetch(routes("admin"));
    open();
    await expand("Plant OPC");
    const source = at("src:1");
    await userEvent.click(screen.getByTestId("drag-cluster:1:LVP02")); // to 7,8
    expect(at("src:1")).toEqual(source);
    flow.state.dropAt = { x: 50, y: 50 };
    await userEvent.click(screen.getByTestId("drag-src:1")); // by +50,+50
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(body(puts(calls)[1])).toEqual([{ node_id: "src:1", x: 50, y: 50 }, { node_id: "cluster:1:LVP02", x: 57, y: 58 }]);
  });

  it("an Alt drag moves the node alone: the saved places of its hidden children stay, and only the node is sent", async () => {
    const calls = mockFetch(routes("admin", placed()));
    open();
    await screen.findByText("Plant OPC");
    fireEvent.click(screen.getByTestId("drag-src:1"), { altKey: true });
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(body(puts(calls)[0])).toEqual([{ node_id: "src:1", x: 7, y: 8 }]);
  });

  it("an Alt drag leaves the drawn children where they stand, and gives each one without a place the place it stands at (else it would follow at the next rebuild)", async () => {
    const calls = mockFetch(routes("admin", placed()));
    open();
    await expand("Plant OPC");
    const [lvp01, ungrouped] = [at("cluster:1:LVP01"), at("cluster:1:__ungrouped__")];
    fireEvent.click(screen.getByTestId("drag-src:1"), { altKey: true });
    expect(at("cluster:1:LVP01")).toEqual(lvp01);
    expect(at("cluster:1:LVP02")).toEqual([500, 300]);
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(body(puts(calls)[0])).toEqual([
      { node_id: "src:1", x: 7, y: 8 }, { node_id: "cluster:1:LVP01", x: lvp01[0], y: lvp01[1] }, { node_id: "cluster:1:__ungrouped__", x: ungrouped[0], y: ungrouped[1] },
    ]);
    await expand("LVP01"); // a rebuild
    expect(at("cluster:1:LVP01")).toEqual(lvp01);
    expect(at("src:1")).toEqual([7, 8]);
  });

  it("a plain drag after an Alt drag takes the pinned children along again", async () => {
    mockFetch(routes("operator"));
    open();
    await expand("Plant OPC");
    const lvp01 = at("cluster:1:LVP01");
    fireEvent.click(screen.getByTestId("drag-src:1"), { altKey: true }); // to 7,8; the group stays
    flow.state.dropAt = { x: 17, y: 28 };
    await userEvent.click(screen.getByTestId("drag-src:1")); // by +10,+20
    expect(at("cluster:1:LVP01")).toEqual([lvp01[0] + 10, lvp01[1] + 20]);
  });

  it("dropping a group on an asset puts the group AND its open points back, and saves and remembers nothing", async () => {
    const calls = mockFetch(routes("admin"));
    open();
    await expand("Plant OPC");
    await expand("LVP01");
    const before = ["cluster:1:LVP01", "point:1", "point:2"].map(at);
    flow.state.intersecting = [{ id: "asset:11", type: "asset" }];
    await userEvent.click(screen.getByTestId("drag-cluster:1:LVP01"));
    await screen.findByRole("dialog", { name: "Review mappings" });
    expect(["cluster:1:LVP01", "point:1", "point:2"].map(at)).toEqual(before);
    expect(puts(calls)).toHaveLength(0);
  });

  it("a layout of more than 2000 places goes in several requests, one after the other", async () => {
    const model = graph();
    const keys = Array.from({ length: 2100 }, (_, i) => `K${i}`);
    model.sources[0].clusters = keys.map((key, i) => ({ key, points: [point(1000 + i, `${key} p`)] }));
    model.layout = { "src:1": { x: 0, y: 0 }, ...Object.fromEntries(keys.map((key, i) => [`cluster:1:${key}`, { x: i, y: i }])) };
    const calls = mockFetch(routes("admin", model));
    open();
    await screen.findByText("Plant OPC");
    await userEvent.click(screen.getByTestId("drag-src:1")); // collapsed: all 2100 groups are hidden, each with a place of its own
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(puts(calls).map((c) => body(c).length)).toEqual([2000, 101]); // the source and the 2100 groups
    expect(body(puts(calls)[0])[0].node_id).toBe("src:1");
  });
});

describe("DiscoveryPage Tidy layout, the bar, collapse and expand all (W7t)", () => {
  const placed = () => graph({ layout: { "src:1": { x: 10, y: 20 }, "cluster:1:LVP02": { x: 500, y: 300 } } });
  const at = (id: string) => [Number(node(id).dataset.x), Number(node(id).dataset.y)];
  const expand = async (name: string) => userEvent.click(await screen.findByRole("button", { name: `Expand ${name}` }));
  const tidyButton = () => screen.getByRole("button", { name: "Tidy layout" });
  const calls_of = (calls: { method: string; path: string }[], method: string) => calls.filter((c) => c.method === method && c.path === "/api/discovery/layout");
  const graphReads = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method === "GET" && c.path === "/api/discovery/graph").length;

  it("with discovery.edit it asks first, then deletes the saved layout for everyone, shows the default columns and fits the view by the opening rules", async () => {
    let layout = placed().layout;
    const calls = mockFetch({
      ...routes("admin", () => graph({ layout })),
      "DELETE /api/discovery/layout": () => { layout = {}; return { status: 204 }; },
    });
    open();
    await screen.findByText("Plant OPC");
    expect(at("src:1")).toEqual([10, 20]);
    await userEvent.click(tidyButton());
    const dialog = await screen.findByRole("dialog", { name: "Tidy the layout for everyone?" });
    expect(dialog).toHaveTextContent("Every node goes back to its default column for all users. Nothing else changes.");
    expect(calls_of(calls, "DELETE")).toHaveLength(0);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Tidy for everyone" }));
    await waitFor(() => expect(flow.fitView).toHaveBeenCalled());
    expect(calls_of(calls, "DELETE")).toHaveLength(1);
    expect(at("src:1")).toEqual([0, 0]);
    expect(graphReads(calls)).toBe(2); // the graph was read again
    expect(flow.fitView).toHaveBeenCalledWith(expect.objectContaining({ minZoom: 0.75, maxZoom: 1, padding: 0.2, nodes: [{ id: "src:1" }] }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(tidyButton()).toHaveFocus(); // the dialog handed the focus back
  });

  it("a Cancel sends nothing and changes nothing", async () => {
    const calls = mockFetch(routes("admin", placed()));
    open();
    await screen.findByText("Plant OPC");
    await userEvent.click(tidyButton());
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(calls_of(calls, "DELETE")).toHaveLength(0);
    expect(at("src:1")).toEqual([10, 20]);
    expect(flow.fitView).not.toHaveBeenCalled();
  });

  it("the question is not asked twice, and the button waits (aria-disabled, never disabled) while it is open", async () => {
    mockFetch(routes("admin", placed()));
    open();
    await screen.findByText("Plant OPC");
    await userEvent.click(tidyButton());
    await screen.findByRole("dialog");
    expect(tidyButton()).toHaveAttribute("aria-disabled", "true");
    expect(tidyButton()).not.toBeDisabled();
  });

  it("nothing can be dragged while a Tidy runs (the question open, the DELETE in flight), and it can again afterwards", async () => {
    const calls = mockFetch({ ...routes("admin", placed()), "DELETE /api/discovery/layout": { status: 204 } });
    const draggable = () => screen.getByTestId("flow").dataset.nodesDraggable;
    // What React Flow really decides per node: a node's own `draggable` beats the canvas-wide switch, so NO node may carry its own `true`.
    const nodeFlags = () => [...document.querySelectorAll<HTMLElement>("[data-testid=flow] [data-id]")].map((el) => el.dataset.draggable);
    open();
    await screen.findByText("Plant OPC");
    await expand("Plant OPC"); // a source with its groups: several nodes
    expect(draggable()).toBe("true");
    expect(nodeFlags().length).toBeGreaterThan(2);
    expect(new Set(nodeFlags())).toEqual(new Set(["true"]));
    const held = holdFetch((method, path) => method === "DELETE" && path === "/api/discovery/layout");
    await userEvent.click(tidyButton());
    const dialog = await screen.findByRole("dialog", { name: "Tidy the layout for everyone?" });
    expect(draggable()).toBe("false"); // the question is open
    expect(new Set(nodeFlags())).toEqual(new Set(["false"])); // and no node can be dragged
    await userEvent.click(within(dialog).getByRole("button", { name: "Tidy for everyone" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls_of(calls, "DELETE")).toHaveLength(0); // the DELETE is held: in flight
    expect(draggable()).toBe("false");
    expect(new Set(nodeFlags())).toEqual(new Set(["false"]));
    held.release();
    await waitFor(() => expect(flow.fitView).toHaveBeenCalled());
    await waitFor(() => expect(draggable()).toBe("true"));
    expect(new Set(nodeFlags())).toEqual(new Set(["true"]));
    expect(calls_of(calls, "DELETE")).toHaveLength(1);
  });

  it("a Cancel on the question gives the drag back too", async () => {
    mockFetch(routes("admin", placed()));
    open();
    await screen.findByText("Plant OPC");
    await userEvent.click(tidyButton());
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByTestId("flow").dataset.nodesDraggable).toBe("true"));
  });

  it("waits for the drag still being saved: the DELETE reaches the server after the PUT", async () => {
    const calls = mockFetch(routes("admin", placed()));
    const held = holdFetch((method) => method === "PUT");
    open();
    await screen.findByText("Plant OPC");
    await userEvent.click(screen.getByTestId("drag-src:1"));
    await userEvent.click(tidyButton());
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Tidy for everyone" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls_of(calls, "DELETE")).toHaveLength(0); // the PUT has not got through yet
    held.release();
    await waitFor(() => expect(calls_of(calls, "DELETE")).toHaveLength(1));
    expect(calls.map((c) => c.method).filter((m) => m === "PUT" || m === "DELETE")).toEqual(["PUT", "DELETE"]);
    await waitFor(() => expect(flow.fitView).toHaveBeenCalled());
  });

  it("the old layout does not flash back: the places are gone as soon as the route answers, before the graph is read again", async () => {
    const calls = mockFetch({ ...routes("admin", placed()) });
    open();
    await expand("Plant OPC");
    await userEvent.click(screen.getByTestId("drag-src:1")); // to 7,8
    const held = holdFetch((method, path) => method === "GET" && path === "/api/discovery/graph");
    await userEvent.click(tidyButton());
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Tidy for everyone" }));
    await waitFor(() => expect(calls_of(calls, "DELETE")).toHaveLength(1));
    await waitFor(() => expect(at("src:1")).toEqual([0, 0])); // while the read is still held
    expect(at("cluster:1:LVP02")).not.toEqual([500, 300]);
    held.release();
    await waitFor(() => expect(flow.fitView).toHaveBeenCalled());
  });

  it("a refusal shows the server's reason in the error line and leaves every node where it was, with no refit", async () => {
    mockFetch({ ...routes("admin", placed()), "DELETE /api/discovery/layout": { status: 403, body: { detail: "You may not change the layout." } } });
    open();
    await screen.findByText("Plant OPC");
    await userEvent.click(screen.getByTestId("drag-src:1")); // to 7,8
    await userEvent.click(tidyButton());
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Tidy for everyone" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You may not change the layout.");
    expect(at("src:1")).toEqual([7, 8]);
    expect(flow.fitView).not.toHaveBeenCalled();
    expect(tidyButton()).not.toHaveAttribute("aria-disabled");
  });

  it("every Tidy rebuilds the nodes: drag, Tidy, drag, Tidy puts them back each time", async () => {
    mockFetch(routes("admin"));
    open();
    await screen.findByText("Plant OPC");
    for (let round = 0; round < 2; round++) {
      await userEvent.click(screen.getByTestId("drag-src:1"));
      expect(at("src:1")).toEqual([7, 8]);
      await userEvent.click(tidyButton());
      await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Tidy for everyone" }));
      await waitFor(() => expect(at("src:1")).toEqual([0, 0]));
      await waitFor(() => expect(flow.fitView).toHaveBeenCalledTimes(round + 1));
    }
  });

  it("without discovery.edit there is no question and no request: the view goes back to the default columns, and a toast says it is the person's own", async () => {
    const calls = mockFetch(routes("operator", placed()));
    const toasts = spyToasts();
    renderWithProviders(<><DiscoveryPage /><SignedIn /></>, { route: "/discovery", path: "/discovery", toasts: toasts.api });
    await screen.findByText("Plant OPC");
    await userEvent.click(screen.getByTestId("drag-src:1"));
    expect(at("src:1")).toEqual([7, 8]);
    await userEvent.click(tidyButton());
    await waitFor(() => expect(at("src:1")).toEqual([0, 0])); // the shared layout (10,20) is left out too: this view is tidy
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE" || c.method === "PUT")).toBe(false);
    expect(toasts.calls).toEqual([{ kind: "info", text: "Tidied for you only. Your role may not change the layout everyone sees." }]);
    await waitFor(() => expect(flow.fitView).toHaveBeenCalledTimes(1));
  });

  it("is drawn for every role that can see the page, as a plain button", async () => {
    mockFetch(routes("operator"));
    open();
    await screen.findByText("Plant OPC");
    expect(tidyButton()).toHaveAttribute("type", "button");
    expect(tidyButton()).not.toHaveAttribute("aria-disabled");
  });

  describe("the bar", () => {
    it("sits between the header and the canvas, inside .graph-page, with the summary as the one polite announcer and no role", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      const bar = document.querySelector(".graph-bar") as HTMLElement;
      const page = document.querySelector(".graph-page") as HTMLElement;
      expect(page.contains(bar)).toBe(true);
      expect(bar.previousElementSibling).toBe(page.querySelector("header.page-head"));
      expect(bar.nextElementSibling).toHaveClass("graph-layout");
      const summary = bar.querySelector(".graph-summary") as HTMLElement;
      expect(summary.tagName).toBe("P");
      expect(summary).toHaveAttribute("aria-live", "polite");
      expect(summary).toHaveAttribute("aria-atomic", "true");
      expect(summary).not.toHaveAttribute("role");
      expect(summary).toHaveAttribute("title", summary.textContent as string);
      expect(within(bar).getAllByRole("button").map((b) => b.textContent)).toEqual(["Collapse all", "Expand all", "Tidy layout"]);
      for (const button of within(bar).getAllByRole("button")) expect(button).toHaveAttribute("type", "button");
    });

    it.each([
      ["1 source, 4 points, 0 mapped", graph()],
      ["2 sources, 5 points, 2 mapped", graph({ sources: [
        ...graph().sources,
        { ...graph().sources[0], id: 2, name: "Lab", clusters: [{ key: "L", points: [point(20, "L kW", { asset_id: 10, mapping_id: 1 })] }], ungrouped: [] },
      ].map((s, i) => (i === 0 ? { ...s, clusters: [{ key: "A", points: [point(1, "A", { asset_id: 11, mapping_id: 2 })] }], ungrouped: [point(4, "Status"), point(5, "S2"), point(6, "S3")] } : s)) })],
      ["1 source, 4 points, 0 mapped, 1 needs credentials", graph({ sources: graph().sources.map((s) => ({ ...s, needs_credentials: true })) })],
      ["2 sources, 8 points, 0 mapped, 2 need credentials", graph({ sources: [0, 1].map((i) => ({ ...graph().sources[0], id: i + 1, name: `S${i}`, needs_credentials: true })) })],
    ])("the summary reads %s", async (text, model) => {
      mockFetch(routes("operator", model));
      open();
      await screen.findByRole("heading", { level: 1, name: "Discovery" });
      expect(await screen.findByText(text)).toHaveClass("graph-summary");
    });

    it("Collapse all and Expand all: Expand all opens every source and group, Collapse all closes them; the one with nothing to do is aria-disabled, not disabled, and does nothing", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      const collapse = () => screen.getByRole("button", { name: "Collapse all" });
      const expandAll = () => screen.getByRole("button", { name: "Expand all" });
      expect(collapse()).toHaveAttribute("aria-disabled", "true");
      expect(collapse()).toHaveAttribute("title", "Nothing is open");
      expect(collapse()).not.toBeDisabled();
      expect(expandAll()).not.toHaveAttribute("aria-disabled");
      await userEvent.click(collapse());
      expect(screen.queryByText("LVP01 (2)")).not.toBeInTheDocument();
      await userEvent.click(expandAll());
      expect(screen.getByText("LVP01 kW")).toBeInTheDocument(); // the source, its groups and their points
      expect(screen.getByText("Status")).toBeInTheDocument();
      expect(expandAll()).toHaveAttribute("aria-disabled", "true");
      expect(expandAll()).toHaveAttribute("title", "Everything is open");
      expect(expandAll()).toHaveFocus(); // it kept the focus the click gave it
      expect(collapse()).not.toHaveAttribute("aria-disabled");
      await userEvent.click(expandAll());
      expect(screen.getByText("LVP01 kW")).toBeInTheDocument();
      await userEvent.click(collapse());
      expect(screen.queryByText("LVP01 (2)")).not.toBeInTheDocument();
      expect(screen.getByText("Plant OPC")).toBeInTheDocument();
      expect(collapse()).toHaveAttribute("aria-disabled", "true");
      expect(collapse()).toHaveFocus();
    });

    it("Expand all keeps the places the person set, and does not move the view", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      await userEvent.click(screen.getByTestId("drag-src:1"));
      await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
      expect(at("src:1")).toEqual([7, 8]);
      expect(flow.fitView).not.toHaveBeenCalled();
    });

    it("a graph too big to open whole opens what fits and says what stayed closed in a toast; Expand all stays active", async () => {
      const big = graph();
      big.sources[0].clusters = [{ key: "Huge", points: Array.from({ length: 700 }, (_, i) => point(100 + i, `H${i}`)) }, { key: "Small", points: [point(900, "S")] }];
      big.sources[0].ungrouped = [];
      mockFetch(routes("operator", big));
      const { toasts } = openToasts();
      await screen.findByText("Plant OPC");
      await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
      expect(toasts.calls).toEqual([{ kind: "info", text: "Opened 1 source and 1 group. 1 group stays closed: opening it would draw more than 600 nodes." }]);
      expect(screen.getByText("S")).toBeInTheDocument(); // the small group's point is drawn
      expect(screen.queryByText("H0")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Expand all" })).not.toHaveAttribute("aria-disabled");
    });
  });

  describe("while the graph loads", () => {
    it("holds the bar's room (aria-hidden, between the header and the canvas) and gives it up when the graph is in", async () => {
      mockFetch(routes("operator"));
      const held = holdFetch((_method, path) => path === "/api/discovery/graph");
      open();
      const space = document.querySelector(".graph-bar-space") as HTMLElement;
      expect(space).not.toBeNull();
      expect(space).toHaveAttribute("aria-hidden", "true");
      expect(space.textContent).toBe("");
      expect(space.previousElementSibling).toBe(document.querySelector("header.page-head"));
      expect(space.nextElementSibling).toHaveClass("graph-layout");
      held.release();
      await screen.findByText("Plant OPC");
      expect(document.querySelector(".graph-bar-space")).toBeNull();
      expect(document.querySelector(".graph-bar")).not.toBeNull();
    });

    it("the bar and its placeholder share one rule for height and the gap under them (36px and 8px), so the canvas does not drop when the bar arrives", () => {
      const css = readFileSync("src/styles/discovery-tidy.css", "utf8");
      const rule = /\.graph-bar,\s*\.graph-bar-space\s*\{([^}]*)\}/.exec(css);
      expect(rule, "one rule for both").not.toBeNull();
      expect(rule![1]).toMatch(/height:\s*36px/);
      expect(rule![1]).toMatch(/margin-bottom:\s*8px/);
      expect(rule![1]).toMatch(/flex:\s*none/);
    });
  });
});

// ---- W7u (part 1): camera, path highlight, live edges, minimap, snap and box select ----

describe("DiscoveryPage premium canvas (W7u)", () => {
  /** jsdom has no matchMedia: reduced motion and hover are answered here, and removed again after each test. */
  const stubMedia = (reduced: boolean) => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (query: string) => ({ matches: query.includes("reduced-motion") ? reduced : query.includes("hover: hover"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
    });
  };
  /** Whether the browser would call the focused element's focus a keyboard one (`:focus-visible`). jsdom says yes to a click too; a real browser does not. */
  const keyboard = { on: false };
  beforeEach(() => {
    keyboard.on = false;
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
      return selector === ":focus-visible" ? keyboard.on : matches.call(this, selector);
    });
  });
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
    vi.restoreAllMocks();
  });
  const liveWorld = (over: Partial<GraphSource> = {}) => world([srcOf(1, "Plant OPC", { enabled: true, status: "online", ...over })]);
  const expand = async (name: string) => userEvent.click(await screen.findByRole("button", { name: `Expand ${name}` }));
  const at = (id: string) => [Number(node(id).dataset.x), Number(node(id).dataset.y)];
  const canvas = () => document.querySelector(".graph-canvas") as HTMLElement;
  const edge = (prefix: string) => document.querySelector(`[data-edge^="${prefix}"]`) as HTMLElement;
  /** The canvas is 800x600 (jsdom measures nothing). */
  const sized = () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(600);
  };

  describe("live edges", () => {
    it("an enabled online source's dashed edges flow, an offline one's do not", async () => {
      mockFetch(routes("operator", liveWorld()));
      open();
      await expand("Plant OPC");
      expect(edge("e:src:1>")).toHaveAttribute("data-animated", "true");
    });

    it("a source that is offline keeps still edges", async () => {
      mockFetch(routes("operator", liveWorld({ status: "offline" })));
      open();
      await expand("Plant OPC");
      expect(edge("e:src:1>")).toHaveAttribute("data-animated", "false");
    });

    it("under reduced motion no edge flows, and it follows the preference being on", async () => {
      stubMedia(true);
      mockFetch(routes("operator", liveWorld()));
      open();
      await expand("Plant OPC");
      expect(edge("e:src:1>")).toHaveAttribute("data-animated", "false");
    });
  });

  describe("selection", () => {
    it("a selected node stays selected through a rebuild (expand, collapse, a refresh)", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      await userEvent.click(screen.getByTestId("select-src:1"));
      expect(node("src:1")).toHaveAttribute("data-selected", "true");
      await expand("Plant OPC");
      expect(node("src:1")).toHaveAttribute("data-selected", "true");
      expect(node("asset:10")).toHaveAttribute("data-selected", "false");
      await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(node("src:1")).toHaveAttribute("data-selected", "true"));
    });

    it("a selection and a box are React Flow's own: Shift draws the box, and Ctrl or Cmd (its default) adds, never a pass-through multi key", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      expect(screen.getByTestId("flow")).toHaveAttribute("data-selection-key", "Shift");
      expect(screen.getByTestId("flow")).toHaveAttribute("data-multi-key", "undefined");
    });

    it("the canvas takes the focus on a click (tabindex -1) without joining the tab order", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      expect(canvas()).toHaveAttribute("tabindex", "-1");
    });
  });

  describe("path highlight", () => {
    it("hovering a node lights its path after the dwell and clears it after the grace", async () => {
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      expect(canvas()).not.toHaveClass("has-focus");
      fireEvent.click(screen.getByTestId("enter-cluster:1:LVP01"));
      expect(canvas()).not.toHaveClass("has-focus"); // not before the dwell
      await waitFor(() => expect(canvas()).toHaveClass("has-focus"));
      expect(node("cluster:1:LVP01").dataset.class).toContain("lit");
      expect(node("src:1").dataset.class).toContain("lit");
      expect(node("asset:10").dataset.class ?? "").not.toContain("lit");
      expect(edge("e:src:1>cluster:1:LVP01").dataset.class).toContain("lit");
      fireEvent.click(screen.getByTestId("leave-cluster:1:LVP01"));
      await waitFor(() => expect(canvas()).not.toHaveClass("has-focus"));
      expect(node("src:1").dataset.class).not.toContain("lit");
    });

    it("a selection lights its path without a hover", async () => {
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      fireEvent.click(screen.getByTestId("select-cluster:1:LVP02"));
      expect(canvas()).toHaveClass("has-focus");
      expect(node("cluster:1:LVP02").dataset.class).toContain("lit");
      expect(node("cluster:1:LVP01").dataset.class ?? "").not.toContain("lit");
    });

    it("a node the keyboard reached lights its path (focus on the wrapper), and a click on a button does not", async () => {
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      expect(canvas()).not.toHaveClass("has-focus"); // the click that opened the source left the focus in its node, and that is a mouse focus
      keyboard.on = true;
      act(() => screen.getByRole("button", { name: "Expand LVP01" }).focus());
      await waitFor(() => expect(canvas()).toHaveClass("has-focus"));
      expect(node("cluster:1:LVP01").dataset.class).toContain("lit");
      expect(node("cluster:1:LVP02").dataset.class ?? "").not.toContain("lit");
      act(() => screen.getByRole("button", { name: "Refresh" }).focus());
      await waitFor(() => expect(canvas()).not.toHaveClass("has-focus"));
      keyboard.on = false;
      act(() => screen.getByRole("button", { name: "Expand LVP01" }).focus());
      expect(canvas()).not.toHaveClass("has-focus");
    });

    it("nothing is lit while a drag runs", async () => {
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      fireEvent.click(screen.getByTestId("select-cluster:1:LVP02"));
      expect(canvas()).toHaveClass("has-focus");
      fireEvent.click(screen.getByTestId("dragstart-cluster:1:LVP02"));
      expect(canvas()).not.toHaveClass("has-focus");
    });
  });

  describe("camera", () => {
    it("the Controls' fit-view button glides for 300 ms, and not at all under reduced motion", async () => {
      mockFetch(routes("operator"));
      const first = open();
      await screen.findByText("Plant OPC");
      expect(screen.getByTestId("controls")).toHaveAttribute("data-fit-duration", "300");
      first.unmount();
      stubMedia(true);
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      expect(screen.getByTestId("controls")).toHaveAttribute("data-fit-duration", "0");
    });

    it("Tidy's refit glides", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      await userEvent.click(screen.getByRole("button", { name: "Tidy layout" }));
      await waitFor(() => expect(flow.fitView).toHaveBeenCalled());
      expect(flow.fitView).toHaveBeenCalledWith(expect.objectContaining({ duration: 300 }));
    });

    it("opening a source by its own button pans just enough to bring it and its groups inside the margin; the zoom is untouched", async () => {
      sized();
      flow.state.viewport = { x: -30, y: -30, zoom: 0.5 };
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      await waitFor(() => expect(flow.setViewport).toHaveBeenCalledTimes(1));
      const [view, options] = flow.setViewport.mock.calls[0] as [{ x: number; y: number; zoom: number }, { duration: number }];
      expect(view.zoom).toBe(0.5);
      expect(view.x).toBe(40); // the source's left edge (0 * 0.5 - 30) comes to the 40 px margin
      expect(view.y).toBe(40);
      expect(options).toEqual({ duration: 300 });
    });

    it("moves instantly under reduced motion", async () => {
      stubMedia(true);
      sized();
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      await waitFor(() => expect(flow.setViewport).toHaveBeenCalled());
      expect(flow.setViewport.mock.calls[0][1]).toEqual({ duration: 0 });
    });

    it("does not move when everything is already in view", async () => {
      sized();
      flow.state.viewport = { x: 100, y: 100, zoom: 1 };
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      await screen.findByText("LVP01 (2)");
      await new Promise((resolve) => setTimeout(resolve, 80)); // two animation frames
      expect(flow.setViewport).not.toHaveBeenCalled();
    });

    it("only a source's own opening pans: a group, a close, Expand all and Collapse all leave the camera alone", async () => {
      sized();
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      await waitFor(() => expect(flow.setViewport).toHaveBeenCalledTimes(1));
      flow.setViewport.mockClear();
      await expand("LVP01");
      await userEvent.click(screen.getByRole("button", { name: "Collapse LVP01" }));
      await userEvent.click(screen.getByRole("button", { name: "Collapse Plant OPC" }));
      await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
      await userEvent.click(screen.getByRole("button", { name: "Collapse all" }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(flow.setViewport).not.toHaveBeenCalled();
    });
  });

  describe("minimap and snap", () => {
    it("draws the minimap inside the canvas", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      expect(within(screen.getByTestId("flow")).getByTestId("minimap")).toBeInTheDocument();
    });

    it("snaps to an 8 px grid by default, and the toggle turns it off and remembers", async () => {
      mockFetch(routes("operator"));
      const first = open();
      await screen.findByText("Plant OPC");
      const toggle = screen.getByRole("button", { name: "Snap to grid" });
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("flow")).toHaveAttribute("data-snap", "true");
      expect(screen.getByTestId("flow")).toHaveAttribute("data-snap-grid", "8,8");
      await userEvent.click(toggle);
      expect(screen.getByRole("button", { name: "Snap to grid" })).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByTestId("flow")).toHaveAttribute("data-snap", "false");
      expect(window.localStorage.getItem("dcdash.discovery.snap")).toBe("off");
      first.unmount();
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      expect(screen.getByRole("button", { name: "Snap to grid" })).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByTestId("flow")).toHaveAttribute("data-snap", "false");
    });
  });

  describe("a selection dragged together", () => {
    it("a source and its own open group dragged together move the group's open points once (not once for each)", async () => {
      const layout = { "src:1": { x: 10, y: 20 }, "cluster:1:LVP02": { x: 500, y: 300 }, "point:3": { x: 800, y: 340 } };
      mockFetch(routes("admin", graph({ layout })));
      open();
      await expand("Plant OPC");
      await expand("LVP02");
      expect(at("point:3")).toEqual([800, 340]);
      flow.state.partner = "cluster:1:LVP02";
      await userEvent.click(screen.getByTestId("dragwith-src:1")); // from 10,20 to 7,8: by -3,-12
      expect(at("point:3")).toEqual([797, 328]); // not 794,316 (the two dragged nodes are React Flow's to move; the mock does not)
    });
  });
});
