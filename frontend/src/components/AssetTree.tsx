import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { Link, NavLink } from "react-router";
import { Icon } from "./Icon";
import { Skeleton, SkeletonRegion, TreeSkeleton } from "./Skeleton";
import { assetIcon } from "../lib/assetIcons";
import { pickLine, type PickEvent } from "../lib/moveText";
import { readStored, writeStored } from "../lib/sidebarState";
import { ancestorIds, type TreeNode } from "../lib/tree";
import { createTreeDnd } from "../lib/treeDnd";
import { foldableIds, readFolded, saveFolded } from "../lib/treeFold";
import type { DropTarget } from "../lib/treeMove";
import { createPickStore, visibleOrder, type PickStore } from "../lib/treeSelect";
import { TREE_MIN, TREE_STEP, TREE_STEP_BIG, clampTreeWidth, clearTreeWidth, readTreeWidth, saveTreeWidth, treeMax } from "../lib/treeWidth";

export type { DropTarget };

const KEY = "dcdash.assetTree";
type ColumnState = "expanded" | "minimized";
const DEFAULT_WIDTH = 280; // --tree-w, for a column with no layout to measure (jsdom)

// Inline SVG, 24-unit viewBox, drawn with the 1.7 stroke of `svg.i`; decoration only (the button's own label is its name).
function Svg({ children }: { children: ReactNode }) {
  return <svg className="i" viewBox="0 0 24 24" aria-hidden="true">{children}</svg>;
}
const Plus = () => <Svg><path d="M12 5v14M5 12h14" /></Svg>;
const Caret = () => <Svg><path d="m7 9 5 5 5-5" /></Svg>;
const ChevronLeft = () => <Svg><path d="m15 6-6 6 6 6" /></Svg>;
// Two chevrons that point toward each other (fold everything) and away from each other (unfold everything).
const ChevronsIn = () => <Svg><path d="m7 5 5 5 5-5" /><path d="m7 19 5-5 5 5" /></Svg>;
const ChevronsOut = () => <Svg><path d="m7 10 5-5 5 5" /><path d="m7 14 5 5 5-5" /></Svg>;
const Search = () => <Svg><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4-4" /></Svg>;

/** The ids to show while filtering: what matches by name or kind, and the ancestors of a match (a match's own children only if they match too). */
function matchingIds(nodes: TreeNode[], needle: string): Set<number> {
  const out = new Set<number>();
  const walk = (node: TreeNode): boolean => {
    let hit = node.name.toLowerCase().includes(needle) || node.kind.toLowerCase().includes(needle);
    for (const child of node.children) if (walk(child)) hit = true; // every child, no short-circuit: each needs its own verdict
    if (hit) out.add(node.id);
    return hit;
  };
  nodes.forEach(walk);
  return out;
}

const only = (list: TreeNode[], visible: ReadonlySet<number> | null) => (visible ? list.filter((node) => visible.has(node.id)) : list);

/**
 * What a row needs to be picked (W7p). Made once per tree: the picks live in a store outside React and the handlers read the latest props
 * through refs, so nothing in here changes when a row is picked or the tree renders again.
 */
interface RowKit {
  store: PickStore;
  /** The id of the hidden word "picked": a picked row's link is described by it (its name stays the asset's name). */
  pickedId: string;
  click(e: MouseEvent<HTMLAnchorElement>, id: number): void;
  mouseDown(e: MouseEvent<HTMLAnchorElement>): void;
}

interface View {
  selectedId: number | null;
  onAddChild?: (id: number) => void;
  disabled?: boolean;
  /** Branches the user folded; a branch is open unless it is in here, so a node that gains its first child starts open. */
  collapsed: ReadonlySet<number>;
  /** Null when there is no filter. */
  visible: ReadonlySet<number> | null;
  toggle: (id: number) => void;
  /** Null for someone who may not move assets: the rows are plain links then. */
  kit: RowKit | null;
  /** Rows can be dragged: there is a `move` and the page is not busy. */
  draggable: boolean;
}

const NO_SUBSCRIBE = () => () => {};

