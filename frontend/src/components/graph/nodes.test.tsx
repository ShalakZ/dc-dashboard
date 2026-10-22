import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GraphPoint, GraphSource } from "../../api/types";
import { assetIcon } from "../../lib/assetIcons";
import { clusterIcon, metricIcon, pointMetric } from "../../lib/graphIcons";
import { nodeTypes } from "./nodes";

// Handles need a React Flow store; the node bodies are what is under test here. The mock draws each handle as a div that says which handle it is and whether it can
// start or end a connection (React Flow's defaults, true, when the node did not say), and passes on what a custom handle brings (the "+": role, name, class, clicks and keys).
// It also counts its own renders (W12b): every node draws its handles in its body, so the count moves exactly when a node component re-renders.
const handleRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("@xyflow/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xyflow/react")>()),
  Handle: ({ id, type, isConnectableStart = true, isConnectableEnd = true, children, position: _position, ...rest }: any) => {
    handleRenders.count++;
    return <div data-handle={id ?? type} data-start={String(isConnectableStart)} data-end={String(isConnectableEnd)} {...rest}>{children}</div>;
  },
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
  it("a source shows its title, protocol, status word, origin and how many points are mapped", () => {
    renderNode("source", "src:1", { source, expanded: false });
    expect(screen.getByText("Plant OPC")).toHaveClass("node-title");
    expect(screen.getByText(/OPC UA/)).toBeInTheDocument();
    expect(screen.getByText(/discovered/)).toBeInTheDocument();
    expect(screen.getByText("0 of 7 mapped")).toBeInTheDocument();
    expect(screen.getByText("needs credentials")).toBeInTheDocument();
  });

  it("a source without the flag does not say it needs credentials", () => {
    renderNode("source", "src:1", { source: { ...source, needs_credentials: false }, expanded: false });
    expect(screen.queryByText("needs credentials")).not.toBeInTheDocument();
  });

  describe("every node draws its icon before its title (W12c)", () => {
    const iconOf = () => document.querySelector(".gicon") as HTMLElement;

    it("a point draws the icon of what it measures: the mapped metric, else the suggested one", () => {
      renderNode("point", "point:3", { sourceId: 1, clusterKey: "LVP01", point: { ...point, asset_id: 10, mapping_id: 1, mapped_metric: "voltage_v" } });
      expect(iconOf()).toHaveAttribute("data-icon", "metricVoltage");
      cleanup();
      renderNode("point", "point:3", { sourceId: 1, clusterKey: "LVP01", point }); // not mapped: the scan suggests active power
      expect(iconOf()).toHaveAttribute("data-icon", metricIcon(pointMetric(point)));
      expect(iconOf()).toHaveAttribute("data-icon", "rate");
      cleanup();
      renderNode("point", "point:3", { sourceId: 1, clusterKey: "LVP01", point: { ...point, suggestion: { ...point.suggestion, metric: "custom" } } });
      expect(iconOf()).toHaveAttribute("data-icon", "metricOther");
    });

    it("a group draws the layers icon", () => {
      renderNode("cluster", "cluster:1:LVP01", cluster);
      expect(iconOf()).toHaveAttribute("data-icon", clusterIcon);
      expect(iconOf()).toHaveAttribute("data-icon", "layers");
    });

    it("a source draws its protocol icon, and a connector this build does not know draws the generic sources icon", () => {
      for (const [type, icon] of [["opcua", "protoOpcua"], ["modbus", "protoModbus"], ["simulator", "protoSimulator"], ["http", "sources"]]) {
        renderNode("source", "src:1", { source: { ...source, connector_type: type }, expanded: false });
        expect(iconOf()).toHaveAttribute("data-icon", icon);
        cleanup();
      }
    });

    it("an unidentified service draws the sources icon", () => {
      renderNode("unidentified", "unid:10.0.0.9:8080", { host: "10.0.0.9", port: 8080 });
      expect(iconOf()).toHaveAttribute("data-icon", "sources");
    });

    it("an asset draws what assetIcon gives for it: the chosen icon first, then the registry's, then the guess from its kind", () => {
      const plain = { id: 10, parent_id: null, name: "Rack A", kind: "rack" };
      const cases = [
        { ...plain, icon: "ups", kind_icon: "rack" }, // chosen wins over the registry's
        { ...plain, icon: null, kind_icon: "panel" }, // the registry's
        { ...plain, kind: "UPS room" }, // neither: the guess from the kind text
      ];
      for (const asset of cases) {
        renderNode("asset", "asset:10", { asset, depth: 0 });
        expect(iconOf()).toHaveAttribute("data-icon", assetIcon(asset));
        cleanup();
      }
      renderNode("asset", "asset:10", { asset: cases[0], depth: 0 });
      expect(iconOf()).toHaveAttribute("data-icon", "kindUps");
      cleanup();
      renderNode("asset", "asset:10", { asset: cases[1], depth: 0 });
      expect(iconOf()).toHaveAttribute("data-icon", "kindPanel");
    });

    it("the icon is a decorative span that holds an svg and stands BEFORE the words, inside the title (so no node gets a row it did not have)", () => {
      renderNode("point", "point:3", { sourceId: 1, clusterKey: "LVP01", point });
      const title = screen.getByText("LVP01 kW");
      expect(title).toHaveClass("node-title");
      expect(iconOf().tagName).toBe("SPAN");
      expect(iconOf()).toHaveAttribute("aria-hidden", "true");
      expect(iconOf().querySelector("svg.i")).not.toBeNull();
      expect(iconOf().parentElement).toBe(title);
      expect(title.firstElementChild).toBe(iconOf());
    });

    it("every kind draws exactly one icon, and the icon adds no text to what a screen reader reads", () => {
      const kinds: [keyof typeof nodeTypes, object][] = [
        ["source", { source, expanded: false }], ["cluster", cluster], ["point", { sourceId: 1, clusterKey: "LVP01", point }],
        ["asset", { asset: { id: 10, parent_id: null, name: "Site", kind: "generic" }, depth: 0 }], ["unidentified", { host: "10.0.0.9", port: 8080 }],
      ];
      for (const [type, data] of kinds) {
        renderNode(type, `${type}:1`, data);
        expect(document.querySelectorAll(".gicon"), type).toHaveLength(1);
        expect(document.querySelector(".gicon")!.textContent, type).toBe("");
        cleanup();
      }
      renderNode("more", "more:1", { clusterId: "cluster:1:LVP01", label: "LVP01", left: 70, step: 50 });
      expect(document.querySelector(".gicon")).toBeNull(); // the Show more node is a button and nothing else
    });
  });

  describe("the source card (W12c)", () => {
    const pointOf = (id: number, mapped: boolean): GraphPoint => ({ ...point, id, mapping_id: mapped ? id : null, asset_id: mapped ? 10 : null, mapped_metric: mapped ? "active_power_kw" : null });
    const pointsOf = (total: number, mapped: number) => Array.from({ length: total }, (_, i) => pointOf(i + 1, i < mapped));
    const opc: GraphSource = {
      ...source, name: "OPC UA server at 172.20.0.2:4840", config: { endpoint: "opc.tcp://172.20.0.2:4840/server" }, enabled: true, status: "online",
      needs_credentials: false, point_count: 60, clusters: [{ key: "K", points: pointsOf(60, 60) }],
    };
    const lines = () => Array.from(document.querySelectorAll(".gsrc-body > *")).map((line) => line.className.split(" ")[0]);

    it("the title is the short name on ONE line with the full name in its title; the second line says the protocol and where the source listens", () => {
      renderNode("source", "src:1", { source: opc, expanded: false });
      const title = screen.getByText("OPC UA server");
      expect(title).toHaveClass("node-title");
      expect(title).toHaveAttribute("title", "OPC UA server at 172.20.0.2:4840");
      expect(screen.getByText("OPC UA · 172.20.0.2:4840")).toHaveClass("muted");
    });

    it("a hand-typed name stays as typed; a source with no address in its config shows the protocol alone", () => {
      renderNode("source", "src:1", { source: { ...opc, name: "Boiler house", config: {} }, expanded: false });
      expect(screen.getByText("Boiler house")).toHaveAttribute("title", "Boiler house");
      expect(screen.getByText("OPC UA", { selector: ".gsrc-sub" })).toBeInTheDocument();
    });

    it("the Modbus auto name loses its address; the line shows host and port from the config", () => {
      renderNode("source", "src:2", { source: { ...opc, name: "Modbus device at 10.0.0.5:502", connector_type: "modbus", config: { host: "10.0.0.5", port: 502 } }, expanded: false });
      expect(screen.getByText("Modbus device")).toHaveClass("node-title");
      expect(screen.getByText("Modbus · 10.0.0.5:502")).toBeInTheDocument();
    });

    it("the status line is the dot, its word and the origin: online, offline, needs credentials, disabled and not polled each say their word", () => {
      // [fields, word, dot class]
      const cases: [object, string, string][] = [
        [{ enabled: true, status: "online", needs_credentials: false }, "online", "gdot-online"],
        [{ enabled: true, status: "offline", needs_credentials: false }, "offline", "gdot-offline"],
        [{ enabled: true, status: "online", needs_credentials: true }, "needs credentials", "gdot-credentials"],
        [{ enabled: false, status: "online", needs_credentials: false }, "disabled", "gdot-idle"],
        [{ enabled: true, status: "unknown", needs_credentials: false }, "not polled", "gdot-idle"],
      ];
      for (const [fields, word, dot] of cases) {
        renderNode("source", "src:1", { source: { ...opc, ...fields }, expanded: false });
        const line = document.querySelector(".gsrc-status") as HTMLElement;
        const mark = line.querySelector(".gdot") as HTMLElement;
        expect(mark, word).toHaveClass("gdot", dot);
        expect(mark).toHaveAttribute("aria-hidden", "true"); // decoration: the word is the signal
        expect(mark).toHaveAttribute("title", word);
        expect(mark.textContent).toBe("");
        expect(line.textContent, word).toBe(`${word} · discovered`);
        expect(screen.getByText(word, { selector: ".gsrc-word" }), word).toBeInTheDocument();
        cleanup();
      }
    });

    it("there is no separate needs-credentials badge any more", () => {
      renderNode("source", "src:1", { source, expanded: false });
      expect(document.querySelector(".badge")).toBeNull();
      expect(screen.getAllByText("needs credentials")).toHaveLength(1);
    });

    it("says N of M mapped in words, with a 4px bar under them that is decoration and as wide as the share", () => {
      renderNode("source", "src:1", { source: opc, expanded: false });
      expect(screen.getByText("60 of 60 mapped")).toBeInTheDocument();
      const bar = document.querySelector(".gsrc-bar") as HTMLElement;
      expect(bar).toHaveAttribute("aria-hidden", "true");
      expect((bar.firstElementChild as HTMLElement).style.width).toBe("100%");
      cleanup();
      renderNode("source", "src:1", { source: { ...opc, point_count: 8, clusters: [{ key: "K", points: pointsOf(5, 2) }], ungrouped: pointsOf(3, 1).map((p) => ({ ...p, id: p.id + 100 })) }, expanded: false });
      expect(screen.getByText("3 of 8 mapped")).toBeInTheDocument(); // clusters and the ungrouped points both count
      expect(((document.querySelector(".gsrc-bar") as HTMLElement).firstElementChild as HTMLElement).style.width).toBe("38%");
    });

    it("an empty source says No points yet and draws a bar with nothing in it; the share never passes 100%", () => {
      renderNode("source", "src:1", { source: { ...opc, point_count: 0, clusters: [] }, expanded: false });
      expect(screen.getByText("No points yet")).toBeInTheDocument();
      expect(screen.queryByText(/mapped/)).not.toBeInTheDocument();
      expect(((document.querySelector(".gsrc-bar") as HTMLElement).firstElementChild as HTMLElement).style.width).toBe("0%");
      cleanup();
      renderNode("source", "src:1", { source: { ...opc, point_count: 40 }, expanded: false }); // the count lags behind the points: 60 mapped of 40
      expect(screen.getByText("40 of 40 mapped")).toBeInTheDocument();
      expect(((document.querySelector(".gsrc-bar") as HTMLElement).firstElementChild as HTMLElement).style.width).toBe("100%");
    });

    it("the lines come in a fixed order: head, protocol, status, mapped, Details, last seen; the last two only when there is something to show", () => {
      renderNode("source", "src:1", { source: opc, expanded: false, onSelect: vi.fn(), seen: "Seen in scan #6, 10 min ago" });
      expect(lines()).toEqual(["gsrc-head", "gsrc-sub", "gsrc-status", "gsrc-mapped", "gsrc-actions", "gsrc-seen"]);
      cleanup();
      renderNode("source", "src:1", { source: opc, expanded: false });
      expect(lines()).toEqual(["gsrc-head", "gsrc-sub", "gsrc-status", "gsrc-mapped"]);
    });

    it("the fold is a chevron on the LEFT of the icon and the title, named Expand or Collapse with the FULL name, and it reports the node id without selecting the node", async () => {
      const onToggle = vi.fn();
      const outer = vi.fn();
      const Node = nodeTypes.source as unknown as (props: { id: string; data: object }) => React.ReactElement;
      const view = render(<div onClick={outer}><Node id="src:1" data={{ source: opc, expanded: false, onToggle }} /></div>);
      const head = document.querySelector(".gsrc-head") as HTMLElement;
      const fold = screen.getByRole("button", { name: "Expand OPC UA server at 172.20.0.2:4840" });
      expect(head.firstElementChild).toBe(fold);
      expect(fold).toHaveClass("nodrag", "gnode-fold");
      expect(fold).toHaveAttribute("data-folded", "true"); // pointing right while closed
      expect(fold.querySelector("svg.i")).not.toBeNull();
      expect(fold.textContent).toBe("");
      expect(fold.nextElementSibling).toHaveClass("gicon");
      expect(fold.nextElementSibling!.nextElementSibling).toHaveClass("node-title");
      await userEvent.click(fold);
      expect(onToggle).toHaveBeenCalledWith("src:1");
      expect(outer).not.toHaveBeenCalled();
      view.rerender(<div onClick={outer}><Node id="src:1" data={{ source: opc, expanded: true, onToggle }} /></div>);
      expect(screen.getByRole("button", { name: "Collapse OPC UA server at 172.20.0.2:4840" })).not.toHaveAttribute("data-folded");
    });

    it("the Source actions button is drawn only when the page gave the node an onMenu, is named for the FULL name, opens a menu and hands over its own element", async () => {
      const view = renderNode("source", "src:1", { source: opc, expanded: false, onToggle: vi.fn(), onSelect: vi.fn() });
      expect(screen.queryByRole("button", { name: /^Source actions/ })).not.toBeInTheDocument();
      view.unmount();
      const onMenu = vi.fn();
      const outer = vi.fn();
      const Node = nodeTypes.source as unknown as (props: { id: string; data: object }) => React.ReactElement;
      render(<div onClick={outer}><Node id="src:1" data={{ source: opc, expanded: false, onMenu }} /></div>);
      const button = screen.getByRole("button", { name: "Source actions for OPC UA server at 172.20.0.2:4840" });
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveAttribute("aria-haspopup", "menu");
      expect(button).toHaveClass("nodrag", "nokey");
      expect(button.textContent).toBe("");
      expect(button.parentElement).toHaveClass("gsrc-head"); // on the title line, at its right end
      expect(button.parentElement!.lastElementChild).toBe(button);
      await userEvent.click(button);
      expect(onMenu).toHaveBeenCalledWith(button);
      expect(outer).not.toHaveBeenCalled();
    });

    it("a point's and a group's menu button keep their own name (Mapping actions for X)", () => {
      renderNode("point", "point:3", { sourceId: 1, clusterKey: "LVP01", point, onMenu: vi.fn() });
      expect(screen.getByRole("button", { name: "Mapping actions for LVP01 kW" })).toBeInTheDocument();
    });

    it("draws no Create assets and no Remove button even when the data carries both callbacks: they are items of the node's menu now", () => {
      renderNode("source", "src:1", { source: opc, expanded: false, onSelect: vi.fn(), onCreateAssets: vi.fn(), onRemove: vi.fn(), groups: 3 });
      expect(screen.queryByRole("button", { name: /^Create assets/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument();
      expect(screen.getAllByRole("button")).toHaveLength(1); // Details
      expect(document.querySelector(".gnode-actions, .gnode-remove, .gnode-facts, .gnode-seen, .gproto")).toBeNull();
    });

    it("keeps the dashed border class for a discovered source and the origin class for a manual one", () => {
      renderNode("source", "src:1", { source: opc, expanded: false });
      expect(document.querySelector(".gnode")!.className).toBe("gnode gnode-source discovered");
      cleanup();
      renderNode("source", "src:1", { source: { ...opc, origin: "manual" }, expanded: false });
      expect(document.querySelector(".gnode")!.className).toBe("gnode gnode-source manual");
    });
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

  describe("a source card's keyboard order, buttons and last-seen line (W7r, W12c)", () => {
    const all = { source, expanded: false, onToggle: vi.fn(), onSelect: vi.fn(), onMenu: vi.fn(), groups: 3, seen: "Seen in scan #6, 10 min ago" };

    it("keyboard order is the fold, Source actions, then Details", async () => {
      renderNode("source", "src:1", all);
      const order: string[] = [];
      for (let i = 0; i < 3; i++) {
        await userEvent.tab();
        order.push(document.activeElement?.getAttribute("aria-label") ?? "");
      }
      expect(order).toEqual(["Expand Plant OPC", "Source actions for Plant OPC", "Details for Plant OPC"]);
    });

    it("Details sits on a line of its own, apart from the head with the fold and the menu", () => {
      renderNode("source", "src:1", all);
      const line = screen.getByRole("button", { name: "Details for Plant OPC" }).parentElement!;
      expect(line).toHaveClass("gsrc-actions");
      expect(line).not.toContainElement(screen.getByRole("button", { name: "Expand Plant OPC" }));
      expect(screen.getByRole("button", { name: "Details for Plant OPC" })).toHaveTextContent("Details");
    });

    it("every button is type=button, so none submits a form around the graph", () => {
      renderNode("source", "src:1", all);
      expect(screen.getAllByRole("button")).toHaveLength(3);
      for (const button of screen.getAllByRole("button")) expect(button).toHaveAttribute("type", "button");
    });

    it("shows the last-seen line as one muted line with the whole text in its title", () => {
      renderNode("source", "src:1", all);
      const line = screen.getByText("Seen in scan #6, 10 min ago");
      expect(line).toHaveClass("muted", "gsrc-seen");
      expect(line).toHaveAttribute("title", "Seen in scan #6, 10 min ago");
    });

    it("draws no Details line and no last-seen line when there is nothing to show", () => {
      renderNode("source", "src:1", { source, expanded: false });
      expect(document.querySelector(".gsrc-actions")).toBeNull();
      expect(document.querySelector(".gsrc-seen")).toBeNull();
    });
  });

  // (w33) A discovered source the newest scan of its range did not find is drawn quieter (class gsrc-not-seen: the stylesheet gives it the quieter ground), with its
  // seen line unchanged in height: one line, the whole sentence in the title. One with something mapped says what to do instead.
  describe("a source that is not seen (w33)", () => {
    const miss = { scan_id: 7, at: "2026-10-15T11:00:00Z", last_seen_scan_id: 5, last_seen_at: "2026-10-11T09:00:00Z" };
    const LINE = "Not seen in scan #7 (last seen in #5, 4 days ago)";
    const gone: GraphSource = { ...source, not_seen: miss };
    const mappedPoint: GraphPoint = { ...point, id: 4, asset_id: 10, mapping_id: 1, mapped_metric: "voltage_v" };
    const lines = () => Array.from(document.querySelectorAll(".gsrc-body > *")).map((line) => line.className.split(" ")[0]);

    it("the card wears the class gsrc-not-seen, and only then (no trailing space in the class list)", () => {
      renderNode("source", "src:1", { source: gone, expanded: false, seen: LINE });
      expect(document.querySelector(".gnode")!.className).toBe("gnode gnode-source discovered gsrc-not-seen");
      cleanup();
      renderNode("source", "src:1", { source: { ...source, not_seen: null }, expanded: false, seen: "Seen in scan #6, 10 min ago" });
      expect(document.querySelector(".gnode")!.className).toBe("gnode gnode-source discovered");
    });

    it("a source added by hand is never drawn as not seen, whatever the field says", () => {
      renderNode("source", "src:1", { source: { ...gone, origin: "manual" }, expanded: false, seen: "Added by hand" });
      expect(document.querySelector(".gnode")!.className).toBe("gnode gnode-source manual");
    });

    it("the seen line is still one muted line with the whole sentence in its title, and the card keeps its other lines", () => {
      renderNode("source", "src:1", { source: gone, expanded: false, onSelect: vi.fn(), seen: LINE });
      const line = screen.getByText(LINE);
      expect(line).toHaveClass("muted", "gsrc-seen");
      expect(line).toHaveAttribute("title", LINE);
      expect(lines()).toEqual(["gsrc-head", "gsrc-sub", "gsrc-status", "gsrc-mapped", "gsrc-actions", "gsrc-seen"]);
    });

    it("with a mapped point the line says what to do, and the title keeps both sentences (the card has no room for a seventh line)", () => {
      renderNode("source", "src:1", { source: { ...gone, status: "offline", point_count: 1, ungrouped: [mappedPoint] }, expanded: false, seen: LINE });
      const line = screen.getByText("Mapped: move it or delete it on Sources");
      expect(line).toHaveClass("muted", "gsrc-seen");
      expect(line).toHaveAttribute("title", `${LINE}. Mapped: move it or delete it on Sources`);
      expect(screen.queryByText(LINE)).not.toBeInTheDocument();
      expect(lines()).toEqual(["gsrc-head", "gsrc-sub", "gsrc-status", "gsrc-mapped", "gsrc-seen"]);
    });

    it("a mapped source that is not seen but still polls fine keeps its seen line (nothing to move or delete)", () => {
      renderNode("source", "src:1", { source: { ...gone, status: "online", point_count: 1, ungrouped: [mappedPoint] }, expanded: false, seen: LINE });
      const line = screen.getByText(LINE);
      expect(line).toHaveClass("muted", "gsrc-seen");
      expect(line).toHaveAttribute("title", LINE);
      expect(screen.queryByText(/Mapped: move it/)).not.toBeInTheDocument();
    });

    it("a seen source with a mapped point keeps its own line", () => {
      renderNode("source", "src:1", { source: { ...source, ungrouped: [mappedPoint] }, expanded: false, seen: "Seen in scan #6, 10 min ago" });
      expect(screen.getByText("Seen in scan #6, 10 min ago")).toBeInTheDocument();
      expect(screen.queryByText(/Mapped: move it/)).not.toBeInTheDocument();
    });
  });

  // (w33) A new, unmapped source that looks like an old one that stopped answering, two such old ones, and another server at the address. The card keeps its six lines (one last line,
  // one button row): the offer, the two and the warning replace the seen line, and Move... stands beside Details.
  describe("a source that looks like an old one, two, or a different server (w33)", () => {
    const OLD = "OPC UA server at 172.20.0.3:4840";
    const offer = {
      kind: "offer" as const, from_source_id: 2, from_name: OLD, from_endpoint: "opc.tcp://172.20.0.3:4840/dcdash/", from_since: "2026-10-18T04:52:51Z", mappings: 12, assets: 3,
      match: { kind: "same_server" as const, evidence: "uri" as const, value: "urn:dcdash:simulator:dev", addresses: 12, missing_addresses: 0, needs_tick: false },
    };
    // the page words the sentence (the time of from_since in the site's zone) and hands it to the node as `looks`; the name holds the address, so it is not said twice
    const SENTENCE = `This looks like ${OLD} (12 mappings on 3 assets), which has not answered since 18 Oct 07:52`;
    const LOOKS_LINE = "Looks like OPC UA server (12 mappings)";
    const SEEN = "Seen in scan #8, 2 min ago";
    const identity = { application_uri: null, application_name: null, product_uri: null, thumbprint: null, instance: null, usable: true, different: false };
    const candidate: GraphSource = { ...source, name: "OPC UA server at 172.20.0.5:4840", move_candidate: offer };
    const BUTTON = `Move ${OLD} to OPC UA server at 172.20.0.5:4840...`;
    const lines = () => Array.from(document.querySelectorAll(".gsrc-body > *")).map((line) => line.className.split(" ")[0]);

    it("an offer: the last line says Looks like <old title> (12 mappings) on one muted line, with the whole sentence and then the seen line in its title", () => {
      renderNode("source", "src:1", { source: candidate, expanded: false, onSelect: vi.fn(), onMoveSource: vi.fn(), seen: SEEN, looks: SENTENCE });
      const line = screen.getByText(LOOKS_LINE);
      expect(line).toHaveClass("muted", "gsrc-seen");
      expect(line).not.toHaveClass("gsrc-warn");
      expect(line).toHaveAttribute("title", `${SENTENCE}. ${SEEN}`);
      expect(screen.queryByText(SEEN)).not.toBeInTheDocument();
    });

    it("the card keeps its six lines: the same classes in the same order as a source with no offer, and Move... stands in the button row beside Details", () => {
      renderNode("source", "src:1", { source: candidate, expanded: false, onSelect: vi.fn(), onMoveSource: vi.fn(), seen: SEEN });
      expect(lines()).toEqual(["gsrc-head", "gsrc-sub", "gsrc-status", "gsrc-mapped", "gsrc-actions", "gsrc-seen"]);
      const row = document.querySelector(".gsrc-actions") as HTMLElement;
      const buttons = Array.from(row.querySelectorAll("button"));
      expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([`Details for ${candidate.name}`, BUTTON]);
      expect(buttons[1]).toHaveTextContent("Move...");
      expect(document.querySelector(".gnode")!.className).toBe("gnode gnode-source discovered"); // no class of its own that changes the card's size
      cleanup();
      renderNode("source", "src:1", { source, expanded: false, onSelect: vi.fn(), seen: SEEN });
      expect(lines()).toEqual(["gsrc-head", "gsrc-sub", "gsrc-status", "gsrc-mapped", "gsrc-actions", "gsrc-seen"]);
    });

    it("Move... is a button of type button that reports the node id, takes no drag and never selects the node", async () => {
      const onMoveSource = vi.fn();
      const onSelect = vi.fn();
      renderNode("source", "src:1", { source: candidate, expanded: false, onSelect, onMoveSource, seen: SEEN });
      const button = screen.getByRole("button", { name: BUTTON });
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveClass("nodrag");
      await userEvent.click(button);
      expect(onMoveSource).toHaveBeenCalledTimes(1);
      expect(onMoveSource).toHaveBeenCalledWith("src:1");
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("the keyboard order is the fold, Details, then Move...; Enter and Space press it", async () => {
      const onMoveSource = vi.fn();
      renderNode("source", "src:1", { source: candidate, expanded: false, onToggle: vi.fn(), onSelect: vi.fn(), onMoveSource, seen: SEEN });
      const order: string[] = [];
      for (let i = 0; i < 3; i++) {
        await userEvent.tab();
        order.push(document.activeElement?.getAttribute("aria-label") ?? "");
      }
      expect(order).toEqual([`Expand ${candidate.name}`, `Details for ${candidate.name}`, BUTTON]);
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard(" ");
      expect(onMoveSource).toHaveBeenCalledTimes(2);
    });

    it("without the callback (no sources.edit) the sentence stays and there is no button", () => {
      renderNode("source", "src:1", { source: candidate, expanded: false, onSelect: vi.fn(), seen: SEEN, looks: SENTENCE });
      expect(screen.getByText(LOOKS_LINE)).toHaveAttribute("title", `${SENTENCE}. ${SEEN}`);
      expect(screen.queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
      expect(screen.getAllByRole("button")).toHaveLength(1); // Details
    });

    it("a callback on a source with no offer (or with two candidates) draws no button either", () => {
      renderNode("source", "src:1", { source, expanded: false, onSelect: vi.fn(), onMoveSource: vi.fn(), seen: SEEN });
      expect(screen.queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
      cleanup();
      renderNode("source", "src:1", { source: { ...source, move_candidate: { kind: "two", count: 2 } }, expanded: false, onSelect: vi.fn(), onMoveSource: vi.fn(), seen: SEEN });
      expect(screen.queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
    });

    it("the button row is drawn for Move... even when the page gave no Details", () => {
      renderNode("source", "src:1", { source: candidate, expanded: false, onMoveSource: vi.fn(), seen: SEEN });
      expect(document.querySelector(".gsrc-actions")).not.toBeNull();
      expect(screen.getByRole("button", { name: BUTTON })).toBeInTheDocument();
    });

    it("two candidates: the sentence on the last line, the seen line in its title, and no button", () => {
      renderNode("source", "src:1", { source: { ...source, move_candidate: { kind: "two", count: 2 } }, expanded: false, onSelect: vi.fn(), onMoveSource: vi.fn(), seen: SEEN });
      const line = screen.getByText("Two servers could be this one; edit the address by hand");
      expect(line).toHaveClass("muted", "gsrc-seen");
      expect(line).toHaveAttribute("title", `Two servers could be this one; edit the address by hand. ${SEEN}`);
      expect(screen.queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
      expect(lines()).toEqual(["gsrc-head", "gsrc-sub", "gsrc-status", "gsrc-mapped", "gsrc-actions", "gsrc-seen"]);
      cleanup();
      renderNode("source", "src:1", { source: { ...source, move_candidate: { kind: "two", count: 3 } }, expanded: false, onSelect: vi.fn(), seen: SEEN });
      expect(screen.getByText("Several servers could be this one; edit the address by hand")).toHaveAttribute("title", `Several servers could be this one; edit the address by hand. ${SEEN}`);
    });

    it("a different server: the warning on the last line in the warning ink (not the muted one), the seen line in its title; a source added by hand too", () => {
      renderNode("source", "src:1", { source: { ...source, identity: { ...identity, different: true } }, expanded: false, onSelect: vi.fn(), seen: SEEN });
      const line = screen.getByText("A different server answers at this address");
      expect(line).toHaveClass("gsrc-seen", "gsrc-warn", "warning");
      expect(line).not.toHaveClass("muted");
      expect(line).toHaveAttribute("title", `A different server answers at this address. ${SEEN}`);
      expect(lines()).toEqual(["gsrc-head", "gsrc-sub", "gsrc-status", "gsrc-mapped", "gsrc-actions", "gsrc-seen"]);
      cleanup();
      renderNode("source", "src:1", { source: { ...source, origin: "manual", identity: { ...identity, different: true } }, expanded: false, seen: "Added by hand" });
      expect(screen.getByText("A different server answers at this address")).toHaveClass("gsrc-warn");
      expect(screen.queryByText("Added by hand")).not.toBeInTheDocument();
    });

    it("without the page's sentence the card words the offer without a time (the name holds the address: nothing is said twice)", () => {
      renderNode("source", "src:1", { source: candidate, expanded: false, onSelect: vi.fn(), seen: SEEN });
      expect(screen.getByText(LOOKS_LINE)).toHaveAttribute("title", `This looks like ${OLD} (12 mappings on 3 assets). ${SEEN}`);
    });

    it("a different server beats the offer on the line, and keeps both sentences in the title; the button is still there", () => {
      renderNode("source", "src:1", { source: { ...candidate, identity: { ...identity, different: true } }, expanded: false, onSelect: vi.fn(), onMoveSource: vi.fn(), seen: SEEN, looks: SENTENCE });
      expect(screen.getByText("A different server answers at this address")).toHaveAttribute("title", `A different server answers at this address. ${SENTENCE}. ${SEEN}`);
      expect(screen.getByRole("button", { name: BUTTON })).toBeInTheDocument();
    });

    it("a source with an identity that is not different, or none, keeps its seen line", () => {
      renderNode("source", "src:1", { source: { ...source, identity }, expanded: false, seen: SEEN });
      expect(screen.getByText(SEEN)).toHaveClass("muted", "gsrc-seen");
      expect(screen.queryByText(/different server/i)).not.toBeInTheDocument();
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

  describe("the Show-more node (W12b)", () => {
    const more = { clusterId: "cluster:1:LVP01", label: "LVP01", left: 70, step: 50 };
    const button = () => screen.getByRole("button", { name: "Show 50 more points of LVP01, 70 left" });

    it("is a node type, with no edge handles", () => {
      expect(Object.keys(nodeTypes).sort()).toEqual(["asset", "cluster", "more", "point", "source", "unidentified"]);
      renderNode("more", "more:cluster:1:LVP01", more);
      expect(document.querySelector("[data-handle]")).toBeNull();
    });

    it("is ONE button: the words are Show N more (M left), the name says which group and how many are left, and it is a type=button that neither drags nor takes the node's keys", () => {
      renderNode("more", "more:cluster:1:LVP01", more);
      expect(screen.getAllByRole("button")).toHaveLength(1);
      expect(button()).toHaveTextContent(/^Show 50 more \(70 left\)$/);
      expect(button()).toHaveAttribute("type", "button");
      expect(button()).toHaveClass("nodrag", "nokey");
    });

    it("the last page shows its own size: Show 20 more (20 left)", () => {
      renderNode("more", "more:cluster:1:LVP01", { ...more, left: 20, step: 20 });
      expect(screen.getByRole("button", { name: "Show 20 more points of LVP01, 20 left" })).toHaveTextContent("Show 20 more (20 left)");
    });

    it("a click reports the group's node id and does not also select the node", async () => {
      const onMore = vi.fn();
      const reachedNode = vi.fn();
      const Node = nodeTypes.more as unknown as (props: { id: string; data: object }) => React.ReactElement;
      render(<div onClick={reachedNode}><Node id="more:cluster:1:LVP01" data={{ ...more, onMore }} /></div>);
      await userEvent.click(button());
      expect(onMore).toHaveBeenCalledTimes(1);
      expect(onMore).toHaveBeenCalledWith("cluster:1:LVP01");
      expect(reachedNode).not.toHaveBeenCalled();
    });

    it("Enter and Space press it like any button (they are the button's own, not the node's)", async () => {
      const onMore = vi.fn();
      renderNode("more", "more:cluster:1:LVP01", { ...more, onMore });
      await userEvent.tab();
      expect(button()).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard(" ");
      expect(onMore).toHaveBeenCalledTimes(2);
    });

    it("a node whose page gave no onMore still renders and a click does nothing", async () => {
      renderNode("more", "more:cluster:1:LVP01", more);
      await userEvent.click(button());
      expect(button()).toBeInTheDocument();
    });
  });

  describe("a paged group's line (W12b)", () => {
    const paged = { ...cluster, count: 120, mappedCount: 4, expanded: true, visibleCount: 120, shownCount: 50 };

    it("an open group that draws fewer points than it has says N of M shown, in a muted line, and keeps its title", () => {
      renderNode("cluster", "cluster:1:LVP01", paged);
      expect(screen.getByText("50 of 120 shown")).toHaveClass("muted");
      expect(screen.getByText("LVP01 (120)")).toHaveClass("node-title");
    });

    it("counts the points the filter lets through, not the total (the title stays the total)", () => {
      renderNode("cluster", "cluster:1:LVP01", { ...paged, visibleCount: 80 });
      expect(screen.getByText("50 of 80 shown")).toBeInTheDocument();
      expect(screen.getByText("LVP01 (120)")).toBeInTheDocument();
    });

    it.each([
      ["a closed group", { ...paged, expanded: false }],
      ["a group that draws all its points", { ...paged, shownCount: 120 }],
      ["a group of the old shape (no visibleCount, no shownCount)", { ...cluster, expanded: true }],
    ])("%s has no such line", (_name, data) => {
      renderNode("cluster", "cluster:1:LVP01", data);
      expect(screen.queryByText(/shown$/)).not.toBeInTheDocument();
    });
  });

  describe("the sub-asset toggle and the mapped badge of an asset node (W12b)", () => {
    const asset = { id: 10, parent_id: null, name: "Rack A", kind: "rack" };
    const parent = { asset, depth: 0, children: 3, collapsed: false };

    it("an open parent offers Hide sub-assets of X; a collapsed one Show sub-assets of X; both are a chevron (never a minus or a plus, which the add handle owns), and report the node id and go no further", async () => {
      const onToggleAssets = vi.fn();
      const reachedNode = vi.fn();
      const Node = nodeTypes.asset as unknown as (p: { id: string; data: object }) => React.ReactElement;
      const view = render(<div onClick={reachedNode}><Node id="asset:10" data={{ ...parent, onToggleAssets }} /></div>);
      const hide = screen.getByRole("button", { name: "Hide sub-assets of Rack A" });
      expect(hide).toHaveTextContent(/^$/);
      expect(hide.querySelector("svg.i")).not.toBeNull();
      expect(hide).not.toHaveAttribute("data-folded");
      expect(hide).toHaveClass("nodrag", "gnode-fold");
      expect(hide).toHaveAttribute("type", "button");
      await userEvent.click(hide);
      expect(onToggleAssets).toHaveBeenCalledWith("asset:10");
      expect(reachedNode).not.toHaveBeenCalled();
      view.rerender(<div onClick={reachedNode}><Node id="asset:10" data={{ ...parent, collapsed: true, onToggleAssets }} /></div>);
      expect(screen.queryByRole("button", { name: "Hide sub-assets of Rack A" })).not.toBeInTheDocument();
      const show = screen.getByRole("button", { name: "Show sub-assets of Rack A" });
      expect(show).toHaveTextContent(/^$/);
      expect(show.querySelector("svg.i")).not.toBeNull();
      expect(show).toHaveAttribute("data-folded", "true"); // the stylesheet turns the chevron to point right
    });

    it("a source's fold is a chevron too since W12c, with the words Expand and Collapse; a group keeps its minus and plus", () => {
      renderNode("source", "src:1", { source, expanded: true, onToggle: vi.fn() });
      const fold = screen.getByRole("button", { name: "Collapse Plant OPC" });
      expect(fold).toHaveTextContent(/^$/);
      expect(fold.querySelector("svg.i")).not.toBeNull();
      cleanup();
      renderNode("cluster", "cluster:1:LVP01", { ...cluster, expanded: true, onToggle: vi.fn() });
      expect(screen.getByRole("button", { name: "Collapse LVP01" })).toHaveTextContent(/^−$/);
    });

    it("the words Expand and Collapse are not used (they belong to groups and sources)", () => {
      renderNode("asset", "asset:10", { ...parent, onToggleAssets: vi.fn() });
      expect(screen.queryByRole("button", { name: /expand|collapse/i })).not.toBeInTheDocument();
    });

    it.each([
      ["an asset with no sub-assets", { asset, depth: 0, children: 0, collapsed: false, onToggleAssets: vi.fn() }],
      ["an asset of the old shape", { asset, depth: 0, onToggleAssets: vi.fn() }],
      ["a parent whose page gave no onToggleAssets", parent],
    ])("%s has no toggle", (_name, data) => {
      renderNode("asset", "asset:10", data);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("the + to add a sub-asset stays, beside the toggle, after the two edge handles", () => {
      renderNode("asset", "asset:10", { ...parent, onToggleAssets: vi.fn(), onAdd: vi.fn() });
      expect(screen.getByRole("button", { name: "Hide sub-assets of Rack A" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Add a sub-asset under Rack A" })).toBeInTheDocument();
      expect(Array.from(document.querySelectorAll<HTMLElement>("[data-handle]")).map((h) => h.dataset.handle)).toEqual(["target", "source", "add"]);
    });

    it("a collapsed asset with points mapped inside shows N mapped as a badge on the SAME row as the title (no second line, so the node is no taller)", () => {
      renderNode("asset", "asset:10", { ...parent, collapsed: true, mappedInside: 4, onToggleAssets: vi.fn() });
      const badge = screen.getByText("4 mapped");
      const title = screen.getByText("Rack A");
      expect(title).toHaveClass("node-title");
      expect(badge.parentElement).toBe(title.parentElement);
      expect(badge.parentElement).toHaveClass("row");
      expect(badge.parentElement).toContainElement(screen.getByRole("button", { name: "Show sub-assets of Rack A" }));
    });

    it.each([
      ["an open parent", { ...parent, mappedInside: 4 }],
      ["a collapsed parent with nothing mapped inside", { ...parent, collapsed: true }],
      ["a collapsed parent with a zero count", { ...parent, collapsed: true, mappedInside: 0 }],
    ])("%s has no badge", (_name, data) => {
      renderNode("asset", "asset:10", { ...data, onToggleAssets: vi.fn() });
      expect(screen.queryByText(/mapped/)).not.toBeInTheDocument();
    });

    it("the badge shows without the toggle too (a page that gave no onToggleAssets still tells where the mappings went)", () => {
      renderNode("asset", "asset:10", { ...parent, collapsed: true, mappedInside: 2 });
      expect(screen.getByText("2 mapped")).toBeInTheDocument();
    });
  });

  describe("memoised nodes (W12b)", () => {
    // Every node draws its two handles in its body, and the mock counts its renders: a node component that re-rendered moves the count.
    const Node = nodeTypes.point as unknown as React.ComponentType<Record<string, unknown>>;
    const data = { sourceId: 1, clusterKey: "LVP01", point };
    const props = { id: "point:3", type: "point", data, selected: false, width: 220, height: 40, positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 0, dragging: false };

    const rendersOf = (change: Record<string, unknown>) => {
      const view = render(<Node {...props} />);
      const before = handleRenders.count;
      view.rerender(<Node {...props} {...change} />);
      const moved = handleRenders.count - before;
      view.unmount();
      return moved;
    };

    it("a change of position, stacking or dragging does not re-render the node (a drag, a compaction of rows and Tidy layout move many nodes at once)", () => {
      expect(rendersOf({})).toBe(0);
      expect(rendersOf({ positionAbsoluteX: 96, positionAbsoluteY: 128 })).toBe(0);
      expect(rendersOf({ zIndex: 5 })).toBe(0);
      expect(rendersOf({ dragging: true })).toBe(0);
      expect(rendersOf({ isConnectable: false, draggable: false })).toBe(0);
    });

    it.each([
      ["data", { data: { ...data } }],
      ["selected", { selected: true }],
      ["width", { width: 240 }],
      ["height", { height: 64 }],
      ["id", { id: "point:4" }],
    ])("a change of %s re-renders it", (_name, change) => {
      expect(rendersOf(change)).toBeGreaterThan(0);
    });

    it("every node type is memoised the same way (a position-only change leaves each alone, a new data object does not)", () => {
      // The one property each body reads while it renders; a getter counts the reads, which also covers the `more` node (it has no handle to count).
      const reads = { count: 0 };
      const counted = (plain: object, key: string): object => {
        const value = (plain as Record<string, unknown>)[key];
        return Object.defineProperty({ ...plain }, key, { enumerable: true, get: () => (reads.count++, value) });
      };
      const rack = { id: 10, parent_id: null, name: "Rack A", kind: "rack" };
      const kinds: [keyof typeof nodeTypes, object, string][] = [
        ["source", { source, expanded: false }, "source"], ["cluster", { ...cluster, expanded: true }, "label"], ["point", data, "point"],
        ["asset", { asset: rack, depth: 0 }, "asset"], ["unidentified", { host: "10.0.0.9", port: 8080 }, "host"],
        ["more", { clusterId: "cluster:1:LVP01", label: "LVP01", left: 70, step: 50 }, "label"],
      ];
      expect(kinds.map(([type]) => type).sort()).toEqual(Object.keys(nodeTypes).sort());
      for (const [type, plain, key] of kinds) {
        const Each = nodeTypes[type] as unknown as React.ComponentType<Record<string, unknown>>;
        const base = { ...props, id: `${type}:1`, type, data: counted(plain, key) };
        const view = render(<Each {...base} />);
        expect(reads.count, `${type} reads ${key} when it renders`).toBeGreaterThan(0);
        reads.count = 0;
        view.rerender(<Each {...base} positionAbsoluteX={400} positionAbsoluteY={400} />);
        expect(reads.count, `${type} after a position-only change`).toBe(0);
        view.rerender(<Each {...base} data={counted(plain, key)} />);
        expect(reads.count, `${type} after a new data object`).toBeGreaterThan(0);
        reads.count = 0;
        view.unmount();
      }
    });
  });
});
