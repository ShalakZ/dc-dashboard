import {
  Background, Controls, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Edge, type Node, type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import { keys, useGraph, useInvalidate, useRemoveDiscoveredSources, useSite, useTidyLayout } from "../api/queries";
import type { GraphModel, GraphSource } from "../api/types";
import { useAppearance } from "../auth/AppearanceProvider";
import { useAuth } from "../auth/AuthProvider";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { BulkCreateDialog } from "../components/graph/BulkCreateDialog";
import { nodeTypes } from "../components/graph/nodes";
import { ReviewDialog, type InitialTarget } from "../components/graph/ReviewDialog";
import { SourcePanel } from "../components/graph/SourcePanel";
import { PageHeader } from "../components/PageHeader";
import { CanvasSkeleton, GraphBarSpace } from "../components/Skeleton";
import { useToast } from "../components/Toasts";
import { useAction } from "../hooks/useAction";
import { useConfirm } from "../hooks/useConfirm";
import { dropPayload, mappableClusters, pickDropTarget, type DropPayload } from "../lib/drop";
import {
  buildGraph, childNodeIds, descendantNodeIds, initialView, isRemovable, layoutBatches, ownPlaces, removalDialogText, removalOutcome, seenLine,
  shiftedPlaces, type ClusterNodeData, type OpenState, type PointNodeData, type SourceNodeData, type XY,
} from "../lib/graph";
import { canCollapse, canExpand, collapseAll, expandAll, expandNote, graphSummary } from "../lib/graphView";

const HINT = "Dashed: discovered. Solid: assets. Drag a group onto an asset or press New asset… A node takes its open children along; Alt or Option moves it alone.";

/** Two animation frames: the nodes React Flow was given a moment ago are in its store and drawn. */
const afterPaint = () => new Promise<void>((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve())); });

/**
 * What a drag works from, taken ONCE when it starts (the callbacks must not read the maps they are changing): which nodes are dragged, where every
 * node that can move with the drag stood, which of them follow, and every place a node had of its own (as copies).
 */
interface DragSnapshot {
  /** Alt (Option) was held when the drag began: the node moves alone. Read once; it holds for the whole drag. */
  alone: boolean;
  /** Where the dragged nodes, the followers and the pinned children stood when the drag began. */
  starts: ReadonlyMap<string, XY>;
  /** The nodes that are drawn and move with the dragged ones (never a dragged id). Empty for an Alt drag. */
  followers: ReadonlySet<string>;
  /** Every node under a dragged one, open or not, except the dragged ones themselves. Empty for an Alt drag. */
  below: readonly string[];
  /** An Alt drag only: the drawn children of the dragged nodes, which stay where they stand and so need a place of their own. */
  pins: readonly string[];
  /** `moved` over the saved layout, as it was when the drag began. */
  own: ReadonlyMap<string, XY>;
}

const toggled = <T,>(set: ReadonlySet<T>, value: T): Set<T> => {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
};

type Callbacks = {
  onToggle: (id: string) => void; onSelect: (id: string) => void; onMap: (id: string) => void; onNewAsset: (id: string) => void;
  onCreateAssets: (id: string) => void; onRemove: (id: string) => void;
};

/** What the page works out about a source once per graph, so a toggle or a drag does not do it again for every node. */
interface SourceFacts { seen: string; groups: number; removable: boolean }

/**
 * The callbacks a node gets in its data (it renders a button only for a callback it has). Sources and clusters toggle and
 * sources open their details;
 * for someone who may accept scan results (`canAccept`), a cluster with something left to map offers both mapping buttons and an
 * unmapped point offers "Map", and a source with at least one group to turn into an asset offers "Create assets" (`facts.groups`, 0 for
 * a role that may not accept). A source offers "Remove" only when it is removable and the person may change the graph (`canRemove`).
 * The conditions mirror what `dropPayload` accepts, so a button is never shown for something that could not be mapped.
 */