/** For tests: called with the id of every row that renders, to show that picking re-renders the one row and not the tree. */
export const rowRenderProbe: { current: ((id: number) => void) | null } = { current: null };

/**
 * One row and, inside its `li`, the rows below it. A row is memoised on (node, view): `view` changes with the fold, the filter and the open
 * asset, not with the picks, which a row reads itself from the store, so picking an asset renders that row and no other.
 */
const Row = memo(function Row({ node, view }: { node: TreeNode; view: View }) {
  rowRenderProbe.current?.(node.id);
  const { kit, draggable } = view;
  const picked = useSyncExternalStore(kit ? kit.store.subscribe : NO_SUBSCRIBE, () => (kit ? kit.store.has(node.id) : false));
  const filtering = view.visible !== null;
  const kids = only(node.children, view.visible);
  const open = filtering || !view.collapsed.has(node.id); // a filter shows its matches even under a folded branch
  const selected = node.id === view.selectedId;
  const childrenId = `asset-children-${node.id}`;
  // The inner link and buttons are not drags of their own: a dragged link would carry a URL, and the row is what moves.
  const inner = draggable ? false : undefined;
  return (
    <li>
      <div
        className={selected ? "node is-selected" : "node"}
        data-asset-id={kit ? node.id : undefined}
        data-picked={picked ? "true" : undefined}
        draggable={draggable ? true : undefined}
      >
        {kids.length > 0 ? (
          <button
            type="button"
            className="twisty"
            aria-expanded={open}
            aria-controls={childrenId}
            aria-label={`Children of ${node.name}`}
            draggable={inner}
            disabled={filtering}
            onClick={() => view.toggle(node.id)}
          >
            <Caret />
          </button>
        ) : (
          <span className="twisty-sp" />
        )}
        <span className="node-icon"><Icon name={assetIcon(node)} /></span>
        <Link
          to={`/assets/${node.id}`}
          title={node.name}
          dir="auto"
          aria-current={selected ? "true" : undefined}
          aria-describedby={picked && kit ? kit.pickedId : undefined}
          draggable={inner}
          onClick={kit ? (e) => kit.click(e, node.id) : undefined}
          onMouseDown={kit?.mouseDown}
        >
          {node.name}
        </Link>
        <span className="kind">{node.kind}</span>
        {view.onAddChild && (
          <button type="button" className="add" aria-label={`Add child of ${node.name}`} title="Add child" draggable={inner} disabled={view.disabled} onClick={() => view.onAddChild!(node.id)}>
            <Plus />
          </button>
        )}
      </div>
      {kids.length > 0 && (
        // Folded is hidden, not removed, so the twisty's aria-controls always names an element.
        <ul id={childrenId} hidden={!open}>
          <Nodes nodes={kids} view={view} />
        </ul>
      )}
    </li>
  );
});

/** The rows of one level. `nodes` is already narrowed by the filter; the nested `ul` stays inside the parent's `li`. */
function Nodes({ nodes, view }: { nodes: TreeNode[]; view: View }) {
  return nodes.map((node) => <Row key={node.id} node={node} view={view} />);
}

/** What the Assets page hands the tree for moving assets (W7p). Absent for a role without assets.edit: no picking, no dragging, no slot, no M key. */
export interface AssetTreeMove {
  /** Raw ids (the picked set, or the single dragged row) and where they land; the page reduces them to roots, previews, warns and moves. */
  onDrop(ids: number[], target: DropTarget): void | Promise<void>;
  /** Opens Move to... for these ids; `opener` gets the focus back on Cancel. */
  onMoveTo(ids: number[], opener: HTMLElement | null): void;
  /**
   * Starts the latest move's Undo (Ctrl+Z / Cmd+Z on a row) and says whether it did: false when there is nothing to undo any more (the toast
   * is gone, it was done already) or the page is busy. Absent: the keys are left to the browser.
   */
  onUndo?(): boolean;
  /**
   * A NEW object after every successful move: the tree unpicks `ids` (the moved roots, and the picked rows inside them, which went along),
   * unfolds the way to `firstId` and focuses its link. It may arrive before the refetched asset list does (the tree waits for a new list,
   * or 250 ms, before it looks for the row). `line` is said on the tree's live line ("Moved 3 assets to Row A. Press Ctrl+Z to undo."); a
   * signal without one (an Undo) clears the line.
   */
  moved: { firstId: number; ids: number[]; line?: string } | null;
}

