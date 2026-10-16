import { getBezierPath, Handle, Position, type ConnectionLineComponentProps, type Node, type NodeProps } from "@xyflow/react";
import { memo, type KeyboardEvent, type MouseEvent, type ReactElement } from "react";
import { Icon } from "../Icon";
import type {
  AssetNodeData, ClusterNodeData, MoreNodeData, NodeActions, PointNodeData, SourceNodeData, UnidentifiedNodeData,
} from "../../lib/graph";
import { protocolLabel, sourceStatus } from "../../lib/graphStatus";

/**
 * The two handles every node has are only where the edges attach: neither can start or end a connection (W12a). The one handle that can is the "+" of an
 * asset node (`AddHandle`); without this, a press on the little dot of any node would start a line the page must then throw away.
 */
function Handles({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectableStart={false} isConnectableEnd={false} />
      {children}
      <Handle type="source" position={Position.Right} isConnectableStart={false} isConnectableEnd={false} />
    </>
  );
}

// `nodrag` keeps a click on a button from starting a drag; stopPropagation keeps it from also selecting the node.
const press = (action: (event: MouseEvent<HTMLElement>) => void) => (event: MouseEvent<HTMLElement>) => {
  event.stopPropagation();
  action(event);
};

/**
 * `label` (W12b) replaces the name "Expand X" / "Collapse X": an asset's toggle hides its sub-assets and must not read like the one of a group or a source.
 * `fold` draws a chevron instead of the minus and plus (the asset's fold: its "+" must not be read as the add handle's); the stylesheet turns it down while the
 * sub-assets show and leaves it pointing right while they are hidden (`data-folded`).
 */
function Toggle({ id, name, expanded, onToggle, label, fold }: { id: string; name: string; expanded: boolean; onToggle?: NodeActions["onToggle"]; label?: string; fold?: boolean }) {
  if (!onToggle) return null;
  return (
    <button
      type="button" className={fold ? "nodrag gnode-fold" : "nodrag"} data-folded={fold && !expanded ? "true" : undefined}
      aria-label={label ?? `${expanded ? "Collapse" : "Expand"} ${name}`} onClick={press(() => onToggle(id))}
    >
      {fold ? <Icon name="chevron" /> : expanded ? "−" : "+"}
    </button>
  );
}

/**
 * W12a: the small menu button of a mapped point or group. It is NOT a row menu: a menu inside a React Flow node would leak its arrow, Enter and
 * Space keys, its hover and its focus into the node and the canvas, so the button only reports its own element (`onMenu`) and the page opens the
 * node's context menu, outside the canvas, next to it. `nokey` is React Flow's own opt-out of the node's key handling. 20px and absolutely placed
 * by the stylesheet (`gnode-menu-btn`), so the node is no taller; the host node carries `gnode-hasmenu`, which leaves the title room for it.
 */
function MenuButton({ name, onMenu }: { name: string; onMenu?: NodeActions["onMenu"] }) {
  if (!onMenu) return null;
  return (
    <button
      type="button" className="nodrag nokey icon-btn gnode-menu-btn" aria-label={`Mapping actions for ${name}`} aria-haspopup="menu"
      onClick={press((event) => onMenu(event.currentTarget))}
    >
      <Icon name="more" />
    </button>
  );
}

/**
 * `wait` (W12a): New asset… opens the asset form, which needs the asset list; until it is read the button says so (aria-disabled, never `disabled`:
 * it may hold the focus). It still takes the click: the page answers it with the reason.
 */
function MapButtons({ id, name, onMap, onNewAsset, wait }: { id: string; name: string; wait?: boolean } & Pick<NodeActions, "onMap" | "onNewAsset">) {
  if (!onMap && !onNewAsset) return null;
  return (
    <div className="row">
      {onMap && <button type="button" className="nodrag" aria-label={`Map ${name} to asset…`} onClick={press(() => onMap(id))}>Map…</button>}
      {onNewAsset && (
        <button type="button" className="nodrag" aria-label={`New asset from ${name}…`} aria-disabled={wait || undefined} onClick={press(() => onNewAsset(id))}>New asset…</button>
      )}
    </div>
  );
}

/**
 * W12a: the "+" on an asset node, a source Handle (so that a drag from it is a connection the page can read: it opens New sub-asset where it is
 * released on the empty canvas) drawn as a small round control at the node's top right corner (`gnode-add`, hidden until the node is hovered, focused
 * or selected). A click, Enter or Space opens the same dialog, which is also what keyboard and touch use: neither can drag. The handle's own
 * `onClick` REPLACES the library's click-to-connect, so a click is only this. `nokey` keeps the keys off the node and the canvas; Enter and Space
 * are taken here and every other key (Tab, the menu key) goes on. `wait`: see MapButtons.
 */