function nodeData(
  node: Node, canAccept: boolean, canRemove: boolean, facts: ReadonlyMap<number, SourceFacts>,
  { onToggle, onSelect, onMap, onNewAsset, onCreateAssets, onRemove }: Callbacks,
): Node["data"] {
  if (node.type === "source") {
    const data = node.data as SourceNodeData;
    const fact = facts.get(data.source.id);
    return {
      ...data, onToggle, onSelect, seen: fact?.seen,
      ...(fact && fact.groups > 0 ? { onCreateAssets, groups: fact.groups } : {}),
      ...(canRemove && fact?.removable ? { onRemove } : {}),
    };
  }
  if (node.type === "cluster") {
    const cluster = node.data as ClusterNodeData;
    const mappable = canAccept && !cluster.ungrouped && cluster.mappedCount < cluster.count;
    return { ...cluster, onToggle, ...(mappable ? { onMap, onNewAsset } : {}) };
  }
  if (node.type === "point" && canAccept && (node.data as PointNodeData).point.asset_id === null) return { ...node.data, onMap };
  return node.data;
}

function Canvas({ model }: { model: GraphModel }) {
  const { can } = useAuth();
  const canAccept = can("discovery.accept"); // map and accept: the buttons on the nodes, a drop onto an asset, the offer and the review
  const canLayout = can("discovery.edit"); // the shared layout
  const canRemove = canLayout; // Remove and Clear unmapped ride on the same permission (it is the remove route's)
  const canEditSource = can("sources.edit"); // the source panel's credentials and Browse again
  const invalidate = useInvalidate();
  const toast = useToast();
  const removeSources = useRemoveDiscoveredSources();
  const { run, error: saveError } = useAction();
  const timezone = useSite().data?.timezone ?? "UTC"; // the "10 min ago" of a source counts on the site's clock; UTC until it is read
  const [open, setOpen] = useState<OpenState>({ sources: new Set(), clusters: new Set() });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Where the user has dragged nodes this session. A rebuild (expand, collapse, refresh) puts these back instead of
  // snapping the nodes to the saved layout, which this person may never change or whose save may not have reloaded yet.
  const moved = useRef(new Map<string, XY>());
  // The drag in progress (taken when it starts): a drop onto an asset puts the dragged nodes and their followers back from it.
  const drag = useRef<DragSnapshot | null>(null);
  // How many times Tidy layout ran here. Above 0 the saved layout is left out of the build (the graph is read again after a Tidy, and until then the old
  // places must not flash back); each Tidy is a new value, so the nodes are rebuilt even when the second one changes nothing else.
  const [tidyRuns, setTidyRuns] = useState(0);
  const [tidying, setTidying] = useState(false);
  const tidyBusy = useRef(false);
  // Every layout write (a drag's PUT batches, Tidy's DELETE) goes through this one chain, so a quick second drag or a Tidy cannot reach the server out of order.
  const layoutWrites = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const job = layoutWrites.current.then(work);
    layoutWrites.current = job.catch(() => undefined); // the chain itself never rejects: a failed write is its caller's to show
    return job;
  }, []);
  const { getIntersectingNodes, getNodes, fitView } = useReactFlow();
  const [ask, askDialog] = useConfirm();
  const { dark } = useAppearance();
  const [review, setReview] = useState<{ key: number; payload: DropPayload; initialTarget: InitialTarget } | null>(null);
  const reviewCount = useRef(0);
  const [offer, setOffer] = useState<{ nodeId: string; label: string } | null>(null);
  // The sources a Remove or a Clear unmapped is asking about, FROZEN when the dialog opens: the request carries these ids and no others, so a source
  // a scan adds meanwhile is never touched. `fromNode`: the Remove button of a node opened it (that node is gone afterwards; Clear keeps its button).
  const [removal, setRemoval] = useState<{ sources: { id: number; name: string }[]; fromNode: boolean } | null>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const focusRefresh = useRef(false);
  // The source whose bulk-create dialog is open, as it was when the button was pressed (like the review dialog's payload, so the dialog's own
  // rows do not shift under it when the graph is read again after each asset). `focusAfterCreate`: the source whose node takes the focus back.
  const [createFor, setCreateFor] = useState<GraphSource | null>(null);
  const focusAfterCreate = useRef<number | null>(null);

  // The offer has no timer (WCAG 2.2.1): it stays until it is dismissed, used, replaced by a newer one, or another drag starts.
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

  const canvas = useRef<HTMLDivElement>(null);
  // Where the canvas opens (the first sources, readable). Taken once, when the canvas mounts: a refresh never moves the view, and the Controls'
  // fit-view button (it passes no options) still fits everything, so a drop onto an asset that lies out of view is a click away.
  const [opening] = useState(() => initialView(model));
  const onSelect = useCallback((id: string) => setSelectedId(Number(id.slice("src:".length))), []);
  const closePanel = useCallback(() => {
    const id = selectedId;
    setSelectedId(null);
    // Hand the keyboard back to the node's Details button, which stays in the canvas while the panel is open.
    if (id !== null) canvas.current?.querySelector<HTMLElement>(`[data-id="src:${id}"] button[aria-label^="Details for"]`)?.focus();
  }, [selectedId]);

  const onToggle = useCallback((id: string) => {
    setOpen((prev) => id.startsWith("src:")
      ? { ...prev, sources: toggled(prev.sources, Number(id.slice("src:".length))) }
      : { ...prev, clusters: toggled(prev.clusters, id) });
  }, []);

  const sourceOf = useCallback((id: string) => model.sources.find((s) => s.id === Number(id.slice("src:".length))), [model]);
  const onCreateAssets = useCallback((id: string) => {
    const source = sourceOf(id);
    if (source) setCreateFor(source);
  }, [sourceOf]);
  const closeCreate = useCallback(() => {
    focusAfterCreate.current = createFor?.id ?? null;
    setCreateFor(null);
  }, [createFor]);
  const onRemove = useCallback((id: string) => {
    const source = sourceOf(id);
    if (source && isRemovable(source)) setRemoval({ sources: [{ id: source.id, name: source.name }], fromNode: true });
  }, [sourceOf]);
  const removable = useMemo(() => model.sources.filter(isRemovable), [model]);
  const clearUnmapped = () => {
    if (removable.length > 0) setRemoval({ sources: removable.map((s) => ({ id: s.id, name: s.name })), fromNode: false });
  };

  // What the page works out about each source once per graph: the muted last-seen line, how many groups "Create assets" would turn into
  // assets (a role that may not accept has none) and whether it is removable. `asOf` moves with each read of the graph: the "ago" is as old as the data.
  const asOf = useMemo(() => new Date(), [model]);
  const facts = useMemo(() => new Map<number, SourceFacts>(model.sources.map((s) => [s.id, {
    seen: seenLine(s, asOf, timezone), groups: canAccept ? mappableClusters(s).length : 0, removable: isRemovable(s),
  }])), [model, asOf, timezone, canAccept]);

  const seeded = useMemo(() => {
    const built = buildGraph(model, open, { moved: moved.current, ignoreSaved: tidyRuns > 0 });
    const nodes: Node[] = built.nodes.map((n) => ({
      ...n,
      data: nodeData(n, canAccept, canRemove, facts, { onToggle, onSelect, onMap, onNewAsset, onCreateAssets, onRemove }),
    }));
    return { nodes, edges: built.edges };
  }, [model, open, tidyRuns, canAccept, canRemove, facts, onToggle, onSelect, onMap, onNewAsset, onCreateAssets, onRemove]);
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

  /** One snapshot per drag. A node takes its OPEN children along unless Alt (Option) is held; the places of the hidden ones are shifted at the drop. */
  const onNodeDragStart: OnNodeDrag<Node> = useCallback((event, _node, dragged) => {
    const draggedIds = new Set(dragged.map((n) => n.id));
    const live = new Map(getNodes().map((n) => [n.id, n.position]));
    const alone = event.altKey;
    const below = new Set<string>();
    if (!alone) for (const n of dragged) for (const id of descendantNodeIds(model, n.id)) if (!draggedIds.has(id)) below.add(id);
    const followers = new Set([...below].filter((id) => live.has(id)));
    const pins = alone ? [...new Set(dragged.flatMap((n) => childNodeIds(model, n.id)))].filter((id) => !draggedIds.has(id) && live.has(id)) : [];
    const starts = new Map<string, XY>(dragged.map((n) => [n.id, { x: n.position.x, y: n.position.y }]));
    for (const id of [...followers, ...pins]) starts.set(id, { ...live.get(id)! });
    drag.current = { alone, starts, followers, below: [...below], pins, own: ownPlaces(model, { moved: moved.current, ignoreSaved: tidyRuns > 0 }) };
    setOffer(null);
  }, [model, tidyRuns, getNodes]);

  /** The followers stand where they started plus how far the dragged node has gone from where IT started (never a dragged id: they are React Flow's). */
  const placeFollowers = useCallback((snapshot: DragSnapshot, node: Node) => {
    const from = snapshot.starts.get(node.id);
    if (!from || snapshot.followers.size === 0) return;
    const [dx, dy] = [node.position.x - from.x, node.position.y - from.y];
    setNodes((current) => current.map((n) => {
      const start = snapshot.followers.has(n.id) ? snapshot.starts.get(n.id) : undefined;
      return start ? { ...n, position: { x: start.x + dx, y: start.y + dy } } : n;
    }));
  }, [setNodes]);
  const onNodeDrag: OnNodeDrag<Node> = useCallback((_event, node) => {
    if (drag.current) placeFollowers(drag.current, node);
  }, [placeFollowers]);

  const onNodeDragStop: OnNodeDrag<Node> = useCallback((_event, node, dragged) => {
    const snapshot = drag.current;
    drag.current = null;
    // Everyone arranges the graph for themselves (kept in `moved`); only discovery.edit shares the layout, and only discovery.accept maps.
    if (canAccept && dragged.length <= 1) {
      const payload = dropPayload(model, node.id);
      const assetId = payload ? pickDropTarget(getIntersectingNodes(node)) : null;
      if (payload && assetId !== null) {
        // Dropped on an asset: that is a request to map, not a move. Put the node and its followers back where they were (after React Flow's own
        // final position change, hence the functional update) and remember nothing, so rebuilds keep them there too.
        const back = snapshot?.starts;
        if (back) setNodes((current) => current.map((n) => { const at = back.get(n.id); return at ? { ...n, position: at } : n; }));
        openReview(payload, { kind: "existing", assetId });
        return;
      }
      if (payload?.kind === "cluster") setOffer({ nodeId: node.id, label: payload.label });
    }
    // What this drag changed, in the order it is sent: the dragged nodes where they now stand, then every place that was shifted with them.
    const writes = new Map<string, XY>();
    for (const n of dragged) writes.set(n.id, { x: n.position.x, y: n.position.y });
    const from = snapshot?.starts.get(node.id);
    if (snapshot && from) {
      // Computed from the snapshot, never from `moved` while it is being filled: a source and its own group dragged together shift each place once.
      placeFollowers(snapshot, node); // React Flow may deliver the last position without one more onNodeDrag
      const shifted = shiftedPlaces(snapshot.own, snapshot.below, { x: node.position.x - from.x, y: node.position.y - from.y });
      for (const [id, place] of shifted) writes.set(id, place);
      // Alt: the children stay, so each one that had no place of its own gets the one it stands at (else it would follow its parent at the next rebuild).
      for (const id of snapshot.pins) if (!snapshot.own.has(id)) writes.set(id, snapshot.starts.get(id)!);
    }
    for (const [id, place] of writes) moved.current.set(id, place);
    if (!canLayout) return;
    // A node with an over-long id stays where it was dragged for this session but is not sent (layoutBatches leaves it out): the server would reject
    // the whole request and take every other position down with it.
    const batches = layoutBatches(writes);
    if (batches.length === 0) return;
    void run(() => enqueue(async () => { for (const nodes of batches) await api.put("/api/discovery/layout", { nodes }); }));
  }, [canAccept, canLayout, model, getIntersectingNodes, setNodes, placeFollowers, openReview, run, enqueue]);

  // The bar above the canvas: what the graph holds, Collapse all, Expand all and Tidy layout. A button with nothing to do keeps its place and says so
  // (aria-disabled and a click guard, never `disabled`: it may hold the focus the click gave it).
  const summary = useMemo(() => graphSummary(model), [model]);
  const collapsible = canCollapse(model, open);
  const expandable = canExpand(model, open);
  const onCollapseAll = () => {
    if (collapsible) setOpen(collapseAll());
  };
  const onExpandAll = () => {
    if (!expandable) return;
    const result = expandAll(model, open);
    setOpen(result.open);
    const note = expandNote(result); // what the node budget kept closed, if anything
    if (note) toast.info(note);
  };

  // Tidy layout: every node back to its default column. The model of the moment is read after the awaits (a refresh may have come in meanwhile).
  const modelRef = useRef(model);
  useEffect(() => { modelRef.current = model; }, [model]);
  const tidyLayout = useTidyLayout({
    // Right after the route has answered, before the graph is read again: the old layout (this session's drags and the saved places) never shows.
    onDeleted: () => { moved.current.clear(); setTidyRuns((n) => n + 1); },
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const refit = useCallback(async () => {
    await afterPaint(); // the rebuilt nodes are in React Flow's store
    if (!mounted.current) return; // the person left the page meanwhile
    void fitView(initialView({ ...modelRef.current, layout: {} })); // the opening rules (W7r), as if no place were saved
  }, [fitView]);
  const onTidy = async () => {
    if (tidyBusy.current) return;
    tidyBusy.current = true;
    setTidying(true);
    try {
      if (!canLayout) {
        // The layout is shared and this role may not change it: its own view goes back to the default columns, and nothing is sent.
        moved.current.clear();
        setTidyRuns((n) => n + 1);
        toast.info("Tidied for you only. Your role may not change the layout everyone sees.");
        await refit();
        return;
      }
      const yes = await ask({
        title: "Tidy the layout for everyone?",
        message: "Every node goes back to its default column for all users. Nothing else changes.",
        confirmLabel: "Tidy for everyone",
        tone: "primary",
      });
      if (!yes) return;
      let cleared = false;
      // Behind the drags still being saved (one chain); a refusal lands in the same error line as a failed drag and changes nothing here.
      await run(async () => { await enqueue(() => tidyLayout.mutateAsync()); cleared = true; });
      if (cleared) await refit();
    } finally {
      tidyBusy.current = false;
      setTidying(false);
    }
  };

  // The panel reads the source from the current model, so it follows a refresh instead of showing stale facts.
  const selected = selectedId === null ? undefined : model.sources.find((s) => s.id === selectedId);

  const confirmRemoval = async () => {
    if (!removal) return;
    // The call resolves after the graph is read again, so the removed nodes are already gone when the dialog closes below.
    const outcome = removalOutcome(await removeSources.mutateAsync(removal.sources.map((s) => s.id)));
    if (outcome.kind === "none") throw new Error(outcome.text); // nothing went: the dialog stays open and says why as its error line
    if (outcome.kind === "done") toast.success(outcome.text);
    else if (outcome.kind === "partial") toast.error(outcome.text);
    else toast.info(outcome.text);
    focusRefresh.current = removal.fromNode;
    setRemoval(null);
  };
  // After the dialog has gone (a PARENT effect runs after the dialog's own cleanup has put the focus back on the node's Remove button, which the
  // refreshed graph has taken away): the focus lands on Refresh. A Clear unmapped keeps its own button, and the dialog hands the focus back to it.
  useEffect(() => {
    if (removal === null && focusRefresh.current) {
      focusRefresh.current = false;
      refreshRef.current?.focus();
    }
  }, [removal]);
  // The bulk-create dialog does not restore focus itself (the page decides): its Create assets… button, or, when every group has become an asset
  // and the button is gone, the node's Details button.
  useEffect(() => {
    if (createFor !== null || focusAfterCreate.current === null) return;
    const node = canvas.current?.querySelector(`[data-id="src:${focusAfterCreate.current}"]`);
    focusAfterCreate.current = null;
    (node?.querySelector<HTMLElement>('button[aria-label^="Create assets for"]') ?? node?.querySelector<HTMLElement>('button[aria-label^="Details for"]'))?.focus();
  }, [createFor]);

  return (
    <>
      <PageHeader
        title="Discovery"
        sub={HINT}
        actions={
          <>
            <button type="button" ref={refreshRef} onClick={() => invalidate(keys.graph)}>Refresh</button>
            {/* Always drawn for a role that may use it (never a slot that comes and goes); with nothing to clear it is aria-disabled, not disabled, so it keeps the focus it may hold. */}
            {canRemove && (
              <button
                type="button"
                className="discovery-clear"
                aria-disabled={removable.length === 0 || undefined}
                title={removable.length === 0 ? "Nothing to clear" : undefined}
                onClick={clearUnmapped}
              >{`Clear unmapped (${removable.length})`}</button>
            )}
          </>
        }
      />
      <div className="graph-bar">
        {/* The one announcer of this area: React leaves the text alone when the numbers do not change, so it speaks only when they do. */}
        <p className="graph-summary" aria-live="polite" aria-atomic="true" title={summary}>{summary}</p>
        <button
          type="button"
          aria-disabled={!collapsible || undefined}
          title={collapsible ? undefined : "Nothing is open"}
          onClick={onCollapseAll}
        >Collapse all</button>
        <button
          type="button"
          aria-disabled={!expandable || undefined}
          title={expandable ? undefined : "Everything is open"}
          onClick={onExpandAll}
        >Expand all</button>
        <button type="button" aria-disabled={tidying || undefined} onClick={() => void onTidy()}>Tidy layout</button>
      </div>
      {saveError && <p className="error" role="alert">{saveError}</p>}
      <div className="graph-layout">
        <div className="graph-canvas" ref={canvas}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_event, node) => { if (node.type === "source") setSelectedId((node.data as SourceNodeData).source.id); }}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            colorMode={dark ? "dark" : "light"}
            nodesConnectable={false}
            nodesDraggable={!tidying} // a drag while Tidy runs would put the old places back after the wipe, for everyone
            edgesFocusable={false} // an edge is a Tab stop with no visible ring; the nodes stay focusable
            deleteKeyCode={null}
            fitView
            fitViewOptions={opening}
            minZoom={0.2} // the opening view holds 0.75 through fitViewOptions; this floor is what lets Fit View (and the wheel) show a tall graph whole
          >
            <Controls />
            <Background />
          </ReactFlow>
          {canAccept && offer && (
            <div className="offer-bar" role="status">
              <span>{`Create asset "${offer.label}" from this cluster?`}</span>
              <button className="primary" onClick={() => {
                const payload = dropPayload(model, offer.nodeId);
                if (payload) openReview(payload, { kind: "new", name: payload.label, parentId: null });
                else setOffer(null);
              }}>Create asset…</button>
              <button className="quiet" onClick={() => setOffer(null)}>Dismiss</button>
            </div>
          )}
        </div>
        {selected && <SourcePanel key={selected.id} source={selected} canEdit={canEditSource} seen={facts.get(selected.id)?.seen ?? ""} onClose={closePanel} />}
      </div>
      {canAccept && review && (
        <ReviewDialog key={review.key} model={model} payload={review.payload} initialTarget={review.initialTarget} onClose={closeReview} />
      )}
      {canAccept && createFor && <BulkCreateDialog model={model} source={createFor} onClose={closeCreate} />}
      {askDialog}
      {removal && (
        <ConfirmDeleteDialog
          {...removalDialogText(removal.sources.map((s) => s.name))}
          confirmLabel="Remove"
          onConfirm={confirmRemoval}
          onCancel={() => setRemoval(null)}
        />
      )}
    </>
  );
}