/** Ctrl+Z and Cmd+Z, but not Redo (Shift) or Alt. On a layout whose key is not a Latin letter (Arabic, Cyrillic) the physical key decides. */
function isUndoKey(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return false;
  const key = e.key.toLowerCase();
  return key === "z" || (!/^[a-z]$/.test(key) && e.code === "KeyZ");
}

/** The width right of the sidebar: the column's flex container. A container with no layout (jsdom) or no element yet gives the window's. */
const availableWidth = (column: HTMLElement | null) => column?.parentElement?.clientWidth || window.innerWidth;

/**
 * The width the user chose for the column (null: the CSS default), and what changes it. The choice is kept as made; the width shown follows
 * the room right of the sidebar, so a smaller window or a wider sidebar shows less and more room brings the choice back. Only the user's own
 * actions are saved.
 */
function useTreeWidth(column: RefObject<HTMLElement | null>) {
  const [chosen, setChosen] = useState<number | null>(readTreeWidth);
  const [available, setAvailable] = useState(() => availableWidth(column.current));
  const [measured, setMeasured] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ left: number; width: number | null } | null>(null); // the column's left edge, and the last width of this drag (null: no move yet)
  const room = () => availableWidth(column.current); // for the event handlers: the width as it is now, not as of the last render

  useEffect(() => {
    const update = () => setAvailable(availableWidth(column.current));
    update();
    window.addEventListener("resize", update);
    // A sidebar that is minimized or expanded changes the parent's width without a window resize.
    const parent = column.current?.parentElement;
    let observer: ResizeObserver | null = null;
    if (parent && typeof ResizeObserver === "function") {
      observer = new ResizeObserver(update);
      observer.observe(parent);
    }
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [column]);
  // The default width is a CSS token, so it is read from the layout, also while the column animates.
  useEffect(() => {
    const el = column.current;
    if (!el) return;
    const measure = () => setMeasured(Math.round(el.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [column]);

  const shown = chosen === null ? null : clampTreeWidth(chosen, available);
  const now = clampTreeWidth(shown ?? (measured || DEFAULT_WIDTH), available) ?? TREE_MIN;
  const choose = (px: number) => {
    const next = clampTreeWidth(px, room());
    if (next === null) return;
    setChosen(next);
    saveTreeWidth(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return; // Alt+Left is the browser's Back
    const step = e.shiftKey ? TREE_STEP_BIG : TREE_STEP;
    let next: number;
    if (e.key === "ArrowRight") next = now + step;
    else if (e.key === "ArrowLeft") next = now - step;
    else if (e.key === "Home") next = TREE_MIN;
    else if (e.key === "End") next = treeMax(room());
    else return;
    e.preventDefault();
    choose(next);
  };
  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    const el = column.current;
    if (e.button !== 0 || !el) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* a pointer that is already gone */ }
    drag.current = { left: el.getBoundingClientRect().left, width: null };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = clampTreeWidth(e.clientX - d.left, room());
    if (next === null) return;
    d.width = next;
    setChosen(next);
  };
  const endDrag = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* released with the pointer */ }
    setDragging(false);
    if (d.width !== null) saveTreeWidth(d.width); // a click that moved nothing must not turn the default into a chosen width
  };
  const reset = () => {
    clearTreeWidth();
    setChosen(null);
  };

  return {
    shown, now, max: treeMax(available), dragging,
    handle: { onKeyDown, onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag, onDoubleClick: reset },
  };
}

/**
 * The reserved line between the filter and the rows (W7p), always drawn for someone who may move assets so that nothing below it shifts:
 * a hint when nothing is picked (with a button to move the open asset), "N picked" with Move to... and Clear otherwise. It reads the picks
 * itself, so the tree does not render when a row is picked.
 */
