import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GraphModel, GraphPoint } from "../api/types";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { DiscoveryPage } from "./DiscoveryPage";

// React Flow measures the DOM, which jsdom cannot do: render the nodes plainly and expose the props the page wires up.
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    ReactFlow: ({ nodes, nodeTypes, onNodeClick, onNodeDragStop, onNodesChange }: any) => (
      <div data-testid="flow">
        {nodes.map((n: any) => {
          const Node = nodeTypes[n.type];
          return (
            <div key={n.id} data-id={n.id} data-x={n.position.x} data-y={n.position.y} data-width={n.measured?.width} onClick={(e) => onNodeClick?.(e, n)}>
              <Node id={n.id} data={n.data} />
              <button data-testid={`measure-${n.id}`} onClick={() => onNodesChange?.([{ id: n.id, type: "dimensions", dimensions: { width: 100, height: 40 } }])} />
              <button data-testid={`drag-${n.id}`} onClick={(e) => onNodeDragStop?.(e, n, [{ ...n, position: { x: 7, y: 8 } }])} />
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
