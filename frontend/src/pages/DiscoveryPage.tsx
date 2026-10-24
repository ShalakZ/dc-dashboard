import {
  Background, Controls, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Edge, type Node, type NodeMouseHandler, type OnConnectEnd, type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FocusEvent } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api/client";
import { keys, useAssetKinds, useAssets, useGraph, useInvalidate, useRemoveDiscoveredSources, useSite, useTidyLayout } from "../api/queries";
import type { Asset, GraphModel, GraphSource } from "../api/types";
import { useAppearance } from "../auth/AppearanceProvider";
import { useAuth } from "../auth/AuthProvider";
import { meets } from "../auth/need";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { PAGE_NEED } from "../components/navItems";
import { AlignGuides, type AlignGuidesHandle } from "../components/graph/AlignGuides";
import { BulkCreateDialog } from "../components/graph/BulkCreateDialog";
import { CanvasTools } from "../components/graph/CanvasTools";
import { GraphBar } from "../components/graph/GraphBar";
import { GraphContextMenu } from "../components/graph/GraphContextMenu";
import { GraphMiniMap } from "../components/graph/GraphMiniMap";
import { MoveSourceDialog } from "../components/MoveSourceDialog";
import { NewAssetDialog } from "../components/graph/NewAssetDialog";
import { AddConnectionLine, nodeTypes } from "../components/graph/nodes";
import { PointValueTip } from "../components/graph/PointValueTip";
import { ReviewDialog, type InitialTarget } from "../components/graph/ReviewDialog";
import { ShortcutsBubble } from "../components/graph/ShortcutsBubble";
import { SourcePanel } from "../components/graph/SourcePanel";
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
import { useGraphNav } from "../hooks/useGraphNav";
import { useMappingActions, type MappedInfo } from "../hooks/useMappingActions";
import { useMovedToast } from "../hooks/useMovedToast";
import { reducedMotion, useReducedMotion } from "../hooks/useReducedMotion";
import { useValueTip } from "../hooks/useValueTip";
import { afterPaint, framesUntil } from "../lib/afterPaint";
import { dropPayload, mappableClusters, multiPointDrop, pickDropTarget, takenMetrics, type DropPayload } from "../lib/drop";
import {
  ASSET_PAGE, buildGraph, childNodeIds, descendantNodeIds, drawnCount, groupsOf, initialView, isNotSeen, isOfferable, isRemovable, layoutBatches, looksLikeSentence, moreNodeIds, moveOfferFor, nodeId, notSeenCount, ownPlaces,
  PAGE_SIZE, pruneAssetsShown, pruneShown, removableNotSeen, removalDialogText, removalOutcome, seenLine, shiftedPlaces, sourceIdOfNode, visiblePoints,
  type AssetNodeData, type ClusterNodeData, type Group, type GraphView, type MappedSource, type NodeActions, type OpenState, type PointNodeData, type SourceNodeData, type XY,
} from "../lib/graph";
import { cameraMs, keepInView, overlayMargin, unionRect } from "../lib/graphCamera";
import { buildFindIndex, extendPagesFor, findMatches, findPlan, tooFarNote, type FindEntry, type ShapesTarget } from "../lib/graphFind";
import { alignGuides, type Rect } from "../lib/graphGuides";
import { navIndex } from "../lib/graphNav";
import {
  readAssetsClosed, readSnap, readUnmappedOnly, SNAP_GRID, writeAssetsClosed, writeSnap, writeUnmappedOnly,
} from "../lib/graphPrefs";
import { reuseEdges, reuseNodes } from "../lib/graphReuse";
import {
  canCollapse, canExpand, changeNote, collapseAll, collapseTargets, EXPAND_NODE_BUDGET, expandAll, expandNote, expandTargets, graphCounts, graphSummary, groupsOverBudget, selectionStates,
  tooManyGroupsNote, type Change,
} from "../lib/graphView";
import { mappedRefs, mappedSourcesByAsset, mappingsWhat } from "../lib/mappedRefs";
import { shapesPageLink } from "../lib/shapes";
import { formatOfflineSince } from "../lib/sourceStatus";

/**
 * The one sentence under the title, the same in all three states of the page (loading, empty, loaded) so the header never changes height. The rest of what the
 * canvas can do is in the shortcuts bubble beside the bar's other page controls.
 */
const SUB = "Dashed means discovered, solid means assets. Drag a group onto an asset to map it.";

/** A node's box for the camera: its measured size, else the width of a node and the height of a short one (a node not yet measured). */
const NODE_W = 220;
const NODE_H = 80;
const rectOf = (n: Node): Rect => ({ x: n.position.x, y: n.position.y, w: n.measured?.width ?? NODE_W, h: n.measured?.height ?? NODE_H });
/** A new node is `visibility: hidden` until React Flow has measured it, and a hidden element cannot take the focus: a jump waits for the measure, at most this many frames. */
const MEASURE_FRAMES = 10;
const FRAME_MS = 16;
const isMeasured = (n: Node) => n.measured?.width !== undefined && n.measured?.height !== undefined;
/**
 * The margin a jump keeps a node away from the canvas's edges: the minimap (bottom right) and the tools panel (top right) are drawn OVER the canvas, so the
 * plain 40 px would park the node under them. Measured when the jump is made (the panel grows with its card, the minimap is hidden on a small window).
 */
const overlayMarginOf = (area: HTMLElement) => overlayMargin(
  area.getBoundingClientRect(), area.querySelector(".graph-minimap")?.getBoundingClientRect() ?? null, area.querySelector(".graph-tools")?.getBoundingClientRect() ?? null,
);
const nap =(ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });
/**
 * What a screen reader is told when a node takes the focus. The library's own sentence says Enter or Space selects it and the arrows move a SELECTED node, which
 * is no longer all there is to say here. Module level, so the prop keeps its identity.
 */
const ARIA_TEXT = "Arrow keys move between nodes. Enter opens or closes. Space selects.";
const ARIA_LABELS = { "node.a11yDescription.default": ARIA_TEXT, "node.a11yDescription.keyboardDisabled": ARIA_TEXT }; // the library picks one of the two by whether a node can be moved: both say the same

/** The alignment guides while a node is dragged. Visual only; if a measurement ever shows they cost a frame, this is the one switch (the helper and its tests stay). */
const GUIDES_ENABLED = true;
/** How long the node Find jumped to wears its outline. */
const FLASH_MS = 1500;