/**
 * The header's actions while the graph loads: the words of the real buttons (Refresh, and Clear unmapped for a role that has it), hidden. The actions
 * column takes its width from them, so the hint beside it wraps onto the same number of lines as it will beside the real buttons and the canvas does not
 * drop when the graph arrives (a bare gap, `ActionsSpace`, holds the height but not the width). Not focusable and not read out.
 */
function LoadingActions({ withClear }: { withClear: boolean }) {
  return (
    <span className="graph-actions-space" aria-hidden="true">
      <button type="button" tabIndex={-1}>Refresh</button>
      {withClear && <button type="button" tabIndex={-1}>Clear unmapped (0)</button>}
    </span>
  );
}

export function DiscoveryPage() {
  const { loading, can } = useAuth();
  const { data: model, error, isLoading } = useGraph();
  const empty = !model || (model.sources.length === 0 && model.unidentified.length === 0);
  // A Clear unmapped that takes the last source away leaves the empty page: the canvas, with the dialog and the button that had the focus, is
  // gone. The main area takes the focus (without scrolling), as the drawer does when its opener has no row to go back to.
  const wasShown = useRef(false);
  useEffect(() => {
    if (!model) return;
    if (!empty) wasShown.current = true;
    else if (wasShown.current) {
      wasShown.current = false;
      document.getElementById("main")?.focus({ preventScroll: true });
    }
  }, [model, empty]);
  if (loading || isLoading) {
    // Inside .graph-page from the first paint: the shell's one-window-tall rules key on it, and the canvas takes what the header leaves.
    return (
      <div className="graph-page">
        <PageHeader title="Discovery" sub={HINT} actions={<LoadingActions withClear={can("discovery.edit")} />} />
        <GraphBarSpace />
        <CanvasSkeleton label="Loading the graph" />
      </div>
    );
  }
  if (error) return <p className="error" role="alert">{error.message}</p>;
  if (!model || empty) {
    return (
      <>
        <PageHeader title="Discovery" />
        <div className="empty">
          <div className="empty-icon">
            <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2.2" /><circle cx="19" cy="5" r="2.2" /><circle cx="19" cy="19" r="2.2" /><path d="M7 11 17 6M7 13l10 5" /></svg>
          </div>
          <p className="muted">Nothing discovered yet — <Link to="/scans">run a scan</Link>.</p>
        </div>
      </>
    );
  }
  return (
    <div className="graph-page">
      <ReactFlowProvider>
        <Canvas model={model} />
      </ReactFlowProvider>
    </div>
  );
}
