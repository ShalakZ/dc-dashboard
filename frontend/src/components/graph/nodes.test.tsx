import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GraphPoint, GraphSource } from "../../api/types";
import { nodeTypes } from "./nodes";

// Handles need a React Flow store; the node bodies are what is under test here. The mock draws each handle as a div that says which handle it is and whether it can
// start or end a connection (React Flow's defaults, true, when the node did not say), and passes on what a custom handle brings (the "+": role, name, class, clicks and keys).
vi.mock("@xyflow/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xyflow/react")>()),
  Handle: ({ id, type, isConnectableStart = true, isConnectableEnd = true, children, position: _position, ...rest }: any) => (
    <div data-handle={id ?? type} data-start={String(isConnectableStart)} data-end={String(isConnectableEnd)} {...rest}>{children}</div>
  ),
}));

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
    expect(screen.getByText(/OPC UA/)).toBeInTheDocument();
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

  describe("a source node's buttons and last-seen line (W7r)", () => {
    const all = { source, expanded: false, onToggle: vi.fn(), onSelect: vi.fn(), onCreateAssets: vi.fn(), onRemove: vi.fn(), groups: 3, seen: "Seen in scan #6, 10 min ago" };

    it("Remove and Create assets… render only when their callback is injected, and report the node id", async () => {
      const view = renderNode("source", "src:1", { source, expanded: false, onSelect: vi.fn(), groups: 3 });
      expect(screen.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Create assets/ })).not.toBeInTheDocument();
      view.unmount();
      const [onRemove, onCreateAssets] = [vi.fn(), vi.fn()];
      renderNode("source", "src:1", { ...all, onRemove, onCreateAssets });
      const remove = screen.getByRole("button", { name: "Remove Plant OPC from Discovery" });
      const create = screen.getByRole("button", { name: "Create assets for 3 groups of Plant OPC" });
      expect(remove.textContent).toBe(""); // the bin alone (W7t): the name is the aria-label, the tooltip the title
      expect(remove).toHaveAttribute("title", "Remove");
      expect(remove.querySelector("svg.i")).toHaveAttribute("aria-hidden", "true");
      expect(create).toHaveTextContent("Create assets…");
      expect(remove).toHaveClass("nodrag");
      expect(create).toHaveClass("nodrag");
      await userEvent.click(remove);
      await userEvent.click(create);
      expect(onRemove).toHaveBeenCalledWith("src:1");
      expect(onCreateAssets).toHaveBeenCalledWith("src:1");
    });

    it("the Create assets name counts its groups, one group included", () => {
      renderNode("source", "src:1", { ...all, groups: 1 });
      expect(screen.getByRole("button", { name: "Create assets for 1 group of Plant OPC" })).toBeInTheDocument();
    });

    it("keyboard order is Toggle, Details, Create assets, Remove", async () => {
      renderNode("source", "src:1", all);
      const order: string[] = [];
      for (let i = 0; i < 4; i++) {
        await userEvent.tab();
        order.push(document.activeElement?.getAttribute("aria-label") ?? "");
      }
      expect(order).toEqual(["Expand Plant OPC", "Details for Plant OPC", "Create assets for 3 groups of Plant OPC", "Remove Plant OPC from Discovery"]);
    });

    it("Details, Create assets and Remove share ONE row that may wrap, apart from the title row with the toggle", () => {
      renderNode("source", "src:1", all);
      const row = screen.getByRole("button", { name: "Details for Plant OPC" }).parentElement!;
      expect(row).toHaveClass("row", "gnode-actions");
      expect(row).toContainElement(screen.getByRole("button", { name: /^Create assets/ }));
      expect(row).toContainElement(screen.getByRole("button", { name: /^Remove / }));
      expect(row).not.toContainElement(screen.getByRole("button", { name: "Expand Plant OPC" }));
    });

    it("Details and Create assets keep their words; only Remove is a bin without text", () => {
      renderNode("source", "src:1", all);
      expect(screen.getByRole("button", { name: "Details for Plant OPC" })).toHaveTextContent("Details");
      expect(screen.getByRole("button", { name: /^Create assets/ })).toHaveTextContent("Create assets…");
      expect(screen.getByRole("button", { name: /^Remove / })).toHaveClass("gnode-remove");
    });

    it("every button is type=button, so none submits a form around the graph", () => {
      renderNode("source", "src:1", all);
      for (const button of screen.getAllByRole("button")) expect(button).toHaveAttribute("type", "button");
    });

    it("shows the last-seen line as one muted line with the whole text in its title", () => {
      renderNode("source", "src:1", all);
      const line = screen.getByText("Seen in scan #6, 10 min ago");
      expect(line).toHaveClass("muted", "gnode-seen");
      expect(line).toHaveAttribute("title", "Seen in scan #6, 10 min ago");
    });

    it("draws no action row at all when the node has no button", () => {
      renderNode("source", "src:1", { source, expanded: false });
      expect(document.querySelector(".gnode-actions")).toBeNull();
    });
  });

  describe("a source node's status dot and protocol badge (W7u)", () => {
    const facts = () => document.querySelector(".gnode-facts") as HTMLElement;
    const dot = () => facts().querySelector(".gdot") as HTMLElement;
    const online = { ...source, enabled: true, status: "online", needs_credentials: false };

    // [name, source fields, class of the dot, its tooltip]
    it.each([
      ["online", { enabled: true, status: "online", needs_credentials: false }, "gdot-online", "online"],
      ["offline", { enabled: true, status: "offline", needs_credentials: false }, "gdot-offline", "offline"],
      ["needs credentials", { enabled: true, status: "online", needs_credentials: true }, "gdot-credentials", "needs credentials"],
      ["disabled", { enabled: false, status: "online", needs_credentials: false }, "gdot-idle", "disabled"],
      ["never polled", { enabled: true, status: "unknown", needs_credentials: false }, "gdot-idle", "not polled"],
    ])("%s: the dot has its class and tooltip, and is hidden from assistive tech (decoration)", (_name, fields, cls, title) => {
      renderNode("source", "src:1", { source: { ...source, ...fields }, expanded: false });
      expect(dot()).toHaveClass("gdot", cls);
      expect(dot()).toHaveAttribute("aria-hidden", "true");
      expect(dot()).toHaveAttribute("title", title);
      expect(dot().textContent).toBe("");
    });

    it("the status word stays in the text, raw: colour is never the only signal (unknown stays unknown beside an amber dot)", () => {
      renderNode("source", "src:1", { source, expanded: false }); // needs credentials, status "unknown"
      expect(dot()).toHaveClass("gdot-credentials");
      expect(screen.getByText(/discovered · unknown · 7 points/)).toBeInTheDocument();
    });

    it("the facts line is the dot, the badge, then the origin, status and count as ONE text node", () => {
      renderNode("source", "src:1", { source: online, expanded: false });
      expect(facts()).toHaveClass("muted");
      const texts = [...facts().childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && /\S/.test(n.textContent ?? ""));
      expect(texts).toHaveLength(1);
      expect(texts[0].textContent).toBe(" discovered · online · 7 points");
      expect(facts().textContent).toBe(" OPC UA discovered · online · 7 points"); // what a screen reader reads: the dot is empty
      const kids = [...facts().children].map((c) => c.className);
      expect(kids).toEqual(["gdot gdot-online", "gproto"]);
    });

    it.each([["opcua", "OPC UA"], ["modbus", "Modbus"], ["simulator", "Simulator"], ["http", "http"]])("the badge says %s as %s", (type, label) => {
      renderNode("source", "src:1", { source: { ...source, connector_type: type }, expanded: false });
      expect(screen.getByText(label, { selector: ".gproto" })).toBeInTheDocument();
      expect(document.querySelectorAll(".gproto")).toHaveLength(1);
    });

    it("the credentials badge below the facts is still there beside the amber dot", () => {
      renderNode("source", "src:1", { source, expanded: false });
      expect(screen.getByText("needs credentials", { selector: ".badge" })).toBeInTheDocument();
    });
  });

  describe("a group's mapped progress strip (W7u)", () => {
    const strip = () => document.querySelector(".gprogress") as HTMLElement;

    // [mapped, of, width]
    it.each([
      [0, 6, "0%"],
      [3, 6, "50%"],
      [1, 3, "33%"],
      [2, 3, "67%"],
      [6, 6, "100%"],
      [7, 6, "100%"], // more mapped than points (a point count that lags): never past the full width
      [0, 0, "0%"], // an empty group: no division by zero
    ])("%i of %i mapped is %s wide", (mappedCount, count, width) => {
      renderNode("cluster", "cluster:1:LVP01", { ...cluster, count, mappedCount });
      expect(strip().style.width).toBe(width);
    });

    it("is decoration (aria-hidden), carries the exact words in its title, and sits inside the node", () => {
      renderNode("cluster", "cluster:1:LVP01", { ...cluster, count: 6, mappedCount: 3 });
      expect(strip()).toHaveAttribute("aria-hidden", "true");
      expect(strip()).toHaveAttribute("title", "3 of 6 mapped");
      expect(strip().textContent).toBe("");
      expect(strip().closest(".gnode-cluster")).toHaveClass("gprogress-host");
    });

    it("keeps the words N mapped, and the strip is not drawn on any other node", () => {
      renderNode("cluster", "cluster:1:LVP01", { ...cluster, count: 6, mappedCount: 3 });
      expect(screen.getByText("3 mapped")).toBeInTheDocument();
      cleanup();
      renderNode("point", "point:3", { sourceId: 1, clusterKey: "LVP01", point });
      renderNode("source", "src:1", { source, expanded: false });
      expect(document.querySelector(".gprogress")).toBeNull();
    });
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

  describe("the mapping menu button on a mapped point and a mapped group (W12a)", () => {
    const mappedPoint = { ...point, asset_id: 10, mapping_id: 1, mapped_metric: "active_power_kw" as const };
    const menuName = (name: string) => `Mapping actions for ${name}`;

    it("is drawn only when the page gives the node an onMenu (a role without assets.edit, or a node with nothing mapped, gets none)", () => {
      const view = renderNode("point", "point:3", { sourceId: 1, clusterKey: "LVP01", point: mappedPoint });
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      view.unmount();
      renderNode("cluster", "cluster:1:LVP01", { ...cluster, onToggle: vi.fn() });
      expect(screen.queryByRole("button", { name: /^Mapping actions/ })).not.toBeInTheDocument();
    });

    it("a point's button is named for the point, opens a menu (aria-haspopup), never selects the node or starts a drag, and hands its own element to onMenu", async () => {
      const onMenu = vi.fn();
      const outer = vi.fn();
      const Node = nodeTypes.point as unknown as (props: { id: string; data: object }) => React.ReactElement;
      render(<div onClick={outer}><Node id="point:3" data={{ sourceId: 1, clusterKey: "LVP01", point: mappedPoint, onMenu, onUnmap: vi.fn(), onMove: vi.fn() }} /></div>);
      const button = screen.getByRole("button", { name: menuName("LVP01 kW") });
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveAttribute("aria-haspopup", "menu");
      // nodrag: a press on it is not a drag; nokey: Enter, Space and the arrows on it are not the node's keys (React Flow's own opt-out class).
      expect(button).toHaveClass("nodrag", "nokey");
      expect(button.textContent).toBe(""); // an icon: the name is the aria-label
      expect(button.querySelector("svg.i")).toHaveAttribute("aria-hidden", "true");
      await userEvent.click(button);
      expect(onMenu).toHaveBeenCalledTimes(1);
      expect(onMenu).toHaveBeenCalledWith(button);
      expect(outer).not.toHaveBeenCalled(); // stopPropagation: the click does not also select the node
    });

    it("is reached by the keyboard and opens with Enter and Space", async () => {
      const onMenu = vi.fn();
      renderNode("point", "point:3", { sourceId: 1, clusterKey: "LVP01", point: mappedPoint, onMenu });
      await userEvent.tab();
      expect(screen.getByRole("button", { name: menuName("LVP01 kW") })).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard(" ");
      expect(onMenu).toHaveBeenCalledTimes(2);
    });

    it("adds no row and no wrapper: the point's title and metric line are what they were, and the node marks itself so the title leaves room for the button", () => {
      renderNode("point", "point:3", { sourceId: 1, clusterKey: "LVP01", point: mappedPoint, onMenu: vi.fn() });
      const title = screen.getByText("LVP01 kW");
      expect(title).toHaveClass("node-title");
      expect(title.parentElement).toHaveClass("gnode", "gnode-point", "gnode-hasmenu");
      expect(screen.getByText(/active_power_kw/)).toHaveClass("muted");
      expect(screen.getByRole("button", { name: menuName("LVP01 kW") }).parentElement).toBe(title.parentElement); // a direct child of the node, positioned by the stylesheet
    });

    it("a group's button is named for the group and sits between its toggle and its Map buttons in the keyboard order", async () => {
      const [onMenu, onToggle, onMap, onNewAsset] = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
      renderNode("cluster", "cluster:1:LVP01", { ...cluster, onToggle, onMap, onNewAsset, onMenu });
      const order: string[] = [];
      for (let i = 0; i < 4; i++) {
        await userEvent.tab();
        order.push(document.activeElement?.getAttribute("aria-label") ?? "");
      }
      expect(order).toEqual(["Expand LVP01", menuName("LVP01"), "Map LVP01 to asset…", "New asset from LVP01…"]);
      const button = screen.getByRole("button", { name: menuName("LVP01") });
      expect(button).toHaveClass("nodrag", "nokey");
      await userEvent.click(button);
      expect(onMenu).toHaveBeenCalledWith(button);
      expect(onToggle).not.toHaveBeenCalled();
    });

    it("on a group the title row keeps its toggle at the end and leaves room for the button; the progress strip is still there", () => {
      renderNode("cluster", "cluster:1:LVP01", { ...cluster, onToggle: vi.fn(), onMenu: vi.fn() });
      const head = screen.getByText("LVP01 (3)").parentElement!;
      expect(head).toHaveClass("row", "gnode-head");
      expect(head).toContainElement(screen.getByRole("button", { name: "Expand LVP01" }));
      expect(head).not.toContainElement(screen.getByRole("button", { name: menuName("LVP01") }));
      expect(head.parentElement).toHaveClass("gnode", "gnode-cluster", "gprogress-host", "gnode-hasmenu");
      expect(document.querySelector(".gprogress")).not.toBeNull();
    });

    it("a node without the button keeps the exact classes it had", () => {
      renderNode("point", "point:3", { sourceId: 1, clusterKey: "LVP01", point });
      expect(document.querySelector(".gnode")!.className).toBe("gnode gnode-point");
      cleanup();
      renderNode("cluster", "cluster:1:LVP01", { ...cluster, onToggle: vi.fn() });
      expect(document.querySelector(".gnode")!.className).toBe("gnode gnode-cluster gprogress-host");
      expect(screen.getByText("LVP01 (3)").parentElement!.className).toBe("row");
    });

    it("an asset node, a source and an unidentified service draw no such button even if the data carried the callbacks", () => {
      renderNode("asset", "asset:10", { asset: { id: 10, parent_id: null, name: "Site", kind: "generic" }, depth: 0, mapped: [{ sourceId: 1, sourceName: "Plant", count: 2 }], onUnmapSource: vi.fn() });
      renderNode("source", "src:1", { source, expanded: false });
      renderNode("unidentified", "unid:10.0.0.9:8080", { host: "10.0.0.9", port: 8080 });
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });
  });

  describe("every handle but the + cannot start or end a connection (W12a)", () => {
    const asset = { id: 10, parent_id: null, name: "Site", kind: "generic" };
    const handles = () => Array.from(document.querySelectorAll<HTMLElement>("[data-handle]"));

    it.each([
      ["source", "src:1", { source, expanded: false }],
      ["cluster", "cluster:1:LVP01", { ...cluster, onToggle: vi.fn() }],
      ["point", "point:3", { sourceId: 1, clusterKey: "LVP01", point }],
      ["asset", "asset:10", { asset, depth: 0 }],
      ["unidentified", "unid:10.0.0.9:8080", { host: "10.0.0.9", port: 8080 }],
    ] as const)("a %s node has its two edge handles and neither starts or ends a connection", (type, id, data) => {
      renderNode(type, id, data);
      expect(handles().map((h) => h.dataset.handle)).toEqual(["target", "source"]);
      for (const h of handles()) {
        expect(h.dataset.start, `${h.dataset.handle} can start`).toBe("false");
        expect(h.dataset.end, `${h.dataset.handle} can end`).toBe("false");
      }
    });
  });

  describe("the + on an asset node (W12a)", () => {
    const asset = { id: 10, parent_id: null, name: "Site", kind: "generic" };
    const handles = () => Array.from(document.querySelectorAll<HTMLElement>("[data-handle]"));
    const add =() => screen.getByRole("button", { name: "Add a sub-asset under Site" });

    it("is drawn only when the data carries onAdd; an asset without it draws no button at all", () => {
      const view = renderNode("asset", "asset:10", { asset, depth: 0 });
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(document.querySelector('[data-handle="add"]')).toBeNull();
      view.unmount();
      renderNode("asset", "asset:10", { asset, depth: 0, onAdd: vi.fn() });
      expect(add()).toBeInTheDocument();
    });

    it("is the handle with id add, a source that cannot end a connection, a button with a name, a tab stop and the classes that keep drags and keys off the node", () => {
      renderNode("asset", "asset:10", { asset, depth: 0, onAdd: vi.fn() });
      expect(add()).toBe(document.querySelector('[data-handle="add"]'));
      expect(add()).toHaveAttribute("data-start", "true");
      expect(add()).toHaveAttribute("data-end", "false");
      expect(add()).toHaveAttribute("tabindex", "0");
      expect(add()).toHaveClass("nodrag", "nokey", "gnode-add");
      expect(add().querySelector("svg")).toHaveAttribute("aria-hidden", "true"); // the name is the label, the plus is a drawing
    });

    it("comes AFTER the two default handles: an edge with no sourceHandle starts at the first source handle in the document", () => {
      renderNode("asset", "asset:10", { asset, depth: 0, onAdd: vi.fn() });
      expect(handles().map((h) => h.dataset.handle)).toEqual(["target", "source", "add"]);
    });

    it("a click reports the node id and goes no further", async () => {
      const onAdd = vi.fn();
      const reachedNode = vi.fn();
      const Node = nodeTypes.asset as unknown as (p: { id: string; data: object }) => React.ReactElement;
      render(<div onClick={reachedNode}><Node id="asset:10" data={{ asset, depth: 0, onAdd }} /></div>);
      await userEvent.click(add());
      expect(onAdd).toHaveBeenCalledTimes(1);
      expect(onAdd).toHaveBeenCalledWith("asset:10");
      expect(reachedNode).not.toHaveBeenCalled();
    });

    it("Enter and Space report the node id, stay off the node and the canvas, and other keys go on", async () => {
      const onAdd = vi.fn();
      const reachedCanvas = vi.fn();
      const Node = nodeTypes.asset as unknown as (p: { id: string; data: object }) => React.ReactElement;
      render(<div onKeyDown={reachedCanvas}><Node id="asset:10" data={{ asset, depth: 0, onAdd }} /></div>);
      act(() => add().focus());
      await userEvent.keyboard("{Enter}");
      expect(onAdd).toHaveBeenCalledTimes(1);
      await userEvent.keyboard(" ");
      expect(onAdd).toHaveBeenCalledTimes(2);
      expect(onAdd).toHaveBeenLastCalledWith("asset:10");
      expect(reachedCanvas).not.toHaveBeenCalled();
      await userEvent.keyboard("a");
      await userEvent.keyboard("{ContextMenu}");
      expect(onAdd).toHaveBeenCalledTimes(2);
      expect(reachedCanvas).toHaveBeenCalledTimes(2); // anything else (the menu key, Tab) is the canvas's
    });

    it("says aria-disabled while the asset list the form needs is not read, and still reports the click (the page says why nothing opened)", async () => {
      const onAdd = vi.fn();
      renderNode("asset", "asset:10", { asset, depth: 0, onAdd, formWait: true });
      expect(add()).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(add());
      expect(onAdd).toHaveBeenCalledTimes(1);
    });

    it("the group's New asset… button says aria-disabled in the same case, and a point draws no New asset button for its menu-only key", () => {
      renderNode("cluster", "cluster:1:LVP01", { ...cluster, onMap: vi.fn(), onNewAsset: vi.fn(), formWait: true });
      expect(screen.getByRole("button", { name: "New asset from LVP01…" })).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("button", { name: "Map LVP01 to asset…" })).not.toHaveAttribute("aria-disabled");
      cleanup();
      renderNode("point", "point:3", { sourceId: 1, clusterKey: "LVP01", point, onMap: vi.fn(), menuNewAsset: vi.fn() });
      expect(screen.queryByRole("button", { name: /^New asset from/ })).not.toBeInTheDocument();
      expect(screen.getAllByRole("button")).toHaveLength(1); // Map… only
    });
  });

  it("an asset shows its name and an unidentified service its host and port", () => {
    const asset = renderNode("asset", "asset:10", { asset: { id: 10, parent_id: null, name: "Site", kind: "generic" }, depth: 0 });
    expect(screen.getByText("Site")).toHaveClass("node-title");
    asset.unmount();
    renderNode("unidentified", "unid:10.0.0.9:8080", { host: "10.0.0.9", port: 8080 });
    expect(screen.getByText("10.0.0.9:8080 — unidentified service")).toHaveClass("node-title");
  });
});