const SNAP_GRID_XY: [number, number] = [SNAP_GRID, SNAP_GRID];
const NO_IDS: readonly string[] = [];
const selectorId = (id: string) => id.replace(/["\\]/g, "\\$&");
/**
 * What takes the focus for a node: its wrapper, or, for the "show more" node of a group and the summary of an asset's sub-assets (w37; their wrappers are not a stop), its button.
 * Null when the node is not on the canvas.
 */
function focusTargetOf(root: HTMLElement | null, id: string): HTMLElement | null {
  const wrapper = root?.querySelector<HTMLElement>(`.react-flow__node[data-id="${selectorId(id)}"]`) ?? null;
  return id.startsWith("more:") ? wrapper?.querySelector<HTMLElement>(".gnode-more button, .gnode-more-assets button") ?? null : wrapper;
}

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
  onCreateAssets: (id: string) => void; onRemove: (id: string) => void; onMoveSource: (id: string) => void;
  /** (w36) Map by shape on a large source's card: opens `/sources/:id/shapes`. */
  onShapes: (id: string) => void;
  onMenu: (button: HTMLElement) => void; onUnmap: (id: string) => void; onMove: (id: string) => void; onUnmapSource: (id: string, sourceId: number) => void;
  onAdd: (id: string) => void;
  /** W12b: the `more` node's button, and the fold of an asset's sub-assets (the latter is given to every role). */
  onMore: (clusterId: string) => void; onToggleAssets: (id: string) => void;
  /** (w37) The summary node's Show 50: draws the next page of an asset's sub-assets (given to every role: it only changes the view). */
  onMoreAssets: (summaryId: string) => void;
};

/** The group a group node stands for. A group key may hold colons, so the id is matched whole, group by group. */
function groupOfNode(model: GraphModel, clusterId: string): Group | undefined {
  for (const source of model.sources) {
    if (!clusterId.startsWith(`cluster:${source.id}:`)) continue;
    const group = groupsOf(source).find((g) => nodeId.cluster(source.id, g.key) === clusterId);
    if (group) return group;
  }
  return undefined;
}

/** The mapping a point node stands for: null for any other node and for a point that is not mapped (nothing to show a value of). */
const mappingOf = (node: Pick<Node, "type" | "data">): number | null =>
  node.type === "point" ? (node.data as PointNodeData).point.mapping_id : null;

/** The highlight's own rule (`useGraphHighlight`) for "the keyboard put the focus here": a click on a node's button is not it. A browser that cannot answer says no. */
function keyboardFocus(target: Element): boolean {
  try {
    return target.matches(":focus-visible");
  } catch {
    return false;
  }
}

const NO_MAPPED: ReadonlyMap<number, MappedSource[]> = new Map();

/** The New asset form lists the assets and offers their kinds, so it needs both views as well as the right to make one (the roles editor only offers the pair; the server does not enforce it). */
const NEEDS_FORM = ["assets.edit", "assets.view"] as const;
/** No edge can ever be made by hand: the "+" starts a line only to be released on the empty canvas (`onConnectEnd`), never onto a handle. */
const NEVER_VALID = () => false;

/** What the page's permissions give the nodes (see `nodeData`). `formWait`: the asset list the New asset form needs is not read yet. */
/**
 * `canMove`: sources.edit, the right to move an old source to the address where a scan found its device (w33): the Move... button of a new source that has an offer.
 * `canShapes` (w36): the page's whole need, `meets(PAGE_NEED.sourceShapes, can)`: the Map by shape button of a large source.
 */
interface NodeGates { canAccept: boolean; canRemove: boolean; canEdit: boolean; canForm: boolean; formWait: boolean; canMove: boolean; canShapes: boolean }

/** What the page works out about a source once per graph, so a toggle or a drag does not do it again for every node. */
interface SourceFacts { seen: string; groups: number; removable: boolean; looks?: string }

/** (w33) The whole sentence of a source's move offer, with the time it stopped answering written in the site's zone (the zone is the page's); undefined without an offer. */
function looksOf(source: GraphSource, siteZone: string | undefined): string | undefined {
  const offer = moveOfferFor(source);
  if (!offer) return undefined;
  return looksLikeSentence(offer, offer.from_since && siteZone ? formatOfflineSince(offer.from_since, siteZone) : null);
}

/**
 * The callbacks a node gets in its data (it renders a button only for a callback it has). Sources and clusters toggle and
 * sources open their details;
 * for someone who may accept scan results (`canAccept`), a cluster with something left to map offers both mapping buttons and an
 * unmapped point offers "Map", and a source with at least one group to turn into an asset gets "Create assets" (`facts.groups`, 0 for
 * a role that may not accept). A source gets "Remove" only when it is removable and the person may change the graph (`canRemove`).
 * The conditions mirror what `dropPayload` accepts, so a button is never shown for something that could not be mapped.
 *
 * W12c: a source node draws neither of those two; they are items of its menu, so a source gets the callback `onMenu` (the Source actions button) exactly when it has
 * at least one of them.
 *
 * For a role with assets.edit (`canEdit`), a mapped point and a group with something mapped also get the menu button and the unmap and move
 * callbacks (W12a), and an asset node gets the sources that have mappings on it (`mappedBy`) with the callback that takes all of one source's off.
 *
 * For a role that can make an asset by the form (`canForm`: assets.edit and assets.view) an asset node gets the "+" (`onAdd`) and an unmapped point
 * the menu-only New asset… (`menuNewAsset`); the group's New asset… button is given by `canAccept` alone, as before (what it opens depends on `canForm`).
 *
 * (w33) A source that has an offer (`moveOfferFor`) gets `onMoveSource` for a person with sources.edit (`canMove`): the Move... button beside Details.
 * (w36) A source with `large` (the server's field, never a count of ours) gets `onShapes` for a person who meets the shapes page's need (`canShapes`): the Map by shape button beside them.
 *
 * W12b: the `more` node gets `onMore` and EVERY asset node gets `onToggleAssets` (the fold only changes the view, so no permission is needed; the node draws
 * the button only when the asset has sub-assets).
 * (w37) The summary of an asset's sub-assets (`moreAssets`) gets `onMoreAssets`, to every role for the same reason; it has no other action (a right-click on it is the canvas's menu).
 */
function nodeData(
  node: Node, { canAccept, canRemove, canEdit, canForm, formWait, canMove, canShapes }: NodeGates, facts: ReadonlyMap<number, SourceFacts>, mappedBy: ReadonlyMap<number, MappedSource[]>,
  { onToggle, onSelect, onMap, onNewAsset, onCreateAssets, onRemove, onMoveSource, onShapes, onMenu, onUnmap, onMove, onUnmapSource, onAdd, onMore, onToggleAssets, onMoreAssets }: Callbacks,
): Node["data"] {
  if (node.type === "more") return { ...node.data, onMore };
  if (node.type === "moreAssets") return { ...node.data, onMoreAssets };
  if (node.type === "source") {
    const data = node.data as SourceNodeData;
    const fact = facts.get(data.source.id);
    const creates = fact !== undefined && fact.groups > 0;
    const removes = canRemove && fact?.removable === true;
    return {
      ...data, onToggle, onSelect, seen: fact?.seen, ...(fact?.looks ? { looks: fact.looks } : {}),
      ...(creates ? { onCreateAssets, groups: fact.groups } : {}),
      ...(removes ? { onRemove } : {}),
      ...(canMove && moveOfferFor(data.source) !== null ? { onMoveSource } : {}),
      ...(canShapes && data.source.large ? { onShapes } : {}),
      // (W12c) The node draws no Create assets and no Remove: they are items of the menu its Source actions button opens (the right-click menu's own).
      // A source with neither has nothing to put in it that Details and the fold do not already do, so it gets no button.
      ...(creates || removes ? { onMenu } : {}),
    };
  }
  if (node.type === "cluster") {
    const cluster = node.data as ClusterNodeData;
    const mappable = canAccept && !cluster.ungrouped && (cluster.offerable ?? cluster.count - cluster.mappedCount) > 0;
    return {
      ...cluster, onToggle, ...(mappable ? { onMap, onNewAsset, ...(formWait ? { formWait } : {}) } : {}),
      ...(canEdit && cluster.mappedCount > 0 ? { onMenu, onUnmap, onMove } : {}),
    };
  }
  if (node.type === "point") {
    const point = (node.data as PointNodeData).point;
    if (canAccept && isOfferable(point)) return { ...node.data, onMap, ...(canForm ? { menuNewAsset: onNewAsset, ...(formWait ? { formWait } : {}) } : {}) };
    if (canEdit && point.mapping_id !== null) return { ...node.data, onMenu, onUnmap, onMove };
  }
  if (node.type === "asset") {
    const mapped = canEdit ? mappedBy.get((node.data as AssetNodeData).asset.id) : undefined;
    return { ...node.data, onToggleAssets, ...(mapped ? { mapped, onUnmapSource } : {}), ...(canForm ? { onAdd, ...(formWait ? { formWait } : {}) } : {}) };
  }
  return node.data;
}

function Canvas({ model }: { model: GraphModel }) {
  const { can } = useAuth();
  const canAccept = can("discovery.accept"); // map and accept: the buttons on the nodes, a drop onto an asset, the offer and the review
  const canLayout = can("discovery.edit"); // the shared layout
  const canRemove = canLayout; // Remove and Clear unmapped ride on the same permission (it is the remove route's)
  const canEditSource = can("sources.edit"); // the source panel's credentials and Browse again
  const canShapes = meets(PAGE_NEED.sourceShapes, can); // (w36) a link to a page takes that page's whole need: the Map by shape button of a large source and its panel link
  const canPoints = meets(PAGE_NEED.sourcePoints, can); // (w36) the panel's link to the Points page of a large source
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const toast = useToast();
  const movedToast = useMovedToast(); // (w33) "Moved ... 12 mappings kept." with an Undo for 10 seconds: the one toast of a finished move
  const removeSources = useRemoveDiscoveredSources();
  const { run, error: saveError } = useAction();
  const siteZone = useSite().data?.timezone;
  const timezone = siteZone ?? "UTC"; // the "10 min ago" of a source counts on the site's clock; UTC until it is read (a wall-clock time is left out until then: `looksOf`)
  const [open, setOpen] = useState<OpenState>({ sources: new Set(), clusters: new Set() });
  // ---- The view (W12b): the filter and the folded assets are remembered per browser, the pages only for this visit (a closed group starts again at one page) ----
  const [unmappedOnly, setUnmappedOnlyState] = useState(readUnmappedOnly);
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(() => new Map());
  // (w37) How many sub-assets of a parent with more than ASSET_PAGE of them are drawn (parent id -> count; none = the summary alone). Session only, like a group's pages.
  const [assetsShown, setAssetsShown] = useState<ReadonlyMap<number, number>>(() => new Map());
  const [assetsClosed, setAssetsClosedState] = useState<ReadonlySet<number>>(() => {
    const known = new Set(model.assets.map((a) => a.id));
    return new Set([...readAssetsClosed()].filter((id) => known.has(id)));
  });
  // (w33) "Not seen lately": only the sources the newest scan of their range did not find. Session only (a filter that outlives the visit would hide sources the next scan
  // found again). It is in force only while some source is marked, so a rescan or a removal that clears the last mark never leaves an empty canvas.
  const [notSeenOn, setNotSeenOn] = useState(false);
  const notSeenTotal = useMemo(() => notSeenCount(model.sources), [model]);
  const notSeenOnly = notSeenOn && notSeenTotal > 0;
  useEffect(() => { if (notSeenTotal === 0) setNotSeenOn(false); }, [notSeenTotal]); // forgotten with the last mark, so a later scan that marks a source does not bring the filter back by itself
  const view = useMemo<GraphView>(
    () => ({ unmappedOnly, notSeenOnly, shown, assetsClosed, pageSize: PAGE_SIZE, assetPageSize: ASSET_PAGE, assetsShown }),
    [unmappedOnly, notSeenOnly, shown, assetsClosed, assetsShown],
  );
  // The folds are set at once by their setter (two quick presses must not both start from the old set); it is up here because a new sub-asset opens its parent (`onAdd`).
  // It keeps only ids the model knows, and reads the model of the moment (`modelRef`, below) because a graph read may have come in since the render.
  const assetsClosedNow = useRef(assetsClosed);
  const setAssetsClosed = useCallback((next: ReadonlySet<number>) => {
    assetsClosedNow.current = next;
    setAssetsClosedState(next);
    writeAssetsClosed(next, new Set(modelRef.current.assets.map((a) => a.id)));
  }, []);
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
  // Find (W12c): the BUTTON is in the bar and the CARD in the canvas's top-right panel, so whether it is open lives here. `findOpenNow` is what `openFind` reads when
  // it is called, so that callback keeps one identity.
  const [findOpen, setFindOpen] = useState(false);
  const findOpenNow = useRef(false);
  findOpenNow.current = findOpen;
  const findCardId = useId();
  const findButton = useRef<HTMLButtonElement>(null);
  const keysRef = useRef<{ open(): void } | null>(null); // the shortcuts bubble's `open()`, for the ? key
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
  // `createdAsset`: the Review that follows the New asset form carries the name of the asset the form made (it says Cancel keeps it).
  const [review, setReview] = useState<{ key: number; payload: DropPayload; initialTarget: InitialTarget; createdAsset?: string } | null>(null);
  const reviewCount = useRef(0);
  const [offer, setOffer] = useState<{ nodeId: string; label: string } | null>(null);
  // The sources a Remove or a Clear unmapped is asking about, FROZEN when the dialog opens: the request carries these ids and no others, so a source
  // a scan adds meanwhile is never touched. `fromNode`: the Remove button of a node opened it (that node is gone afterwards; Clear keeps its button).
  // (w33) `kind: "notSeen"`: the list is the unmapped sources the newest scan did not find (Remove not seen); the dialog is worded for that and sends the same ids to the same route.
  const [removal, setRemoval] = useState<{ sources: { id: number; name: string }[]; fromNode: boolean; kind?: "notSeen" } | null>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const focusRefresh = useRef(false);
  // The source whose bulk-create dialog is open, as it was when the button was pressed (like the review dialog's payload, so the dialog's own
  // rows do not shift under it when the graph is read again after each asset). `focusAfterCreate`: the source whose node takes the focus back.
  const [createFor, setCreateFor] = useState<GraphSource | null>(null);
  const focusAfterCreate = useRef<number | null>(null);

  // The offer has no timer (WCAG 2.2.1): it stays until it is dismissed, used, replaced by a newer one, or another drag starts.
  const openReview = useCallback((payload: DropPayload, initialTarget: InitialTarget, createdAsset?: string) => {
    setOffer(null);
    refocus.current = null; // a mapping that was left unfinished must not move the focus when this one closes
    setReview({ key: ++reviewCount.current, payload, initialTarget, createdAsset });
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
  /**
   * A new sub-asset under `parentId`. A parent that is folded is opened first (kept per browser like any fold), or the asset would be made and not drawn. Not when the
   * form cannot open yet (the asset list is still being read): nothing happens then, and the fold stays.
   */
  const addUnder = useCallback((parentId: number) => {
    if (formState.current.ready && assetsClosedNow.current.has(parentId)) {
      const next = new Set(assetsClosedNow.current);
      next.delete(parentId);
      setAssetsClosed(next);
    }
    openNewAsset({ parentId });
  }, [openNewAsset, setAssetsClosed]);
  /** The "+" and the asset's New sub-asset…: the node's own id names the parent. */
  const onAdd = useCallback((id: string) => {
    const parentId = pickDropTarget([{ id }]);
    if (parentId !== null) addUnder(parentId);
  }, [addUnder]);
  /**
   * A line dragged from an asset's "+" and let go on the empty canvas: New sub-asset under that asset. Only the "+" (handle `add`) and only the empty pane count: a
   * release over a node, an edge or a control does nothing, and no connection is ever made (`isValidConnection`). The library draws every node and edge INSIDE
   * `.react-flow__pane`, so being in the pane is not enough: the release must be on nothing else. That includes the rectangle a box selection leaves: it is
   * drawn over the selected nodes, inside the pane, and takes the pointer, so a release on it would otherwise reach no node and open a dialog. Touch has no
   * drag here: a finger's end event is aimed at the element the touch began on, never at the pane, so the tap on the "+" and the node's menu do the same job there.
   */
  const onConnectEnd: OnConnectEnd = useCallback((event, state) => {
    if (state.fromHandle?.id !== "add") return;
    const target = event.target as Element | null;
    if (!target?.closest?.(".react-flow__pane")) return;
    if (target.closest(".react-flow__node, .react-flow__edge, .react-flow__nodesselection, .react-flow__nodesselection-rect, .react-flow__selection, .react-flow__minimap, .react-flow__controls, .react-flow__panel")) return;
    const parentId = state.fromNode ? pickDropTarget([state.fromNode]) : null;
    if (parentId !== null) addUnder(parentId);
  }, [addUnder]);

  const canvas = useRef<HTMLDivElement>(null);
  // The right-click menu's state is up here because a mapped node's own menu button opens it (`onMenu`), and the nodes are built below.
  const { menu, openNode, openPane, openSelection, openFromKey, openFor, close: closeMenu } = useCanvasMenu({ model, canvas });
  // Whether a menu is open, as a ref: the hover handler below reads it when the pointer enters a node, so that handler keeps one identity (see `tip`).
  const menuOpenNow = useRef(false);
  menuOpenNow.current = menu !== null;
  // Where the canvas opens (the first sources, readable). Taken once, when the canvas mounts: a refresh never moves the view, and the Controls'
  // fit-view button (it passes no options) still fits everything, so a drop onto an asset that lies out of view is a click away.
  const [opening] = useState(() => initialView(model, view));
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
  // The view of the moment, for the same reason.
  const viewNow = useRef(view);
  useEffect(() => { viewNow.current = view; }, [view]);
  const setUnmappedOnly = useCallback((on: boolean) => {
    setUnmappedOnlyState(on);
    writeUnmappedOnly(on);
  }, []);
  // A group that is no longer open goes back to one page: its entry is dropped (the same map comes back when nothing is, so nothing renders).
  useEffect(() => { setShown((current) => pruneShown(current, open)); }, [open]);
  // (w37) The same for an asset that is folded (by its chevron or by Collapse this branch): it forgets its pages and starts at the summary when it is opened again.
  useEffect(() => { setAssetsShown((current) => pruneAssetsShown(current, assetsClosed)); }, [assetsClosed]);

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

  // The one place every toggle goes through: the card's expand button, a click, Enter on a focused node (`navToggle`) and the menu's Expand.
  // (w36) A closed source whose visible groups alone are more than the Expand all budget is not opened: thousands of nodes freeze the tab. Any source, `large` or not;
  // it says why in a toast, with the same words as Find's note. The model, the view and the permission are read from refs, so this callback keeps its identity.
  const canPointsNow = useRef(canPoints);
  canPointsNow.current = canPoints;
  const toastNow = useRef(toast);
  toastNow.current = toast;
  const onToggle = useCallback((id: string) => {
    if (id.startsWith("src:")) {
      const sourceId = Number(id.slice("src:".length));
      const opens = !openNow.current.sources.has(sourceId);
      if (opens) {
        const source = modelRef.current.sources.find((s) => s.id === sourceId);
        const tooMany = source ? groupsOverBudget(source, viewNow.current) : null;
        if (source && tooMany !== null) {
          toastNow.current.info(tooManyGroupsNote(source, tooMany, canPointsNow.current));
          return;
        }
      }
      setOpen((prev) => ({ ...prev, sources: toggled(prev.sources, sourceId) }));
      if (opens) void panToOpened(id);
    } else {
      setOpen((prev) => ({ ...prev, clusters: toggled(prev.clusters, id) }));
    }
  }, [panToOpened]);

  const sourceOf = useCallback((id: string) => model.sources.find((s) => s.id === Number(id.slice("src:".length))), [model]);
  const onCreateAssets = useCallback((id: string) => {
    const source = sourceOf(id);
    if (source) {
      refocus.current = null;
      setCreateFor(source);
    }
  }, [sourceOf]);
  const closeCreate = useCallback(() => {
    focusAfterCreate.current = createFor?.id ?? null;
    setCreateFor(null);
  }, [createFor]);
  const onRemove = useCallback((id: string) => {
    const source = sourceOf(id);
    if (source && isRemovable(source)) setRemoval({ sources: [{ id: source.id, name: source.name }], fromNode: true });
  }, [sourceOf]);
  // (w33) Move... of a new source that looks like an old one: the dialog gets the two ids and the old name as they were when the button was pressed (the graph is read again every few
  // seconds). `afterMove` is the old source, whose card takes the focus when the opener is gone (a finished move removes the new source's card and closes its panel).
  const [moving, setMoving] = useState<{ oldId: number; oldName: string; newId: number } | null>(null);
  const afterMove = useRef<number | null>(null);
  const onMoveSource = useCallback((id: string) => {
    const source = sourceOf(id);
    const offer = source ? moveOfferFor(source) : null;
    if (source && offer) setMoving({ oldId: offer.from_source_id, oldName: offer.from_name, newId: source.id });
  }, [sourceOf]);
  const closeMove = useCallback(() => {
    afterMove.current = moving?.oldId ?? null;
    setMoving(null);
  }, [moving]);
  // (w36) Map by shape on a large source's card: the page of its tag shapes. The card is a plain button, so Enter and Space press it like a click.
  const onShapes = useCallback((id: string) => {
    const source = sourceOf(id);
    if (source?.large) navigate(shapesPageLink(source.id, { rules: (source.large.rules_new ?? 0) > 0 })); // new tags that match saved rules: the page opens with those rows preset
  }, [sourceOf, navigate]);
  const removable = useMemo(() => model.sources.filter(isRemovable), [model]);
  const clearUnmapped = () => {
    if (removable.length > 0) setRemoval({ sources: removable.map((s) => ({ id: s.id, name: s.name })), fromNode: false });
  };
  // (w33) Remove not seen: the sources the newest scan of their range did not find AND with nothing mapped, frozen when the dialog opens like Clear unmapped's.
  const missing = useMemo(() => removableNotSeen(model.sources), [model]);
  const removeNotSeen = () => {
    if (missing.length > 0) setRemoval({ sources: missing.map((s) => ({ id: s.id, name: s.name })), fromNode: false, kind: "notSeen" });
  };
  // The filter in the bar's menu. The menu hands the focus back to its button before this runs, so (unlike the Unmapped only switch) no node can be holding it.
  const onNotSeenFilter = useCallback((on: boolean) => setNotSeenOn(on), []);

  // What the page works out about each source once per graph: the muted last-seen line, how many groups "Create assets" would turn into
  // assets (a role that may not accept has none) and whether it is removable. `asOf` moves with each read of the graph: the "ago" is as old as the data.
  const asOf = useMemo(() => new Date(), [model]);
  const facts = useMemo(() => new Map<number, SourceFacts>(model.sources.map((s) => [s.id, {
    // (w36) A large source draws only its mapped points: no group of it is offered for Create assets, whatever the model holds.
    seen: seenLine(s, asOf, timezone), groups: canAccept && !s.large ? mappableClusters(s).length : 0, removable: isRemovable(s), looks: looksOf(s, siteZone),
  }])), [model, asOf, timezone, siteZone, canAccept]);

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
    // A focus the person has already put on the canvas group itself (a click on the empty canvas, a key) is not taken back; anything else (a lost focus, the
    // node's own menu button, the toast that has just gone) is put right as before.
    if (document.activeElement === canvas.current) return;
    (element ?? document.getElementById("main"))?.focus({ preventScroll: true });
  }, []);
  /**
   * A jump of the keyboard (an arrow, Show more): pan to the node, then focus it. Waits for the nodes just drawn to be in React Flow's store and measured (a new
   * node is `visibility: hidden` until then, and a hidden element cannot take the focus; about ten frames at most, then it goes on with the size of a node it has
   * not been told). The camera only pans (`keepInView`: the zoom is the person's), keeps the node clear of the minimap and the tools panel (`overlayMarginOf`, measured
   * once per jump) and glides; the focus comes LAST, once the glide is over, with no scrolling:
   * React Flow's own focus handler centres a node that is off screen with no animation, which would cut the glide short. The "show more" node has no focus
   * stop of its own, so for it the button inside takes the focus. `focusNode` above is the other thing (the node an action was about, no camera).
   */
  const goToNode = useCallback(async (id: string) => {
    await afterPaint();
    const area = canvas.current;
    if (!mounted.current || !area) return;
    let target = getNodes().find((n) => n.id === id);
    for (let frame = 0; frame < MEASURE_FRAMES && !(target && isMeasured(target)); frame++) {
      await nap(FRAME_MS);
      if (!mounted.current) return;
      target = getNodes().find((n) => n.id === id);
    }
    if (target) {
      const view = getViewport();
      const to = keepInView(rectOf(target), view, { w: area.clientWidth, h: area.clientHeight }, overlayMarginOf(area));
      if (to) {
        await setViewport({ ...view, ...to }, { duration: cameraMs(reducedMotion()) });
        if (!mounted.current) return;
      }
    }
    const element = focusTargetOf(canvas.current, id);
    if (element) element.focus({ preventScroll: true });
    else if (!document.activeElement || document.activeElement === document.body) canvas.current?.focus({ preventScroll: true }); // the node is not there: not the body
  }, [getNodes, getViewport, setViewport]);
  /**
   * The focus never ends on <body>. Whatever can take away the node that holds it (Collapse, Expand, a fold, the filter, Enter on a node) calls this first:
   * it notes where the focus is and, once the graph is drawn again, if the focus has been lost it goes to the nearest node of the same branch that is still
   * drawn (the group, then the source; a sub-asset's parent), else the control the person used, else the canvas group, which is named. A focus that is
   * somewhere that still stands is left alone.
   */
  const keepFocus = useCallback(() => {
    const active = document.activeElement;
    const held = active instanceof Element ? active.closest<HTMLElement>(".react-flow__node")?.dataset.id : undefined;
    const branch: string[] = [];
    if (held) {
      const parent = navIndex(getNodes()).parent;
      for (let id: string | null | undefined = held; id && !branch.includes(id); id = parent.get(id)) branch.push(id);
    }
    const control = active instanceof HTMLElement && active !== document.body && !canvas.current?.contains(active) ? active : null;
    void afterPaint().then(() => {
      if (!mounted.current) return;
      const now = document.activeElement;
      if (now && now !== document.body && now.isConnected) return;
      const target = branch.map((id) => focusTargetOf(canvas.current, id)).find((el) => el) ?? (control?.isConnected ? control : null) ?? canvas.current;
      target?.focus({ preventScroll: true });
    });
  }, [getNodes]);
  /**
   * "Show 50 more" of a group: its page grows by a page (never past its visible points). The `more` node, whose button had the focus, goes when the last page
   * is shown, so the focus moves on at once: to the first point just drawn, or to the group itself when there is nothing new to go to.
   */
  const onMore = useCallback((clusterId: string) => {
    const group = groupOfNode(modelRef.current, clusterId);
    if (!group) return;
    const now = viewNow.current;
    const visible = visiblePoints(group, now);
    const drawn = drawnCount(group, clusterId, now);
    if (drawn >= visible.length) {
      void goToNode(clusterId);
      return;
    }
    setShown((current) => new Map(current).set(clusterId, Math.min(visible.length, drawn + PAGE_SIZE)));
    void goToNode(nodeId.point(visible[drawn].id));
  }, [goToNode]);
  /**
   * (w37) "Show 50" of a summary node: the page of its parent's sub-assets grows by a page (never past its sub-assets). The summary, whose button had the focus, goes when the last
   * page is shown, so the focus moves on at once, as the group's "Show 50 more" does: to the first sub-asset just drawn.
   */
  const onMoreAssets = useCallback((summaryId: string) => {
    const parentId = Number(summaryId.slice("more:asset:".length));
    const kids = modelRef.current.assets.filter((a) => a.parent_id === parentId && a.id !== parentId); // the walk's own rule for a sub-asset, in the model's order
    const drawn = viewNow.current.assetsShown?.get(parentId) ?? 0;
    if (drawn >= kids.length) {
      void goToNode(nodeId.asset(parentId)); // (a stale press: nothing is left to draw)
      return;
    }
    setAssetsShown((current) => new Map(current).set(parentId, Math.min(kids.length, drawn + ASSET_PAGE)));
    void goToNode(nodeId.asset(kids[drawn].id));
  }, [goToNode]);
  /** The fold of an asset's sub-assets: kept per browser. Its button (or the node, for Enter) stays where it is, so the focus does not move. */
  const onToggleAssets = useCallback((id: string) => {
    keepFocus();
    setAssetsClosed(toggled(assetsClosedNow.current, Number(id.slice("asset:".length))));
  }, [setAssetsClosed, keepFocus]);
  /** The bar's Unmapped only switch. The switch keeps the focus it was given; a focus that was on a node the filter takes away goes to the nearest one left. */
  const onFilter = useCallback((on: boolean) => {
    keepFocus();
    setUnmappedOnly(on);
  }, [keepFocus, setUnmappedOnly]);

  // ---- After a mapping, with "Unmapped only" on (W12b): the node the person acted on may be gone, and a focus on <body> helps nobody ----
  /** What was mapped, as the nodes that stood for it: set when the mapping succeeds, used once the dialog has closed and the graph is read again. */
  const refocus = useRef<{ sourceId: number; clusterId?: string; pointId?: number } | null>(null);
  const keepFocusAfter = (subject: NonNullable<typeof refocus.current>) => {
    if (viewNow.current.unmappedOnly) refocus.current = subject;
  };
  /**
   * The node to hand the focus to when the filter has taken the mapped one away, nearest first: the next unmapped point of the same group, the group, the
   * source. A node that is not on the canvas (the filter hides a group once all its points are mapped, a source once all of its are) is passed over;
   * none left means the canvas group, which is named.
   */
  const focusAfterFilter = useCallback(async (subject: NonNullable<typeof refocus.current>) => {
    await afterPaint(); // the graph that was read again is drawn, and the dialog has handed the focus back to what it could
    if (!mounted.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return; // the focus is somewhere that still stands: leave it
    const ids: string[] = [];
    const source = modelRef.current.sources.find((s) => s.id === subject.sourceId);
    if (source && subject.pointId !== undefined) {
      const group = groupsOf(source).find((g) => g.points.some((p) => p.id === subject.pointId));
      if (group) {
        const at = group.points.findIndex((p) => p.id === subject.pointId);
        for (const p of group.points.slice(at + 1)) if (isOfferable(p)) ids.push(nodeId.point(p.id));
        ids.push(nodeId.cluster(source.id, group.key));
      }
    } else if (subject.clusterId) {
      ids.push(subject.clusterId);
    }
    ids.push(nodeId.source(subject.sourceId));
    const target = ids.map((id) => canvas.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${selectorId(id)}"]`)).find((el) => el);
    (target ?? canvas.current)?.focus({ preventScroll: true });
  }, []);
  // The dialog that mapped has closed (Review after its lists were read again, the bulk dialog after its last group): now look at where the focus is.
  useEffect(() => {
    if (review !== null || createFor !== null || refocus.current === null) return;
    const subject = refocus.current;
    refocus.current = null;
    void focusAfterFilter(subject);
  }, [review, createFor, focusAfterFilter]);
  /**
   * The toast a Review or a bulk create raises has an Undo; its button leaves with the toast, so when the Undo is done (the lists read again) the focus goes to the
   * canvas group, which is named: the keyboard person carries on from the graph, not from the top of the page.
   */
  const onMapped = useCallback((info: MappedInfo) => {
    mapsRef.current.mappedToast({ ...info, after: () => canvas.current?.focus({ preventScroll: true }) });
  }, []);
  /** A Review that mapped `payload`: the toast, and (filter on) the node to hand the focus to if the mapped one is gone. */
  const onReviewMapped = (info: MappedInfo, payload: DropPayload) => {
    onMapped(info);
    keepFocusAfter(payload.kind === "cluster"
      ? { sourceId: payload.source.id, clusterId: nodeId.cluster(payload.source.id, payload.label) }
      : { sourceId: payload.source.id, pointId: payload.points[0]?.id });
  };
  /** A bulk create of the groups of `source`. */
  const onBulkMapped = (info: MappedInfo, source: GraphSource) => {
    onMapped(info);
    keepFocusAfter({ sourceId: source.id });
  };
  // The menu opens next to the button itself (not next to the whole node, whose far side can be a long way from the pointer), and a second press on the button closes it.
  const onMenu = useCallback((button: HTMLElement) => {
    const id = button.closest<HTMLElement>(".react-flow__node")?.dataset.id;
    if (id) openFor(id, button);
    else openFromKey(button);
  }, [openFor, openFromKey]);
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
   * already waited for the graph to be read again, but React draws that read, and copies it into `modelRef`, some frames later (two are not always enough on a
   * busy page), and the Review lists its assets from the model it is given: so wait frame by frame, for at most about 2 s, until the model of the moment has the
   * asset. The error toast therefore means the graph really did not show the asset in that time (the refresh failed): the person is told and the asset stays.
   */
  const onNewAssetCreated = async (asset: Asset) => {
    const payload = newAsset?.payload;
    setNewAsset(null);
    if (!payload && asset.parent_id === null) return; // (a root asset is never behind a summary)
    const found = await framesUntil(() => modelRef.current.assets.some((a) => a.id === asset.id), { stop: () => !mounted.current });
    if (!mounted.current) return;
    if (!found) {
      if (payload) toast.error("The asset was created, but the graph could not be refreshed. Use Map… to map to it.");
      return;
    }
    // (w37) A new sub-asset can land behind its parent's summary (or, as the 51st, turn 50 drawn ones into a summary): the pages that hold it back are extended, as Find does,
    // so it is drawn. Over the budget the summary is where the person is taken, with the same words as Find's. A Review that opens takes the focus itself.
    const pages = extendPagesFor(modelRef.current, viewNow.current, asset.id);
    const paged = pages.assetsShown !== viewNow.current.assetsShown;
    if (paged) setAssetsShown(pages.assetsShown);
    if (pages.stoppedAt !== null) toast.info(tooFarNote(modelRef.current, viewNow.current, pages.stoppedAt, asset.name));
    if (payload) openReview(payload, { kind: "existing", assetId: asset.id }, asset.name);
    else if (paged || pages.stoppedAt !== null) void goToNode(pages.stoppedAt === null ? nodeId.asset(asset.id) : nodeId.moreAssets(pages.stoppedAt));
  };

  const seeded = useMemo(() => {
    const built = buildGraph(model, open, { moved: moved.current, ignoreSaved: tidyRuns > 0, animate: !reduced, view });
    const nodes: Node[] = built.nodes.map((n) => ({
      ...n,
      data: nodeData(n, { canAccept, canRemove, canEdit: canEditAssets, canForm, formWait, canMove: canEditSource, canShapes }, facts, mappedBy, {
        onToggle, onSelect, onMap, onNewAsset, onCreateAssets, onRemove, onMoveSource, onShapes, onMenu, onUnmap, onMove, onUnmapSource, onAdd, onMore, onToggleAssets, onMoreAssets,
      }),
    }));
    return { nodes, edges: built.edges };
  }, [model, open, view, tidyRuns, reduced, canAccept, canRemove, canEditAssets, canForm, formWait, canEditSource, canShapes, facts, mappedBy, onToggle, onSelect, onMap, onNewAsset, onCreateAssets, onRemove, onMoveSource, onShapes, onMenu, onUnmap, onMove, onUnmapSource, onAdd, onMore, onToggleAssets, onMoreAssets]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(seeded.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(seeded.edges);
  useEffect(() => {
    // New node objects carry no size, which would hide every node until React Flow measures them again: keep what it knows. A selection (a box drawn
    // with Shift, a Ctrl-click) must also outlive a rebuild: an expand, a collapse or a refresh keeps the nodes that are still there selected.
    // A node or edge the rebuild did not change stays the SAME object, so React Flow re-renders only what moved; when nothing changed the previous array
    // comes back and React skips the update (W12b, lib/graphReuse.ts).
    setNodes((current) => reuseNodes(current, seeded.nodes));
    setEdges((current) => reuseEdges(current, seeded.edges));
  }, [seeded, setNodes, setEdges]);

  // The path highlight: hovering, keyboard focus or a selection lights the node's whole path (only the path's nodes and edges become new objects; the
  // wrapper's `has-focus` class dims the rest). The CURRENT nodes and edges of each rebuild go in, so it forgets a node that has gone. Not while dragging.
  // `selectedNow` is the selection as it stands (the expand and collapse actions read it, a drag or not); it keeps its identity while the same nodes are
  // selected, so what is worked out from it (`states`) is not worked out again on every frame of a drag.
  const selection = useRef<readonly string[]>(NO_IDS);
  const selectedNow = useMemo(() => {
    const ids = nodes.filter((n) => n.selected).map((n) => n.id);
    const before = selection.current;
    if (ids.length === before.length && ids.every((id, i) => id === before[i])) return before;
    selection.current = ids;
    return ids;
  }, [nodes]);
  const selectedIds = dragging ? NO_IDS : selectedNow;
  const { shownNodes, shownEdges, active: dimming, handlers: highlight } = useGraphHighlight({ nodes, edges, selectedIds, dragging });
  // The last value of a mapped point (W12c): a card after a short rest on its node, by the pointer or by the keyboard. Every function of `tip` has one identity for the
  // life of the page, so the handlers below that combine them with the highlight's have one too: a new handler identity would re-render every node wrapper (measured, W12b).
  const tip = useValueTip();
  const { enter: tipEnter, leave: tipLeave, focus: tipFocus, blur: tipBlur, hide: tipHide } = tip;
  // The card steps aside for a layer above it. It sits over the canvas menu (z-index 200 against 90), and one Escape would close both, so it goes the moment a canvas
  // menu (the right-click one and a node's own button's) or the Find card opens, and the enter handler below starts nothing while either stands. `tipHide` forgets the
  // pointer's hover too. The card can still return by itself after the layer closes: Escape from a node's menu gives the keyboard focus back to the node, and a
  // keyboard focus on a mapped point shows the card (the same rule as the node's focus ring). A pointer user who closes the menu by a click does not get it.
  useEffect(() => {
    if (menu !== null || findOpen) tipHide();
  }, [menu, findOpen, tipHide]);
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
    // A paged group's "Show 50 more" node stands under its points, so it moves with the group (and with a dragged source's groups). It follows and nothing
    // more: it is never in `below` or `pins`, so it never gets a place of its own and is never saved (the layout would hold an id no build reads).
    if (!alone) for (const n of dragged) for (const id of moreNodeIds(model, n.id)) if (live.has(id) && !draggedIds.has(id)) followers.add(id);
    // What the guides line up with: every node that stands still during this drag. Not the dragged ones (the other nodes of a selection included) and
    // not their followers, which move with them: each would line up with itself on every frame.
    if (GUIDES_ENABLED) guideOthers.current = everyone.filter((n) => !draggedIds.has(n.id) && !followers.has(n.id)).map(rectOf);
    const pins = alone ? [...new Set(dragged.flatMap((n) => childNodeIds(model, n.id)))].filter((id) => !draggedIds.has(id) && live.has(id)) : [];
    const starts = new Map<string, XY>(dragged.map((n) => [n.id, { x: n.position.x, y: n.position.y }]));
    for (const id of [...followers, ...pins]) starts.set(id, { ...live.get(id)! });
    drag.current = { alone, starts, followers, below: [...below], pins, own: ownPlaces(model, { moved: moved.current, ignoreSaved: tidyRuns > 0 }) };
    setOffer(null);
    setDragging(true);
    tipHide(); // a card stays where the node was: it does not follow a drag
  }, [model, tidyRuns, getNodes, tipHide]);

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
  // These are worked out once per change of the graph, the open set, the view or the selection, not on every render (a hover renders the page).
  // (w33) With "Not seen lately" on, the announced sentence says the canvas shows only those (the figures stay the whole graph's, as with Unmapped only).
  const summary = useMemo(() => (view.notSeenOnly ? `${graphSummary(model, view)}, showing only sources not seen lately (${notSeenTotal})` : graphSummary(model, view)), [model, view, notSeenTotal]);
  const counts = useMemo(() => graphCounts(model, view), [model, view]); // the bar's chips (decoration); the sentence above is what is announced
  const collapsible = useMemo(() => canCollapse(model, open, view), [model, open, view]);
  const expandable = useMemo(() => canExpand(model, open, view), [model, open, view]);
  const states = useMemo(() => selectionStates(model, open, view, selectedNow), [model, open, view, selectedNow]);
  const onCollapseAll = () => {
    if (!collapsible) return;
    keepFocus();
    setOpen(collapseAll());
  };
  const onExpandAll = () => {
    if (!expandable) return;
    keepFocus();
    const result = expandAll(model, open, EXPAND_NODE_BUDGET, view);
    setOpen(result.open);
    const note = expandNote(result); // what the node budget kept closed, if anything
    if (note) toast.info(note);
  };
  /**
   * Expand or collapse the given nodes (the selection, or one node's branch): the new open set and folds, and a toast saying what changed. The toast is the
   * announcement for a screen reader (the bar's one live region is the summary, which these do not change); nothing to say, nothing is said.
   */
  const applyChange = (change: Change, verb: "expand" | "collapse") => {
    keepFocus();
    if (change.open !== open) setOpen(change.open);
    if (change.assetsClosed !== assetsClosed) setAssetsClosed(change.assetsClosed);
    const note = changeNote(change, verb);
    if (note) toast.info(note);
  };
  const expandBy = (ids: readonly string[], branch: boolean) => applyChange(expandTargets(model, open, view, ids, branch), "expand");
  const collapseBy = (ids: readonly string[], branch: boolean) => applyChange(collapseTargets(model, open, view, ids, branch), "collapse");

  // Tidy layout: every node back to its default column. The model of the moment is read after the awaits (a refresh may have come in meanwhile).
  const tidyLayout = useTidyLayout({
    // Right after the route has answered, before the graph is read again: the old layout (this session's drags and the saved places) never shows.
    onDeleted: () => { moved.current.clear(); setTidyRuns((n) => n + 1); },
  });
  const refit = useCallback(async () => {
    await afterPaint(); // the rebuilt nodes are in React Flow's store
    if (!mounted.current) return; // the person left the page meanwhile
    // The opening rules (W7r), as if no place were saved; the camera glides there (at once under reduced motion).
    void fitView({ ...initialView({ ...modelRef.current, layout: {} }, viewNow.current), duration: cameraMs(reducedMotion()) });
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
    try {
      // The call resolves after the graph is read again, so the removed nodes are already gone when the dialog closes below.
      const outcome = removalOutcome(await removeSources.mutateAsync(removal.sources.map((s) => s.id)));
      if (outcome.kind === "none") throw new Error(outcome.text); // nothing went: the dialog stays open and says why as its error line
      if (outcome.kind === "done") toast.success(outcome.text);
      else if (outcome.kind === "partial") toast.error(outcome.text);
      else toast.info(outcome.text);
      focusRefresh.current = removal.fromNode;
      setRemoval(null);
    } finally {
      // (w33, A11) The hook refreshes the graph, the sources and the audit log; a removal also changes the findings a scan lists (they lose their source), so the scans are read again too, answer or refusal.
      void invalidate(keys.scans);
    }
  };
  // After the dialog has gone (a PARENT effect runs after the dialog's own cleanup has put the focus back on the node's Remove button, which the
  // refreshed graph has taken away): the focus lands on Refresh. A Clear unmapped keeps its own button, and the dialog hands the focus back to it.
  useEffect(() => {
    if (removal === null && focusRefresh.current) {
      focusRefresh.current = false;
      refreshRef.current?.focus();
    }
  }, [removal]);
  // The bulk-create dialog does not restore focus itself (the page decides): the node's Source actions button (the menu holds Create assets…) while a group is
  // left to map, or, when every group has become an asset and the node has no menu button any more, the node's Details button.
  useEffect(() => {
    if (createFor !== null || focusAfterCreate.current === null) return;
    const node = canvas.current?.querySelector(`[data-id="src:${focusAfterCreate.current}"]`);
    focusAfterCreate.current = null;
    (node?.querySelector<HTMLElement>('button[aria-label^="Source actions for"]') ?? node?.querySelector<HTMLElement>('button[aria-label^="Details for"]'))?.focus();
  }, [createFor]);

  // (w33) The move dialog hands the focus back to what opened it (the Move... button of the new source's card or panel). After a finished move that button is gone with the new source
  // (the dialog has read the graph again before it said done), so the focus goes to the old source's card, the source that was moved; else to the canvas, never to <body>.
  useEffect(() => {
    if (moving !== null || afterMove.current === null) return;
    const oldId = afterMove.current;
    afterMove.current = null;
    void (async () => {
      await afterPaint(); // the dialog's own cleanup has put the focus back, and the refreshed graph is drawn
      if (!mounted.current) return;
      const at = document.activeElement;
      if (at instanceof HTMLElement && at !== document.body && at.isConnected) return;
      const card = canvas.current?.querySelector(`[data-id="src:${oldId}"]`);
      (card?.querySelector<HTMLElement>('button[aria-label^="Details for"]') ?? canvas.current ?? document.getElementById("main"))?.focus({ preventScroll: true });
    })();
  }, [moving]);

  // ---- Find (Ctrl+K on the canvas), the right-click menus and the canvas's keys ----
  const findIndex = useMemo(() => buildFindIndex(model), [model]);
  const search = useCallback((query: string) => findMatches(findIndex, query), [findIndex]);
  // (w36) The tags of a large source are not on the canvas, so Find offers to search them on its shapes page; only to a person who may open that page (its whole need).
  const shapesTargets = useMemo<ShapesTarget[]>(
    () => (canShapes ? model.sources.flatMap((s) => (s.large ? [{ id: s.id, name: s.name, points: s.large.points }] : [])) : []),
    [model, canShapes],
  );
  const goToShapes = useCallback((to: string) => navigate(to), [navigate]);
  /** Ctrl+K (on the canvas, or on the bar outside the card): opens the card, or, when it is open, takes the focus back into its field. */
  const openFind = useCallback(() => {
    if (!findOpenNow.current) {
      setFindOpen(true);
      return;
    }
    const field = canvas.current?.querySelector<HTMLInputElement>('.graph-find input[role="combobox"]');
    field?.focus({ preventScroll: true });
    field?.select();
  }, []);
  const toggleFind = useCallback(() => setFindOpen((was) => !was), []);
  const closeFind = useCallback(() => setFindOpen(false), []);
  const find = useMemo(() => ({ open: findOpen, cardId: findCardId, onToggle: toggleFind, buttonRef: findButton }), [findOpen, findCardId, toggleFind]);
  const openKeys = useCallback(() => keysRef.current?.open(), []);
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
    let now = viewNow.current;
    // (w33) findPlan knows nothing of "Not seen lately": a node of a source the filter hides turns the filter off first (the same promise as Unmapped only's), and says so.
    if (now.notSeenOnly) {
      const sourceId = sourceIdOfNode(modelRef.current, entry.id);
      const source = sourceId === null ? undefined : modelRef.current.sources.find((s) => s.id === sourceId);
      if (source && !isNotSeen(source)) {
        now = { ...now, notSeenOnly: false };
        setNotSeenOn(false);
        toast.info(`Not seen lately is off so ${entry.label} can be shown.`);
      }
    }
    const plan = findPlan(modelRef.current, openNow.current, entry, EXPAND_NODE_BUDGET, now, canPointsNow.current); // the model, open set and view of the moment: a refresh may have come in while the card was open
    if (plan.open !== openNow.current) setOpen(plan.open); // the very same object when nothing has to open: no rebuild
    if (plan.view) {
      // The jump needs a longer page, an unfolded asset or no filter: change those first (one batch with the open set), then wait for the paint as below.
      setShown(plan.view.shown);
      if (plan.view.assetsClosed !== now.assetsClosed) setAssetsClosed(plan.view.assetsClosed);
      if (plan.view.assetsShown && plan.view.assetsShown !== now.assetsShown) setAssetsShown(plan.view.assetsShown); // (w37) the pages of the parents that hold the asset back
      if (plan.view.unmappedOnly !== now.unmappedOnly) setUnmappedOnly(plan.view.unmappedOnly);
    }
    if (plan.note) toast.info(plan.note);
    await afterPaint(); // the nodes just opened are in React Flow's store
    if (!mounted.current) return;
    const target = getNodes().find((n) => n.id === plan.targetId);
    if (!target) return; // the graph was read again meanwhile and the node is gone
    const { x, y, w, h } = rectOf(target);
    await setCenter(x + w / 2, y + h / 2, { zoom: Math.min(1, Math.max(0.75, getZoom())), duration: cameraMs(reducedMotion()) });
    if (!mounted.current) return;
    const element = focusTargetOf(canvas.current, plan.targetId); // (w37) a summary node is no stop of its own: its button takes the focus
    if (!element) return;
    window.clearTimeout(flashTimer.current);
    setFlashId(plan.targetId); // (the outline holds under reduced motion too; the CSS drops only the pulse)
    flashTimer.current = window.setTimeout(() => setFlashId(null), FLASH_MS);
    element.focus({ preventScroll: true });
  }, [toast, getNodes, getZoom, setCenter, setAssetsClosed, setUnmappedOnly]);

  const clearSelection = useCallback(() => {
    setNodes((current) => (current.some((n) => n.selected) ? current.map((n) => (n.selected ? { ...n, selected: false } : n)) : current));
  }, [setNodes]);
  const canvasKeys = useCanvasKeys({ canvas, openFind, openMenuFor: openFromKey, onEscape: clearSelection, openKeys });
  // Enter on a focused node: a source or a group opens or closes, an asset with sub-assets folds; the hook only knows "toggle this id", the page knows which kind it is.
  const navToggle = useCallback((id: string) => {
    if (id.startsWith("asset:")) {
      onToggleAssets(id);
    } else {
      keepFocus();
      onToggle(id);
    }
  }, [onToggle, onToggleAssets, keepFocus]);
  const nav = useGraphNav({ canvas, nodes, onToggle: navToggle, onMore, goToNode, clearSelection });
  // Stable, because React Flow re-renders every node wrapper when one of these props changes identity: as inline arrows they cost a render of the
  // whole graph on each hover (measured, W12b).
  const onNodeClick: NodeMouseHandler = useCallback((_event, node) => {
    if (node.type === "source") setSelectedId((node.data as SourceNodeData).source.id);
  }, []);
  const onNodeContextMenu: NodeMouseHandler = useCallback((event, node) => openNode(node.id, event), [openNode]);

  // ---- The handlers that combine the highlight's with the last-value card's (W12c) ----
  const onNodeMouseEnter: NodeMouseHandler = useCallback((event, node) => {
    highlight.onNodeMouseEnter(event, node);
    const mappingId = mappingOf(node);
    const wrapper = event.currentTarget instanceof Element ? event.currentTarget.closest(".react-flow__node") ?? event.currentTarget : null;
    // A menu or the Find card is open (read from refs, so this handler keeps its identity): the card starts nothing, the highlight above still follows the pointer.
    if (menuOpenNow.current || findOpenNow.current) tipLeave();
    else if (mappingId !== null && wrapper) tipEnter(node.id, mappingId, wrapper);
    else tipLeave(); // a node that has no value to show: the card of the one just left goes after its short grace
  }, [highlight, tipEnter, tipLeave]);
  const onNodeMouseLeave: NodeMouseHandler = useCallback((event, node) => {
    highlight.onNodeMouseLeave(event, node);
    tipLeave();
  }, [highlight, tipLeave]);
  // The same rule as the highlight's for what counts as the keyboard's focus; `getNodes` is read when the focus lands (a node may have been rebuilt since the last render).
  const onCanvasFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    highlight.onFocus(event);
    const target = event.target;
    const wrapper = target instanceof Element ? target.closest<HTMLElement>(".react-flow__node") : null;
    const id = wrapper?.dataset.id;
    const found = id !== undefined && keyboardFocus(target) ? getNodes().find((n) => n.id === id) : undefined;
    const mappingId = found ? mappingOf(found) : null;
    if (wrapper && id !== undefined && mappingId !== null) tipFocus(id, mappingId, wrapper);
    else tipBlur();
  }, [highlight, getNodes, tipFocus, tipBlur]);
  const onCanvasBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    highlight.onBlur(event);
    tipBlur();
  }, [highlight, tipBlur]);
  // The canvas moving under the menu or the card (a pan, a wheel zoom: no scroll event comes with those) takes both away.
  const onMoveStart = useCallback(() => {
    closeMenu();
    tipHide();
  }, [closeMenu, tipHide]);

  // The menu's items come from the node's own callbacks (the ones its buttons use), so a role sees exactly the actions it has buttons for.
  const nodeActions = (node: Node): RowAction[] => {
    const d = node.data as NodeActions & Pick<AssetNodeData, "mapped" | "onUnmapSource" | "children" | "collapsed"> & Pick<SourceNodeData, "groups"> & Pick<PointNodeData, "twinOf"> & { expanded?: boolean };
    const group = node.type === "cluster";
    const items: RowAction[] = [];
    if (d.onSelect) items.push({ label: "Details", onSelect: () => d.onSelect?.(node.id) });
    if (d.onToggle) items.push({ label: d.expanded ? "Collapse" : "Expand", onSelect: () => d.onToggle?.(node.id) });
    // (W12c) A source has no Create assets or Remove button on its card: these two items, in its Source actions menu and its right-click menu, are where they are.
    if (d.onCreateAssets) items.push({ label: d.groups === undefined ? "Create assets…" : `Create assets for ${d.groups} ${d.groups === 1 ? "group" : "groups"}…`, onSelect: () => d.onCreateAssets?.(node.id) });
    if (d.onMap) items.push({ label: "Map…", onSelect: () => d.onMap?.(node.id) });
    // (w34) The same tag as a mapped point: a role that maps sees the item it would have had, disabled, with the reason (the node has no button for it, so this is the only place it says so).
    if (node.type === "point" && d.twinOf !== undefined && canAccept) items.push({ label: "Map…", disabled: true, reason: `Already mapped as ${d.twinOf}` });
    // The three that open the asset form wait for the asset list (`formWait`: aria-disabled, skipped by the keys).
    if (d.onNewAsset) items.push({ label: "New asset…", disabled: d.formWait, onSelect: () => d.onNewAsset?.(node.id) });
    if (d.menuNewAsset) items.push({ label: "New asset…", disabled: d.formWait, onSelect: () => d.menuNewAsset?.(node.id) }); // an unmapped point: its menu only
    if (d.onAdd) items.push({ label: "New sub-asset…", disabled: d.formWait, onSelect: () => d.onAdd?.(node.id) });
    if (d.onRemove) items.push({ label: "Remove from Discovery…", tone: "danger", onSelect: () => d.onRemove?.(node.id) });
    // W12a, after the rest: what takes a mapping off an asset or moves it (only with assets.edit: the callbacks are not given otherwise).
    if (d.onUnmap) items.push({ label: group ? "Unmap this group…" : "Unmap…", tone: "danger", onSelect: () => d.onUnmap?.(node.id) });
    if (d.onMove) items.push({ label: group ? "Move this group's mappings…" : "Move to another asset…", onSelect: () => d.onMove?.(node.id) });
    // (only an asset node's `mapped` is a list of sources: the summary node's `mapped` (w37) is a count of points, and iterating it threw)
    for (const m of (node.type === "asset" ? d.mapped : undefined) ?? []) items.push({ label: `Unmap everything from ${m.sourceName}…`, tone: "danger", onSelect: () => d.onUnmapSource?.(node.id, m.sourceId) });
    // W12b, last: the branch of THIS node (whatever is selected), for a node that opens or closes; an asset with sub-assets also folds them.
    // A group has no branch items: its branch is itself, so they would do what its Expand or Collapse does.
    const hasChildren = (d.children ?? 0) > 0;
    if (node.type === "source" || (node.type === "asset" && hasChildren)) {
      const branch = selectionStates(model, open, view, [node.id], "node"); // (its reasons speak of the node, not of the selection)
      items.push(
        { label: "Expand this branch", disabled: !branch.expandBranch.enabled, reason: branch.expandBranch.reason, onSelect: () => expandBy([node.id], true) },
        { label: "Collapse this branch", disabled: !branch.collapseBranch.enabled, reason: branch.collapseBranch.reason, onSelect: () => collapseBy([node.id], true) },
      );
    }
    if (hasChildren && d.onToggleAssets) items.push({ label: d.collapsed ? "Show sub-assets" : "Hide sub-assets", onSelect: () => d.onToggleAssets?.(node.id) });
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
  /** W12b: what the selected nodes (a box selection, a Ctrl-click) can open or close; a disabled one says why. */
  const selectionActions = (): RowAction[] => [
    { label: "Expand selection", disabled: !states.expandSelection.enabled, reason: states.expandSelection.reason, onSelect: () => expandBy(selectedNow, false) },
    { label: "Collapse selection", disabled: !states.collapseSelection.enabled, reason: states.collapseSelection.reason, onSelect: () => collapseBy(selectedNow, false) },
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
      menuItems.push(...selectionActions());
    }
  }

  return (
    <>
      <PageHeader title="Discovery" icon="discovery" sub={SUB} />
      {/* Refresh, Clear unmapped (a role that has it, in the overflow menu), Find, Snap to grid and the shortcuts bubble are controls of the bar now. */}
      <GraphBar
        summary={summary} counts={counts} collapsible={collapsible} expandable={expandable} tidying={tidying}
        unmappedOnly={unmappedOnly} onUnmappedOnly={onFilter}
        onCollapseAll={onCollapseAll} onExpandAll={onExpandAll} onTidy={() => void onTidy()}
        expandSelection={states.expandSelection} collapseSelection={states.collapseSelection}
        expandBranch={states.expandBranch} collapseBranch={states.collapseBranch}
        onExpandSelection={() => expandBy(selectedNow, false)} onCollapseSelection={() => collapseBy(selectedNow, false)}
        onExpandBranch={() => expandBy(selectedNow, true)} onCollapseBranch={() => collapseBy(selectedNow, true)}
        snap={snap} onSnap={onSnapChange}
        find={find} onFindKey={openFind}
        onRefresh={() => invalidate(keys.graph)} refreshRef={refreshRef}
        clear={canRemove ? { count: removable.length, onClear: clearUnmapped } : undefined}
        notSeen={{ count: notSeenTotal, filtered: notSeenOnly, onFilter: onNotSeenFilter, ...(canRemove ? { removable: missing.length, onRemove: removeNotSeen } : {}) }}
        shortcuts={<ShortcutsBubble openRef={keysRef} />}
      />
      {saveError && <p className="error" role="alert">{saveError}</p>}
      <div className="graph-layout">
        {/* tabIndex -1: a click on the empty canvas puts the focus here (no ring for a mouse), so the canvas's own keys work after it. `has-focus` dims everything off the lit path. */}
        <div
          className={dimming ? "graph-canvas has-focus" : "graph-canvas"}
          ref={canvas}
          tabIndex={-1}
          role="group" // named, because it is a focus target (a pane click, and the return of Escape from a menu or from Find): a screen reader says "Discovery graph", not the whole canvas text
          aria-label="Discovery graph"
          onFocus={onCanvasFocus}
          onBlur={onCanvasBlur}
          onKeyDown={canvasKeys.onKeyDown}
          onKeyDownCapture={nav.onKeyDownCapture}
        >
          <ReactFlow
            nodes={flashed}
            edges={shownEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onNodeMouseEnter={onNodeMouseEnter}
            onNodeMouseLeave={onNodeMouseLeave}
            onNodeContextMenu={onNodeContextMenu}
            onPaneContextMenu={openPane}
            onSelectionContextMenu={openSelection} // while a box selection stands, its rectangle takes the right-click that would reach a node
            onMoveStart={onMoveStart} // the menu and the value card are placed at a point of the screen: the canvas moving under them closes them
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            colorMode={dark ? "dark" : "light"}
            ariaLabelConfig={ARIA_LABELS}
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
            <CanvasTools search={search} onChoose={onFind} shapes={shapesTargets} onShapes={goToShapes} open={findOpen} onClose={closeFind} triggerRef={findButton} cardId={findCardId} />
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
        {selected && (
          <SourcePanel
            key={selected.id} source={selected} canEdit={canEditSource} seen={facts.get(selected.id)?.seen ?? ""} looks={facts.get(selected.id)?.looks} onClose={closePanel}
            canShapes={canShapes} canPoints={canPoints}
            onMoveSource={canEditSource && moveOfferFor(selected) !== null ? () => onMoveSource(nodeId.source(selected.id)) : undefined}
          />
        )}
      </div>
      {canAccept && review && (
        <ReviewDialog
          key={review.key} model={model} payload={review.payload} initialTarget={review.initialTarget} kinds={kinds} createdAsset={review.createdAsset}
          onMapped={(info) => onReviewMapped(info, review.payload)} onClose={closeReview}
        />
      )}
      {canAccept && createFor && <BulkCreateDialog model={model} source={createFor} onMapped={(info) => onBulkMapped(info, createFor)} onClose={closeCreate} />}
      {/* Beside the Review and outside the canvas, like it: the form's keys and focus must not reach the canvas's handlers. */}
      {canForm && newAsset && assetList.data && (
        <NewAssetDialog
          key={newAsset.key} assets={assetList.data} kinds={kinds ?? []} name={newAsset.name} parentId={newAsset.parentId} continues={newAsset.payload !== undefined}
          canRegister={can("assets.kinds")} create={createAsset} onCreated={(asset) => void onNewAssetCreated(asset)} onCancel={() => setNewAsset(null)}
        />
      )}
      {askDialog}
      {maps.dialogs}
      {/* (w33) Beside the other dialogs and outside the canvas: its keys and focus must not reach the canvas's handlers. It reads the graph, the sources and the scans again before it says done. */}
      {moving && (
        <MoveSourceDialog
          oldId={moving.oldId} oldName={moving.oldName} newId={moving.newId}
          onClose={closeMove}
          onDone={(done, preview) => {
            if (selectedId === moving.newId) setSelectedId(null); // the new source is gone: so is its panel
            closeMove();
            movedToast(done, preview.mappings);
          }}
        />
      )}
      {/* Outside the canvas, like the menus: a portal of its own on the body. It asks the server for a value only while it shows a card, and only for a role that may read values. */}
      <PointValueTip target={tip.target} canView={can("assets.view")} onDismiss={tipHide} />
      {/* Outside the canvas on purpose: React passes the events of a portal up to its parents, and the canvas's focus and key handlers must not hear the menu. */}
      {menu && <GraphContextMenu key={menu.id} at={menu.at} items={menuItems} label={menuLabel} returnFocus={menu.returnFocus} onClose={closeMenu} />}
      {removal && (
        <ConfirmDeleteDialog
          {...removalDialogText(removal.sources.map((s) => s.name), removal.kind)}
          confirmLabel="Remove"
          onConfirm={confirmRemoval}
          onCancel={() => setRemoval(null)}
        />
      )}
    </>
  );
}

export function DiscoveryPage() {
  const { loading } = useAuth();
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
    // Inside .graph-page from the first paint: the shell's one-window-tall rules key on it, and the canvas takes what the header leaves. The header has no actions
    // (the buttons are in the bar), so it is the real header, icon and sentence included.
    return (
      <div className="graph-page">
        <PageHeader title="Discovery" icon="discovery" sub={SUB} />
        <GraphBarSpace />
        <CanvasSkeleton label="Loading the graph" />
      </div>
    );
  }
  if (error) return <p className="error" role="alert">{error.message}</p>;
  if (!model || empty) {
    return (
      <>
        <PageHeader title="Discovery" icon="discovery" sub={SUB} />
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