function AddHandle({ id, name, onAdd, wait }: { id: string; name: string; onAdd?: NodeActions["onAdd"]; wait?: boolean }) {
  if (!onAdd) return null;
  const add = () => onAdd(id);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    add();
  };
  return (
    <Handle
      id="add" type="source" position={Position.Right} isConnectableEnd={false}
      role="button" tabIndex={0} aria-label={`Add a sub-asset under ${name}`} aria-disabled={wait || undefined}
      className="nodrag nokey gnode-add" onClick={press(add)} onKeyDown={onKeyDown}
    >
      <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
    </Handle>
  );
}

/**
 * The line drawn while the "+" is dragged: dashed, in the accent (`gconnect`, graph-nodes.css). The page's `isValidConnection` is always false, so it
 * never turns into an edge; its only use is to show that a release on the empty canvas will do something.
 */
export function AddConnectionLine({ fromX, fromY, toX, toY, fromPosition, toPosition }: ConnectionLineComponentProps) {
  const [path] = getBezierPath({ sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition, targetX: toX, targetY: toY, targetPosition: toPosition });
  return <path className="gconnect" d={path} />;
}

function SourceNode({ id, data }: NodeProps<Node<SourceNodeData, "source">>) {
  const { source, expanded, onToggle, onSelect, onCreateAssets, onRemove, groups = 0, seen } = data;
  const status = sourceStatus(source);
  return (
    <div className={`gnode gnode-source ${source.origin}`}>
      <Handles>
        <div className="row">
          <div className="node-title">{source.name}</div>
          <Toggle id={id} name={source.name} expanded={expanded} onToggle={onToggle} />
        </div>
        {/* One row: Details, Create assets… and the bin (Remove has no text) fit the 220 px node; the row still wraps, a second line being better than a clipped one. Keyboard order is the order here. */}
        {(onSelect || onCreateAssets || onRemove) && (
          <div className="row gnode-actions">
            {onSelect && (
              <button type="button" className="nodrag" aria-label={`Details for ${source.name}`} onClick={press(() => onSelect(id))}>Details</button>
            )}
            {onCreateAssets && (
              <button type="button" className="nodrag" aria-label={`Create assets for ${groups} ${groups === 1 ? "group" : "groups"} of ${source.name}`} onClick={press(() => onCreateAssets(id))}>Create assets…</button>
            )}
            {onRemove && (
              <button type="button" className="nodrag quiet gnode-remove" aria-label={`Remove ${source.name} from Discovery`} title="Remove" onClick={press(() => onRemove(id))}><Icon name="trash" /></button>
            )}
          </div>
        )}
        {/* The dot and the protocol replace the connector word in the facts line, so the node is no taller (SOURCE_H is measured for this line); the status WORD stays in the text, the dot is decoration. */}
        <div className="muted gnode-facts">
          <span className={`gdot gdot-${status.key}`} aria-hidden="true" title={status.label} />{" "}
          <span className="gproto">{protocolLabel(source.connector_type)}</span>
          {` ${source.origin} · ${source.status} · ${source.point_count} points`}
        </div>
        {seen && <div className="muted gnode-seen" title={seen}>{seen}</div>}
        {source.needs_credentials && <span className="badge">needs credentials</span>}
      </Handles>
    </div>
  );
}

function ClusterNode({ id, data }: NodeProps<Node<ClusterNodeData, "cluster">>) {
  const { label, count, mappedCount, expanded, onToggle, onMap, onNewAsset, onMenu, formWait, visibleCount, shownCount } = data;
  const share = count > 0 ? Math.min(100, Math.round((mappedCount / count) * 100)) : 0;
  // W12b: an open group that draws one page of its points says so. The line exists only then, and an open paged group has empty rows beside and below it, so the node may be a line taller.
  const paged = expanded && visibleCount !== undefined && shownCount !== undefined && shownCount < visibleCount;
  return (
    <div className={onMenu ? "gnode gnode-cluster gprogress-host gnode-hasmenu" : "gnode gnode-cluster gprogress-host"}>
      <Handles>
        <div className={onMenu ? "row gnode-head" : "row"}>
          <div className="node-title">{`${label} (${count})`}</div>
          <Toggle id={id} name={label} expanded={expanded} onToggle={onToggle} />
        </div>
        <MenuButton name={label} onMenu={onMenu} />
        <div className="muted">{mappedCount} mapped</div>
        {paged && <div className="muted">{`${shownCount} of ${visibleCount} shown`}</div>}
        <MapButtons id={id} name={label} onMap={onMap} onNewAsset={onNewAsset} wait={formWait} />
        {/* The share of mapped points as a 3px strip on the bottom edge: absolutely placed, so it adds no height. The words stay in the line above. */}
        <span className="gprogress" aria-hidden="true" style={{ width: `${share}%` }} title={`${mappedCount} of ${count} mapped`} />
      </Handles>
    </div>
  );
}

