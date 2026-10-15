import { screen } from "@testing-library/react";
import type { GraphModel } from "../api/types";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { SignedIn } from "../test/signedIn";
import { userFor } from "../test/users";
import { DiscoveryPage } from "./DiscoveryPage";

// React Flow measures the DOM, which jsdom cannot do (the same cut-down mock as DiscoveryPage.test.tsx): the page's own wrapper is what is looked at here.
vi.mock("../components/graph/GraphMiniMap", () => ({ GraphMiniMap: () => null }));
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    useReactFlow: () => ({
      getIntersectingNodes: () => [], getNodes: () => [], fitView: vi.fn(), setViewport: vi.fn(async () => true),
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setCenter: vi.fn(async () => true), getZoom: () => 1,
    }),
    ReactFlow: ({ nodes, nodeTypes, children }: any) => (
      <div data-testid="flow">
        {nodes.map((n: any) => { const Node = nodeTypes[n.type]; return <div key={n.id} data-id={n.id}><Node id={n.id} data={n.data} /></div>; })}
        {children}
      </div>
    ),
    ViewportPortal: ({ children }: any) => <div>{children}</div>,
    Background: () => null,
    Controls: () => null,
  };
});

const model: GraphModel = {
  sources: [{
    id: 1, name: "Plant OPC", connector_type: "opcua", config: { endpoint: "opc.tcp://plc:4840" }, origin: "discovered", enabled: false,
    status: "unknown", last_error: null, has_secret: false, needs_credentials: false, point_count: 0, clusters: [], ungrouped: [],
  }],
  unidentified: [], assets: [], layout: {},
};

describe("DiscoveryPage, the canvas wrapper", () => {
  it("is a named group: it takes the focus (a pane click, the return of Escape from a menu or Find), so a screen reader must say what it is", async () => {
    mockFetch({
      "GET /api/setup": { body: { needed: false } },
      "GET /api/me": { body: userFor("operator") },
      "GET /api/discovery/graph": { body: model },
    });
    renderWithProviders(<><DiscoveryPage /><SignedIn /></>, { route: "/discovery", path: "/discovery" });
    await screen.findByText("Plant OPC");
    const canvas = screen.getByRole("group", { name: "Discovery graph" });
    expect(canvas).toHaveClass("graph-canvas");
    expect(canvas).toHaveAttribute("tabindex", "-1"); // a programmatic focus target only, not a Tab stop
    expect(canvas).toContainElement(screen.getByTestId("flow"));
  });
});
