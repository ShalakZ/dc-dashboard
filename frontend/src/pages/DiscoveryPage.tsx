import {
  Background, Controls, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Edge, type Node, type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import { keys, useGraph, useInvalidate } from "../api/queries";
import type { GraphModel } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { nodeTypes } from "../components/graph/nodes";
import { ReviewDialog, type InitialTarget } from "../components/graph/ReviewDialog";
import { SourcePanel } from "../components/graph/SourcePanel";
import { useAction } from "../hooks/useAction";
import { dropPayload, pickDropTarget, type DropPayload } from "../lib/drop";
import {
  buildGraph, type ClusterNodeData, type OpenState, type PointNodeData, type SourceNodeData,
} from "../lib/graph";

/** How long the "create an asset from this cluster?" offer stays up. */
const OFFER_MS = 10_000;

const toggled = <T,>(set: ReadonlySet<T>, value: T): Set<T> => {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
};

type Callbacks = { onToggle: (id: string) => void; onMap: (id: string) => void; onNewAsset: (id: string) => void };

/**
 * The callbacks a node gets in its data (it renders a button only for a callback it has). Sources and clusters toggle;
 * for an admin, a cluster with something left to map offers both mapping buttons and an unmapped point offers "Map".
 * The conditions mirror what `dropPayload` accepts, so a button is never shown for something that could not be mapped.
 */
function nodeData(node: Node, isAdmin: boolean, { onToggle, onMap, onNewAsset }: Callbacks): Node["data"] {
  if (node.type === "source") return { ...node.data, onToggle };
  if (node.type === "cluster") {
    const cluster = node.data as ClusterNodeData;
    const mappable = isAdmin && !cluster.ungrouped && cluster.mappedCount < cluster.count;
    return { ...cluster, onToggle, ...(mappable ? { onMap, onNewAsset } : {}) };
  }
  if (node.type === "point" && isAdmin && (node.data as PointNodeData).point.asset_id === null) return { ...node.data, onMap };
  return node.data;
}

function Canvas({ model }: { model: GraphModel }) {
  const { hasRole } = useAuth();
  const isAdmin = hasRole("admin");
  const invalidate = useInvalidate();
  const { run, error: saveError } = useAction();
  const [open, setOpen] = useState<OpenState>({ sources: new Set(), clusters: new Set() });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Where the user has dragged nodes this session. A rebuild (expand, collapse, refresh) puts these back instead of
  // snapping the nodes to the saved layout, which an operator never changes and an admin's save may not have reloaded yet.
  const moved = useRef(new Map<string, { x: number; y: number }>());
  // Where the dragged nodes were when the drag began, so a drop onto an asset can put them back.
  const dragStart = useRef(new Map<string, { x: number; y: number }>());
  const { getIntersectingNodes } = useReactFlow();
  const [review, setReview] = useState<{ key: number; payload: DropPayload; initialTarget: InitialTarget } | null>(null);
  const reviewCount = useRef(0);
  const [offer, setOffer] = useState<{ nodeId: string; label: string } | null>(null);

  // A newer offer replaces the old one and gets the full time; leaving the page or dismissing clears the timer too.
  useEffect(() => {
    if (!offer) return;
    const timer = setTimeout(() => setOffer(null), OFFER_MS);
    return () => clearTimeout(timer);
  }, [offer]);

  const openReview = useCallback((payload: DropPayload, initialTarget: InitialTarget) => {
    setOffer(null);
    setReview({ key: ++reviewCount.current, payload, initialTarget });
  }, []);
  const closeReview = useCallback(() => setReview(null), []);
  /** The buttons on the nodes: the keyboard-reachable way to map, which dragging only duplicates. */
  const onMap = useCallback((id: string) => {
    const payload = dropPayload(model, id);
    if (payload) openReview(payload, { kind: "existing", assetId: null });
  }, [model, openReview]);
  const onNewAsset = useCallback((id: string) => {
    const payload = dropPayload(model, id);
    if (payload) openReview(payload, { kind: "new", name: payload.label, parentId: null });
  }, [model, openReview]);

  const onToggle = useCallback((id: string) => {
    setOpen((prev) => id.startsWith("src:")
      ? { ...prev, sources: toggled(prev.sources, Number(id.slice("src:".length))) }
      : { ...prev, clusters: toggled(prev.clusters, id) });
  }, []);

  const seeded = useMemo(() => {
    const built = buildGraph(model, open);
    const nodes: Node[] = built.nodes.map((n) => ({
      ...n,
      position: moved.current.get(n.id) ?? n.position,
      data: nodeData(n, isAdmin, { onToggle, onMap, onNewAsset }),
    }));
    return { nodes, edges: built.edges };
  }, [model, open, isAdmin, onToggle, onMap, onNewAsset]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(seeded.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(seeded.edges);
  useEffect(() => {
    // New node objects carry no size, which would hide every node until React Flow measures them again: keep what it knows.
    setNodes((current) => {
      const known = new Map(current.map((n) => [n.id, n.measured]));
      return seeded.nodes.map((n) => { const measured = known.get(n.id); return measured ? { ...n, measured } : n; });
    });
    setEdges(seeded.edges);
  }, [seeded, setNodes, setEdges]);

  const onNodeDragStart: OnNodeDrag<Node> = useCallback((_event, _node, dragged) => {
    dragStart.current = new Map(dragged.map((n) => [n.id, { x: n.position.x, y: n.position.y }]));
    setOffer(null);
  }, []);

  const onNodeDragStop: OnNodeDrag<Node> = useCallback((_event, node, dragged) => {
    // Operators arrange the graph for themselves (kept in `moved`); only an admin's layout is shared, and only an admin maps.
    if (isAdmin && dragged.length <= 1) {
      const payload = dropPayload(model, node.id);
      const assetId = payload ? pickDropTarget(getIntersectingNodes(node)) : null;
      if (payload && assetId !== null) {
        // Dropped on an asset: that is a request to map, not a move. Put the node back where it was (after React Flow's own
        // final position change, hence the functional update) and remember nothing, so rebuilds keep it there too.
        const back = dragStart.current.get(node.id);
        if (back) setNodes((current) => current.map((n) => (n.id === node.id ? { ...n, position: back } : n)));
        openReview(payload, { kind: "existing", assetId });
        return;
      }
      if (payload?.kind === "cluster") setOffer({ nodeId: node.id, label: payload.label });
    }
    for (const n of dragged) moved.current.set(n.id, { x: n.position.x, y: n.position.y });
    if (!isAdmin) return;
    void run(() => api.put("/api/discovery/layout", { nodes: dragged.map((n) => ({ node_id: n.id, x: n.position.x, y: n.position.y })) }));
  }, [isAdmin, model, getIntersectingNodes, setNodes, openReview, run]);

  // The panel reads the source from the current model, so it follows a refresh instead of showing stale facts.
  const selected = selectedId === null ? undefined : model.sources.find((s) => s.id === selectedId);

  return (
    <>
      <div className="row">
        <h1>Discovery</h1>
        <button onClick={() => invalidate(keys.graph)}>Refresh</button>
        <span className="muted">Dashed nodes were discovered; solid nodes are assets. Drag nodes to arrange them.</span>
      </div>
      {saveError && <p className="error" role="alert">{saveError}</p>}
      <div className="graph-layout">
        <div className="graph-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_event, node) => { if (node.type === "source") setSelectedId((node.data as SourceNodeData).source.id); }}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            nodesConnectable={false}
            deleteKeyCode={null}
            fitView
          >
            <Controls />
            <Background />
          </ReactFlow>
          {isAdmin && offer && (
            <div className="offer-bar" role="status">
              <span>{`Create asset "${offer.label}" from this cluster?`}</span>
              <button onClick={() => {
                const payload = dropPayload(model, offer.nodeId);
                if (payload) openReview(payload, { kind: "new", name: payload.label, parentId: null });
                else setOffer(null);
              }}>Create asset…</button>
              <button onClick={() => setOffer(null)}>Dismiss</button>
            </div>
          )}
        </div>
        {selected && <SourcePanel key={selected.id} source={selected} canEdit={isAdmin} onClose={() => setSelectedId(null)} />}
      </div>
      {isAdmin && review && (
        <ReviewDialog key={review.key} model={model} payload={review.payload} initialTarget={review.initialTarget} onClose={closeReview} />
      )}
    </>
  );
}

export function DiscoveryPage() {
  const { loading } = useAuth();
  const { data: model, error, isLoading } = useGraph();
  if (loading || isLoading) return <p className="muted">loading…</p>;
  if (error) return <p className="error" role="alert">{error.message}</p>;
  if (!model || (model.sources.length === 0 && model.unidentified.length === 0)) {
    return <p className="muted">Nothing discovered yet — <Link to="/scans">run a scan</Link>.</p>;
  }
  return (
    <div className="graph-page">
      <ReactFlowProvider>
        <Canvas model={model} />
      </ReactFlowProvider>
    </div>
  );
}
