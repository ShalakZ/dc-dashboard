import { readFileSync } from "node:fs";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Asset, GraphModel, GraphPoint, GraphSource } from "../api/types";
import { AddConnectionLine } from "../components/graph/nodes";
import { resetUndoForTests, type MappedInfo } from "../hooks/useMappingActions";
import { mockFetch } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { spyToasts } from "../test/toasts";
import { accountKnown, SignedIn } from "../test/signedIn";
import { userFor } from "../test/users";
import type { PermissionId } from "../lib/permissions";
import { DiscoveryPage } from "./DiscoveryPage";

// The bulk-create dialog is another piece (its own tests): here it only has to be mounted with the right props and closed through onClose.
const bulk = vi.hoisted(() => ({ props: [] as { model: GraphModel; source: GraphSource; onClose: () => void; onMapped: (info: MappedInfo) => void }[] }));
vi.mock("../components/graph/BulkCreateDialog", () => ({
  BulkCreateDialog: (props: { model: GraphModel; source: GraphSource; onClose: () => void; onMapped: (info: MappedInfo) => void }) => {
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
    // The connection props of the "+" (W12a), as the page gave them to React Flow on its last render.
    connect: {} as { nodesConnectable?: boolean; isValidConnection?: (c: unknown) => boolean; connectionLineComponent?: unknown; onConnectEnd?: (event: unknown, state: unknown) => void },
  };
  return {
    state, getIntersectingNodes: vi.fn((_node: unknown) => state.intersecting), getNodes: vi.fn(() => state.nodes), fitView: vi.fn(),
    // The camera: a move resolves as the library's does (true when it happened).
    setViewport: vi.fn(async (_view: unknown, _options?: unknown) => true), getViewport: vi.fn(() => state.viewport),
    setCenter: vi.fn(async (_x: number, _y: number, _options?: unknown) => true), getZoom: vi.fn(() => state.viewport.zoom),
  };
});

// The minimap is its own piece (its own tests): here it only has to be drawn inside the canvas.
vi.mock("../components/graph/GraphMiniMap", () => ({ GraphMiniMap: () => <div data-testid="minimap" className="graph-minimap" /> }));

// React Flow measures the DOM, which jsdom cannot do: render the nodes plainly and expose the props the page wires up.
// `data-draggable` is React Flow's own rule for one node (a node's `draggable` beats the canvas-wide `nodesDraggable`; undefined follows it).
// So are `data-selectable` and `data-focusable` (the canvas-wide defaults are on), and the wrapper's `role` ("group" while focusable), `aria-label` and `tabIndex`, as the real wrapper sets them.
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
      onNodeContextMenu, onPaneContextMenu, onSelectionContextMenu, onMoveStart, nodesConnectable, isValidConnection, connectionLineComponent, onConnectEnd,
      ariaLabelConfig,
    }: any) => {
      flow.state.nodes = nodes;
      flow.state.connect = { nodesConnectable, isValidConnection, connectionLineComponent, onConnectEnd };
      return (
        <div
          data-testid="flow" data-color-mode={colorMode} data-edges-focusable={String(edgesFocusable)} data-nodes-draggable={String(nodesDraggable)}
          data-snap={String(snapToGrid)} data-snap-grid={snapGrid?.join(",")} data-selection-key={String(selectionKeyCode)} data-multi-key={String(multiSelectionKeyCode)}
        >
          {/* The library's hidden description of a node (`aria-describedby` on every focusable wrapper points at it); the page overrides its words through `ariaLabelConfig`. */}
          <div id="flow-node-desc" style={{ display: "none" }}>{ariaLabelConfig?.["node.a11yDescription.default"] ?? "Press enter or space to select a node."}</div>
          {/* Like the real library: the pane is the PARENT of the viewport, so every node and every edge lives INSIDE `.react-flow__pane`. The pane's own
              context menu is the one aimed at the pane itself, never at a node or an edge that bubbles up to it (xyflow's `wrapHandler` checks the target). */}
          <div data-testid="pane" className="react-flow__pane" onContextMenu={(e) => { if (e.target === e.currentTarget) onPaneContextMenu?.(e); }}>
            {edges.map((e: any) => <i key={e.id} className="react-flow__edge" data-edge={e.id} data-animated={String(!!e.animated)} data-class={e.className ?? ""} />)}
            {nodes.map((n: any) => {
              const Node = nodeTypes[n.type];
              const dropped = () => ({ ...n, position: flow.state.dropAt });
              return (
                <div key={n.id} className={n.selected ? "react-flow__node selected" : "react-flow__node"} role={(n.focusable ?? true) ? "group" : undefined} aria-label={n.ariaLabel} aria-describedby={(n.focusable ?? true) ? "flow-node-desc" : undefined} tabIndex={(n.focusable ?? true) ? 0 : undefined} data-selectable={String((n.selectable ?? true))} data-focusable={String((n.focusable ?? true))} data-id={n.id} data-x={n.position.x} data-y={n.position.y} data-width={n.measured?.width} data-selected={String(!!n.selected)} data-class={n.className ?? ""} data-draggable={String(!!(n.draggable || (nodesDraggable && typeof n.draggable === "undefined")))} onClick={(e) => onNodeClick?.(e, n)} onContextMenu={(e) => onNodeContextMenu?.(e, n)}>
                  <Node id={n.id} data={n.data} />
                  <button data-testid={`measure-${n.id}`} onClick={() => onNodesChange?.([{ id: n.id, type: "dimensions", dimensions: { width: 100, height: 40 } }])} />
                  <button data-testid={`select-${n.id}`} onClick={() => onNodesChange?.([{ id: n.id, type: "select", selected: true }])} />
                  <button data-testid={`enter-${n.id}`} onClick={(e) => onNodeMouseEnter?.(e, n)} />
                  <button data-testid={`leave-${n.id}`} onClick={(e) => onNodeMouseLeave?.(e, n)} />
                  <button data-testid={`dragstart-${n.id}`} onClick={(e) => onNodeDragStart?.(e, n, [n])} />
                  {/* A drag played in two halves (start and one move, then the drop), for what is drawn while it runs. */}
                  <button data-testid={`dragmove-${n.id}`} onClick={(e) => { onNodeDragStart?.(e, n, [n]); onNodeDrag?.(e, dropped(), [dropped()]); }} />
                  <button data-testid={`dragstop-${n.id}`} onClick={(e) => onNodeDragStop?.(e, dropped(), [dropped()])} />
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
            {/* The rectangle a box selection leaves over its nodes: in the real library it is drawn INSIDE the pane, over the viewport, and takes the pointer
                (a line released on it never reaches the node under it). The page's menu listens to it. */}
            {nodes.some((n: any) => n.selected) && (
              <div className="react-flow__nodesselection">
                <div data-testid="selection-rect" className="react-flow__nodesselection-rect" tabIndex={-1} onContextMenu={(e) => onSelectionContextMenu?.(e, nodes.filter((n: any) => n.selected))} />
              </div>
            )}
          </div>
          {/* The camera starting to move: what the page's guides listen to. */}
          <button data-testid="move-start" onClick={() => onMoveStart?.(null, flow.state.viewport)} />
          {children}
        </div>
      );
    },
    ViewportPortal: ({ children }: any) => <div data-testid="viewport-portal">{children}</div>,
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
/** The full asset list the New asset form reads (the graph carries only id, parent, name and kind): the same two assets as `graph()`. */
const ASSET_LIST: Asset[] = [
  { id: 10, parent_id: null, name: "Site", kind: "generic", sort_order: 0 },
  { id: 11, parent_id: 10, name: "Panel 1", kind: "generic", sort_order: 0 },
];
const routes = (role: string, model: GraphModel | (() => GraphModel) = graph()) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor(role) },
  "GET /api/assets": { body: ASSET_LIST },
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

// The latest Undo is module state in the hook: one this file's tests left unused must not be run by a later test's Ctrl+Z.
afterEach(resetUndoForTests);

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
    // For a role that has the asset form (assets.edit and assets.view) the form comes first, named after the cluster; the Review follows on the saved asset.
    const form = await screen.findByRole("dialog", { name: "New asset" });
    expect(within(form).getByLabelText("Name")).toHaveValue("LVP01");
    expect(within(form).getByLabelText("Parent")).toHaveValue("");
    expect(screen.queryByRole("dialog", { name: "Review mappings" })).not.toBeInTheDocument();
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

  it("the New asset button opens the asset form named after the cluster, and saving it opens the Review on the new asset", async () => {
    let created = false;
    const model = () => {
      const m = graph();
      if (created) m.assets.push({ id: 12, parent_id: null, name: "LVP01", kind: "generic" });
      return m;
    };
    const calls = await start("admin", model, {
      "POST /api/assets": ({ body }: { body: unknown }) => { created = true; return { status: 201, body: { id: 12, sort_order: 0, ...(body as object) } }; },
    });
    await userEvent.click(screen.getByRole("button", { name: "New asset from LVP01…" }));
    const form = await screen.findByRole("dialog", { name: "New asset" });
    expect(within(form).getByLabelText("Name")).toHaveValue("LVP01");
    expect(within(form).getByText("Next you choose the points to map. Cancel keeps the new asset.")).toBeInTheDocument();
    await userEvent.click(within(form).getByRole("button", { name: "Change icon" }));
    await userEvent.click(within(form).getByRole("radio", { name: "Panel", hidden: true }));
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
    const review = await dialog();
    expect(screen.queryByRole("dialog", { name: "New asset" })).not.toBeInTheDocument();
    expect(within(review).getByRole("radio", { name: "Existing asset" })).toBeChecked();
    expect(within(review).getByLabelText("Asset")).toHaveValue("12"); // the asset just made, listed by the refreshed graph
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/assets")?.body).toMatchObject({ name: "LVP01", parent_id: null, icon: "panel" }); // the icon chosen is the icon saved
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

const HINT = "Dashed: discovered. Solid: assets. Drag a group onto an asset or press New asset…";
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
  it("the sub line says to drag a group onto an asset or press New asset…", async () => {
    serverWith("operator", [srcOf(1, "Plant OPC")]);
    openToasts();
    await screen.findByText("Plant OPC");
    expect(screen.getByText(/Dashed: discovered/)).toHaveTextContent(HINT);
  });

  it("the hint is short (under 100 characters: the keys live in the tip beside it)", () => {
    expect(HINT.length).toBeLessThan(100);
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
      // W12b: a chevron beside each of the first two (named by aria-label, it draws only an icon) and the Unmapped only switch (not a button); the three old names keep their order.
      expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
        "Collapse all", "More ways to collapse", "Expand all", "More ways to expand", "Tidy layout",
      ]);
      expect(within(bar).getByRole("switch", { name: "Unmapped only" })).not.toBeChecked();
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

    // W12b: a group costs the points of its first page (50) and the Show more node, not all its points: 13 groups of 60 points cost 51 each, 14 for the
    // source's groups come first, so eleven of them fit under 600 and the other two stay closed (the small group after them still fits).
    it("a graph too big to open whole opens what fits and says what stayed closed in a toast; Expand all stays active", async () => {
      const big = graph();
      big.sources[0].clusters = [
        ...Array.from({ length: 13 }, (_, g) => ({ key: `G${g}`, points: Array.from({ length: 60 }, (_, i) => point(1000 + g * 100 + i, `G${g} p${i}`)) })),
        { key: "Small", points: [point(900, "S")] },
      ];
      big.sources[0].ungrouped = [];
      mockFetch(routes("operator", big));
      const { toasts } = openToasts();
      await screen.findByText("Plant OPC");
      await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
      expect(toasts.calls).toEqual([{ kind: "info", text: "Opened 1 source and 12 groups. 2 groups stay closed: opening them would draw more than 600 nodes." }]);
      expect(screen.getByText("S")).toBeInTheDocument(); // the small group's point is drawn
      expect(screen.getByText("G0 p49")).toBeInTheDocument(); // an open group draws its first page...
      expect(screen.queryByText("G0 p50")).not.toBeInTheDocument(); // ...and not the rest
      expect(screen.queryByText("G11 p0")).not.toBeInTheDocument(); // a group that did not fit stays closed
      expect(screen.getByRole("button", { name: "Expand all" })).not.toHaveAttribute("aria-disabled");
    }, 20_000); // (about 600 nodes are drawn, each with the mock's helper buttons)
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

    it("a click selection (one node) lights nothing, and two selected nodes light the union of their paths without a hover", async () => {
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      fireEvent.click(screen.getByTestId("select-cluster:1:LVP02"));
      expect(node("cluster:1:LVP02")).toHaveAttribute("data-selected", "true");
      expect(canvas()).not.toHaveClass("has-focus");
      expect(node("cluster:1:LVP02").dataset.class ?? "").not.toContain("lit");
      fireEvent.click(screen.getByTestId("select-asset:10"));
      expect(canvas()).toHaveClass("has-focus");
      expect(node("cluster:1:LVP02").dataset.class).toContain("lit");
      expect(node("asset:10").dataset.class).toContain("lit");
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
      fireEvent.click(screen.getByTestId("select-asset:10"));
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

  // ---- W7u (part 2): right-click menus, Find, alignment guides, the shorter hint and its tip ----

  const labelsOf = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((item) => item.querySelector(".graph-menu-text > span")?.textContent ?? item.textContent); // (a disabled item with a reason says it in a second span: the label is the first)
  const viewOnly = () => mockFetch({ ...routes("custom"), "GET /api/me": { body: userFor("custom", { permissions: ["discovery.view"] }) } });
  const rightClick = (id: string) => fireEvent.contextMenu(node(id));
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  describe("right-click menus", () => {
    it("a source's menu holds Details, Expand, Create assets… and Remove for an admin, with the focus on the first", async () => {
      mockFetch(routes("admin", world([srcOf(1, "Plant OPC")]))); // (a group with a unit, so there is something to create assets from)
      open();
      await screen.findByRole("button", { name: /Create assets for/ }); // (the account is known: the node's own buttons are there)
      rightClick("src:1");
      const menu = await screen.findByRole("menu", { name: "Actions for Plant OPC" });
      expect(labelsOf(menu)).toEqual(["Details", "Expand", "Create assets…", "Remove", "Expand this branch", "Collapse this branch"]); // (W12b: the branch items come last)
      expect(within(menu).getAllByRole("menuitem")[0]).toHaveFocus();
      expect(within(menu).getByRole("menuitem", { name: "Remove" })).toHaveClass("danger-item");
    });

    it("a role with discovery.view alone gets Details and Expand: no Create assets… and no Remove (the menu is gated like the buttons)", async () => {
      viewOnly();
      open();
      await screen.findByText("Plant OPC");
      await accountKnown();
      rightClick("src:1");
      expect(labelsOf(await screen.findByRole("menu", { name: "Actions for Plant OPC" }))).toEqual(["Details", "Expand", "Expand this branch", "Collapse this branch"]);
    });

    it("a group offers Expand, Map… and New asset…, and an unmapped point Map… and New asset… (menu only), for a role that may accept and has the asset form", async () => {
      mockFetch(routes("admin"));
      open();
      await expand("Plant OPC");
      await expand("LVP01");
      await screen.findByRole("button", { name: "Map LVP01 to asset…" });
      rightClick("cluster:1:LVP01");
      expect(labelsOf(await screen.findByRole("menu", { name: "Actions for LVP01" }))).toEqual(["Collapse", "Map…", "New asset…"]);
      await userEvent.keyboard("{Escape}");
      rightClick("point:1");
      expect(labelsOf(await screen.findByRole("menu", { name: "Actions for LVP01 kW" }))).toEqual(["Map…", "New asset…"]);
      expect(screen.queryByRole("button", { name: "New asset from LVP01 kW…" })).not.toBeInTheDocument(); // a point draws no button for it
    });

    it("a point that has no action for this role (no Map…) shows the canvas's menu instead", async () => {
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      await expand("LVP01");
      rightClick("point:1");
      expect(labelsOf(await screen.findByRole("menu", { name: "Canvas actions" }))).toEqual(["Expand all", "Collapse all", "Tidy layout", "Fit view", "Expand selection", "Collapse selection"]);
    });

    it("so does a leaf asset, and so does the empty canvas (an asset with sub-assets has its own: the branch and the fold)", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      rightClick("asset:11");
      expect(await screen.findByRole("menu", { name: "Canvas actions" })).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      fireEvent.contextMenu(screen.getByTestId("pane"));
      expect(await screen.findByRole("menu", { name: "Canvas actions" })).toBeInTheDocument();
    });

    it("the canvas menu mirrors the bar: Collapse all is aria-disabled while nothing is open (and does nothing), Expand all opens everything, Fit view glides", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      fireEvent.contextMenu(screen.getByTestId("pane"));
      const menu = await screen.findByRole("menu", { name: "Canvas actions" });
      const collapse = within(menu).getByRole("menuitem", { name: "Collapse all" });
      expect(collapse).toHaveAttribute("aria-disabled", "true");
      expect(within(menu).getByRole("menuitem", { name: "Expand all" })).not.toHaveAttribute("aria-disabled");
      await userEvent.click(collapse);
      expect(screen.getByRole("menu")).toBeInTheDocument(); // a disabled item does not even close the menu
      await userEvent.click(within(menu).getByRole("menuitem", { name: "Fit view" }));
      expect(flow.fitView).toHaveBeenCalledWith({ duration: 300 });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      fireEvent.contextMenu(screen.getByTestId("pane"));
      await userEvent.click(within(await screen.findByRole("menu", { name: "Canvas actions" })).getByRole("menuitem", { name: "Expand all" }));
      expect(await screen.findByText("LVP01 (2)")).toBeInTheDocument();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("the rectangle a box selection leaves over its nodes opens the canvas menu", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      await userEvent.click(screen.getByTestId("select-src:1"));
      fireEvent.contextMenu(screen.getByTestId("selection-rect"));
      expect(await screen.findByRole("menu", { name: "Canvas actions" })).toBeInTheDocument();
    });

    it("choosing Details opens the source's panel; choosing Expand opens the source", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      rightClick("src:1");
      await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Details" }));
      expect(await screen.findByRole("complementary", { name: "Source details" })).toBeInTheDocument();
      rightClick("src:1");
      await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Expand" }));
      expect(await screen.findByText("LVP01 (2)")).toBeInTheDocument();
    });

    it("the menu's Expand pans the camera like the node's own + button", async () => {
      sized();
      flow.state.viewport = { x: -30, y: -30, zoom: 0.5 };
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      rightClick("src:1");
      await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Expand" }));
      await waitFor(() => expect(flow.setViewport).toHaveBeenCalledTimes(1));
      expect(flow.setViewport.mock.calls[0][0]).toMatchObject({ x: 40, y: 40, zoom: 0.5 });
    });

    it("Shift+F10 and the ContextMenu key open the menu of the node that has the focus; on the canvas itself, the canvas's menu", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      act(() => node("src:1").focus());
      fireEvent.keyDown(node("src:1"), { key: "F10", shiftKey: true });
      expect(labelsOf(await screen.findByRole("menu", { name: "Actions for Plant OPC" }))).toEqual(["Details", "Expand", "Expand this branch", "Collapse this branch"]);
      await userEvent.keyboard("{Escape}");
      expect(node("src:1")).toHaveFocus();
      fireEvent.keyDown(node("src:1"), { key: "ContextMenu" });
      expect(await screen.findByRole("menu", { name: "Actions for Plant OPC" })).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      act(() => canvas().focus());
      fireEvent.keyDown(canvas(), { key: "ContextMenu" });
      expect(await screen.findByRole("menu", { name: "Canvas actions" })).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(canvas()).toHaveFocus();
    });

    it("Escape closes the menu and gives the focus back to the node, and leaves the selection alone (a second Escape clears it)", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      await userEvent.click(screen.getByTestId("select-src:1"));
      expect(node("src:1")).toHaveAttribute("data-selected", "true");
      rightClick("src:1");
      await screen.findByRole("menu");
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(node("src:1")).toHaveFocus();
      expect(node("src:1")).toHaveAttribute("data-selected", "true");
      await userEvent.keyboard("{Escape}");
      expect(node("src:1")).toHaveAttribute("data-selected", "false");
    });

    it("a graph refresh closes an open menu, and so does the canvas starting to move", async () => {
      let points = 4;
      mockFetch(routes("operator", () => graph({ sources: [{ ...graph().sources[0], point_count: points }] })));
      open();
      await screen.findByText("Plant OPC");
      rightClick("src:1");
      await screen.findByRole("menu");
      points = 5;
      fireEvent.click(screen.getByRole("button", { name: "Refresh" })); // (a click without a press: nothing but the new graph closes it)
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
      rightClick("src:1");
      await screen.findByRole("menu");
      fireEvent.click(screen.getByTestId("move-start"));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  describe("Find", () => {
    const findButton = () => screen.getByRole("button", { name: "Find" });
    const search = async (text: string) => {
      await userEvent.click(findButton());
      await userEvent.type(await screen.findByRole("combobox"), text);
      await userEvent.keyboard("{Enter}");
    };

    it("Ctrl+K inside the canvas opens Find and the key goes no further; from the page body it is left alone", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      const heard = vi.fn((event: KeyboardEvent) => event.key);
      document.addEventListener("keydown", heard);
      try {
        act(() => node("src:1").focus());
        fireEvent.keyDown(node("src:1"), { key: "k", ctrlKey: true });
        expect(await screen.findByRole("combobox")).toBeInTheDocument();
        expect(heard.mock.calls.filter(([event]) => event.key === "k")).toHaveLength(0);
        await userEvent.keyboard("{Escape}");
        expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
        fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
        expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
        expect(heard.mock.calls.filter(([event]) => event.key === "k")).toHaveLength(1); // the top bar's quick find would have it
      } finally {
        document.removeEventListener("keydown", heard);
      }
    });

    it("choosing a point in a closed group opens its source and group, glides to it, and focuses it only once the glide is over", async () => {
      keyboard.on = true; // (Enter in the field: the focus Find gives the node counts as a keyboard one, so its path lights as well; the outline must outlive that)
      let finish!: () => void;
      flow.setCenter.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = () => resolve(true); }));
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      await search("LVP02 kW");
      await waitFor(() => expect(flow.setCenter).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
      const [x, y] = at("point:3"); // (opened: source and group)
      expect(flow.setCenter).toHaveBeenCalledWith(x + 110, y + 40, { zoom: 1, duration: 300 }); // the centre of a 220 x 80 node
      expect(node("point:3")).not.toHaveFocus();
      finish();
      await waitFor(() => expect(node("point:3")).toHaveFocus());
      await waitFor(() => expect(node("point:3")).toHaveAttribute("data-class", expect.stringContaining("flash")));
      expect(node("point:3").dataset.class).toMatch(/\blit\b/); // the focus lit its path, and the outline is still there beside it
    });

    it("the outline goes after 1.5 s", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      await search("Plant OPC");
      await waitFor(() => expect(node("src:1")).toHaveAttribute("data-class", expect.stringContaining("flash")));
      await waitFor(() => expect(node("src:1")).toHaveAttribute("data-class", ""), { timeout: 2500 });
    }, 6000);

    it.each([[0.5, 0.75], [0.9, 0.9], [2, 1]])("keeps the zoom between 0.75 and 1 (%s -> %s) and glides instantly under reduced motion", async (zoom, expected) => {
      flow.state.viewport = { x: 0, y: 0, zoom };
      stubMedia(zoom === 2);
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      await search("Site");
      await waitFor(() => expect(flow.setCenter).toHaveBeenCalledTimes(1));
      expect(flow.setCenter.mock.calls[0][2]).toEqual({ zoom: expected, duration: zoom === 2 ? 0 : 300 });
    });

    it("a point too far down a big group to draw opens the group on its first page, says how to go on, and centres on the group", async () => {
      const points = Array.from({ length: 700 }, (_, i) => kw(1000 + i, `BIG pt ${i}`));
      serverWith("operator", [srcOf(1, "Big", { clusters: [{ key: "BIG", points }], point_count: 700 })]);
      const { toasts } = openToasts();
      await screen.findByText("Big");
      await search("BIG pt 699");
      await waitFor(() => expect(flow.setCenter).toHaveBeenCalledTimes(1));
      expect(toasts.calls).toEqual([{ kind: "info", text: "BIG has 700 points; the one you chose is too far down to draw at once. Showing the group: use Show 50 more to go on." }]);
      expect(node("cluster:1:BIG")).not.toBeNull();
      expect(node("point:1699")).toBeNull();
      expect(node("point:1049")).not.toBeNull(); // the first page is drawn,
      expect(node("point:1050")).toBeNull(); // and no more
      expect(node("more:cluster:1:BIG")).not.toBeNull();
      const [x, y] = at("cluster:1:BIG");
      expect(flow.setCenter).toHaveBeenCalledWith(x + 110, y + 40, expect.anything());
    });

    it("Escape in the Find card closes only the card: the selection stays", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      await userEvent.click(screen.getByTestId("select-src:1"));
      await userEvent.click(findButton());
      await screen.findByRole("combobox");
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
      expect(node("src:1")).toHaveAttribute("data-selected", "true");
    });
  });

  describe("alignment guides", () => {
    const lines = () => document.querySelectorAll(".graph-guides line");

    it("a line shows while a node is dragged level with another one, and is gone when the drag ends", async () => {
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      flow.state.dropAt = { x: at("cluster:1:LVP01")[0], y: 500 }; // the same left edge as LVP01
      await userEvent.click(screen.getByTestId("dragmove-cluster:1:LVP02"));
      await waitFor(() => expect(lines().length).toBeGreaterThan(0));
      expect([...lines()].map((line) => line.getAttribute("x1"))).toEqual(["360", "470", "580"]); // same column: left, centre and right edges line up
      await userEvent.click(screen.getByTestId("dragstop-cluster:1:LVP02"));
      expect(lines()).toHaveLength(0);
    });

    it("nodes that move with the drag are not lined up with: a source dragged to its own groups' column draws nothing", async () => {
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      flow.state.dropAt = { x: at("cluster:1:LVP01")[0], y: 500 };
      await userEvent.click(screen.getByTestId("dragmove-src:1"));
      await sleep(100); // (a few animation frames)
      expect(lines()).toHaveLength(0);
      await userEvent.click(screen.getByTestId("dragstop-src:1"));
    });

    it("a frame still waiting when the drag ends never draws", async () => {
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      flow.state.dropAt = { x: at("cluster:1:LVP01")[0], y: 500 };
      await userEvent.click(screen.getByTestId("drag-cluster:1:LVP02")); // start, move and drop in one go
      await sleep(100);
      expect(lines()).toHaveLength(0);
    });
  });

  describe("the hint and its tip", () => {
    const TIP = "What can I do on the canvas?";

    it("the canvas draws the short line and a tip that lists the keys", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      expect(screen.getByText(/Dashed: discovered/)).toHaveClass("sub");
      expect(screen.getByText(/Dashed: discovered/).textContent!.trim().length).toBeLessThan(100);
      await userEvent.click(screen.getByRole("button", { name: TIP }));
      const lines = within(await screen.findByRole("note")).getAllByRole("listitem").map((item) => item.textContent);
      expect(lines).toHaveLength(8);
      expect(lines[0]).toContain("Alt or Option moves it alone.");
      expect(lines.join("\n")).toMatch(/Arrow keys move between nodes\. Enter opens or closes one\./);
      expect(lines.join("\n")).toContain("Ctrl+Z undoes the last mapping change for 10 seconds.");
      expect(lines.join("\n")).toMatch(/Shift-drag selects/);
      expect(lines.join("\n")).toMatch(/Ctrl\+K finds/);
      expect(lines.join("\n")).toMatch(/Shift\+F10/);
      expect(lines.join("\n")).toMatch(/Escape/);
    });

    it("the loading branch draws the same line and tip, so nothing moves when the graph arrives", async () => {
      mockFetch(routes("operator"));
      const held = holdFetch((_method, path) => path === "/api/discovery/graph");
      open();
      expect(screen.getByText(/Dashed: discovered/)).toHaveClass("sub");
      expect(screen.getByRole("button", { name: TIP })).toBeInTheDocument();
      held.release();
      await screen.findByText("Plant OPC");
      expect(screen.getAllByRole("button", { name: TIP })).toHaveLength(1);
    });
  });
});

