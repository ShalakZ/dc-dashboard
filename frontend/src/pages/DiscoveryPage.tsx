import {
  Background, Controls, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Edge, type Node, type OnConnectEnd, type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import { keys, useAssetKinds, useAssets, useGraph, useInvalidate, useRemoveDiscoveredSources, useSite, useTidyLayout } from "../api/queries";
import type { Asset, GraphModel, GraphSource } from "../api/types";
import { useAppearance } from "../auth/AppearanceProvider";
import { useAuth } from "../auth/AuthProvider";
import { meets } from "../auth/need";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { AlignGuides, type AlignGuidesHandle } from "../components/graph/AlignGuides";
import { BulkCreateDialog } from "../components/graph/BulkCreateDialog";
import { CanvasTools } from "../components/graph/CanvasTools";
import { GraphContextMenu } from "../components/graph/GraphContextMenu";
import { GraphMiniMap } from "../components/graph/GraphMiniMap";
import { NewAssetDialog } from "../components/graph/NewAssetDialog";
import { AddConnectionLine, nodeTypes } from "../components/graph/nodes";
import { ReviewDialog, type InitialTarget } from "../components/graph/ReviewDialog";
import { SourcePanel } from "../components/graph/SourcePanel";
import { InfoTip } from "../components/InfoTip";
import { PageHeader } from "../components/PageHeader";
import type { RowAction } from "../components/RowActions";
import { CanvasSkeleton, GraphBarSpace } from "../components/Skeleton";
import { useToast } from "../components/Toasts";
import { useAction } from "../hooks/useAction";
import { useCanvasKeys } from "../hooks/useCanvasKeys";
import { useCanvasMenu } from "../hooks/useCanvasMenu";
import { useConfirm } from "../hooks/useConfirm";
import { useCreateAsset } from "../hooks/useCreateAsset";
import { useGraphHighlight } from "../hooks/useGraphHighlight";
import { useMappingActions } from "../hooks/useMappingActions";
import { reducedMotion, useReducedMotion } from "../hooks/useReducedMotion";
import { dropPayload, mappableClusters, multiPointDrop, pickDropTarget, takenMetrics, type DropPayload } from "../lib/drop";
import {
  buildGraph, childNodeIds, descendantNodeIds, initialView, isRemovable, layoutBatches, ownPlaces, removalDialogText, removalOutcome, seenLine,
  shiftedPlaces, type AssetNodeData, type ClusterNodeData, type MappedSource, type NodeActions, type OpenState, type PointNodeData, type SourceNodeData, type XY,
} from "../lib/graph";
import { cameraMs, keepInView, unionRect } from "../lib/graphCamera";
import { buildFindIndex, findMatches, findPlan, type FindEntry } from "../lib/graphFind";
import { alignGuides, type Rect } from "../lib/graphGuides";
import { readSnap, SNAP_GRID, writeSnap } from "../lib/graphPrefs";
import { canCollapse, canExpand, collapseAll, expandAll, expandNote, graphSummary } from "../lib/graphView";
import { mappedRefs, mappedSourcesByAsset, mappingsWhat } from "../lib/mappedRefs";

/** One line under the title; the rest of what the canvas can do is in the tip beside it (the same line in the loading branch, so nothing moves when the graph arrives). */
const HINT = "Dashed: discovered. Solid: assets. Drag a group onto an asset or press New asset…";

function HintLine() {
  return (
    <>
      {HINT}{" "}
      <InfoTip label="What can I do on the canvas?">
        <ul className="graph-hint-list">
          <li>Dragging a node takes its open children along. Alt or Option moves it alone.</li>
          <li>Shift-drag selects. Ctrl or Cmd adds.</li>
          <li>Ctrl+K finds while the canvas has focus.</li>
          <li>Right-click or Shift+F10 opens the actions.</li>
          <li>Hovering or selecting lights the path.</li>
          <li>Click empty space or press Escape to clear a selection.</li>
        </ul>
      </InfoTip>
    </>
  );
}

/** Two animation frames: the nodes React Flow was given a moment ago are in its store and drawn. */
const afterPaint = () => new Promise<void>((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve())); });

/** A node's box for the camera: its measured size, else the width of a node and the height of a short one (a node not yet measured). */
const NODE_W = 220;
const NODE_H = 80;
const rectOf = (n: Node): Rect => ({ x: n.position.x, y: n.position.y, w: n.measured?.width ?? NODE_W, h: n.measured?.height ?? NODE_H });