function PickSlot({ store, open, disabled, onMoveTo, onClear }: {
  store: PickStore;
  /** The asset in the URL, if there is one: with nothing picked the slot offers to move that. */
  open: { id: number; name: string } | null;
  disabled: boolean;
  onMoveTo: (ids: number[], opener: HTMLElement) => void;
  onClear: () => void;
}) {
  const count = useSyncExternalStore(store.subscribe, () => store.getSnapshot().ids.size);
  const title = count > 0 ? `Move ${count === 1 ? "the picked asset" : `the ${count} picked assets`} to another place` : open ? `Move ${open.name} to another place` : undefined;
  return (
    <div className="tree-slot" role="group" aria-label="Selection">
      <span className={count > 0 ? "tree-slot-text tree-slot-count" : "tree-slot-text"}>{count > 0 ? `${count} picked` : "Ctrl-click to pick several"}</span>
      {(count > 0 || open) && (
        // aria-disabled, not disabled: a button that has the focus must not lose it when the page gets busy.
        <button
          type="button"
          className="tree-slot-btn"
          title={title}
          aria-disabled={disabled ? "true" : undefined}
          onClick={(e) => {
            if (disabled) return;
            const ids = count > 0 ? [...store.getSnapshot().ids] : open ? [open.id] : [];
            if (ids.length > 0) onMoveTo(ids, e.currentTarget);
          }}
        >
          Move to...
        </button>
      )}
      {count > 0 && <button type="button" className="tree-slot-btn" onClick={onClear}>Clear</button>}
    </div>
  );
}

/** How long after a move the tree waits for the refetched assets before it takes the signal that the tree is already current. */
const REVEAL_GRACE_MS = 250;

/** The first moved asset, waiting to be shown and focused. `nodes` is the tree as it was when the signal came. */
interface Reveal { id: number; nodes: TreeNode[]; settled: boolean; timer: ReturnType<typeof setTimeout> }

/**
 * The asset tree as its own column (option B): a title, the top-level +, Collapse all / Expand all and a toggle, then a filter and the
 * tree. The column can be minimized to a strip with just the toggle (remembered in localStorage); the branches fold with a twisty each,
 * and which are folded is remembered too. Selecting an asset unfolds the way to it. A handle on the right edge resizes the column
 * (drag, arrow keys, double click for the default); the width is remembered too.
 *
 * With `move` (someone who may change assets) the rows can also be picked (Ctrl/Cmd-click, Shift-click, Space, Shift+arrows) and dragged
 * onto a row or the area below the last one; the page does the moving. The picks are called "picked": "selected" is the asset in the URL.
 */