function PointNode({ id, data }: NodeProps<Node<PointNodeData, "point">>) {
  const { point, onMap, onNewAsset, onMenu } = data;
  const detail = [point.unit_hint, point.mapped_metric && `→ ${point.mapped_metric}`].filter(Boolean).join(" ");
  return (
    <div className={onMenu ? "gnode gnode-point gnode-hasmenu" : "gnode gnode-point"}>
      <Handles>
        <div className="node-title">{point.name}</div>
        <MenuButton name={point.name} onMenu={onMenu} />
        {detail && <div className="muted">{detail}</div>}
        <MapButtons id={id} name={point.name} onMap={onMap} onNewAsset={onNewAsset} />
      </Handles>
    </div>
  );
}

/**
 * W12b: an asset with sub-assets has a toggle on its title row (a chevron: down while they show, right while hidden), and a hidden subtree that holds mapped points says
 * how many in a small badge on the SAME row, so the node keeps its height (asset rows are `ROW` apart). A node with neither keeps the bare title as before.
 */
function AssetNode({ id, data }: NodeProps<Node<AssetNodeData, "asset">>) {
  const { asset, children = 0, collapsed = false, mappedInside = 0, onToggleAssets } = data;
  const toggle = children > 0 && onToggleAssets !== undefined;
  const badge = collapsed && mappedInside > 0;
  return (
    <div className="gnode gnode-asset">
      <Handles>
        {toggle || badge ? (
          <div className="row">
            <div className="node-title">{asset.name}</div>
            {badge && <span className="gnode-mapped" title={`${mappedInside} mapped inside`}>{`${mappedInside} mapped`}</span>}
            {toggle && (
              <Toggle id={id} name={asset.name} expanded={!collapsed} onToggle={onToggleAssets} label={`${collapsed ? "Show" : "Hide"} sub-assets of ${asset.name}`} fold />
            )}
          </div>
        ) : (
          <div className="node-title">{asset.name}</div>
        )}
      </Handles>
      {/* After the two handles above on purpose: an edge with no sourceHandle (every asset-to-asset edge) starts at the FIRST source handle in the DOM, which must stay the default one. */}
      <AddHandle id={id} name={asset.name} onAdd={data.onAdd} wait={data.formWait} />
    </div>
  );
}

/**
 * W12b: the "Show 50 more (70 left)" control at the end of a paged group's points. It stands in the point column, a row like a point but with no handles (no edge
 * joins it) and no label of its own: the builder made its wrapper unfocusable, so the one stop is the button, named for the group. `nokey` is React Flow's own
 * opt-out of the node's key handling, so Enter and Space on the button are the button's; a press never selects the node.
 */
function MoreNode({ data }: NodeProps<Node<MoreNodeData, "more">>) {
  const { clusterId, label, left, step, onMore } = data;
  return (
    <div className="gnode gnode-more">
      <button type="button" className="nodrag nokey" aria-label={`Show ${step} more points of ${label}, ${left} left`} onClick={press(() => onMore?.(clusterId))}>
        {`Show ${step} more (${left} left)`}
      </button>
    </div>
  );
}

function UnidentifiedNode({ data }: NodeProps<Node<UnidentifiedNodeData, "unidentified">>) {
  return (
    <div className="gnode gnode-unidentified">
      <Handles>
        <div className="node-title">{`${data.host}:${data.port} — unidentified service`}</div>
      </Handles>
    </div>
  );
}

/**
 * W12b speed: React Flow passes every node its absolute position, its stacking order and whether it is being dragged, and re-renders the node whenever
 * one of them changes (a drag, a compaction of rows, Tidy layout), though none of them is drawn by a node's body. A node is the same when what it DOES
 * draw is: its id and type, its `data` (the page and the graph reuse the old object of an unchanged node, so the reference is the test), whether it
 * is selected, and its measured size. Everything else is ignored on purpose; a prop added here later must be one the bodies read.
 */
type Watched = Pick<NodeProps, "id" | "type" | "data" | "selected" | "width" | "height">;
const sameNode = (a: Watched, b: Watched) =>
  a.id === b.id && a.type === b.type && a.data === b.data && a.selected === b.selected && a.width === b.width && a.height === b.height;
const memoNode = <Props extends Watched>(component: (props: Props) => ReactElement) => memo(component, sameNode);

/** Defined once at module level: React Flow warns (and re-mounts every node) if this object changes between renders. */
export const nodeTypes = {
  source: memoNode(SourceNode),
  cluster: memoNode(ClusterNode),
  point: memoNode(PointNode),
  asset: memoNode(AssetNode),
  unidentified: memoNode(UnidentifiedNode),
  more: memoNode(MoreNode),
};
