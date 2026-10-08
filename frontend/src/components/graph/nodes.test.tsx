import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GraphPoint, GraphSource } from "../../api/types";
import { nodeTypes } from "./nodes";

// Handles need a React Flow store; the node bodies are what is under test here.
vi.mock("@xyflow/react", async (importOriginal) => ({ ...(await importOriginal<typeof import("@xyflow/react")>()), Handle: () => null }));

const point: GraphPoint = {
  id: 3, address: "a3", name: "LVP01 kW", unit_hint: "kW", mapping_id: null, asset_id: null, mapped_metric: null,
  suggestion: { metric: "active_power_kw", scale: 1, interval_seconds: 5, custom_unit: null },
};
const source: GraphSource = {
  id: 1, name: "Plant OPC", connector_type: "opcua", config: {}, origin: "discovered", enabled: false, status: "unknown",
  last_error: null, has_secret: false, needs_credentials: true, point_count: 7, clusters: [], ungrouped: [],
};
const cluster = { sourceId: 1, key: "LVP01", label: "LVP01", count: 3, mappedCount: 1, expanded: false, ungrouped: false };

// The components only read id and data; the rest of NodeProps is irrelevant to them.
const renderNode = (type: keyof typeof nodeTypes, id: string, data: object) => {
  const Node = nodeTypes[type] as unknown as (props: { id: string; data: object }) => React.ReactElement;
  return render(<Node id={id} data={data} />);
};

describe("graph nodes", () => {
  it("a source shows its facts, a credentials badge and a node-title", () => {
    renderNode("source", "src:1", { source, expanded: false });
    expect(screen.getByText("Plant OPC")).toHaveClass("node-title");
    expect(screen.getByText(/opcua/)).toBeInTheDocument();
    expect(screen.getByText(/discovered/)).toBeInTheDocument();
    expect(screen.getByText(/7 points/)).toBeInTheDocument();
    expect(screen.getByText("needs credentials")).toBeInTheDocument();
  });

  it("a source without the flag shows no credentials badge", () => {
    renderNode("source", "src:1", { source: { ...source, needs_credentials: false }, expanded: false });
    expect(screen.queryByText("needs credentials")).not.toBeInTheDocument();
  });

  it("a toggle button appears only when onToggle is injected, and reports the node id", async () => {
    const view = renderNode("source", "src:1", { source, expanded: false });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    view.unmount();
    const onToggle = vi.fn();
    const expanded = renderNode("source", "src:1", { source, expanded: false, onToggle });
    const button = screen.getByRole("button", { name: "Expand Plant OPC" });
    expect(button).toHaveClass("nodrag");
    await userEvent.click(button);
    expect(onToggle).toHaveBeenCalledWith("src:1");
    expanded.unmount();
    renderNode("source", "src:1", { source, expanded: true, onToggle });
    expect(screen.getByRole("button", { name: "Collapse Plant OPC" })).toBeInTheDocument();
  });

  it("a source has a Details button only when onSelect is injected, and it reports the node id", async () => {
    const view = renderNode("source", "src:1", { source, expanded: false, onToggle: vi.fn() });
    expect(screen.queryByRole("button", { name: "Details for Plant OPC" })).not.toBeInTheDocument();
    view.unmount();
    const onSelect = vi.fn();
    renderNode("source", "src:1", { source, expanded: false, onSelect });
    const button = screen.getByRole("button", { name: "Details for Plant OPC" });
    expect(button).toHaveClass("nodrag");
    await userEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith("src:1");
  });

  it("the Details button is operable from the keyboard", async () => {
    const onSelect = vi.fn();
    renderNode("source", "src:1", { source, expanded: false, onSelect });
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Details for Plant OPC" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("a cluster shows label (count) and its mapped count, with a toggle only when injected", async () => {
    const onToggle = vi.fn();
    renderNode("cluster", "cluster:1:LVP01", { ...cluster, onToggle });
    expect(screen.getByText("LVP01 (3)")).toHaveClass("node-title");
    expect(screen.getByText("1 mapped")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Expand LVP01" }));
    expect(onToggle).toHaveBeenCalledWith("cluster:1:LVP01");
  });

  it("map and new-asset buttons render only when their callbacks are present", async () => {
    const view = renderNode("point", "point:3", { sourceId: 1, clusterKey: "LVP01", point });
    expect(screen.getByText("LVP01 kW")).toHaveClass("node-title");
    expect(screen.getByText(/kW/, { selector: ".muted" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    view.unmount();
    const onMap = vi.fn();
    const onNewAsset = vi.fn();
    renderNode("point", "point:3", { sourceId: 1, clusterKey: "LVP01", point, onMap, onNewAsset });
    const map = screen.getByRole("button", { name: "Map LVP01 kW to asset…" });
    const create = screen.getByRole("button", { name: "New asset from LVP01 kW…" });
    expect(map).toHaveClass("nodrag");
    expect(create).toHaveClass("nodrag");
    await userEvent.click(map);
    await userEvent.click(create);
    expect(onMap).toHaveBeenCalledWith("point:3");
    expect(onNewAsset).toHaveBeenCalledWith("point:3");
  });

  it("a mapped point shows its metric", () => {
    renderNode("point", "point:3", { sourceId: 1, clusterKey: "LVP01", point: { ...point, asset_id: 10, mapping_id: 1, mapped_metric: "active_power_kw" } });
    expect(screen.getByText(/active_power_kw/)).toBeInTheDocument();
  });

  it("an asset shows its name and an unidentified service its host and port", () => {
    const asset = renderNode("asset", "asset:10", { asset: { id: 10, parent_id: null, name: "Site", kind: "generic" }, depth: 0 });
    expect(screen.getByText("Site")).toHaveClass("node-title");
    asset.unmount();
    renderNode("unidentified", "unid:10.0.0.9:8080", { host: "10.0.0.9", port: 8080 });
    expect(screen.getByText("10.0.0.9:8080 — unidentified service")).toHaveClass("node-title");
  });
});