export function AssetTree({ nodes, selectedId, onAddChild, onAddTop, disabled, loading, move }: {
  nodes: TreeNode[];
  /** The asset in the URL (null: none). A node is a link to its page, so there is no select callback. */
  selectedId: number | null;
  /** Present for someone who may change assets: a + on every node. */
  onAddChild?: (id: number) => void;
  /** Present for someone who may change assets: a + in the header that adds a top-level asset. */
  onAddTop?: () => void;
  /** Disables the + buttons (the page is busy with something that must not get a dialog next to it). */
  disabled?: boolean;
  /** The asset list is on its way: the same column (its width, its state, its handle) with placeholders where the filter and the rows will be. */
  loading?: boolean;
  /** Present for someone who may change assets (W7p): picking rows, dragging them, Move to.... While `disabled` rows can still be picked but not dragged. */
  move?: AssetTreeMove;
}) {
  const [state, setState] = useState<ColumnState>(() => (readStored(KEY) === "minimized" ? "minimized" : "expanded"));
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(readFolded);
  const minimized = state === "minimized";
  const column = useRef<HTMLElement>(null);
  const width = useTreeWidth(column);
  const needle = filter.trim().toLowerCase();
  const visible = useMemo(() => (needle ? matchingIds(nodes, needle) : null), [nodes, needle]);
  const foldable = useMemo(() => new Set(foldableIds(nodes)), [nodes]);
  // The way to the selection as text, so that a new `nodes` array with the same path is not a change.
  const pathKey = useMemo(() => (selectedId === null ? "" : ancestorIds(nodes, selectedId).join(",")), [nodes, selectedId]);

  // Forget folds of nodes that are gone or have lost their children (such a node starts open when it gains one). Not while the list is loading.
  useEffect(() => {
    if (nodes.length === 0) return;
    setCollapsed((prev) => {
      const kept = [...prev].filter((id) => foldable.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [nodes, foldable]);
  useEffect(() => { saveFolded(collapsed); }, [collapsed]);
  // Keyed on the selection and its path, not on `nodes` or `collapsed`: a create, rename or delete anywhere gives `nodes` a new identity,
  // which must not re-open what Collapse all just folded. A new selection or a reparent still unfolds the way to it.
  useEffect(() => {
    const path = pathKey ? pathKey.split(",").map(Number) : [];
    setCollapsed((prev) => {
      if (!path.some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      path.forEach((id) => next.delete(id));
      return next;
    });
  }, [selectedId, pathKey]);

  const toggleColumn = () => {
    const next: ColumnState = minimized ? "expanded" : "minimized";
    setState(next);
    writeStored(KEY, next);
  };
  // Stable, so that `view` (and with it every memoised row) changes only when the fold, the filter or the open asset does.
  const toggleBranch = useCallback((id: number) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  }), []);
  const unfold = useCallback((ids: readonly number[]) => setCollapsed((prev) => {
    if (!ids.some((id) => prev.has(id))) return prev;
    const next = new Set(prev);
    ids.forEach((id) => next.delete(id));
    return next;
  }), []);
  const collapseAll = () => setCollapsed(new Set(foldable));
  const expandAll = () => setCollapsed(new Set());
  const addChild = useCallback((id: number) => {
    unfold([id]);
    onAddChild?.(id); // the new child must not appear inside a folded branch
  }, [unfold, onAddChild]);

  // ---- W7p: picking, dragging, Move to... ----
  const movable = move !== undefined;
  const draggable = movable && !disabled;
  const [store] = useState(createPickStore);
  const pickedId = useId();
  const liveLine = useRef<HTMLDivElement>(null);
  const hinted = useRef(false); // "Press M to move" is said once, with the first pick
  const byId = useMemo(() => {
    const all = new Map<number, TreeNode>();
    const walk = (list: readonly TreeNode[]) => list.forEach((node) => { all.set(node.id, node); walk(node.children); });
    walk(nodes);
    return all;
  }, [nodes]);
  // Everything the handlers below read, as of the last render: the handlers themselves are made once.
  const latest = useRef({ nodes, byId, collapsed, visible, move, disabled });
  latest.current = { nodes, byId, collapsed, visible, move, disabled };

  // The one live line of the tree. Written to the DOM directly: no React child, so announcing never renders the rows.
  const announce = useCallback((text: string) => { if (liveLine.current) liveLine.current.textContent = text; }, []);
  const focusLink = useCallback((id: number) => {
    const link = column.current?.querySelector<HTMLElement>(`[data-asset-id="${id}"] a`);
    link?.focus();
    return link != null;
  }, []);
  const say = useCallback((event: PickEvent) => {
    const first = (event.kind === "on" || event.kind === "range") && !hinted.current;
    if (first) hinted.current = true;
    announce(pickLine(event, store.getSnapshot().ids.size, first));
  }, [announce, store]);
  const clearPicks = useCallback(() => {
    const { nodes: all, collapsed: folded, visible: shown } = latest.current;
    const { ids, anchor } = store.getSnapshot();
    if (ids.size === 0) return;
    // The Clear button disappears with the picks: the focus goes to the row the person last touched, or to the first picked row on screen.
    const order = visibleOrder(all, folded, shown);
    const back = anchor !== null && order.includes(anchor) ? anchor : order.find((id) => ids.has(id));
    store.clear();
    say({ kind: "clear" });
    if (back !== undefined) focusLink(back);
  }, [store, say, focusLink]);

  const kit = useMemo<RowKit>(() => ({
    store,
    pickedId,
    // A Shift press on a link would start a text selection across the rows (and drag it along).
    mouseDown(e) { if (e.shiftKey) e.preventDefault(); },
    click(e, id) {
      if (e.altKey) return; // the browser's own (download)
      const { nodes: all, byId: names, collapsed: folded, visible: shown } = latest.current;
      const name = names.get(id)?.name ?? "";
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        e.preventDefault(); // picking must not open the asset (react-router navigates only when this click was not prevented)
        e.currentTarget.focus({ preventScroll: true }); // the mousedown did not focus it when Shift was held; the keys continue from this row
        if (e.shiftKey) {
          store.pickRange(visibleOrder(all, folded, shown), id);
          say({ kind: "range", count: store.getSnapshot().ids.size });
        } else {
          const was = store.has(id);
          store.toggle(id);
          say({ kind: was ? "off" : "on", name });
        }
        return;
      }
      // A plain click opens the asset (the link does that) and ends the picking; the opened row is the anchor of the next Shift-click.
      const had = store.getSnapshot().ids.size > 0;
      store.clear(id);
      if (had) say({ kind: "clear" });
    },
  }), [store, pickedId, say]);

  const onTreeKeyDown = useCallback((e: KeyboardEvent<HTMLUListElement>) => {
    const link = e.target instanceof Element ? e.target.closest<HTMLElement>("a") : null;
    const row = link?.closest<HTMLElement>("[data-asset-id]");
    if (!link || !row) return; // a twisty or + keeps its own keys
    const { nodes: all, byId: names, collapsed: folded, visible: shown, move: mover, disabled: busy } = latest.current;
    if (isUndoKey(e)) { // before the modifier check below: Ctrl+Z is how the keyboard reaches the Undo of a move (the toast's button is far away in the tab order)
      if (mover?.onUndo && !busy && mover.onUndo()) e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey || !mover) return;
    const id = Number(row.dataset.assetId);
    const openMove = () => {
      if (busy) return;
      const picks = store.getSnapshot().ids;
      mover.onMoveTo(picks.size > 0 ? [...picks] : [id], link);
    };
    if (e.key === " " && !e.shiftKey) {
      e.preventDefault(); // a link does not use Space, the page would scroll
      const was = store.has(id);
      store.toggle(id);
      say({ kind: was ? "off" : "on", name: names.get(id)?.name ?? "" });
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const order = visibleOrder(all, folded, shown);
      const to = order[order.indexOf(id) + (e.key === "ArrowDown" ? 1 : -1)];
      if (order.indexOf(id) < 0 || to === undefined) return;
      if (e.shiftKey) {
        const anchor = store.getSnapshot().anchor;
        if (anchor === null || !order.includes(anchor)) store.pick(id); // a range needs a start: the row the key was pressed on
        store.pickRange(order, to);
        say({ kind: "range", count: store.getSnapshot().ids.size });
      }
      focusLink(to);
    } else if ((e.key === "m" || e.key === "M") || e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      openMove();
    } else if (e.key === "Escape" && store.getSnapshot().ids.size > 0) {
      e.preventDefault();
      store.clear();
      say({ kind: "clear" });
    }
  }, [store, say, focusLink]);

  const dnd = useMemo(() => createTreeDnd({
    nodes: () => latest.current.nodes,
    picked: () => store.getSnapshot().ids,
    canDrag: () => latest.current.move !== undefined && !latest.current.disabled,
    drop: (ids, target) => latest.current.move?.onDrop(ids, target),
    announce,
    expand: (id) => unfold([id]),
  }), [store, announce, unfold]);
  useEffect(() => () => dnd.cancel(), [dnd]);

  // The picks follow the list: an asset that is deleted (or gone from the list) is no longer picked.
  useEffect(() => { store.prune(new Set(byId.keys())); }, [store, byId]);

  // After a move the page hands over a NEW `moved` object: the picks are over, the way to the first moved asset is unfolded and its link is
  // focused (the Move to... button is gone with the picks, and a dropped row has moved away from under the pointer). The refetched tree can
  // reach this component after the signal (the query client tells its observers a tick later), so the asset is not looked for until a new
  // tree arrives or REVEAL_GRACE_MS has passed (then the tree was current already).
  const movedSignal = move?.moved ?? null;
  // The moved roots and everything below them: a picked row inside a moved root went along, so its pick is over too.
  const unpickMoved = useCallback((ids: readonly number[]) => {
    if (store.getSnapshot().ids.size === 0) return;
    const gone = new Set<number>();
    const take = (node: TreeNode) => { gone.add(node.id); node.children.forEach(take); };
    for (const id of ids) {
      const node = byId.get(id);
      if (node) take(node);
      else gone.add(id);
    }
    store.unpick(gone);
  }, [store, byId]);
  const lastSignal = useRef(movedSignal); // what was there at mount is not a move
  const reveal = useRef<Reveal | null>(null);
  const [settledTick, setSettledTick] = useState(0);
  useEffect(() => {
    if (movedSignal !== lastSignal.current) {
      lastSignal.current = movedSignal;
      if (movedSignal) {
        unpickMoved(movedSignal.ids);
        announce(movedSignal.line ?? "");
        if (reveal.current) clearTimeout(reveal.current.timer);
        const fresh: Reveal = {
          id: movedSignal.firstId,
          nodes,
          settled: false,
          timer: setTimeout(() => { fresh.settled = true; setSettledTick((n) => n + 1); }, REVEAL_GRACE_MS),
        };
        reveal.current = fresh;
      }
    }
    const pending = reveal.current;
    if (!pending || !(pending.settled || nodes !== pending.nodes)) return;
    const done = () => { clearTimeout(pending.timer); reveal.current = null; };
    if (minimized) return done(); // nothing to focus in a closed column
    if (!byId.has(pending.id)) return; // not in the list (yet)
    if (visible && !visible.has(pending.id)) { setFilter(""); return; } // the filter hides it: show the row rather than lose the focus
    const way = ancestorIds(nodes, pending.id);
    if (way.some((id) => collapsed.has(id))) { unfold(way); return; }
    if (focusLink(pending.id)) done();
  }, [movedSignal, nodes, byId, collapsed, visible, minimized, settledTick, store, unfold, focusLink, announce, unpickMoved]);
  useEffect(() => () => { if (reveal.current) clearTimeout(reveal.current.timer); }, []);

  const noFold = visible !== null || foldable.size === 0; // a filter has its own view of the tree
  const toggleName = minimized ? "Expand asset tree" : "Minimize asset tree";
  const open = selectedId === null ? undefined : byId.get(selectedId);
  const view = useMemo<View>(
    () => ({ selectedId, onAddChild: onAddChild ? addChild : undefined, disabled, collapsed, visible, toggle: toggleBranch, kit: movable ? kit : null, draggable }),
    [selectedId, onAddChild, addChild, disabled, collapsed, visible, toggleBranch, movable, kit, draggable],
  );
  const treeEvents = movable
    ? {
        onKeyDown: onTreeKeyDown,
        onDragStart: dnd.dragStart,
        onDragEnter: (e: DragEvent<HTMLUListElement>) => dnd.dragEnter(e),
        onDragOver: (e: DragEvent<HTMLUListElement>) => dnd.dragOver(e),
        onDragLeave: dnd.dragLeave,
        onDrop: (e: DragEvent<HTMLUListElement>) => dnd.drop(e),
      }
    : undefined;
  return (
    <section
      ref={column}
      className={width.dragging ? "tree-col is-resizing" : "tree-col"}
      aria-label="Asset tree"
      data-state={state}
      style={width.shown === null ? undefined : ({ "--tree-user-w": `${width.shown}px` } as CSSProperties)}
    >
      {/* With thousands of assets a keyboard user would otherwise pass every row before the page's own controls. The router owns the hash, so the click moves focus itself. */}
      {!minimized && (
        <a className="skip-link" href="#asset-detail" onClick={(event) => { event.preventDefault(); document.getElementById("asset-detail")?.focus(); }}>
          Skip the tree
        </a>
      )}
      <div className="tree-head">
        {!minimized && <p className="tree-title" title="Assets Tree">Assets Tree</p>}
        {!minimized && onAddTop && (
          <button type="button" className="icon-btn" aria-label="Add a top-level asset" title="Add a top-level asset" disabled={disabled} onClick={onAddTop}>
            <Plus />
          </button>
        )}
        {!minimized && (
          <>
            <button type="button" className="icon-btn" aria-label="Collapse all" title="Collapse all" disabled={noFold} onClick={collapseAll}>
              <ChevronsIn />
            </button>
            <button type="button" className="icon-btn" aria-label="Expand all" title="Expand all" disabled={noFold} onClick={expandAll}>
              <ChevronsOut />
            </button>
            {/* After the tree's own controls (they keep their place in the tab order), before the toggle; NavLink marks it current on its page. */}
            <NavLink to="/assets/kinds" className="icon-btn" aria-label="Asset kinds" title="Asset kinds">
              <Icon name="layers" />
            </NavLink>
          </>
        )}
        <button type="button" className="icon-btn tree-toggle" aria-controls="asset-tree-body" aria-expanded={!minimized} aria-label={toggleName} title={toggleName} onClick={toggleColumn}>
          <ChevronLeft />
        </button>
      </div>
      <div className="tree-body" id="asset-tree-body" hidden={minimized}>
        {loading ? (
          // The filter's slot and the rows are one region, so neither shows before the 150 ms delay is over.
          <SkeletonRegion label="Loading the asset tree">
            <div className="tree-filter"><Skeleton variant="block" height={34} /></div>
            {movable && <div className="tree-slot" aria-hidden="true" />}
            <div className="tree-scroll"><TreeSkeleton /></div>
          </SkeletonRegion>
        ) : (
          <>
            {nodes.length > 0 && (
              <div className="tree-filter">
                <Search />
                <label className="sr-only" htmlFor="asset-tree-filter">Filter assets</label>
                <input id="asset-tree-filter" type="search" placeholder="Filter by name or kind" autoComplete="off" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
            )}
            {move && nodes.length > 0 && (
              <PickSlot
                store={store}
                open={open ? { id: open.id, name: open.name } : null}
                disabled={!!disabled}
                onMoveTo={(ids, opener) => move.onMoveTo(ids, opener)}
                onClear={clearPicks}
              />
            )}
            <div className={movable ? "tree-scroll tree-scroll-move" : "tree-scroll"}>
              {visible && visible.size === 0 && <p className="muted tree-empty">No assets match the filter.</p>}
              {nodes.length > 0 && (!visible || visible.size > 0) && (
                <ul className="tree" {...treeEvents}>
                  <Nodes nodes={only(nodes, visible)} view={view} />
                </ul>
              )}
              {/* The top level, last: the area below the last row. Always drawn for an editor (its text only while dragging), so nothing shifts when a drag starts. */}
              {movable && nodes.length > 0 && (
                <div
                  className="tree-root-drop"
                  aria-hidden="true"
                  onDragEnter={(e) => dnd.dragEnter(e, true)}
                  onDragOver={(e) => dnd.dragOver(e, true)}
                  onDragLeave={dnd.dragLeave}
                  onDrop={(e) => dnd.drop(e, true)}
                >
                  <span className="tree-root-hint">Drop here to move to the top level</span>
                </div>
              )}
            </div>
          </>
        )}
        {movable && (
          <>
            {/* The word a picked row's link is described by, and the tree's one live line (role-less: a role per item would announce twice). */}
            <span id={pickedId} className="sr-only">picked</span>
            <div ref={liveLine} className="sr-only" aria-live="polite" aria-atomic="true" />
          </>
        )}
      </div>
      {!minimized && (
        <div
          className="tree-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the tree column"
          aria-valuemin={TREE_MIN}
          aria-valuemax={width.max}
          aria-valuenow={width.now}
          tabIndex={0}
          {...width.handle}
        />
      )}
    </section>
  );
}