/** The alignment guides while a node is dragged. Visual only; if a measurement ever shows they cost a frame, this is the one switch (the helper and its tests stay). */
const GUIDES_ENABLED = true;
/** How long the node Find jumped to wears its outline. */
const FLASH_MS = 1500;

const SNAP_GRID_XY: [number, number] = [SNAP_GRID, SNAP_GRID];
const NO_IDS: readonly string[] = [];
const selectorId = (id: string) => id.replace(/["\\]/g, "\\$&");

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
  onMenu: (button: HTMLElement) => void; onUnmap: (id: string) => void; onMove: (id: string) => void; onUnmapSource: (id: string, sourceId: number) => void;
  onAdd: (id: string) => void;
};

const NO_MAPPED: ReadonlyMap<number, MappedSource[]> = new Map();

/** The New asset form lists the assets and offers their kinds, so it needs both views as well as the right to make one (the roles editor only offers the pair; the server does not enforce it). */
const NEEDS_FORM = ["assets.edit", "assets.view"] as const;
/** No edge can ever be made by hand: the "+" starts a line only to be released on the empty canvas (`onConnectEnd`), never onto a handle. */
const NEVER_VALID = () => false;

/** What the page's permissions give the nodes (see `nodeData`). `formWait`: the asset list the New asset form needs is not read yet. */
interface NodeGates { canAccept: boolean; canRemove: boolean; canEdit: boolean; canForm: boolean; formWait: boolean }

/** What the page works out about a source once per graph, so a toggle or a drag does not do it again for every node. */
interface SourceFacts { seen: string; groups: number; removable: boolean }

/**
 * The callbacks a node gets in its data (it renders a button only for a callback it has). Sources and clusters toggle and
 * sources open their details;
 * for someone who may accept scan results (`canAccept`), a cluster with something left to map offers both mapping buttons and an
 * unmapped point offers "Map", and a source with at least one group to turn into an asset offers "Create assets" (`facts.groups`, 0 for
 * a role that may not accept). A source offers "Remove" only when it is removable and the person may change the graph (`canRemove`).
 * The conditions mirror what `dropPayload` accepts, so a button is never shown for something that could not be mapped.
 *
 * For a role with assets.edit (`canEdit`), a mapped point and a group with something mapped also get the menu button and the unmap and move
 * callbacks (W12a), and an asset node gets the sources that have mappings on it (`mappedBy`) with the callback that takes all of one source's off.
 *
 * For a role that can make an asset by the form (`canForm`: assets.edit and assets.view) an asset node gets the "+" (`onAdd`) and an unmapped point
 * the menu-only New asset… (`menuNewAsset`); the group's New asset… button is given by `canAccept` alone, as before (what it opens depends on `canForm`).
 */
function nodeData(
  node: Node, { canAccept, canRemove, canEdit, canForm, formWait }: NodeGates, facts: ReadonlyMap<number, SourceFacts>, mappedBy: ReadonlyMap<number, MappedSource[]>,
  { onToggle, onSelect, onMap, onNewAsset, onCreateAssets, onRemove, onMenu, onUnmap, onMove, onUnmapSource, onAdd }: Callbacks,
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
    return {
      ...cluster, onToggle, ...(mappable ? { onMap, onNewAsset, ...(formWait ? { formWait } : {}) } : {}),
      ...(canEdit && cluster.mappedCount > 0 ? { onMenu, onUnmap, onMove } : {}),
    };
  }
  if (node.type === "point") {
    const point = (node.data as PointNodeData).point;
    if (canAccept && point.asset_id === null) return { ...node.data, onMap, ...(canForm ? { menuNewAsset: onNewAsset, ...(formWait ? { formWait } : {}) } : {}) };
    if (canEdit && point.mapping_id !== null) return { ...node.data, onMenu, onUnmap, onMove };
  }
  if (node.type === "asset" && (canEdit || canForm)) {
    const mapped = canEdit ? mappedBy.get((node.data as AssetNodeData).asset.id) : undefined;
    return { ...node.data, ...(mapped ? { mapped, onUnmapSource } : {}), ...(canForm ? { onAdd, ...(formWait ? { formWait } : {}) } : {}) };
  }
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
  const { getIntersectingNodes, getNodes, fitView, setViewport, getViewport, setCenter, getZoom } = useReactFlow();
  const reduced = useReducedMotion(); // the dashes on live edges stop, and the Controls' fit-view button jumps instead of gliding
  const [snap, setSnap] = useState(readSnap);
  const onSnapChange = useCallback((on: boolean) => { setSnap(on); writeSnap(on); }, []);
  const findRef = useRef<{ open(): void } | null>(null);
  const [dragging, setDragging] = useState(false);
  // The alignment guides: where the nodes that do not move with the drag stand (taken once, when it starts), the last dragged node, the one pending frame,
  // and the handle the guides' own component gives back (its state lives there, so a drag frame does not render this page a second time).
  const guides = useRef<AlignGuidesHandle | null>(null);
  const guideOthers = useRef<Rect[]>([]);
  const guideNode = useRef<Node | null>(null);
  const guideFrame = useRef(0);
  // The node Find has just jumped to wears the class `flash` (through its `className`, so React Flow keeps it when it rewrites the node's classes), and the timer that takes it away.
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  const fitOptions = useMemo(() => ({ duration: cameraMs(reduced) }), [reduced]);
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

  // ---- New asset (W12a): the real asset form, made for a role that has it (assets.edit and assets.view) ----
  const canForm = meets(NEEDS_FORM, can);
  const assetList = useAssets(canForm); // the form's Parent list: every asset in full (the graph's own list carries only id, parent, name and kind)
  const createAsset = useCreateAsset({ also: [keys.graph, keys.auditAll] }); // the Assets page's own save, then the graph is read again
  // `payload`: the group or point whose Review opens on the new asset once it is saved (none for the pane's and an asset's New asset: they only create).
  const [newAsset, setNewAsset] = useState<{ key: number; name?: string; parentId: number | null; payload?: DropPayload } | null>(null);
  const newAssetCount = useRef(0);
  const formWait = canForm && assetList.data === undefined;
  // What openNewAsset reads when it is called, through a ref: the callbacks below sit in the memo that builds every node, so they must not change with it.
  const formState = useRef({ ready: false, failed: false });
  formState.current = { ready: assetList.data !== undefined, failed: assetList.isError };
  const openNewAsset = useCallback((from: { name?: string; parentId: number | null; payload?: DropPayload }) => {
    if (!formState.current.ready) {
      // The items that lead here say aria-disabled while this is so; a click that gets through (a button keeps taking it) is told why nothing opened.
      toast.info(formState.current.failed
        ? "The asset list could not be read, so a new asset cannot be made now. Refresh and try again."
        : "Still reading the asset list. Try again in a moment.");
      return;
    }
    setOffer(null);
    setNewAsset({ key: ++newAssetCount.current, ...from });
  }, [toast]);
  /** A group's or a point's New asset… (its button, its menu item, the offer): the form first for a role that has it, then the Review on the new asset; else the Review's own "New asset" choice. */
  const newAssetFor = useCallback((payload: DropPayload) => {
    if (canForm) openNewAsset({ name: payload.label, parentId: null, payload });
    else openReview(payload, { kind: "new", name: payload.label, parentId: null });
  }, [canForm, openNewAsset, openReview]);
  const onNewAsset = useCallback((id: string) => {
    const payload = dropPayload(model, id);
    if (payload) newAssetFor(payload);
  }, [model, newAssetFor]);
  /** The "+" and the asset's New sub-asset…: the node's own id names the parent. */
  const onAdd = useCallback((id: string) => {
    const parentId = pickDropTarget([{ id }]);
    if (parentId !== null) openNewAsset({ parentId });
  }, [openNewAsset]);
  /**
   * A line dragged from an asset's "+" and let go on the empty canvas: New sub-asset under that asset. Only the "+" (handle `add`) and only the pane count: a release
   * over a node or a control does nothing, and no connection is ever made (`isValidConnection`). Touch has no drag here: a finger's end event is aimed at the element
   * the touch began on, never at the pane, so the tap on the "+" and the node's menu do the same job there.
   */
  const onConnectEnd: OnConnectEnd = useCallback((event, state) => {
    if (state.fromHandle?.id !== "add") return;
    if (!(event.target as Element | null)?.closest?.(".react-flow__pane")) return;
    const parentId = state.fromNode ? pickDropTarget([state.fromNode]) : null;
    if (parentId !== null) openNewAsset({ parentId });
  }, [openNewAsset]);

  const canvas = useRef<HTMLDivElement>(null);
  // The right-click menu's state is up here because a mapped node's own menu button opens it (`onMenu`), and the nodes are built below.
  const { menu, openNode, openPane, openSelection, openFromKey, close: closeMenu } = useCanvasMenu({ model, canvas });
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

  // What the camera and the toggles read after an await, when a render may have come in meanwhile: the model of the moment, whether the page is still
  // there, and which sources are open (so a source's own button knows whether it OPENS the source).
  const modelRef = useRef(model);
  useEffect(() => { modelRef.current = model; }, [model]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const openNow = useRef(open);
  useEffect(() => { openNow.current = open; }, [open]);

  /**
   * After a source has opened: pan, never zoom, just enough to bring the source and its groups inside the canvas with a margin. Waits until the new
   * nodes are in React Flow's store; does nothing when they are already in view. Only the source's own button and the menu's Expand ask for this
   * (through `onToggle`): Expand all and Find move the camera themselves, and two animations would fight.
   */
  const panToOpened = useCallback(async (id: string) => {
    await afterPaint();
    const area = canvas.current;
    if (!mounted.current || !area) return;
    const wanted = new Set([id, ...childNodeIds(modelRef.current, id)]);
    const box = unionRect(getNodes().filter((n) => wanted.has(n.id)).map(rectOf));
    if (!box) return;
    const view = getViewport();
    const to = keepInView(box, view, { w: area.clientWidth, h: area.clientHeight });
    if (to) void setViewport({ ...view, ...to }, { duration: cameraMs(reducedMotion()) });
  }, [getNodes, getViewport, setViewport]);

  const onToggle = useCallback((id: string) => {
    if (id.startsWith("src:")) {
      const sourceId = Number(id.slice("src:".length));
      const opens = !openNow.current.sources.has(sourceId);
      setOpen((prev) => ({ ...prev, sources: toggled(prev.sources, sourceId) }));
      if (opens) void panToOpened(id);
    } else {
      setOpen((prev) => ({ ...prev, clusters: toggled(prev.clusters, id) }));
    }
  }, [panToOpened]);

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

  // ---- Unmap and move (W12a): the module's confirmation, Move dialog, toasts and Undo; the page names the mappings and where the focus goes afterwards ----
  const kinds = useAssetKinds(can("assets.view")).data; // for the note about a room or a hall (the Move dialog's and the Review's)
  const maps = useMappingActions({ assets: model.assets, kinds, takenFor: (assetId) => takenMetrics(model, assetId) });
  // The hook's object is new on every render and the node callbacks below must not be (they sit in the memo that builds every node), so they reach it through a ref.
  const mapsRef = useRef(maps);
  mapsRef.current = maps;
  const canEditAssets = maps.canEdit;
  const mappedBy = useMemo(() => (canEditAssets ? mappedSourcesByAsset(model) : NO_MAPPED), [model, canEditAssets]);
  /**
   * After an unmap or a move, once the lists are read again: the focus goes to the node the action was about (the button or menu that opened it has
   * closed, and a point that is unmapped has no menu button any more), else to the main area when the node has gone.
   */
  const focusNode = useCallback(async (id: string) => {
    await afterPaint(); // the refreshed nodes are in React Flow's store and drawn
    if (!mounted.current) return;
    const element = canvas.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${selectorId(id)}"]`);
    (element ?? document.getElementById("main"))?.focus({ preventScroll: true });
  }, []);
  const onMenu = useCallback((button: HTMLElement) => openFromKey(button), [openFromKey]);
  const onUnmap = useCallback((id: string) => {
    mapsRef.current.unmap(mappedRefs(model, id), { what: mappingsWhat(model, id), after: () => void focusNode(id) });
  }, [model, focusNode]);
  const onMove = useCallback((id: string) => {
    mapsRef.current.move(mappedRefs(model, id), { what: mappingsWhat(model, id), after: () => void focusNode(id) });
  }, [model, focusNode]);
  const onUnmapSource = useCallback((id: string, sourceId: number) => {
    mapsRef.current.unmap(mappedRefs(model, id, sourceId), { what: mappingsWhat(model, id, sourceId), after: () => void focusNode(id) });
  }, [model, focusNode]);
  /**
   * The New asset form saved an asset. A pane's or an asset's New asset ends here; a group's or a point's goes on to the Review on the new asset. `create` has
   * already waited for the graph to be read again, but React draws that read a moment later, and the Review lists its assets from the model it is given: so
   * wait for the paint, then look in the model of the moment. If the asset is not there (the refresh failed) the person is told and the asset stays.
   */
  const onNewAssetCreated = async (asset: Asset) => {
    const payload = newAsset?.payload;
    setNewAsset(null);
    if (!payload) return;
    await afterPaint();
    if (!mounted.current) return;
    if (modelRef.current.assets.some((a) => a.id === asset.id)) openReview(payload, { kind: "existing", assetId: asset.id });
    else toast.error("The asset was created, but the graph could not be refreshed. Use Map… to map to it.");
  };

  const seeded = useMemo(() => {
    const built = buildGraph(model, open, { moved: moved.current, ignoreSaved: tidyRuns > 0, animate: !reduced });
    const nodes: Node[] = built.nodes.map((n) => ({
      ...n,
      data: nodeData(n, { canAccept, canRemove, canEdit: canEditAssets, canForm, formWait }, facts, mappedBy, {
        onToggle, onSelect, onMap, onNewAsset, onCreateAssets, onRemove, onMenu, onUnmap, onMove, onUnmapSource, onAdd,
      }),
    }));
    return { nodes, edges: built.edges };
  }, [model, open, tidyRuns, reduced, canAccept, canRemove, canEditAssets, canForm, formWait, facts, mappedBy, onToggle, onSelect, onMap, onNewAsset, onCreateAssets, onRemove, onMenu, onUnmap, onMove, onUnmapSource, onAdd]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(seeded.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(seeded.edges);
  useEffect(() => {
    // New node objects carry no size, which would hide every node until React Flow measures them again: keep what it knows. A selection (a box drawn
    // with Shift, a Ctrl-click) must also outlive a rebuild: an expand, a collapse or a refresh keeps the nodes that are still there selected.
    setNodes((current) => {
      const known = new Map(current.map((n) => [n.id, n]));
      return seeded.nodes.map((n) => {
        const was = known.get(n.id);
        if (!was || (!was.measured && !was.selected)) return n;
        return { ...n, ...(was.measured ? { measured: was.measured } : {}), ...(was.selected ? { selected: true } : {}) };
      });
    });
    setEdges(seeded.edges);
  }, [seeded, setNodes, setEdges]);

  // The path highlight: hovering, keyboard focus or a selection lights the node's whole path (only the path's nodes and edges become new objects; the
  // wrapper's `has-focus` class dims the rest). The CURRENT nodes and edges of each rebuild go in, so it forgets a node that has gone. Not while dragging.
  const selectedIds = useMemo(() => (dragging ? NO_IDS : nodes.filter((n) => n.selected).map((n) => n.id)), [nodes, dragging]);
  const { shownNodes, shownEdges, active: dimming, handlers: highlight } = useGraphHighlight({ nodes, edges, selectedIds, dragging });
  // The node Find has just jumped to wears the class `flash`: set through its className (a class added to the element itself would be lost the next time
  // React Flow rewrites the node's classes, e.g. when the focus lights its path). One new object, made after the highlight's own, so `lit flash` sit together.
  const flashed = useMemo(
    () => (flashId === null ? shownNodes : shownNodes.map((n) => (n.id === flashId ? { ...n, className: n.className ? `${n.className} flash` : "flash" } : n))),
    [shownNodes, flashId],
  );

  /** One snapshot per drag. A node takes its OPEN children along unless Alt (Option) is held; the places of the hidden ones are shifted at the drop. */
  const onNodeDragStart: OnNodeDrag<Node> = useCallback((event, _node, dragged) => {
    const draggedIds = new Set(dragged.map((n) => n.id));
    const everyone = getNodes();
    const live = new Map(everyone.map((n) => [n.id, n.position]));
    const alone = event.altKey;
    const below = new Set<string>();
    if (!alone) for (const n of dragged) for (const id of descendantNodeIds(model, n.id)) if (!draggedIds.has(id)) below.add(id);
    const followers = new Set([...below].filter((id) => live.has(id)));
    // What the guides line up with: every node that stands still during this drag. Not the dragged ones (the other nodes of a selection included) and
    // not their followers, which move with them: each would line up with itself on every frame.
    if (GUIDES_ENABLED) guideOthers.current = everyone.filter((n) => !draggedIds.has(n.id) && !followers.has(n.id)).map(rectOf);
    const pins = alone ? [...new Set(dragged.flatMap((n) => childNodeIds(model, n.id)))].filter((id) => !draggedIds.has(id) && live.has(id)) : [];
    const starts = new Map<string, XY>(dragged.map((n) => [n.id, { x: n.position.x, y: n.position.y }]));
    for (const id of [...followers, ...pins]) starts.set(id, { ...live.get(id)! });
    drag.current = { alone, starts, followers, below: [...below], pins, own: ownPlaces(model, { moved: moved.current, ignoreSaved: tidyRuns > 0 }) };
    setOffer(null);
    setDragging(true);
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
  /** At most once per animation frame, from the last position the drag reported. */
  const drawGuides = useCallback(() => {
    guideFrame.current = 0;
    const dragged = guideNode.current;
    if (dragged) guides.current?.set(alignGuides(rectOf(dragged), guideOthers.current));
  }, []);
  const stopGuides = useCallback(() => {
    if (guideFrame.current) cancelAnimationFrame(guideFrame.current);
    guideFrame.current = 0;
    guideNode.current = null;
    guideOthers.current = [];
    guides.current?.set(null);
  }, []);
  const onNodeDrag: OnNodeDrag<Node> = useCallback((_event, node) => {
    if (drag.current) placeFollowers(drag.current, node);
    if (GUIDES_ENABLED) {
      guideNode.current = node;
      if (!guideFrame.current) guideFrame.current = requestAnimationFrame(drawGuides);
    }
  }, [placeFollowers, drawGuides]);

  const onNodeDragStop: OnNodeDrag<Node> = useCallback((_event, node, dragged) => {
    stopGuides(); // a frame still pending must not draw after the drop
    const snapshot = drag.current;
    drag.current = null;
    setDragging(false);
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
    } else if (canAccept) {
      // Several nodes dragged together (a selection): when they are all unmapped points of one source and the node under the pointer lands on an asset, that is one request
      // to map them all, so every dragged node goes back as above. A refusal (a mapped point, two sources) is told in a toast and the nodes go back too; anything else
      // (not over an asset, not all points) is the plain move it has always been.
      const multi = multiPointDrop(model, dragged.map((n) => n.id));
      const assetId = multi ? pickDropTarget(getIntersectingNodes(node)) : null;
      if (multi && assetId !== null) {
        const back = snapshot?.starts;
        if (back) setNodes((current) => current.map((n) => { const at = back.get(n.id); return at ? { ...n, position: at } : n; }));
        if ("payload" in multi) openReview(multi.payload, { kind: "existing", assetId });
        else toast.info(multi.refusal);
        return;
      }
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
  }, [canAccept, canLayout, model, getIntersectingNodes, setNodes, placeFollowers, openReview, toast, run, enqueue, stopGuides]);

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
  const tidyLayout = useTidyLayout({
    // Right after the route has answered, before the graph is read again: the old layout (this session's drags and the saved places) never shows.
    onDeleted: () => { moved.current.clear(); setTidyRuns((n) => n + 1); },
  });
  const refit = useCallback(async () => {
    await afterPaint(); // the rebuilt nodes are in React Flow's store
    if (!mounted.current) return; // the person left the page meanwhile
    // The opening rules (W7r), as if no place were saved; the camera glides there (at once under reduced motion).
    void fitView({ ...initialView({ ...modelRef.current, layout: {} }), duration: cameraMs(reducedMotion()) });
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

  // ---- Find (Ctrl+K on the canvas), the right-click menus and the canvas's keys ----
  const findIndex = useMemo(() => buildFindIndex(model), [model]);
  const search = useCallback((query: string) => findMatches(findIndex, query), [findIndex]);
  const openFind = useCallback(() => findRef.current?.open(), []);
  useEffect(() => () => {
    // The page goes away: no frame, no outline timer left behind.
    if (guideFrame.current) cancelAnimationFrame(guideFrame.current);
    window.clearTimeout(flashTimer.current);
  }, []);

  /**
   * A choice in the Find card (it has closed and the focus is back where it was): open what hides the node, say so when the budget kept something closed,
   * glide there, flash the node and hand it the focus. The focus comes LAST, once the glide is over: React Flow's own focus handler centres a node that is
   * off screen with no animation, which would cut the glide short and lose the zoom.
   */
  const onFind = useCallback(async (entry: FindEntry) => {
    const plan = findPlan(modelRef.current, openNow.current, entry); // the model and the open set of the moment: a refresh may have come in while the card was open
    if (plan.open !== openNow.current) setOpen(plan.open); // the very same object when nothing has to open: no rebuild
    if (plan.note) toast.info(plan.note);
    await afterPaint(); // the nodes just opened are in React Flow's store
    if (!mounted.current) return;
    const target = getNodes().find((n) => n.id === plan.targetId);
    if (!target) return; // the graph was read again meanwhile and the node is gone
    const { x, y, w, h } = rectOf(target);
    await setCenter(x + w / 2, y + h / 2, { zoom: Math.min(1, Math.max(0.75, getZoom())), duration: cameraMs(reducedMotion()) });
    if (!mounted.current) return;
    const element = canvas.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${selectorId(plan.targetId)}"]`);
    if (!element) return;
    window.clearTimeout(flashTimer.current);
    setFlashId(plan.targetId); // (the outline holds under reduced motion too; the CSS drops only the pulse)
    flashTimer.current = window.setTimeout(() => setFlashId(null), FLASH_MS);
    element.focus({ preventScroll: true });
  }, [toast, getNodes, getZoom, setCenter]);

  const clearSelection = useCallback(() => {
    setNodes((current) => (current.some((n) => n.selected) ? current.map((n) => (n.selected ? { ...n, selected: false } : n)) : current));
  }, [setNodes]);
  const canvasKeys = useCanvasKeys({ canvas, openFind, openMenuFor: openFromKey, onEscape: clearSelection });

  // The menu's items come from the node's own callbacks (the ones its buttons use), so a role sees exactly the actions it has buttons for.
  const nodeActions = (node: Node): RowAction[] => {
    const d = node.data as NodeActions & Pick<AssetNodeData, "mapped" | "onUnmapSource"> & { expanded?: boolean };
    const group = node.type === "cluster";
    const items: RowAction[] = [];
    if (d.onSelect) items.push({ label: "Details", onSelect: () => d.onSelect?.(node.id) });
    if (d.onToggle) items.push({ label: d.expanded ? "Collapse" : "Expand", onSelect: () => d.onToggle?.(node.id) });
    if (d.onCreateAssets) items.push({ label: "Create assets…", onSelect: () => d.onCreateAssets?.(node.id) });
    if (d.onMap) items.push({ label: "Map…", onSelect: () => d.onMap?.(node.id) });
    // The three that open the asset form wait for the asset list (`formWait`: aria-disabled, skipped by the keys).
    if (d.onNewAsset) items.push({ label: "New asset…", disabled: d.formWait, onSelect: () => d.onNewAsset?.(node.id) });
    if (d.menuNewAsset) items.push({ label: "New asset…", disabled: d.formWait, onSelect: () => d.menuNewAsset?.(node.id) }); // an unmapped point: its menu only
    if (d.onAdd) items.push({ label: "New sub-asset…", disabled: d.formWait, onSelect: () => d.onAdd?.(node.id) });
    if (d.onRemove) items.push({ label: "Remove", tone: "danger", onSelect: () => d.onRemove?.(node.id) });
    // W12a, after the rest: what takes a mapping off an asset or moves it (only with assets.edit: the callbacks are not given otherwise).
    if (d.onUnmap) items.push({ label: group ? "Unmap this group…" : "Unmap…", tone: "danger", onSelect: () => d.onUnmap?.(node.id) });
    if (d.onMove) items.push({ label: group ? "Move this group's mappings…" : "Move to another asset…", onSelect: () => d.onMove?.(node.id) });
    for (const m of d.mapped ?? []) items.push({ label: `Unmap everything from ${m.sourceName}…`, tone: "danger", onSelect: () => d.onUnmapSource?.(node.id, m.sourceId) });
    return items;
  };
  const nodeName = (node: Node): string => {
    const d = node.data as Partial<SourceNodeData & ClusterNodeData & PointNodeData & AssetNodeData>;
    return d.source?.name ?? d.label ?? d.point?.name ?? d.asset?.name ?? "this node";
  };
  /** The same four actions as the bar above the canvas (a button with nothing to do is aria-disabled there and here) and the Controls' fit-view button. */
  const canvasActions = (): RowAction[] => [
    { label: "Expand all", disabled: !expandable, onSelect: onExpandAll },
    { label: "Collapse all", disabled: !collapsible, onSelect: onCollapseAll },
    { label: "Tidy layout", disabled: tidying, onSelect: () => void onTidy() },
    { label: "Fit view", onSelect: () => void fitView({ duration: cameraMs(reducedMotion()) }) },
  ];
  // A node with no actions of its own (an asset with nothing mapped on it, an unidentified service) and a box selection get the canvas's menu.
  let menuItems: RowAction[] = [];
  let menuLabel = "Canvas actions";
  if (menu) {
    const aimed = menu.target;
    const node = aimed.kind === "node" ? nodes.find((n) => n.id === aimed.id) : undefined;
    const own = node ? nodeActions(node) : [];
    if (node && own.length > 0) {
      menuItems = own;
      menuLabel = `Actions for ${nodeName(node)}`;
    } else {
      menuItems = canvasActions();
      // The empty canvas (not a node with nothing of its own, not a selection) can also make an asset, at the top level, with nothing to map after it.
      if (canForm && aimed.kind === "pane") menuItems.push({ label: "New asset…", disabled: formWait, onSelect: () => openNewAsset({ parentId: null }) });
    }
  }

  return (
    <>
      <PageHeader
        title="Discovery"
        sub={<HintLine />}
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
        {/* tabIndex -1: a click on the empty canvas puts the focus here (no ring for a mouse), so the canvas's own keys work after it. `has-focus` dims everything off the lit path. */}
        <div
          className={dimming ? "graph-canvas has-focus" : "graph-canvas"}
          ref={canvas}
          tabIndex={-1}
          role="group" // named, because it is a focus target (a pane click, and the return of Escape from a menu or from Find): a screen reader says "Discovery graph", not the whole canvas text
          aria-label="Discovery graph"
          onFocus={highlight.onFocus}
          onBlur={highlight.onBlur}
          onKeyDown={canvasKeys.onKeyDown}
        >
          <ReactFlow
            nodes={flashed}
            edges={shownEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_event, node) => { if (node.type === "source") setSelectedId((node.data as SourceNodeData).source.id); }}
            onNodeMouseEnter={highlight.onNodeMouseEnter}
            onNodeMouseLeave={highlight.onNodeMouseLeave}
            onNodeContextMenu={(event, node) => openNode(node.id, event)}
            onPaneContextMenu={openPane}
            onSelectionContextMenu={openSelection} // while a box selection stands, its rectangle takes the right-click that would reach a node
            onMoveStart={closeMenu} // the menu is placed at a point of the screen: the canvas moving under it closes it
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            colorMode={dark ? "dark" : "light"}
            nodesConnectable={canForm} // the connection line is drawn only with this: the "+" of an asset node is the one handle that can start one
            isValidConnection={NEVER_VALID} // ...and it never makes an edge; letting go on the empty canvas is read by onConnectEnd
            connectionLineComponent={AddConnectionLine}
            onConnectEnd={onConnectEnd}
            nodesDraggable={!tidying} // a drag while Tidy runs would put the old places back after the wipe, for everyone
            snapToGrid={snap}
            snapGrid={SNAP_GRID_XY}
            selectionKeyCode="Shift" // Shift-drag draws a selection box; Ctrl or Cmd (the library's multi-select key) is left at its default: a Ctrl-click is a right-click on a Mac
            edgesFocusable={false} // an edge is a Tab stop with no visible ring; the nodes stay focusable
            deleteKeyCode={null}
            fitView
            fitViewOptions={opening}
            minZoom={0.2} // the opening view holds 0.75 through fitViewOptions; this floor is what lets Fit View (and the wheel) show a tall graph whole
          >
            <Controls fitViewOptions={fitOptions} />
            <Background />
            <GraphMiniMap />
            {GUIDES_ENABLED && <AlignGuides handleRef={guides} />}
            <CanvasTools search={search} onChoose={onFind} snap={snap} onSnapChange={onSnapChange} openRef={findRef} />
          </ReactFlow>
          {canAccept && offer && (
            <div className="offer-bar" role="status">
              <span>{`Create asset "${offer.label}" from this cluster?`}</span>
              <button className="primary" onClick={() => {
                const payload = dropPayload(model, offer.nodeId);
                if (payload) newAssetFor(payload);
                else setOffer(null);
              }}>Create asset…</button>
              <button className="quiet" onClick={() => setOffer(null)}>Dismiss</button>
            </div>
          )}
        </div>
        {selected && <SourcePanel key={selected.id} source={selected} canEdit={canEditSource} seen={facts.get(selected.id)?.seen ?? ""} onClose={closePanel} />}
      </div>
      {canAccept && review && (
        <ReviewDialog key={review.key} model={model} payload={review.payload} initialTarget={review.initialTarget} kinds={kinds} onMapped={maps.mappedToast} onClose={closeReview} />
      )}
      {canAccept && createFor && <BulkCreateDialog model={model} source={createFor} onMapped={maps.mappedToast} onClose={closeCreate} />}
      {/* Beside the Review and outside the canvas, like it: the form's keys and focus must not reach the canvas's handlers. */}
      {canForm && newAsset && assetList.data && (
        <NewAssetDialog
          key={newAsset.key} assets={assetList.data} kinds={kinds ?? []} name={newAsset.name} parentId={newAsset.parentId} continues={newAsset.payload !== undefined}
          canRegister={can("assets.kinds")} create={createAsset} onCreated={(asset) => void onNewAssetCreated(asset)} onCancel={() => setNewAsset(null)}
        />
      )}
      {askDialog}
      {maps.dialogs}
      {/* Outside the canvas on purpose: React passes the events of a portal up to its parents, and the canvas's focus and key handlers must not hear the menu. */}
      {menu && <GraphContextMenu key={menu.id} at={menu.at} items={menuItems} label={menuLabel} returnFocus={menu.returnFocus} onClose={closeMenu} />}
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
        <PageHeader title="Discovery" sub={<HintLine />} actions={<LoadingActions withClear={can("discovery.edit")} />} />
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
