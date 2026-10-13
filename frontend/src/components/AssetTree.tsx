import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { Link } from "react-router";
import { Icon } from "./Icon";
import { Skeleton, SkeletonRegion, TreeSkeleton } from "./Skeleton";
import { assetIcon } from "../lib/assetIcons";
import { readStored, writeStored } from "../lib/sidebarState";
import { ancestorIds, type TreeNode } from "../lib/tree";
import { foldableIds, readFolded, saveFolded } from "../lib/treeFold";
import { TREE_MIN, TREE_STEP, TREE_STEP_BIG, clampTreeWidth, clearTreeWidth, readTreeWidth, saveTreeWidth, treeMax } from "../lib/treeWidth";

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

interface View {
  selectedId: number | null;
  onAddChild?: (id: number) => void;
  disabled?: boolean;
  /** Branches the user folded; a branch is open unless it is in here, so a node that gains its first child starts open. */
  collapsed: ReadonlySet<number>;
  /** Null when there is no filter. */
  visible: ReadonlySet<number> | null;
  toggle: (id: number) => void;
}

/** The rows of one level. `nodes` is already narrowed by the filter; the nested `ul` stays inside the parent's `li`. */
function Nodes({ nodes, view }: { nodes: TreeNode[]; view: View }) {
  const filtering = view.visible !== null;
  return nodes.map((node) => {
    const kids = only(node.children, view.visible);
    const open = filtering || !view.collapsed.has(node.id); // a filter shows its matches even under a folded branch
    const selected = node.id === view.selectedId;
    const childrenId = `asset-children-${node.id}`;
    return (
      <li key={node.id}>
        <div className={selected ? "node is-selected" : "node"}>
          {kids.length > 0 ? (
            <button
              type="button"
              className="twisty"
              aria-expanded={open}
              aria-controls={childrenId}
              aria-label={`Children of ${node.name}`}
              disabled={filtering}
              onClick={() => view.toggle(node.id)}
            >
              <Caret />
            </button>
          ) : (
            <span className="twisty-sp" />
          )}
          <span className="node-icon"><Icon name={assetIcon(node)} /></span>
          <Link to={`/assets/${node.id}`} title={node.name} dir="auto" aria-current={selected ? "true" : undefined}>
            {node.name}
          </Link>
          <span className="kind">{node.kind}</span>
          {view.onAddChild && (
            <button type="button" className="add" aria-label={`Add child of ${node.name}`} title="Add child" disabled={view.disabled} onClick={() => view.onAddChild!(node.id)}>
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
  // The default width is a CSS token (248px in a narrow window), so it is read from the layout, also while the column animates.
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
 * The asset tree as its own column (option B): a title, the top-level +, Collapse all / Expand all and a toggle, then a filter and the
 * tree. The column can be minimized to a strip with just the toggle (remembered in localStorage); the branches fold with a twisty each,
 * and which are folded is remembered too. Selecting an asset unfolds the way to it. A handle on the right edge resizes the column
 * (drag, arrow keys, double click for the default); the width is remembered too.
 */
export function AssetTree({ nodes, selectedId, onAddChild, onAddTop, disabled, loading }: {
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
  const toggleBranch = (id: number) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const collapseAll = () => setCollapsed(new Set(foldable));
  const expandAll = () => setCollapsed(new Set());
  const addChild = onAddChild && ((id: number) => {
    setCollapsed((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    onAddChild(id); // the new child must not appear inside a folded branch
  });

  const noFold = visible !== null || foldable.size === 0; // a filter has its own view of the tree
  const toggleName = minimized ? "Expand asset tree" : "Minimize asset tree";
  const view: View = { selectedId, onAddChild: addChild, disabled, collapsed, visible, toggle: toggleBranch };
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
            <div className="tree-scroll">
              {visible && visible.size === 0 && <p className="muted tree-empty">No assets match the filter.</p>}
              {nodes.length > 0 && (!visible || visible.size > 0) && (
                <ul className="tree">
                  <Nodes nodes={only(nodes, visible)} view={view} />
                </ul>
              )}
            </div>
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