// ---- W12a: unmap and move from the nodes and the menu, the Undo after mapping, the note about a room ----

describe("DiscoveryPage unmap, move and the Undo after mapping (W12a)", () => {
  type M = { id: number; point_id: number; asset_id: number; metric: GraphPoint["mapped_metric"] & string; scale: number; interval_seconds: number | null; custom_unit: string | null };
  const mapping = (id: number, point_id: number, asset_id: number, metric: M["metric"], over: Partial<M> = {}): M =>
    ({ id, point_id, asset_id, metric, scale: 1, interval_seconds: 5, custom_unit: null, ...over });
  // Mapping 21: LVP01 kW on Panel 1 (11), at scale 0.001 and interval 1 (what an Undo must put back); 22: LVP01 V on Site (10); 23: Atrium's M kW on Site.
  const KW_ON_PANEL = mapping(21, 1, 11, "active_power_kw", { scale: 0.001, interval_seconds: 1 });
  const V_ON_SITE = mapping(22, 2, 10, "voltage_v");
  const M_ON_SITE = mapping(23, 8, 10, "active_power_kw");
  const KINDS = [{ id: 1, name: "room", icon: "room", asset_count: 1, starter: true }, { id: 2, name: "panel", icon: "panel", asset_count: 1, starter: true }];

  /** A server that keeps the mappings, builds the graph from them and answers the mapping routes the way the API does. `dropSource1`: the first source is gone from the next graph. */
  function server(initial: M[], extra: Record<string, unknown> = {}, permissions: PermissionId[] | "admin" = "admin") {
    const state = { mappings: new Map(initial.map((m) => [m.id, { ...m }])) /* copies: a PATCH changes the stored mapping */, next: 900, dropSource1: false };
    const p = (id: number, name: string, extra: Partial<GraphPoint> = {}) => {
      const m = [...state.mappings.values()].find((x) => x.point_id === id);
      return point(id, name, { ...extra, ...(m ? { asset_id: m.asset_id, mapping_id: m.id, mapped_metric: m.metric } : {}) });
    };
    const kwh = { suggestion: { metric: "energy_kwh" as const, scale: 0.001, interval_seconds: 60, custom_unit: null } };
    const graphNow = (): GraphModel => ({
      sources: [
        ...(state.dropSource1 ? [] : [srcOf(1, "Plant OPC", { clusters: [{ key: "LVP01", points: [p(1, "LVP01 kW"), p(2, "LVP01 V"), p(3, "LVP01 kWh", kwh)] }] })]),
        srcOf(2, "Atrium", { origin: "manual", clusters: [{ key: "M", points: [p(8, "M kW")] }] }),
      ],
      unidentified: [],
      assets: [{ id: 10, parent_id: null, name: "Site", kind: "generic" }, { id: 11, parent_id: 10, name: "Panel 1", kind: "panel" }, { id: 12, parent_id: 10, name: "Room 1", kind: "room" }],
      layout: {},
    });
    const missing = { status: 404, body: { detail: "mapping not found" } };
    const routes_: Record<string, unknown> = {};
    for (const id of [...Array.from({ length: 30 }, (_, i) => i + 1), 900, 901, 902]) { // the ids the store hands out to new mappings start at 900
      routes_[`GET /api/mappings/${id}`] = () => (state.mappings.has(id) ? { body: state.mappings.get(id) } : missing);
      routes_[`DELETE /api/mappings/${id}`] = () => {
        if (!state.mappings.delete(id)) return missing;
        return { status: 204 };
      };
      routes_[`PATCH /api/mappings/${id}`] = ({ body }: { body: unknown }) => {
        const m = state.mappings.get(id);
        if (!m) return missing;
        Object.assign(m, body);
        return { body: m };
      };
    }
    const user = permissions === "admin" ? routes("admin") : { ...routes("custom"), "GET /api/me": { body: userFor("custom", { permissions }) } };
    const calls = mockFetch({
      ...user,
      "GET /api/discovery/graph": () => ({ body: graphNow() }),
      "GET /api/asset-kinds": { body: KINDS },
      ...routes_,
      "POST /api/mappings": ({ body }: { body: unknown }) => {
        const made = { id: state.next++, ...(body as Omit<M, "id">) };
        state.mappings.set(made.id, made);
        return { status: 201, body: made };
      },
      "POST /api/discovery/accept": ({ body }: { body: unknown }) => {
        const b = body as { asset_id: number; points: { point_id: number; metric: M["metric"]; scale: number; interval_seconds: number | null; custom_unit: string | null }[] };
        const ids = b.points.map((x) => { const made = mapping(state.next++, x.point_id, b.asset_id, x.metric, x); state.mappings.set(made.id, made); return made.id; });
        return { status: 201, body: { asset_id: b.asset_id, mapping_ids: ids } };
      },
      ...extra,
    });
    return { state, calls };
  }
  const writes = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method !== "GET" && c.path.startsWith("/api/mappings")).map((c) => `${c.method} ${c.path}`);
  const mappingCalls = (calls: { method: string; path: string }[]) => calls.filter((c) => c.path.startsWith("/api/mappings")).map((c) => `${c.method} ${c.path}`);
  const labelsOf = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((item) => item.querySelector(".graph-menu-text > span")?.textContent ?? item.textContent); // (a disabled item with a reason says it in a second span: the label is the first)
  const rightClick = (id: string) => fireEvent.contextMenu(node(id));
  const menuButton = (name: string) => screen.findByRole("button", { name: `Mapping actions for ${name}` });
  const undoOf = (toasts: ReturnType<typeof spyToasts>, at: number) => {
    const action = toasts.calls[at].options?.action;
    expect(action, `toast ${at} has an Undo`).toBeDefined();
    return () => act(() => action!.onAction());
  };

  /** The page with Plant OPC and LVP01 open and the account known. */
  async function start(initial: M[], permissions: PermissionId[] | "admin" = "admin", extra: Record<string, unknown> = {}) {
    const s = server(initial, extra, permissions);
    const { toasts } = openToasts();
    await userEvent.click(await screen.findByRole("button", { name: "Expand Plant OPC" }));
    await userEvent.click(screen.getByRole("button", { name: "Expand LVP01" }));
    await accountKnown();
    return { ...s, toasts };
  }
  beforeEach(() => { bulk.props.length = 0; });

  describe("the menu button and the menu", () => {
    it("a mapped point has one small button that opens the same menu as the right-click, outside the node, and Escape gives the focus back to it", async () => {
      await start([KW_ON_PANEL]);
      const button = await menuButton("LVP01 kW");
      expect(button).toHaveAttribute("aria-haspopup", "menu");
      expect(button).toHaveClass("nodrag", "nokey");
      expect(node("point:1")).toContainElement(button);
      await userEvent.click(button);
      const menu = await screen.findByRole("menu", { name: "Actions for LVP01 kW" });
      expect(node("point:1")).not.toContainElement(menu); // a menu inside the node would leak its keys into the canvas
      expect(labelsOf(menu)).toEqual(["Unmap…", "Move to another asset…"]);
      expect(within(menu).getByRole("menuitem", { name: "Unmap…" })).toHaveClass("danger-item");
      expect(within(menu).getAllByRole("menuitem")[0]).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(button).toHaveFocus();
      rightClick("point:1");
      expect(labelsOf(await screen.findByRole("menu", { name: "Actions for LVP01 kW" }))).toEqual(["Unmap…", "Move to another asset…"]);
    });

    it("only a mapped point has it: an unmapped point gets Map… (and New asset… in its menu) and no button", async () => {
      await start([KW_ON_PANEL]);
      await menuButton("LVP01 kW");
      expect(screen.queryByRole("button", { name: "Mapping actions for LVP01 kWh" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Map LVP01 kWh to asset…" })).toBeInTheDocument();
      rightClick("point:3");
      expect(labelsOf(await screen.findByRole("menu", { name: "Actions for LVP01 kWh" }))).toEqual(["Map…", "New asset…"]);
    });

    it("the menu opens next to the BUTTON, not next to the whole node whose far side can be a long way from the pointer", async () => {
      await start([KW_ON_PANEL]);
      const button = await menuButton("LVP01 kW");
      const box = (top: number, left: number, w: number, h: number) =>
        ({ top, left, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
      node("point:1").getBoundingClientRect = () => box(100, 200, 220, 48); // the node: its menu used to open at ITS left edge, 196
      button.getBoundingClientRect = () => box(300, 560, 20, 20); // the button at the node's top right
      await userEvent.click(button);
      const menu = await screen.findByRole("menu", { name: "Actions for LVP01 kW" });
      await waitFor(() => expect(menu.style.left).toBe("556px")); // the button's left edge less the 4 px gap (the panel measures 0 wide here)
      expect(menu.style.top).toBe("300px"); // the button's top
    });

    it("a second press on the button closes its menu and leaves the focus on the button; a third opens it again", async () => {
      await start([KW_ON_PANEL]);
      const button = await menuButton("LVP01 kW");
      await userEvent.click(button);
      expect(await screen.findByRole("menu", { name: "Actions for LVP01 kW" })).toBeInTheDocument();
      await userEvent.click(button);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(button).toHaveFocus();
      await userEvent.click(button);
      expect(await screen.findByRole("menu", { name: "Actions for LVP01 kW" })).toBeInTheDocument();
    });

    it("a press on another node's button closes the first menu and opens the other's", async () => {
      await start([KW_ON_PANEL, V_ON_SITE]);
      await userEvent.click(await menuButton("LVP01 kW"));
      await screen.findByRole("menu", { name: "Actions for LVP01 kW" });
      await userEvent.click(await menuButton("LVP01 V"));
      expect(await screen.findByRole("menu", { name: "Actions for LVP01 V" })).toBeInTheDocument();
      expect(screen.getAllByRole("menu")).toHaveLength(1);
    });

    it("a group with something mapped has the button too, and its menu adds the group's two items after the old ones", async () => {
      await start([KW_ON_PANEL, V_ON_SITE]);
      const button = await menuButton("LVP01");
      expect(node("cluster:1:LVP01")).toContainElement(button);
      await userEvent.click(button);
      expect(labelsOf(await screen.findByRole("menu", { name: "Actions for LVP01" }))).toEqual([
        "Collapse", "Map…", "New asset…", "Unmap this group…", "Move this group's mappings…",
      ]);
    });

    it("a group with nothing mapped has no button, and the old menu", async () => {
      await start([]);
      await screen.findByRole("button", { name: "Map LVP01 to asset…" });
      expect(screen.queryByRole("button", { name: /^Mapping actions/ })).not.toBeInTheDocument();
      rightClick("cluster:1:LVP01");
      expect(labelsOf(await screen.findByRole("menu", { name: "Actions for LVP01" }))).toEqual(["Collapse", "Map…", "New asset…"]);
    });

    it("an asset's menu has one item per source with mappings on it, by name, and nothing for an asset with none (that keeps the canvas menu)", async () => {
      await start([KW_ON_PANEL, V_ON_SITE, M_ON_SITE]);
      await menuButton("LVP01 kW");
      rightClick("asset:10");
      expect(labelsOf(await screen.findByRole("menu", { name: "Actions for Site" }))).toEqual([
        "New sub-asset…", "Unmap everything from Atrium…", "Unmap everything from Plant OPC…", "Expand this branch", "Collapse this branch", "Hide sub-assets", // (Site has sub-assets)
      ]);
      await userEvent.keyboard("{Escape}");
      rightClick("asset:11");
      expect(labelsOf(await screen.findByRole("menu", { name: "Actions for Panel 1" }))).toEqual(["New sub-asset…", "Unmap everything from Plant OPC…"]);
      await userEvent.keyboard("{Escape}");
      // An asset with nothing mapped on it still has New sub-asset… (a role with the asset form), so it no longer falls back to the canvas menu.
      rightClick("asset:12");
      expect(labelsOf(await screen.findByRole("menu", { name: "Actions for Room 1" }))).toEqual(["New sub-asset…"]);
    });
  });

  describe("unmap", () => {
    it("asks first in words that do not lie about billing; Cancel sends nothing", async () => {
      const { calls } = await start([KW_ON_PANEL]);
      await userEvent.click(await menuButton("LVP01 kW"));
      await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Unmap…" }));
      const dialog = await screen.findByRole("dialog", { name: 'Unmap "LVP01 kW" from Panel 1?' });
      expect(dialog).toHaveTextContent("Billing for months that are still open is recalculated without it; closed months keep their billed figures.");
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(mappingCalls(calls)).toEqual([]);
    });

    it("reads the mapping, deletes it, toasts with an Undo, reads the graph again and puts the focus on the node", async () => {
      const { calls, toasts, state } = await start([KW_ON_PANEL]);
      await userEvent.click(await menuButton("LVP01 kW"));
      await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Unmap…" }));
      await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Unmap" }));
      await waitFor(() => expect(toasts.calls).toHaveLength(1));
      expect(mappingCalls(calls)).toEqual(["GET /api/mappings/21", "DELETE /api/mappings/21"]);
      expect(toasts.calls[0]).toMatchObject({ kind: "success", text: "Unmapped 1 point from Panel 1.", options: { durationMs: 10_000, action: { label: "Undo" } } });
      expect(state.mappings.size).toBe(0);
      await waitFor(() => expect(node("point:1")).toHaveFocus());
      expect(screen.queryByRole("button", { name: "Mapping actions for LVP01 kW" })).not.toBeInTheDocument(); // it is unmapped now: Map… instead
      expect(await screen.findByRole("button", { name: "Map LVP01 kW to asset…" })).toBeInTheDocument();
    });

    it("Undo puts the mapping back with the values that were read (scale 0.001, interval 1), and the node shows it mapped again", async () => {
      const { calls, toasts } = await start([KW_ON_PANEL]);
      await userEvent.click(await menuButton("LVP01 kW"));
      await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Unmap…" }));
      await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Unmap" }));
      await waitFor(() => expect(toasts.calls).toHaveLength(1));
      undoOf(toasts, 0)();
      await waitFor(() => expect(toasts.calls).toHaveLength(2));
      expect(toasts.calls[1]).toEqual({ kind: "success", text: "Put back 1 mapping." });
      expect(calls.filter((c) => c.method === "POST" && c.path === "/api/mappings").map((c) => c.body)).toEqual([
        { point_id: 1, asset_id: 11, metric: "active_power_kw", scale: 0.001, interval_seconds: 1, custom_unit: null },
      ]);
      expect(await menuButton("LVP01 kW")).toBeInTheDocument();
    });

    it("a group's Unmap this group… takes every mapped point of the group off, naming the group and the assets", async () => {
      const { calls, toasts } = await start([KW_ON_PANEL, V_ON_SITE]);
      await userEvent.click(await menuButton("LVP01"));
      await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Unmap this group…" }));
      const dialog = await screen.findByRole("dialog", { name: 'Unmap the group "LVP01" from 2 assets?' });
      await userEvent.click(within(dialog).getByRole("button", { name: "Unmap" }));
      await waitFor(() => expect(toasts.calls).toHaveLength(1));
      expect(writes(calls)).toEqual(["DELETE /api/mappings/21", "DELETE /api/mappings/22"]);
      expect(toasts.calls[0].text).toBe("Unmapped 2 points from 2 assets.");
      await waitFor(() => expect(node("cluster:1:LVP01")).toHaveFocus());
    });

    it("an asset's Unmap everything from <source>… takes off only that source's points on that asset", async () => {
      const { calls, toasts } = await start([KW_ON_PANEL, V_ON_SITE, M_ON_SITE]);
      await menuButton("LVP01 kW");
      rightClick("asset:10");
      await userEvent.click(within(await screen.findByRole("menu", { name: "Actions for Site" })).getByRole("menuitem", { name: "Unmap everything from Plant OPC…" }));
      const dialog = await screen.findByRole("dialog", { name: 'Unmap the point of source "Plant OPC" from Site?' });
      await userEvent.click(within(dialog).getByRole("button", { name: "Unmap" }));
      await waitFor(() => expect(toasts.calls).toHaveLength(1));
      expect(writes(calls)).toEqual(["DELETE /api/mappings/22"]); // not 23 (Atrium's) and not 21 (Panel 1's)
      expect(toasts.calls[0].text).toBe("Unmapped 1 point from Site.");
      await waitFor(() => expect(node("asset:10")).toHaveFocus());
    });

    it("when the node is gone after the change the focus goes to the main area", async () => {
      const { state } = await start([KW_ON_PANEL], "admin", {
        "DELETE /api/mappings/21": () => { state.mappings.delete(21); state.dropSource1 = true; return { status: 204 }; },
      });
      await userEvent.click(await menuButton("LVP01 kW"));
      await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Unmap…" }));
      await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Unmap" }));
      await waitFor(() => expect(node("point:1")).toBeNull());
      await waitFor(() => expect(document.getElementById("main")).toHaveFocus());
    });
  });

  describe("move", () => {
    it("a group's Move this group's mappings… moves what is not on the chosen asset already, and says the rest was there", async () => {
      const { calls, toasts } = await start([KW_ON_PANEL, V_ON_SITE]);
      await userEvent.click(await menuButton("LVP01"));
      await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Move this group's mappings…" }));
      const dialog = await screen.findByRole("dialog", { name: 'Move the group "LVP01" to another asset' });
      await userEvent.selectOptions(within(dialog).getByLabelText("Move to"), "10");
      await userEvent.click(within(dialog).getByRole("button", { name: "Move" }));
      await waitFor(() => expect(toasts.calls).toHaveLength(1));
      expect(writes(calls)).toEqual(["PATCH /api/mappings/21"]); // 22 is on Site already
      expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ asset_id: 10 });
      expect(toasts.calls[0]).toMatchObject({ kind: "success", text: "Moved 1 point to Site. 1 was already there.", options: { action: { label: "Undo" } } });
      await waitFor(() => expect(node("cluster:1:LVP01")).toHaveFocus());
    });

    it("a point's Move to another asset… and its Undo send it back where it came from", async () => {
      const { calls, toasts, state } = await start([KW_ON_PANEL]);
      await userEvent.click(await menuButton("LVP01 kW"));
      await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Move to another asset…" }));
      const dialog = await screen.findByRole("dialog", { name: 'Move "LVP01 kW" to another asset' });
      expect(within(dialog.querySelector("select")!).queryByRole("option", { name: /Panel 1/ })).not.toBeInTheDocument(); // it is on Panel 1 already
      await userEvent.selectOptions(within(dialog).getByLabelText("Move to"), "12");
      expect(dialog).toHaveTextContent("Room 1 is a room; meters usually belong to a Panel or Rack. Move here anyway?");
      await userEvent.click(within(dialog).getByRole("button", { name: "Move" }));
      await waitFor(() => expect(toasts.calls).toHaveLength(1));
      expect(toasts.calls[0].text).toBe("Moved 1 point to Room 1.");
      expect(state.mappings.get(21)!.asset_id).toBe(12);
      undoOf(toasts, 0)();
      await waitFor(() => expect(toasts.calls).toHaveLength(2));
      expect(toasts.calls[1]).toEqual({ kind: "success", text: "Put back 1 mapping." });
      expect(state.mappings.get(21)!.asset_id).toBe(11);
      expect(writes(calls).filter((w) => w.startsWith("PATCH"))).toEqual(["PATCH /api/mappings/21", "PATCH /api/mappings/21"]);
    });

    it("keeps Move off and says which point would clash when the chosen asset has the metric already (read from the graph)", async () => {
      const { calls } = await start([KW_ON_PANEL, M_ON_SITE]);
      await userEvent.click(await menuButton("LVP01 kW"));
      await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Move to another asset…" }));
      const dialog = await screen.findByRole("dialog", { name: 'Move "LVP01 kW" to another asset' });
      await userEvent.selectOptions(within(dialog).getByLabelText("Move to"), "10");
      expect(within(dialog).getByRole("alert")).toHaveTextContent('"LVP01 kW" would clash: Site already has that metric.');
      expect(within(dialog).getByRole("button", { name: "Move" })).toBeDisabled();
      expect(writes(calls)).toEqual([]);
    });
  });

  describe("who gets what", () => {
    it("discovery.accept alone (no assets.edit): no button, no unmap or move item anywhere, and the old menus", async () => {
      await start([KW_ON_PANEL, V_ON_SITE], ["discovery.view", "discovery.accept", "assets.view"]);
      await screen.findByRole("button", { name: "Map LVP01 kWh to asset…" });
      expect(screen.queryByRole("button", { name: /^Mapping actions/ })).not.toBeInTheDocument();
      rightClick("point:1");
      expect(await screen.findByRole("menu", { name: "Canvas actions" })).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      rightClick("cluster:1:LVP01");
      expect(labelsOf(await screen.findByRole("menu", { name: "Actions for LVP01" }))).toEqual(["Collapse", "Map…", "New asset…"]);
      await userEvent.keyboard("{Escape}");
      rightClick("asset:11"); // (a leaf: Site has sub-assets, so it has the branch items of its own)
      expect(await screen.findByRole("menu", { name: "Canvas actions" })).toBeInTheDocument();
    });

    it("assets.edit alone (no discovery.accept) still gets the button and the items: the two permissions are independent", async () => {
      await start([KW_ON_PANEL], ["discovery.view", "assets.view", "assets.edit"]);
      await userEvent.click(await menuButton("LVP01 kW"));
      expect(labelsOf(await screen.findByRole("menu", { name: "Actions for LVP01 kW" }))).toEqual(["Unmap…", "Move to another asset…"]);
      expect(screen.queryByRole("button", { name: /^Map LVP01/ })).not.toBeInTheDocument();
    });

    it("a role that may only view Discovery sees none of it", async () => {
      await start([KW_ON_PANEL], ["discovery.view"]);
      await screen.findByText("LVP01 kW");
      expect(screen.queryByRole("button", { name: /^Mapping actions/ })).not.toBeInTheDocument();
    });
  });

  describe("the toast after mapping", () => {
    /** The Review on the unmapped LVP01 kWh (energy_kwh) mapped to Panel 1. */
    async function mapKwh() {
      await userEvent.click(await screen.findByRole("button", { name: "Map LVP01 kWh to asset…" }));
      const review = await screen.findByRole("dialog", { name: "Review mappings" });
      await userEvent.selectOptions(within(review).getByLabelText("Asset"), "11");
      await userEvent.click(within(review).getByRole("button", { name: "Create mappings" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Review mappings" })).not.toBeInTheDocument());
    }

    it("with assets.edit it says what was mapped and carries an Undo that deletes only what it made, after reading it", async () => {
      const { calls, toasts, state } = await start([KW_ON_PANEL]);
      await mapKwh();
      expect(toasts.calls).toHaveLength(1);
      expect(toasts.calls[0]).toMatchObject({ kind: "success", text: "Mapped 1 point to Panel 1.", options: { durationMs: 10_000, action: { label: "Undo" } } });
      expect(state.mappings.has(900)).toBe(true);
      undoOf(toasts, 0)();
      await waitFor(() => expect(toasts.calls).toHaveLength(2));
      expect(mappingCalls(calls)).toEqual(["GET /api/mappings/900", "DELETE /api/mappings/900"]);
      expect(toasts.calls[1]).toEqual({ kind: "success", text: "Unmapped 1 point." });
      expect(state.mappings.has(900)).toBe(false);
      expect(state.mappings.has(21)).toBe(true); // what was there before is untouched
    });

    it("with discovery.accept alone it says the same, with no Undo", async () => {
      const { toasts } = await start([KW_ON_PANEL], ["discovery.view", "discovery.accept", "assets.view"]);
      await mapKwh();
      expect(toasts.calls).toEqual([{ kind: "success", text: "Mapped 1 point to Panel 1." }]);
    });

    it("pressing the Undo leaves the focus on the canvas group (named Discovery graph), not on <body>: the Undo's button went with its toast", async () => {
      const { toasts } = await start([KW_ON_PANEL]);
      await mapKwh();
      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.body).toHaveFocus();
      undoOf(toasts, 0)();
      await waitFor(() => expect(toasts.calls).toHaveLength(2));
      await waitFor(() => expect(screen.getByRole("group", { name: "Discovery graph" })).toHaveFocus());
    });

    it("the bulk create hands its own sentence and what it made to the same toast", async () => {
      const { toasts } = await start([KW_ON_PANEL]);
      await userEvent.click(await screen.findByRole("button", { name: /^Create assets for/ }));
      await screen.findByRole("dialog", { name: "Create assets stub" });
      const info = { text: "Created 2 of 3 assets", kind: "error" as const, mappings: [{ id: 5, assetId: 30, name: "a" }], newAssets: ["LVP01"], undoTitle: "Unmap the points it mapped; the assets stay (Ctrl+Z)" };
      act(() => bulk.props[bulk.props.length - 1].onMapped(info));
      expect(toasts.calls).toHaveLength(1);
      // The dialog's own description of what its Undo does reaches the button.
      expect(toasts.calls[0]).toMatchObject({ kind: "error", text: "Created 2 of 3 assets", options: { action: { label: "Undo", title: "Unmap the points it mapped; the assets stay (Ctrl+Z)" } } });
    });

    it("the bulk create's Undo puts the focus on the canvas group too", async () => {
      const { toasts } = await start([KW_ON_PANEL]);
      await userEvent.click(await screen.findByRole("button", { name: /^Create assets for/ }));
      await screen.findByRole("dialog", { name: "Create assets stub" });
      act(() => bulk.props[bulk.props.length - 1].onMapped({ text: "Created 1 asset", kind: "success", mappings: [{ id: 21, assetId: 11 }], newAssets: ["LVP01"] }));
      (document.activeElement as HTMLElement | null)?.blur();
      undoOf(toasts, 0)();
      await waitFor(() => expect(toasts.calls).toHaveLength(2));
      await waitFor(() => expect(screen.getByRole("group", { name: "Discovery graph" })).toHaveFocus());
    });

    it("the bulk create's toast has no Undo for discovery.accept alone", async () => {
      const { toasts } = await start([KW_ON_PANEL], ["discovery.view", "discovery.accept", "assets.view"]);
      await userEvent.click(await screen.findByRole("button", { name: /^Create assets for/ }));
      await screen.findByRole("dialog", { name: "Create assets stub" });
      act(() => bulk.props[bulk.props.length - 1].onMapped({ text: "Created 1 asset", kind: "success", mappings: [{ id: 5, assetId: 30 }], newAssets: ["LVP01"] }));
      expect(toasts.calls).toEqual([{ kind: "success", text: "Created 1 asset" }]);
    });
  });

  describe("the note about a room", () => {
    it("choosing a room in the Review shows the note in its reserved slot and leaves Create mappings enabled", async () => {
      await start([KW_ON_PANEL]);
      await userEvent.click(await screen.findByRole("button", { name: "Map LVP01 kWh to asset…" }));
      const review = await screen.findByRole("dialog", { name: "Review mappings" });
      const select = within(review).getByLabelText("Asset");
      await userEvent.selectOptions(select, "12");
      await waitFor(() => expect(review).toHaveTextContent("Room 1 is a room; meters usually belong to a Panel or Rack. Map here anyway?"));
      expect(select).toHaveAccessibleDescription(/Room 1 is a room/);
      expect(within(review).getByRole("button", { name: "Create mappings" })).toBeEnabled();
      await userEvent.selectOptions(select, "11"); // a panel: no note
      expect(select).not.toHaveAccessibleDescription();
    });
  });
});

// ---- W12a: New asset from Discovery (the real form), the "+" on an asset node, and several points dropped together ----

describe("DiscoveryPage New asset, the + and several points at once (W12a)", () => {
  const labelsOf = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((item) => item.querySelector(".graph-menu-text > span")?.textContent ?? item.textContent); // (a disabled item with a reason says it in a second span: the label is the first)
  const rightClick = (id: string) => fireEvent.contextMenu(node(id));
  const post = (calls: { method: string; path: string; body?: unknown }[]) => calls.find((c) => c.method === "POST" && c.path === "/api/assets");
  const reviewDialog = () => screen.findByRole("dialog", { name: "Review mappings" });
  const NO_FORM_REASON = "The asset list could not be read, so a new asset cannot be made now. Refresh and try again.";

  /**
   * The page with a server that makes asset 12 when it is asked to and lists it in the next graph (`lists: false`: the graph keeps answering without it, a refresh
   * that does not show the new asset). `hold`: the asset list is held until `release()`. `model`: the graph the server starts from.
   */
  function setup(permissions: PermissionId[] | "admin" = "admin", opts: { lists?: boolean; hold?: boolean; model?: () => GraphModel; extra?: Record<string, unknown> } = {}) {
    const { lists = true, hold = false, model: base = graph, extra = {} } = opts;
    let created: Asset | null = null;
    const model = () => {
      const m = base();
      if (created && lists) m.assets.push({ id: created.id, parent_id: created.parent_id, name: created.name, kind: created.kind });
      return m;
    };
    const user = permissions === "admin" ? routes("admin", model) : { ...routes("custom", model), "GET /api/me": { body: userFor("custom", { permissions }) } };
    const calls = mockFetch({
      ...user,
      "POST /api/assets": ({ body }: { body: unknown }) => { created = { id: 12, sort_order: 0, ...(body as Omit<Asset, "id" | "sort_order">) }; return { status: 201, body: created }; },
      ...extra,
    });
    const held = hold ? holdFetch((method, path) => method === "GET" && path === "/api/assets") : null;
    const toasts = spyToasts();
    renderWithProviders(<><DiscoveryPage /><SignedIn /></>, { route: "/discovery", path: "/discovery", toasts: toasts.api });
    return { calls, toasts, release: () => held?.release() };
  }
  const openAll = async () => {
    await userEvent.click(await screen.findByRole("button", { name: "Expand Plant OPC" }));
    await userEvent.click(screen.getByRole("button", { name: "Expand LVP01" }));
    await accountKnown();
  };
  /** Fills the open New asset form's icon (a Panel) and saves it. */
  const savePanel = async (form: HTMLElement) => {
    await userEvent.click(within(form).getByRole("button", { name: "Change icon" }));
    await userEvent.click(within(form).getByRole("radio", { name: "Panel", hidden: true }));
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
  };

  beforeEach(() => {
    flow.state.intersecting = [];
    flow.state.connect = {};
    flow.getIntersectingNodes.mockClear();
  });

  describe("New asset on the empty canvas and on an asset", () => {
    it("the empty canvas's menu has New asset… after the four canvas items (the selection items of W12b come last), and it opens the asset form with no parent and no note, and saves the icon chosen", async () => {
      const { calls, toasts } = setup();
      await openAll();
      fireEvent.contextMenu(screen.getByTestId("pane"));
      const menu = await screen.findByRole("menu", { name: "Canvas actions" });
      expect(labelsOf(menu)).toEqual(["Expand all", "Collapse all", "Tidy layout", "Fit view", "New asset…", "Expand selection", "Collapse selection"]);
      await userEvent.click(within(menu).getByRole("menuitem", { name: "New asset…" }));
      const form = await screen.findByRole("dialog", { name: "New asset" });
      expect(within(form).getByLabelText("Parent")).toHaveValue("");
      expect(within(form).queryByText(/Next you choose the points to map/)).not.toBeInTheDocument(); // nothing follows the save
      await userEvent.type(within(form).getByLabelText("Name"), "Panel 9");
      await savePanel(form);
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "New asset" })).not.toBeInTheDocument());
      expect(post(calls)?.body).toMatchObject({ name: "Panel 9", parent_id: null, icon: "panel" });
      expect(toasts.calls.map((c) => c.text)).toContain("Asset created");
      expect(screen.queryByRole("dialog", { name: "Review mappings" })).not.toBeInTheDocument(); // it only creates
    });

    it.each([
      ["an operator (neither permission)", "operator" as const, false],
      ["assets.edit without assets.view (the form needs both)", ["discovery.view", "assets.edit"] as PermissionId[], false],
      ["assets.view without assets.edit", ["discovery.view", "assets.view"] as PermissionId[], false],
      ["assets.edit and assets.view", ["discovery.view", "assets.view", "assets.edit"] as PermissionId[], true],
    ])("the empty canvas's menu has New asset… for %s: %s", async (_who, who, has) => {
      setup(who === "operator" ? ["discovery.view"] : who);
      await screen.findByText("Plant OPC");
      await accountKnown();
      fireEvent.contextMenu(screen.getByTestId("pane"));
      const items = labelsOf(await screen.findByRole("menu", { name: "Canvas actions" }));
      expect(items.includes("New asset…")).toBe(has);
    });

    it("an asset's menu has New sub-asset…, which opens the form with that asset as the parent and creates only", async () => {
      const { calls } = setup();
      await openAll();
      rightClick("asset:11");
      await userEvent.click(within(await screen.findByRole("menu", { name: "Actions for Panel 1" })).getByRole("menuitem", { name: "New sub-asset…" }));
      const form = await screen.findByRole("dialog", { name: "New asset" });
      expect(within(form).getByLabelText("Parent")).toHaveValue("11");
      expect(within(form).queryByText(/Next you choose/)).not.toBeInTheDocument();
      await userEvent.type(within(form).getByLabelText("Name"), "Breaker 1");
      await userEvent.click(within(form).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "New asset" })).not.toBeInTheDocument());
      expect(post(calls)?.body).toMatchObject({ name: "Breaker 1", parent_id: 11 });
      expect(screen.queryByRole("dialog", { name: "Review mappings" })).not.toBeInTheDocument();
    });

    it("Cancel keeps nothing and sends nothing", async () => {
      const { calls } = setup();
      await openAll();
      fireEvent.contextMenu(screen.getByTestId("pane"));
      await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "New asset…" }));
      await userEvent.click(within(await screen.findByRole("dialog", { name: "New asset" })).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(post(calls)).toBeUndefined();
    });
  });

  describe("New asset from a group or a point, and the Review that follows", () => {
    it("a group's menu item opens the form named after the group, and the Review opens on the saved asset", async () => {
      const { calls } = setup();
      await openAll();
      rightClick("cluster:1:LVP01");
      await userEvent.click(within(await screen.findByRole("menu", { name: "Actions for LVP01" })).getByRole("menuitem", { name: "New asset…" }));
      const form = await screen.findByRole("dialog", { name: "New asset" });
      expect(within(form).getByLabelText("Name")).toHaveValue("LVP01");
      await userEvent.click(within(form).getByRole("button", { name: "Save" }));
      const review = await reviewDialog();
      expect(within(review).getByLabelText("Asset")).toHaveValue("12");
      expect(within(review).getAllByRole("checkbox")).toHaveLength(2); // LVP01 kW and LVP01 V
      expect(post(calls)?.body).toMatchObject({ name: "LVP01", parent_id: null });
      // The screen where Cancel is pressed says what Cancel does to the asset just made.
      expect(review.querySelector(".mapmove-slot")).toHaveTextContent("LVP01 was created. Cancel keeps it without any mappings.");
    });

    it("a Review opened any other way has no such line", async () => {
      setup();
      await openAll();
      await userEvent.click(screen.getByRole("button", { name: "Map LVP01 to asset…" }));
      const review = await reviewDialog();
      expect(review.querySelector(".mapmove-slot")).toBeEmptyDOMElement();
    });

    it("an unmapped point has New asset… in its menu only, named after the point, and the Review follows with just that point", async () => {
      setup();
      await openAll();
      expect(screen.queryByRole("button", { name: /New asset from LVP01 kW/ })).not.toBeInTheDocument();
      rightClick("point:1");
      await userEvent.click(within(await screen.findByRole("menu", { name: "Actions for LVP01 kW" })).getByRole("menuitem", { name: "New asset…" }));
      const form = await screen.findByRole("dialog", { name: "New asset" });
      expect(within(form).getByLabelText("Name")).toHaveValue("LVP01 kW");
      await userEvent.click(within(form).getByRole("button", { name: "Save" }));
      const review = await reviewDialog();
      expect(within(review).getByLabelText("Asset")).toHaveValue("12");
      expect(within(review).getAllByRole("checkbox")).toHaveLength(1);
      expect(review.querySelector(".mapmove-slot")).toHaveTextContent("LVP01 kW was created. Cancel keeps it without any mappings.");
    });

    it("when the graph cannot be read again the asset stays, the person is told, and no Review opens", async () => {
      const { toasts } = setup("admin", { lists: false });
      await openAll();
      await userEvent.click(screen.getByRole("button", { name: "New asset from LVP01…" }));
      await userEvent.click(within(await screen.findByRole("dialog", { name: "New asset" })).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(toasts.calls).toContainEqual({ kind: "error", text: "The asset was created, but the graph could not be refreshed. Use Map… to map to it." }));
      expect(screen.queryByRole("dialog", { name: "New asset" })).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Review mappings" })).not.toBeInTheDocument();
    });

    it.each([
      ["discovery.accept alone", ["discovery.view", "discovery.accept"] as PermissionId[]],
      ["discovery.accept and assets.edit without assets.view (the form needs both)", ["discovery.view", "discovery.accept", "assets.edit"] as PermissionId[]],
    ])("%s keeps the Review's own New asset choice (name and parent), and no form", async (_who, permissions) => {
      const { calls } = setup(permissions);
      await openAll();
      await userEvent.click(screen.getByRole("button", { name: "New asset from LVP01…" }));
      const review = await reviewDialog();
      expect(within(review).getByRole("radio", { name: "New asset" })).toBeChecked();
      expect(within(review).getByLabelText("New asset name")).toHaveValue("LVP01");
      expect(screen.queryByRole("dialog", { name: "New asset" })).not.toBeInTheDocument();
      expect(post(calls)).toBeUndefined();
      await userEvent.keyboard("{Escape}");
      rightClick("point:1"); // an unmapped point has no New asset… for such a role
      expect(labelsOf(await screen.findByRole("menu", { name: "Actions for LVP01 kW" }))).toEqual(["Map…"]);
    });
  });

  describe("until the asset list is read", () => {
    it("the buttons and menu items that open the form say aria-disabled, a click says why, and they work once the list has come", async () => {
      const { toasts, release } = setup("admin", { hold: true });
      await openAll();
      const button = screen.getByRole("button", { name: "New asset from LVP01…" });
      expect(button).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(button);
      expect(toasts.calls).toContainEqual({ kind: "info", text: "Still reading the asset list. Try again in a moment." });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      fireEvent.contextMenu(screen.getByTestId("pane"));
      const menu = await screen.findByRole("menu", { name: "Canvas actions" });
      expect(within(menu).getByRole("menuitem", { name: "New asset…" })).toHaveAttribute("aria-disabled", "true");
      await userEvent.keyboard("{Escape}");
      release();
      await waitFor(() => expect(screen.getByRole("button", { name: "New asset from LVP01…" })).not.toHaveAttribute("aria-disabled"));
      await userEvent.click(screen.getByRole("button", { name: "New asset from LVP01…" }));
      expect(await screen.findByRole("dialog", { name: "New asset" })).toBeInTheDocument();
    });

    it("a list that cannot be read says so instead of opening a form with no parents to choose", async () => {
      const { toasts } = setup("admin", { extra: { "GET /api/assets": { status: 500, body: { detail: "boom" } } } });
      await openAll();
      await userEvent.click(screen.getByRole("button", { name: "New asset from LVP01…" }));
      expect(toasts.calls).toContainEqual({ kind: "info", text: NO_FORM_REASON });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  describe("the + on an asset node (what the page gives React Flow)", () => {
    const pane = () => screen.getByTestId("pane");
    /** A connection released on `target`, started from `fromHandle` on `fromNode` (what React Flow reports). */
    const released = (target: Element | null, fromHandle: { id: string | null } | null, fromNode: { id: string } | null) =>
      act(() => { flow.state.connect.onConnectEnd?.({ target }, { fromHandle, fromNode }); });

    it("connections are drawn for a role with the form, can never be made, and use the dashed line", async () => {
      setup();
      await openAll();
      expect(flow.state.connect.nodesConnectable).toBe(true);
      expect(flow.state.connect.isValidConnection?.({ source: "asset:10", target: "asset:11" })).toBe(false);
      expect(flow.state.connect.connectionLineComponent).toBe(AddConnectionLine);
    });

    it("a role without the form draws no connection line and has no + (an asset gets no New sub-asset…)", async () => {
      setup(["discovery.view", "assets.view"]);
      await screen.findByText("Plant OPC");
      await accountKnown();
      expect(flow.state.connect.nodesConnectable).toBe(false);
      rightClick("asset:11"); // (a leaf: Site has sub-assets, so it has the branch items of its own)
      expect(await screen.findByRole("menu", { name: "Canvas actions" })).toBeInTheDocument();
    });

    it("a line from the + released on the empty canvas opens New sub-asset with that asset as the parent", async () => {
      setup();
      await openAll();
      released(pane(), { id: "add" }, { id: "asset:11" });
      const form = await screen.findByRole("dialog", { name: "New asset" });
      expect(within(form).getByLabelText("Parent")).toHaveValue("11");
      expect(within(form).queryByText(/Next you choose/)).not.toBeInTheDocument();
    });

    // In the real library every node and every edge is INSIDE `.react-flow__pane` (the mock draws them so), so the pane test alone lets a release on a
    // node through: it was New sub-asset of the asset the line STARTED from, which is the opposite of what putting a line on another asset means.
    it.each<[string, () => Element | null]>([
      ["another asset node", () => node("asset:10")],
      ["the asset it started from", () => node("asset:11")],
      ["something drawn inside a node", () => node("asset:10").firstElementChild],
      ["a point node", () => node("point:1")],
      ["a group node", () => node("cluster:1:LVP01")],
      ["a source node", () => node("src:1")],
      ["an edge", () => document.querySelector("[data-edge]")],
      ["the controls", () => screen.getByTestId("controls")],
    ])("released over %s it does nothing", async (_what, target) => {
      setup();
      await openAll();
      const over = target();
      expect(over).not.toBeNull();
      if (_what !== "the controls") expect(over!.closest(".react-flow__pane")).not.toBeNull(); // the case that matters is the one inside the pane
      released(over, { id: "add" }, { id: "asset:11" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("released over the rectangle a box selection leaves (it covers the selected nodes inside the pane) it does nothing", async () => {
      setup();
      await openAll();
      await userEvent.click(screen.getByTestId("select-asset:10"));
      const rect = await screen.findByTestId("selection-rect");
      expect(rect.closest(".react-flow__pane")).not.toBeNull();
      released(rect, { id: "add" }, { id: "asset:11" });
      released(rect.parentElement, { id: "add" }, { id: "asset:11" }); // the selection's box, around the rectangle
      const other = document.createElement("div");
      other.className = "react-flow__selection"; // the box being drawn
      screen.getByTestId("pane").append(other);
      released(other, { id: "add" }, { id: "asset:11" });
      other.remove();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("released over a control, the minimap or a panel drawn inside the canvas it does nothing either", async () => {
      setup();
      await openAll();
      for (const cls of ["react-flow__controls", "react-flow__minimap", "react-flow__panel"]) {
        const over = document.createElement("div");
        over.className = cls;
        screen.getByTestId("pane").append(over);
        released(over, { id: "add" }, { id: "asset:11" });
        over.remove();
      }
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("released outside the canvas, or on nothing, it does nothing", async () => {
      setup();
      await openAll();
      released(document.body, { id: "add" }, { id: "asset:11" });
      released(null, { id: "add" }, { id: "asset:11" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("a line from any other handle (or none), or from a node that is not an asset, does nothing", async () => {
      setup();
      await openAll();
      released(pane(), { id: null }, { id: "asset:11" });
      released(pane(), { id: "other" }, { id: "asset:11" });
      released(pane(), null, null);
      released(pane(), { id: "add" }, { id: "src:1" });
      released(pane(), { id: "add" }, null);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  describe("several points dropped on an asset together", () => {
    // point:1 (LVP01 kW) and point:2 (LVP01 V) are dragged together; `dragwith-point:1` plays the drag with the partner and ends at the page's drop place.
    const dragTogether = async (partner = "point:2") => {
      flow.state.partner = partner;
      await userEvent.click(screen.getByTestId("dragwith-point:1"));
    };
    const mappedV = () => {
      const m = graph();
      m.sources[0].clusters[0].points[1] = point(2, "LVP01 V", { asset_id: 10, mapping_id: 9, mapped_metric: "voltage_v" });
      return m;
    };

    it("opens ONE Review for all of them on the asset under the pointer, puts them back and remembers nothing", async () => {
      const { calls } = setup("admin");
      await openAll();
      const start = [1, 2].map((id) => [node(`point:${id}`).dataset.x, node(`point:${id}`).dataset.y]);
      flow.state.intersecting = [{ id: "asset:11", type: "asset" }];
      await dragTogether();
      const review = await reviewDialog();
      expect(within(review).getByLabelText("Asset")).toHaveValue("11");
      expect(within(review).getAllByRole("checkbox")).toHaveLength(2);
      expect(review).toHaveTextContent("2 unmapped points from Plant OPC");
      expect(flow.getIntersectingNodes).toHaveBeenCalledWith(expect.objectContaining({ id: "point:1" }));
      expect(calls.some((c) => c.method === "PUT")).toBe(false); // the layout was not saved
      await userEvent.click(within(review).getByRole("button", { name: "Cancel" }));
      await userEvent.click(screen.getByRole("button", { name: "Collapse LVP01" }));
      await userEvent.click(screen.getByRole("button", { name: "Expand LVP01" }));
      expect([1, 2].map((id) => [node(`point:${id}`).dataset.x, node(`point:${id}`).dataset.y])).toEqual(start); // a rebuild still puts them at the start
    });

    it("a refusal (one of them is mapped already) is told in a toast, opens nothing, and saves no layout", async () => {
      const { calls, toasts } = setup("admin", { model: mappedV });
      await openAll();
      flow.state.intersecting = [{ id: "asset:11", type: "asset" }];
      await dragTogether();
      await waitFor(() => expect(toasts.calls).toContainEqual({ kind: "info", text: "1 of the selected points is already mapped. Unmap it first, or select only unmapped points." }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
    });

    it("not over an asset it is the plain move it always was: the layout is saved for both and no dialog opens", async () => {
      const { calls } = setup("admin");
      await openAll();
      flow.state.intersecting = [];
      await dragTogether();
      await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
      const sent = (calls.find((c) => c.method === "PUT")!.body as { nodes: { node_id: string }[] }).nodes.map((n) => n.node_id);
      expect(sent).toEqual(expect.arrayContaining(["point:1", "point:2"]));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("a mix with a node that is not a point (over an asset) stays a plain move, and a role that may not accept never maps by dragging", async () => {
      const { calls } = setup("admin");
      await openAll();
      flow.state.intersecting = [{ id: "asset:11", type: "asset" }];
      await dragTogether("cluster:1:LVP02");
      await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("without discovery.accept the same drag only moves the nodes", async () => {
      const { calls, toasts } = setup(["discovery.view", "discovery.edit"]);
      await openAll();
      flow.state.intersecting = [{ id: "asset:11", type: "asset" }];
      await dragTogether();
      await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(toasts.calls).toEqual([]);
    });
  });
});

// ---- W12b: Unmapped only, Show more, folded assets, expand and collapse of a selection or a branch, and where the focus goes ----

describe("DiscoveryPage Unmapped only, Show more, folded assets and branches (W12b)", () => {
  const FILTER = "dcdash.discovery.unmapped-only";
  const FOLDED = "dcdash.discovery.assets-closed";
  // (a voltage, not the kW the other points suggest: Site may hold each metric once, and the Review refuses a clash)
  const on = (id: number, extra: Partial<GraphPoint> = {}) => kw(id, `pt ${id}`, { asset_id: 10, mapping_id: id + 500, mapped_metric: "voltage_v", ...extra });
  const at = (id: string) => [Number(node(id).dataset.x), Number(node(id).dataset.y)];
  const expand = async (name: string) => userEvent.click(await screen.findByRole("button", { name: `Expand ${name}` }));
  const count = (prefix: string) => document.querySelectorAll(`[data-id^="${prefix}"]`).length;
  const edgeIds = () => [...document.querySelectorAll("[data-edge]")].map((e) => e.getAttribute("data-edge"));
  const switchOf = () => screen.getByRole("switch", { name: "Unmapped only" });
  const moreButton = () => within(node("more:cluster:1:BIG")).getByRole("button", { name: /^Show \d+ more points of BIG/ }); // (the mock draws test buttons beside it)
  const summaryText = () => (document.querySelector(".graph-summary") as HTMLElement).textContent;
  const search = async (text: string) => {
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    await userEvent.type(await screen.findByRole("combobox"), text);
    await userEvent.keyboard("{Enter}");
  };
  /** One source "Big" with one group "BIG" of `n` points; `mappedAt` are the indexes mapped to Site. Point ids are 1000 + the index. */
  const big = (n: number, mappedAt: number[] = []) => srcOf(1, "Big", {
    clusters: [{ key: "BIG", points: Array.from({ length: n }, (_, i) => (mappedAt.includes(i) ? on(1000 + i, { name: `BIG pt ${i}` }) : kw(1000 + i, `BIG pt ${i}`))) }], point_count: n,
  });
  /** Alpha: G1 holds point 11 (mapped), 12 and 13; G2 holds 21 (mapped) and 22. Omega: H holds 31 (mapped). The filter leaves 12, 13 and 22 of 6. */
  const mixed = () => world([
    srcOf(1, "Alpha", { clusters: [{ key: "G1", points: [on(11), kw(12, "pt 12"), kw(13, "pt 13")] }, { key: "G2", points: [on(21), kw(22, "pt 22")] }], point_count: 5 }),
    srcOf(2, "Omega", { clusters: [{ key: "H", points: [on(31)] }], point_count: 1 }),
  ]);

  describe("Unmapped only", () => {
    it("hides the mapped points, and a group or a source with nothing left to map; the count line leads with how many are left", async () => {
      mockFetch(routes("operator", world([
        srcOf(1, "Alpha", { clusters: [{ key: "G1", points: [on(11), kw(12, "pt 12")] }, { key: "G2", points: [on(21)] }], point_count: 3 }),
        srcOf(2, "Omega", { clusters: [{ key: "H", points: [on(31)] }], point_count: 1 }),
      ])));
      open();
      await screen.findByText("Alpha");
      expect(summaryText()).toBe("2 sources, 4 points, 3 mapped");
      await userEvent.click(switchOf());
      expect(summaryText()).toBe("Showing 1 of 4 points, 2 sources, 3 mapped");
      expect(node("src:2")).toBeNull(); // every point of Omega is mapped
      await expand("Alpha");
      expect(node("cluster:1:G1")).not.toBeNull();
      expect(node("cluster:1:G2")).toBeNull(); // nothing left to map in G2
      await expand("G1");
      expect(node("point:12")).not.toBeNull();
      expect(node("point:11")).toBeNull();
      expect(edgeIds().some((id) => id!.startsWith("m:"))).toBe(false); // a mapping is not drawn while the filter is on
      await userEvent.click(switchOf());
      expect(summaryText()).toBe("2 sources, 4 points, 3 mapped");
      expect(node("src:2")).not.toBeNull();
      expect(node("point:11")).not.toBeNull();
      expect(node("cluster:1:G2")).not.toBeNull();
    });

    it("is remembered: a page opened again starts with the filter on", async () => {
      mockFetch(routes("operator", mixed()));
      const first = open();
      await screen.findByText("Alpha");
      await userEvent.click(switchOf());
      expect(window.localStorage.getItem(FILTER)).toBe("on");
      first.unmount();
      mockFetch(routes("operator", mixed()));
      open();
      await screen.findByText("Alpha");
      expect(switchOf()).toBeChecked();
      expect(summaryText()).toBe("Showing 3 of 6 points, 2 sources, 3 mapped");
      expect(node("src:2")).toBeNull();
      await userEvent.click(switchOf());
      expect(window.localStorage.getItem(FILTER)).toBe("off");
    });

    it("Find on a mapped point turns it off, says so and shows the point", async () => {
      window.localStorage.setItem(FILTER, "on");
      mockFetch(routes("operator", mixed()));
      const { toasts } = openToasts();
      await screen.findByText("Alpha");
      expect(switchOf()).toBeChecked();
      await search("pt 11");
      await waitFor(() => expect(node("point:11")).not.toBeNull());
      expect(toasts.calls).toEqual([{ kind: "info", text: "Unmapped only is off so pt 11 can be shown." }]);
      expect(switchOf()).not.toBeChecked();
      expect(window.localStorage.getItem(FILTER)).toBe("off");
    });

    it("Expand all counts only what the filter leaves, and the bar says nothing is closed when the rest is open", async () => {
      window.localStorage.setItem(FILTER, "on");
      mockFetch(routes("operator", mixed()));
      open();
      await screen.findByText("Alpha");
      await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
      expect(node("cluster:1:G2")).not.toBeNull();
      expect(node("point:22")).not.toBeNull();
      expect(node("point:21")).toBeNull();
      expect(screen.getByRole("button", { name: "Expand all" })).toHaveAttribute("aria-disabled", "true"); // Omega is not on the canvas, so it is not closed
    });
  });

  describe("Show more", () => {
    it("an open group draws one page and a Show more node that says what is left; each press adds a page and the focus follows the first new point", async () => {
      mockFetch(routes("operator", world([big(120)])));
      open();
      await expand("Big");
      await expand("BIG");
      expect(count("point:")).toBe(50);
      expect(within(node("cluster:1:BIG")).getByText("50 of 120 shown")).toBeInTheDocument();
      const more = within(node("more:cluster:1:BIG")).getByRole("button", { name: "Show 50 more points of BIG, 70 left" });
      expect(more).toHaveTextContent("Show 50 more (70 left)");
      expect(node("more:cluster:1:BIG")).toHaveAttribute("data-draggable", "false");
      expect(node("more:cluster:1:BIG")).toHaveAttribute("data-selectable", "false");
      expect(node("more:cluster:1:BIG")).not.toHaveAttribute("tabindex");
      await userEvent.click(more);
      expect(count("point:")).toBe(100);
      await waitFor(() => expect(node("point:1050")).toHaveFocus());
      expect(document.body).not.toHaveFocus();
      expect(moreButton()).toHaveTextContent("Show 20 more (20 left)");
      await userEvent.click(moreButton());
      expect(count("point:")).toBe(120);
      expect(node("more:cluster:1:BIG")).toBeNull(); // the last page: the node is gone
      await waitFor(() => expect(node("point:1100")).toHaveFocus());
      expect(within(node("cluster:1:BIG")).queryByText(/shown/)).not.toBeInTheDocument();
    });

    it("a group of exactly one page has no Show more node, and 51 points have one", async () => {
      mockFetch(routes("operator", world([big(50)])));
      open();
      await expand("Big");
      await expand("BIG");
      expect(count("point:")).toBe(50);
      expect(node("more:cluster:1:BIG")).toBeNull();
    });

    it("a mapped point that is not drawn yet keeps one edge from its group to its asset; showing it moves the edge to the point", async () => {
      mockFetch(routes("operator", world([big(120, [100, 101])])));
      open();
      await expand("Big");
      await expand("BIG");
      expect(edgeIds()).toContain("m:cluster:1:BIG>asset:10");
      expect(edgeIds().filter((id) => id!.startsWith("m:"))).toHaveLength(1); // two undrawn points, one summed edge
      await userEvent.click(moreButton());
      await userEvent.click(moreButton());
      expect(edgeIds()).not.toContain("m:cluster:1:BIG>asset:10");
      expect(edgeIds()).toEqual(expect.arrayContaining(["m:point:1100>asset:10", "m:point:1101>asset:10"]));
    });

    it("the pages are for this visit: a group closed and opened again starts at one page", async () => {
      mockFetch(routes("operator", world([big(120)])));
      open();
      await expand("Big");
      await expand("BIG");
      await userEvent.click(moreButton());
      expect(count("point:")).toBe(100);
      await userEvent.click(screen.getByRole("button", { name: "Collapse BIG" }));
      await expand("BIG");
      expect(count("point:")).toBe(50);
    });

    it("Find on a point further down extends the page to reach it, with no toast", async () => {
      mockFetch(routes("operator", world([big(200)])));
      const { toasts } = openToasts();
      await screen.findByText("Big");
      await search("BIG pt 120");
      await waitFor(() => expect(node("point:1120")).not.toBeNull());
      expect(count("point:")).toBe(150);
      expect(moreButton()).toHaveTextContent("Show 50 more (50 left)");
      expect(toasts.calls).toEqual([]);
    });
  });

  describe("folded assets", () => {
    // Site has Panel 1 and Panel 2; one point is mapped to each of them and one is not.
    const tree = () => world([
      srcOf(1, "Plant", { clusters: [{ key: "G", points: [on(1, { asset_id: 11 }), on(2, { asset_id: 12 }), kw(3, "pt 3")] }], point_count: 3 }),
    ], { assets: [{ id: 10, parent_id: null, name: "Site", kind: "generic" }, { id: 11, parent_id: 10, name: "Panel 1", kind: "generic" }, { id: 12, parent_id: 10, name: "Panel 2", kind: "generic" }] });

    it("Hide sub-assets takes the children away, says how many mapped points sit inside, and moves their edges to the asset that stands for them", async () => {
      mockFetch(routes("operator", tree()));
      open();
      await expand("Plant");
      await expand("G");
      expect(edgeIds()).toEqual(expect.arrayContaining(["m:point:1>asset:11", "m:point:2>asset:12", "a:10>11", "a:10>12"]));
      await userEvent.click(screen.getByRole("button", { name: "Hide sub-assets of Site" }));
      expect(node("asset:11")).toBeNull();
      expect(node("asset:12")).toBeNull();
      expect(within(node("asset:10")).getByText("2 mapped")).toBeInTheDocument();
      expect(edgeIds()).toEqual(expect.arrayContaining(["m:point:1>asset:10", "m:point:2>asset:10"]));
      expect(edgeIds().some((id) => id!.startsWith("a:"))).toBe(false);
      expect(window.localStorage.getItem(FOLDED)).toBe("[10]");
      await userEvent.click(screen.getByRole("button", { name: "Show sub-assets of Site" }));
      expect(node("asset:11")).not.toBeNull();
      expect(window.localStorage.getItem(FOLDED)).toBe("[]");
    });

    it("is remembered after the page is opened again, and an asset that is gone from the model is forgotten", async () => {
      window.localStorage.setItem(FOLDED, "[10,99]");
      mockFetch(routes("operator", tree()));
      open();
      await screen.findByText("Site");
      expect(node("asset:11")).toBeNull();
      expect(screen.getByRole("button", { name: "Show sub-assets of Site" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Show sub-assets of Site" }));
      expect(window.localStorage.getItem(FOLDED)).toBe("[]");
    });

    it("a role that can only look at Discovery has the toggle too, and a leaf asset has none", async () => {
      mockFetch({ ...routes("custom", tree()), "GET /api/me": { body: userFor("custom", { permissions: ["discovery.view"] }) } });
      open();
      await screen.findByText("Site");
      await accountKnown();
      expect(screen.getByRole("button", { name: "Hide sub-assets of Site" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /sub-assets of Panel/ })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Hide sub-assets of Site" }));
      expect(node("asset:11")).toBeNull();
    });

    it("the asset's menu folds and unfolds it, and Find on a hidden sub-asset shows it again", async () => {
      window.localStorage.setItem(FOLDED, "[10]");
      mockFetch(routes("operator", tree()));
      open();
      await screen.findByText("Site");
      await search("Panel 2");
      await waitFor(() => expect(node("asset:12")).not.toBeNull());
      expect(window.localStorage.getItem(FOLDED)).toBe("[]");
      fireEvent.contextMenu(node("asset:10"));
      await userEvent.click(within(await screen.findByRole("menu", { name: "Actions for Site" })).getByRole("menuitem", { name: "Hide sub-assets" }));
      expect(node("asset:12")).toBeNull();
    });

    // A sub-asset made under a folded asset would be saved and not drawn: the parent is opened first (kept per browser, like any fold).
    describe("a new sub-asset under a folded asset", () => {
      const folded = async (role = "admin") => {
        window.localStorage.setItem(FOLDED, "[10]");
        mockFetch(routes(role, tree()));
        open();
        await screen.findByText("Site");
        await accountKnown();
        expect(node("asset:11")).toBeNull();
      };

      it("the menu's New sub-asset… opens the parent, then the form", async () => {
        await folded();
        fireEvent.contextMenu(node("asset:10"));
        await userEvent.click(within(await screen.findByRole("menu", { name: "Actions for Site" })).getByRole("menuitem", { name: "New sub-asset…" }));
        expect(within(await screen.findByRole("dialog", { name: "New asset" })).getByLabelText("Parent")).toHaveValue("10");
        expect(node("asset:11")).not.toBeNull();
        expect(node("asset:12")).not.toBeNull();
        expect(window.localStorage.getItem(FOLDED)).toBe("[]");
      });

      it("the + (a line released on the empty canvas) does the same", async () => {
        await folded();
        act(() => { flow.state.connect.onConnectEnd?.({ target: screen.getByTestId("pane") }, { fromHandle: { id: "add" }, fromNode: { id: "asset:10" } }); });
        expect(within(await screen.findByRole("dialog", { name: "New asset" })).getByLabelText("Parent")).toHaveValue("10");
        expect(node("asset:11")).not.toBeNull();
        expect(window.localStorage.getItem(FOLDED)).toBe("[]");
      });

      it("only the parent is opened: another folded asset stays folded", async () => {
        window.localStorage.setItem(FOLDED, "[10,11]");
        mockFetch(routes("admin", world([srcOf(1, "Plant", { clusters: [{ key: "G", points: [kw(1, "pt 1")] }], point_count: 1 })], {
          assets: [{ id: 10, parent_id: null, name: "Site", kind: "generic" }, { id: 11, parent_id: 10, name: "Panel 1", kind: "generic" }, { id: 13, parent_id: 11, name: "Breaker", kind: "generic" }],
        })));
        open();
        await screen.findByText("Site");
        await accountKnown();
        fireEvent.contextMenu(node("asset:10"));
        await userEvent.click(within(await screen.findByRole("menu", { name: "Actions for Site" })).getByRole("menuitem", { name: "New sub-asset…" }));
        await screen.findByRole("dialog", { name: "New asset" });
        expect(node("asset:11")).not.toBeNull();
        expect(node("asset:13")).toBeNull(); // Panel 1 is still folded
        expect(window.localStorage.getItem(FOLDED)).toBe("[11]");
      });

      it("an asset that is not folded changes nothing", async () => {
        window.localStorage.setItem(FOLDED, "[]");
        mockFetch(routes("admin", tree()));
        open();
        await screen.findByText("Site");
        await accountKnown();
        fireEvent.contextMenu(node("asset:10"));
        await userEvent.click(within(await screen.findByRole("menu", { name: "Actions for Site" })).getByRole("menuitem", { name: "New sub-asset…" }));
        await screen.findByRole("dialog", { name: "New asset" });
        expect(window.localStorage.getItem(FOLDED)).toBe("[]");
        expect(node("asset:11")).not.toBeNull();
      });

      it("while the asset list is still being read no form opens, and the asset stays folded", async () => {
        window.localStorage.setItem(FOLDED, "[10]");
        mockFetch(routes("admin", tree()));
        const held = holdFetch((method, path) => method === "GET" && path === "/api/assets");
        const toasts = spyToasts();
        renderWithProviders(<><DiscoveryPage /><SignedIn /></>, { route: "/discovery", path: "/discovery", toasts: toasts.api });
        await screen.findByText("Site");
        await accountKnown();
        act(() => { flow.state.connect.onConnectEnd?.({ target: screen.getByTestId("pane") }, { fromHandle: { id: "add" }, fromNode: { id: "asset:10" } }); });
        expect(toasts.calls).toContainEqual({ kind: "info", text: "Still reading the asset list. Try again in a moment." });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(node("asset:11")).toBeNull();
        expect(window.localStorage.getItem(FOLDED)).toBe("[10]");
        held.release();
      });
    });
  });

  describe("expand and collapse a selection or a branch", () => {
    const pick = (id: string) => userEvent.click(screen.getByTestId(`select-${id}`));
    const chevron = (name: string) => screen.getByRole("button", { name });

    it("the bar's Expand selection opens the selected source, and Expand this branch opens its groups too; a toast says what changed", async () => {
      mockFetch(routes("operator"));
      const { toasts } = openToasts();
      await screen.findByText("Plant OPC");
      await pick("src:1");
      await userEvent.click(chevron("More ways to expand"));
      await userEvent.click(within(await screen.findByRole("menu", { name: "Expand options" })).getByRole("menuitem", { name: "Expand selection" }));
      expect(node("cluster:1:LVP01")).not.toBeNull();
      expect(node("point:1")).toBeNull(); // the groups stay closed: only the selection
      expect(toasts.calls.at(-1)).toEqual({ kind: "info", text: "Opened 1 source." });
      await userEvent.click(chevron("More ways to expand"));
      await userEvent.click(within(await screen.findByRole("menu", { name: "Expand options" })).getByRole("menuitem", { name: "Expand this branch" }));
      expect(node("point:1")).not.toBeNull();
      expect(toasts.calls.at(-1)).toEqual({ kind: "info", text: "Opened 3 groups." });
      expect(chevron("More ways to expand")).toHaveFocus(); // the menu gave the focus back to the chevron
    });

    it("Collapse selection closes the selected group only; Collapse this branch closes the source and its groups", async () => {
      mockFetch(routes("operator"));
      const { toasts } = openToasts();
      await expand("Plant OPC");
      await expand("LVP01");
      await expand("LVP02");
      await pick("cluster:1:LVP01");
      await userEvent.click(chevron("More ways to collapse"));
      await userEvent.click(within(await screen.findByRole("menu", { name: "Collapse options" })).getByRole("menuitem", { name: "Collapse selection" }));
      expect(node("point:1")).toBeNull();
      expect(node("point:3")).not.toBeNull();
      expect(toasts.calls.at(-1)).toEqual({ kind: "info", text: "Closed 1 group." });
      await pick("src:1");
      await userEvent.click(chevron("More ways to collapse"));
      await userEvent.click(within(await screen.findByRole("menu", { name: "Collapse options" })).getByRole("menuitem", { name: "Collapse this branch" }));
      expect(node("cluster:1:LVP02")).toBeNull();
      expect(toasts.calls.at(-1)).toEqual({ kind: "info", text: "Closed 1 source and 1 group." });
    });

    it("a node's own menu has Expand this branch and Collapse this branch for THAT node, whatever is selected", async () => {
      mockFetch(routes("operator"));
      const { toasts } = openToasts();
      await screen.findByText("Plant OPC");
      await pick("asset:11"); // something else is selected
      fireEvent.contextMenu(node("src:1"));
      await userEvent.click(within(await screen.findByRole("menu", { name: "Actions for Plant OPC" })).getByRole("menuitem", { name: "Expand this branch" }));
      expect(toasts.calls.at(-1)).toEqual({ kind: "info", text: "Opened 1 source and 3 groups." });
      expect(node("point:1")).not.toBeNull();
      fireEvent.contextMenu(node("src:1"));
      await userEvent.click(within(await screen.findByRole("menu", { name: "Actions for Plant OPC" })).getByRole("menuitem", { name: "Collapse this branch" }));
      expect(toasts.calls.at(-1)).toEqual({ kind: "info", text: "Closed 1 source and 3 groups." });
      expect(node("cluster:1:LVP01")).toBeNull();
    });

    it("a group's own menu has no branch items (its branch is itself, and Expand or Collapse is that); a source's and an asset's keep them", async () => {
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      await expand("LVP01");
      fireEvent.contextMenu(node("cluster:1:LVP01"));
      const labels = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((item) => item.querySelector(".graph-menu-text > span")?.textContent ?? item.textContent);
      expect(labels(await screen.findByRole("menu", { name: "Actions for LVP01" }))).toEqual(["Collapse"]);
      await userEvent.keyboard("{Escape}");
      fireEvent.contextMenu(node("src:1"));
      expect(labels(await screen.findByRole("menu", { name: "Actions for Plant OPC" }))).toEqual(expect.arrayContaining(["Expand this branch", "Collapse this branch"]));
      await userEvent.keyboard("{Escape}");
      fireEvent.contextMenu(node("asset:10"));
      expect(labels(await screen.findByRole("menu", { name: "Actions for Site" }))).toEqual(expect.arrayContaining(["Expand this branch", "Collapse this branch"]));
    });

    it("a node's menu words its reasons for the node, never for 'everything selected'", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      await pick("asset:11"); // something else is selected, and it is not what the menu acts on
      fireEvent.contextMenu(node("src:1"));
      const closed = await screen.findByRole("menu", { name: "Actions for Plant OPC" });
      expect(within(closed).getByRole("menuitem", { name: /^Collapse this branch/ })).toHaveAttribute("title", "This branch is already closed.");
      expect(within(closed).getByRole("menuitem", { name: /^Collapse this branch/ })).toHaveTextContent("This branch is already closed.");
      expect(within(closed).getByRole("menuitem", { name: "Expand this branch" })).not.toHaveAttribute("aria-disabled");
      await userEvent.click(within(closed).getByRole("menuitem", { name: "Expand this branch" }));
      fireEvent.contextMenu(node("src:1"));
      const opened = await screen.findByRole("menu", { name: "Actions for Plant OPC" });
      expect(within(opened).getByRole("menuitem", { name: /^Expand this branch/ })).toHaveAttribute("title", "This branch is already open.");
      expect(opened.textContent ?? "").not.toMatch(/selected/i);
      await userEvent.keyboard("{Escape}");
      // The bar and the selection menu keep their own words.
      await pick("src:1");
      fireEvent.contextMenu(screen.getByTestId("selection-rect"));
      expect(within(await screen.findByRole("menu", { name: "Canvas actions" })).getByRole("menuitem", { name: /^Expand selection/ })).toHaveAttribute("title", "Everything selected is already open.");
    });

    it("the pane's menu has Expand selection and Collapse selection, disabled with the reason while nothing is selected", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      fireEvent.contextMenu(screen.getByTestId("pane"));
      const menu = await screen.findByRole("menu", { name: "Canvas actions" });
      for (const name of [/^Expand selection/, /^Collapse selection/]) {
        const item = within(menu).getByRole("menuitem", { name });
        expect(item).toHaveAttribute("aria-disabled", "true");
        expect(item).toHaveAttribute("title", "Select a source, group or asset first.");
      }
      await userEvent.keyboard("{Escape}");
      await pick("src:1");
      fireEvent.contextMenu(screen.getByTestId("selection-rect"));
      const menu2 = await screen.findByRole("menu", { name: "Canvas actions" });
      expect(within(menu2).getByRole("menuitem", { name: "Expand selection" })).not.toHaveAttribute("aria-disabled");
      expect(within(menu2).getByRole("menuitem", { name: /^Collapse selection/ })).toHaveAttribute("title", "Everything selected is already closed.");
    });

    it("the bar's chevrons say why they cannot open: nothing selected, then nothing that opens or closes", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      expect(chevron("More ways to expand")).toHaveAttribute("aria-disabled", "true");
      expect(chevron("More ways to expand")).toHaveAttribute("title", "Select a source, group or asset first.");
      await pick("asset:11");
      expect(chevron("More ways to collapse")).toHaveAttribute("title", "Nothing selected opens or closes.");
      await userEvent.click(chevron("More ways to collapse"));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      await pick("src:1");
      expect(chevron("More ways to expand")).not.toHaveAttribute("aria-disabled");
    });
  });

  describe("dragging with a Show more node", () => {
    const puts = <T extends { method: string }>(calls: T[]) => calls.filter((c) => c.method === "PUT");
    const sentIds = (call: { body?: unknown }) => (call.body as { nodes: { node_id: string }[] }).nodes.map((n) => n.node_id);
    beforeEach(() => { flow.state.intersecting = []; }); // (an earlier describe may have left a node under every drop, which would open the Review instead of moving the group)

    it("a source drag takes the Show more node along, and the node is never sent to the layout", async () => {
      const calls = mockFetch(routes("admin", world([big(120)])));
      open();
      await expand("Big");
      await expand("BIG");
      const before = at("more:cluster:1:BIG");
      flow.state.dropAt = { x: 100, y: 50 };
      await userEvent.click(screen.getByTestId("drag-src:1"));
      expect(at("more:cluster:1:BIG")).toEqual([before[0] + 100, before[1] + 50]);
      await waitFor(() => expect(puts(calls)).toHaveLength(1));
      expect(sentIds(puts(calls)[0])).toEqual(["src:1"]);
    });

    it("an Alt drag of a paged group sends no Show more id, and the node stays where it stands", async () => {
      const calls = mockFetch(routes("admin", world([big(120)])));
      open();
      await expand("Big");
      await expand("BIG");
      const before = at("more:cluster:1:BIG");
      fireEvent.click(screen.getByTestId("drag-cluster:1:BIG"), { altKey: true });
      await waitFor(() => expect(puts(calls)).toHaveLength(1));
      const sent = sentIds(puts(calls)[0]);
      expect(sent).toContain("cluster:1:BIG");
      expect(sent.every((id) => !id.startsWith("more:"))).toBe(true);
      expect(at("more:cluster:1:BIG")).toEqual(before);
    });

    it("a plain drag of a paged group takes the node along too", async () => {
      const calls = mockFetch(routes("admin", world([big(120)])));
      open();
      await expand("Big");
      await expand("BIG");
      const before = at("more:cluster:1:BIG");
      const group = at("cluster:1:BIG");
      flow.state.dropAt = { x: group[0] + 30, y: group[1] + 40 };
      await userEvent.click(screen.getByTestId("drag-cluster:1:BIG"));
      expect(at("more:cluster:1:BIG")).toEqual([before[0] + 30, before[1] + 40]);
      await waitFor(() => expect(puts(calls)).toHaveLength(1));
      expect(sentIds(puts(calls)[0]).every((id) => !id.startsWith("more:"))).toBe(true);
    });
  });

  describe("the focus after a mapping that the filter removes from the canvas", () => {
    /** The server maps whatever the Review sends; `done` is the set of mapped point ids, `base` those mapped from the start. */
    const serve = (base: number[]) => {
      const done = new Set(base);
      const model = () => world([
        srcOf(1, "Alpha", {
          clusters: [
            { key: "G1", points: [11, 12, 13].map((id) => (done.has(id) ? on(id) : kw(id, `pt ${id}`))) },
            { key: "G2", points: [21].map((id) => (done.has(id) ? on(id) : kw(id, `pt ${id}`))) },
          ],
          point_count: 4,
        }),
        srcOf(2, "Omega", { clusters: [{ key: "H", points: [31].map((id) => (done.has(id) ? on(id) : kw(id, `pt ${id}`))) }], point_count: 1 }),
      ]);
      const calls = mockFetch({
        ...routes("admin", model),
        "GET /api/asset-kinds": { body: [] },
        "POST /api/discovery/accept": ({ body }: { body: unknown }) => {
          const sent = (body as { points: { point_id: number }[] }).points;
          for (const p of sent) done.add(p.point_id);
          return { status: 201, body: { asset_id: 10, mapping_ids: sent.map((p) => p.point_id + 500) } };
        },
      });
      return { done, calls };
    };
    const mapPoint = async (id: number) => {
      await userEvent.click(await screen.findByRole("button", { name: `Map pt ${id} to asset…` }));
      const review = await screen.findByRole("dialog", { name: "Review mappings" });
      await userEvent.selectOptions(within(review).getByLabelText("Asset"), "10");
      await userEvent.click(within(review).getByRole("button", { name: "Create mappings" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    };
    const start = async (base: number[]) => {
      window.localStorage.setItem(FILTER, "on");
      serve(base);
      openToasts();
      await expand("Alpha");
      await expand("G1");
      await accountKnown();
    };

    it("goes to the next unmapped point of the same group", async () => {
      await start([]);
      await mapPoint(11);
      await waitFor(() => expect(node("point:11")).toBeNull());
      await waitFor(() => expect(node("point:12")).toHaveFocus());
    });

    it("goes to the group when no unmapped point follows", async () => {
      await start([]);
      await mapPoint(13);
      await waitFor(() => expect(node("point:13")).toBeNull());
      await waitFor(() => expect(node("cluster:1:G1")).toHaveFocus());
    });

    it("goes to the source when the filter hides the whole group", async () => {
      await start([12, 13]);
      await mapPoint(11);
      await waitFor(() => expect(node("cluster:1:G1")).toBeNull());
      await waitFor(() => expect(node("src:1")).toHaveFocus());
    });

    it("goes to the canvas group, which is named, when the filter hides the whole source", async () => {
      await start([12, 13, 21]); // point 11 is the only one of Alpha left to map
      await mapPoint(11);
      await waitFor(() => expect(node("src:1")).toBeNull());
      await waitFor(() => expect(screen.getByRole("group", { name: "Discovery graph" })).toHaveFocus());
    });

    it("leaves the focus alone when the filter is off", async () => {
      window.localStorage.setItem(FILTER, "off");
      serve([]);
      openToasts();
      await expand("Alpha");
      await expand("G1");
      await accountKnown();
      await mapPoint(11);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(node("point:12")).not.toHaveFocus();
    });
  });
});

// ---- W12b: the arrow keys, the camera rules of a jump, the screen-reader text and the rule that the focus never lands on the page body ----

describe("DiscoveryPage arrow keys, camera and focus rules (W12b)", () => {
  const DESCRIPTION = "Arrow keys move between nodes. Enter opens or closes. Space selects.";
  const FILTER = "dcdash.discovery.unmapped-only";
  const FOLDED = "dcdash.discovery.assets-closed";
  const expand = async (name: string) => userEvent.click(await screen.findByRole("button", { name: `Expand ${name}` }));
  /** Inside act: the wrapper's onFocus updates the path highlight. */
  const focusOn = (id: string) => act(() => node(id).focus());
  const canvasGroup = () => screen.getByRole("group", { name: "Discovery graph" });
  const later = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
  const switchOf = () => screen.getByRole("switch", { name: "Unmapped only" });
  /** The canvas is 800x600 (jsdom measures nothing). */
  const sized = () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(600);
  };
  /** Waits for the open source's pan to be over (it runs after a paint), then moves the camera so that no node is in sight. */
  const lookAway = async (zoom = 1) => {
    await screen.findByText("LVP01 (2)");
    await later(80);
    flow.state.viewport = { x: -3000, y: -3000, zoom };
    flow.setViewport.mockClear();
  };
  const pressed = async (key: string, expected: string) => {
    await userEvent.keyboard(`{${key}}`);
    await waitFor(() => expect(node(expected)).toHaveFocus());
  };
  const mapped = (id: number) => kw(id, `pt ${id}`, { asset_id: 10, mapping_id: id + 500, mapped_metric: "voltage_v" });

  beforeEach(() => {
    window.localStorage.removeItem(FILTER);
    window.localStorage.removeItem(FOLDED);
    // jsdom measures nothing, and the page waits for a node to be measured before it aims the camera at it: every node is measured unless a test says otherwise.
    flow.getNodes.mockImplementation(() => flow.state.nodes.map((n: any) => (n.measured ? n : { ...n, measured: { width: 220, height: 80 } })));
    flow.setViewport.mockImplementation(async () => true);
    flow.state.intersecting = [];
  });
  afterEach(() => {
    flow.getNodes.mockImplementation(() => flow.state.nodes);
    flow.setViewport.mockImplementation(async () => true);
    vi.restoreAllMocks();
  });

  describe("the arrow keys", () => {
    it("walk the drawn tree: down and up between siblings, right into the first child, left to the parent", async () => {
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      await expand("LVP01");
      focusOn("src:1");
      await pressed("ArrowRight", "cluster:1:LVP01");
      await pressed("ArrowDown", "cluster:1:LVP02");
      await pressed("ArrowUp", "cluster:1:LVP01");
      await pressed("ArrowRight", "point:1");
      await pressed("ArrowDown", "point:2");
      await pressed("ArrowLeft", "cluster:1:LVP01");
      await pressed("ArrowLeft", "src:1");
      await pressed("ArrowDown", "unid:10.0.0.9:8080"); // the unidentified services stand in the sources' column
      expect(document.body).not.toHaveFocus();
    });

    it("the assets are a column of their own: right goes to a sub-asset, left back to its parent, and down never leaves the column", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Site");
      focusOn("asset:10");
      await pressed("ArrowRight", "asset:11");
      await pressed("ArrowLeft", "asset:10");
      await userEvent.keyboard("{ArrowDown}"); // nothing below Site in its column: the key is ours all the same
      await later(120);
      expect(node("asset:10")).toHaveFocus();
    });

    it("from the canvas itself, Down or Right goes to the first node and Up or Left does nothing", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      act(() => canvasGroup().focus());
      await userEvent.keyboard("{ArrowUp}{ArrowLeft}");
      await later(120);
      expect(canvasGroup()).toHaveFocus();
      await pressed("ArrowDown", "src:1");
    });

    it("an arrow pressed inside a node's own button is left alone, and so is a node that is selected (React Flow moves it 5 px)", async () => {
      mockFetch(routes("operator"));
      open();
      const toggle = await screen.findByRole("button", { name: "Expand Plant OPC" });
      act(() => toggle.focus());
      expect(fireEvent.keyDown(toggle, { key: "ArrowDown" })).toBe(true); // not prevented
      await userEvent.click(screen.getByTestId("select-src:1"));
      focusOn("src:1");
      expect(fireEvent.keyDown(node("src:1"), { key: "ArrowDown" })).toBe(true);
      await later(120);
      expect(node("src:1")).toHaveFocus();
      expect(flow.setViewport).not.toHaveBeenCalled();
    });

    it("Enter opens or closes a source or a group and folds an asset that has sub-assets; the focus stays on the node", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      focusOn("src:1");
      expect(fireEvent.keyDown(node("src:1"), { key: "Enter" })).toBe(false); // ours: React Flow never sees it
      await screen.findByText("LVP01 (2)");
      expect(node("src:1")).toHaveFocus();
      focusOn("cluster:1:LVP01");
      fireEvent.keyDown(node("cluster:1:LVP01"), { key: "Enter" });
      await waitFor(() => expect(node("point:1")).not.toBeNull());
      expect(node("cluster:1:LVP01")).toHaveFocus();
      fireEvent.keyDown(node("cluster:1:LVP01"), { key: "Enter" });
      await waitFor(() => expect(node("point:1")).toBeNull());
      expect(node("cluster:1:LVP01")).toHaveFocus();
      focusOn("asset:10");
      fireEvent.keyDown(node("asset:10"), { key: "Enter" });
      await waitFor(() => expect(node("asset:11")).toBeNull());
      expect(node("asset:10")).toHaveFocus();
      fireEvent.keyDown(node("asset:10"), { key: "Enter" });
      await waitFor(() => expect(node("asset:11")).not.toBeNull());
      expect(node("asset:10")).toHaveFocus();
    });

    it("Enter on a point or on an asset with no sub-assets does not toggle anything and is left to React Flow (it selects)", async () => {
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      await expand("LVP01");
      focusOn("point:1");
      expect(fireEvent.keyDown(node("point:1"), { key: "Enter" })).toBe(true);
      focusOn("asset:11");
      expect(fireEvent.keyDown(node("asset:11"), { key: "Enter" })).toBe(true);
      await later(120);
      expect(screen.getByRole("button", { name: "Collapse LVP01" })).toBeInTheDocument();
      expect(node("asset:11")).not.toBeNull();
      expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    });

    it("Escape on a selected node clears the selection and the focus stays on the node (React Flow would have blurred it)", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      await userEvent.click(screen.getByTestId("select-src:1"));
      await userEvent.click(screen.getByTestId("select-asset:11"));
      expect(node("src:1")).toHaveAttribute("data-selected", "true");
      focusOn("src:1");
      expect(fireEvent.keyDown(node("src:1"), { key: "Escape" })).toBe(false); // ours: React Flow never sees it
      await waitFor(() => expect(node("src:1")).toHaveAttribute("data-selected", "false"));
      expect(node("asset:11")).toHaveAttribute("data-selected", "false"); // the whole selection goes, as it does on the empty canvas
      expect(node("src:1")).toHaveFocus();
      expect(document.body).not.toHaveFocus();
    });

    it("Escape on a node that is not selected is left alone, and so is Escape on the empty canvas (which clears as before)", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      await userEvent.click(screen.getByTestId("select-asset:11"));
      focusOn("src:1");
      expect(fireEvent.keyDown(node("src:1"), { key: "Escape" })).toBe(true);
      act(() => canvasGroup().focus());
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(node("asset:11")).toHaveAttribute("data-selected", "false"));
      expect(canvasGroup()).toHaveFocus();
    });

    describe("on the Show more button", () => {
      const BIG = () => world([srcOf(1, "Big", { clusters: [{ key: "BIG", points: Array.from({ length: 120 }, (_, i) => kw(1000 + i, `BIG pt ${i}`)) }], point_count: 120 })]);
      const more = () => within(node("more:cluster:1:BIG")).getByRole("button", { name: /^Show 50 more points of BIG/ });
      const onMore = async () => {
        sized();
        mockFetch(routes("operator", BIG()));
        open();
        await expand("Big");
        await expand("BIG");
        act(() => more().focus());
      };

      it("Up goes to the last point drawn and Left to the group: the list's last stop is not a dead end", async () => {
        await onMore();
        await pressed("ArrowUp", "point:1049");
        act(() => more().focus());
        await pressed("ArrowLeft", "cluster:1:BIG");
      });

      it("Down and Right have nowhere to go: the key is ours all the same and the focus stays", async () => {
        await onMore();
        expect(fireEvent.keyDown(more(), { key: "ArrowDown" })).toBe(false);
        expect(fireEvent.keyDown(more(), { key: "ArrowRight" })).toBe(false);
        await later(120);
        expect(more()).toHaveFocus();
      });

      it("Enter and Space are the button's own: they press it (50 more points are drawn)", async () => {
        await onMore();
        expect(fireEvent.keyDown(more(), { key: "Enter" })).toBe(true); // not taken
        expect(fireEvent.keyDown(more(), { key: " " })).toBe(true);
        await userEvent.keyboard("{Enter}");
        await waitFor(() => expect(node("point:1050")).toHaveFocus());
        expect(node("point:1099")).not.toBeNull();
      });
    });
  });

  describe("the camera and the focus of a jump", () => {
    it("pans and never zooms, and the focus lands only after the glide is over, without scrolling the page", async () => {
      sized();
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      await lookAway(1.5);
      let release!: () => void;
      flow.setViewport.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }));
      const focus = vi.spyOn(node("cluster:1:LVP02"), "focus");
      focusOn("cluster:1:LVP01");
      await userEvent.keyboard("{ArrowDown}");
      await waitFor(() => expect(flow.setViewport).toHaveBeenCalledTimes(1));
      const [view, options] = flow.setViewport.mock.calls[0] as [{ x: number; y: number; zoom: number }, { duration: number }];
      expect(view.zoom).toBe(1.5); // the zoom is the person's
      expect(view.x).toBeGreaterThan(-3000);
      expect(view.y).toBeGreaterThan(-3000);
      expect(options).toEqual({ duration: 300 });
      expect(focus).not.toHaveBeenCalled(); // React Flow's own focus handler would cut the glide short
      release();
      await waitFor(() => expect(node("cluster:1:LVP02")).toHaveFocus());
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    });

    it("does not move the camera for a node that is already in view", async () => {
      sized();
      flow.state.viewport = { x: 100, y: 100, zoom: 1 };
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      await screen.findByText("LVP01 (2)");
      await later(80);
      flow.setViewport.mockClear();
      focusOn("cluster:1:LVP01");
      await pressed("ArrowDown", "cluster:1:LVP02");
      expect(flow.setViewport).not.toHaveBeenCalled();
    });

    describe("the minimap and the tools panel are drawn over the canvas: a node the keys go to is kept clear of them", () => {
      const box = (top: number, bottom: number, left = 0, right = 800) => ({ top, bottom, left, right, x: left, y: top, width: right - left, height: bottom - top, toJSON: () => ({}) }) as DOMRect;
      /** The canvas is 600 tall and starts 100 px down the page; the minimap's top is at 450, the tools panel ends at 150. The usual margin is 40, so a node may not end below 334 or start above 58. */
      const overlaid = async (targetTop: number) => {
        sized();
        mockFetch(routes("operator"));
        open();
        await expand("Plant OPC");
        await screen.findByText("LVP01 (2)");
        await later(80);
        canvasGroup().getBoundingClientRect = () => box(100, 700);
        screen.getByTestId("minimap").getBoundingClientRect = () => box(450, 602, 600, 800);
        document.querySelector(".graph-tools")!.getBoundingClientRect = () => box(108, 150);
        flow.state.viewport = { x: 0, y: targetTop - Number(node("cluster:1:LVP02").dataset.y), zoom: 1 }; // the target (80 tall) stands at screen y targetTop
        flow.setViewport.mockClear();
        focusOn("cluster:1:LVP01");
        await userEvent.keyboard("{ArrowDown}");
        await waitFor(() => expect(node("cluster:1:LVP02")).toHaveFocus());
      };
      const screenTop = () => {
        const [to] = flow.setViewport.mock.calls[0] as [{ y: number }];
        return Number(node("cluster:1:LVP02").dataset.y) + to.y;
      };

      it("a node that would land under the minimap is lifted above it", async () => {
        await overlaid(400); // 400..480: inside the usual 40, under the minimap
        expect(flow.setViewport).toHaveBeenCalledTimes(1);
        expect(screenTop() + 80).toBeLessThanOrEqual(450 - 100 - 16 + 0.5);
      });

      it("a node that would land under the tools panel is lowered below it", async () => {
        await overlaid(45); // 45..125: inside the usual 40, under the panel (its bottom is 50 below the canvas top)
        expect(flow.setViewport).toHaveBeenCalledTimes(1);
        expect(screenTop()).toBeGreaterThanOrEqual(150 - 100 + 8 - 0.5);
      });

      it("a node that is clear of both does not move the camera", async () => {
        await overlaid(200);
        expect(flow.setViewport).not.toHaveBeenCalled();
      });
    });

    it("moves at once under reduced motion", async () => {
      Object.defineProperty(window, "matchMedia", {
        configurable: true, writable: true,
        value: (query: string) => ({ matches: query.includes("reduced-motion"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
      });
      try {
        sized();
        mockFetch(routes("operator"));
        open();
        await expand("Plant OPC");
        await lookAway();
        focusOn("cluster:1:LVP01");
        await pressed("ArrowDown", "cluster:1:LVP02");
        expect(flow.setViewport.mock.calls[0][1]).toEqual({ duration: 0 });
      } finally {
        delete (window as { matchMedia?: unknown }).matchMedia;
      }
    });

    it("waits until the node is measured: a new node is hidden until then, and a hidden node cannot take the focus", async () => {
      sized();
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      await lookAway();
      let reads = 0; // how often the page has looked at the target
      flow.getNodes.mockImplementation(() => flow.state.nodes.map((n: any) => {
        if (n.id !== "cluster:1:LVP02") return { ...n, measured: { width: 220, height: 80 } };
        reads += 1;
        return { ...n, measured: reads > 3 ? { width: 220, height: 80 } : undefined };
      }));
      const readsWhenAimed: number[] = [];
      flow.setViewport.mockImplementation(async () => { readsWhenAimed.push(reads); return true; });
      focusOn("cluster:1:LVP01");
      await pressed("ArrowDown", "cluster:1:LVP02");
      expect(readsWhenAimed).toHaveLength(1);
      expect(readsWhenAimed[0]).toBeGreaterThan(3);
    });

    it("gives up waiting after about ten frames and goes on with the size of a node it has not been told", async () => {
      sized();
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      await lookAway();
      flow.getNodes.mockImplementation(() => flow.state.nodes.map((n: any) => ({ ...n, measured: undefined })));
      focusOn("cluster:1:LVP01");
      await userEvent.keyboard("{ArrowDown}");
      await waitFor(() => expect(node("cluster:1:LVP02")).toHaveFocus(), { timeout: 2000 });
      expect(flow.setViewport).toHaveBeenCalledTimes(1);
    });

    it("Show more pans to the first new point without zooming, then focuses it", async () => {
      sized();
      const group = Array.from({ length: 120 }, (_, i) => kw(1000 + i, `BIG pt ${i}`));
      mockFetch(routes("operator", world([srcOf(1, "Big", { clusters: [{ key: "BIG", points: group }], point_count: 120 })])));
      open();
      await expand("Big");
      await expand("BIG");
      await later(80);
      flow.state.viewport = { x: -3000, y: -3000, zoom: 0.5 };
      flow.setViewport.mockClear();
      fireEvent.click(within(node("more:cluster:1:BIG")).getByRole("button", { name: /^Show 50 more points of BIG/ }));
      await waitFor(() => expect(node("point:1050")).toHaveFocus());
      expect(flow.setViewport).toHaveBeenCalledTimes(1);
      expect((flow.setViewport.mock.calls[0][0] as { zoom: number }).zoom).toBe(0.5);
    });
  });

  describe("what a screen reader hears", () => {
    it("every node is described by the page's own words about the keys, not the library's", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      expect(node("src:1")).toHaveAccessibleDescription(DESCRIPTION);
      expect(node("asset:10")).toHaveAccessibleDescription(DESCRIPTION);
    });

    it("the tip lists the arrow keys", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Plant OPC");
      await userEvent.click(screen.getByRole("button", { name: "What can I do on the canvas?" }));
      const lines = within(await screen.findByRole("note")).getAllByRole("listitem").map((item) => item.textContent);
      expect(lines).toContain("Arrow keys move between nodes. Enter opens or closes one.");
    });
  });

  describe("the focus never lands on the page body", () => {
    it("Collapse all with the focus on a point: the source, the nearest node still drawn, takes it", async () => {
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      await expand("LVP01");
      focusOn("point:1");
      fireEvent.click(screen.getByRole("button", { name: "Collapse all" })); // a click that leaves the focus where it is
      await waitFor(() => expect(node("point:1")).toBeNull());
      await waitFor(() => expect(node("src:1")).toHaveFocus());
    });

    it("Expand all leaves the focus on the node that had it", async () => {
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      await expand("LVP01");
      focusOn("point:1");
      fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
      await waitFor(() => expect(node("point:3")).not.toBeNull());
      await later();
      expect(node("point:1")).toHaveFocus();
    });

    it("a node's Collapse this branch (from its menu) leaves the focus on that node", async () => {
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      await expand("LVP01");
      fireEvent.contextMenu(node("src:1"));
      await userEvent.click(within(await screen.findByRole("menu", { name: "Actions for Plant OPC" })).getByRole("menuitem", { name: "Collapse this branch" }));
      await waitFor(() => expect(node("cluster:1:LVP01")).toBeNull());
      await later();
      expect(node("src:1")).toHaveFocus();
    });

    it("the bar's Collapse selection and Expand this branch give the focus back to their chevron, never to the body", async () => {
      mockFetch(routes("operator"));
      open();
      await expand("Plant OPC");
      await expand("LVP01");
      await userEvent.click(screen.getByTestId("select-cluster:1:LVP01"));
      await userEvent.click(screen.getByRole("button", { name: "More ways to collapse" }));
      await userEvent.click(within(await screen.findByRole("menu", { name: "Collapse options" })).getByRole("menuitem", { name: "Collapse selection" }));
      await waitFor(() => expect(node("point:1")).toBeNull());
      await later();
      expect(screen.getByRole("button", { name: "More ways to collapse" })).toHaveFocus();
      await userEvent.click(screen.getByRole("button", { name: "More ways to expand" }));
      await userEvent.click(within(await screen.findByRole("menu", { name: "Expand options" })).getByRole("menuitem", { name: "Expand this branch" }));
      await waitFor(() => expect(node("point:1")).not.toBeNull());
      await later();
      expect(screen.getByRole("button", { name: "More ways to expand" })).toHaveFocus();
    });

    it("folding an asset by its button or by Enter keeps the focus", async () => {
      mockFetch(routes("operator"));
      open();
      await screen.findByText("Site");
      await userEvent.click(screen.getByRole("button", { name: "Hide sub-assets of Site" }));
      expect(node("asset:11")).toBeNull();
      expect(screen.getByRole("button", { name: "Show sub-assets of Site" })).toHaveFocus();
      focusOn("asset:10");
      fireEvent.keyDown(node("asset:10"), { key: "Enter" });
      await waitFor(() => expect(node("asset:11")).not.toBeNull());
      await later();
      expect(node("asset:10")).toHaveFocus();
    });

    describe("Unmapped only", () => {
      const two = () => world([
        srcOf(1, "Alpha", { clusters: [{ key: "G1", points: [mapped(11), kw(12, "pt 12")] }, { key: "G2", points: [mapped(21)] }], point_count: 3 }),
        srcOf(2, "Omega", { clusters: [{ key: "H", points: [mapped(31)] }], point_count: 1 }),
      ]);

      it("the switch keeps the focus it was given by a click", async () => {
        mockFetch(routes("operator", two()));
        open();
        await screen.findByText("Alpha");
        await userEvent.click(switchOf());
        expect(switchOf()).toBeChecked();
        expect(switchOf()).toHaveFocus();
      });

      it("the point that goes: the group that stays takes the focus", async () => {
        mockFetch(routes("operator", two()));
        open();
        await expand("Alpha");
        await expand("G1");
        focusOn("point:11");
        fireEvent.click(switchOf());
        await waitFor(() => expect(node("point:11")).toBeNull());
        await waitFor(() => expect(node("cluster:1:G1")).toHaveFocus());
      });

      it("the group goes too: the source takes the focus", async () => {
        mockFetch(routes("operator", two()));
        open();
        await expand("Alpha");
        await expand("G2");
        focusOn("point:21");
        fireEvent.click(switchOf());
        await waitFor(() => expect(node("cluster:1:G2")).toBeNull());
        await waitFor(() => expect(node("src:1")).toHaveFocus());
      });

      it("the whole branch goes: the canvas group, which is named, takes the focus", async () => {
        mockFetch(routes("operator", two()));
        open();
        await expand("Omega");
        await expand("H");
        focusOn("point:31");
        fireEvent.click(switchOf());
        await waitFor(() => expect(node("src:2")).toBeNull());
        await waitFor(() => expect(canvasGroup()).toHaveFocus());
      });

      it("a focus that is still on a node that stands is left alone", async () => {
        mockFetch(routes("operator", two()));
        open();
        await expand("Alpha");
        await expand("G1");
        focusOn("point:12");
        fireEvent.click(switchOf());
        await waitFor(() => expect(node("point:11")).toBeNull());
        await later();
        expect(node("point:12")).toHaveFocus();
      });
    });
  });
});
