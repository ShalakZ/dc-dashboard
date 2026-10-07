import {
  Background, Controls, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState,
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
import { SourcePanel } from "../components/graph/SourcePanel";
import { useAction } from "../hooks/useAction";
import { buildGraph, type OpenState, type SourceNodeData } from "../lib/graph";

const toggled = <T,>(set: ReadonlySet<T>, value: T): Set<T> => {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
};

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
      data: n.type === "source" || n.type === "cluster" ? { ...n.data, onToggle } : n.data,
    }));
    return { nodes, edges: built.edges };
  }, [model, open, onToggle]);
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

  const onNodeDragStop: OnNodeDrag<Node> = useCallback((_event, _node, dragged) => {
    for (const n of dragged) moved.current.set(n.id, { x: n.position.x, y: n.position.y });
    if (!isAdmin) return; // operators arrange the graph for themselves; only an admin's layout is shared
    void run(() => api.put("/api/discovery/layout", { nodes: dragged.map((n) => ({ node_id: n.id, x: n.position.x, y: n.position.y })) }));
  }, [isAdmin, run]);

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
            onNodeDragStop={onNodeDragStop}
            nodesConnectable={false}
            deleteKeyCode={null}
            fitView
          >
            <Controls />
            <Background />
          </ReactFlow>
        </div>
        {selected && <SourcePanel key={selected.id} source={selected} canEdit={isAdmin} onClose={() => setSelectedId(null)} />}
      </div>
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
