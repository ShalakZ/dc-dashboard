import { getBezierPath, Handle, Position, type ConnectionLineComponentProps, type Node, type NodeProps } from "@xyflow/react";
import { memo, useMemo, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode } from "react";
import type { GraphSource } from "../../api/types";
import { Icon, type IconName } from "../Icon";
import { countNumber, isNotSeen, moveOfferFor, seenCard } from "../../lib/graph";
import type {
  AssetNodeData, ClusterNodeData, MoreNodeData, NodeActions, PointNodeData, SourceNodeData, UnidentifiedNodeData,
} from "../../lib/graph";
import { assetIcon } from "../../lib/assetIcons";
import { clusterIcon, metricIcon, pointMetric, protocolIcon } from "../../lib/graphIcons";
import { protocolLabel, sourceAddress, sourceStatus, sourceTitle } from "../../lib/graphStatus";

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
 * W12c: the drawing before a node's title, decoration only (`aria-hidden`; the title is the name). `data-icon` carries the icon's name so a test or a spec can say
 * which one a node chose without reading the paths. 16px, `--text-2`, by the stylesheet (`.gicon`); a modifier class (`gsrc-tile`) lets the source card dress it as a tile.
 */
function NodeIcon({ name, className }: { name: IconName; className?: string }) {
  return (
    <span className={className ? `gicon ${className}` : "gicon"} data-icon={name} aria-hidden="true">
      <Icon name={name} />
    </span>
  );
}

/**
 * W12c: a node's title line, the icon first. The icon stands INSIDE the title (a flex line: icon, then the words, which wrap beside it), so no node gets a row it did not have
 * and the title stays the element a test or a spec finds by its text and its class (`node-title`).
 */
function Title({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <div className="node-title gtitle">
      <NodeIcon name={icon} />
      {children}
    </div>
  );
}

/**
 * W12a: the small menu button of a mapped point or group. It is NOT a row menu: a menu inside a React Flow node would leak its arrow, Enter and
 * Space keys, its hover and its focus into the node and the canvas, so the button only reports its own element (`onMenu`) and the page opens the
 * node's context menu, outside the canvas, next to it. `nokey` is React Flow's own opt-out of the node's key handling. 20px and absolutely placed
 * by the stylesheet (`gnode-menu-btn`), so the node is no taller; the host node carries `gnode-hasmenu`, which leaves the title room for it.
 * W12c: `label` names it differently (the source card's "Source actions for X"); that button stands IN the card's title line, not at the node's corner.
 */
function MenuButton({ name, onMenu, label }: { name: string; onMenu?: NodeActions["onMenu"]; label?: string }) {
  if (!onMenu) return null;
  return (
    <button
      type="button" className="nodrag nokey icon-btn gnode-menu-btn" aria-label={label ?? `Mapping actions for ${name}`} aria-haspopup="menu"
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

/** How many of a source's points are mapped to an asset (every cluster and the ungrouped ones). */
function mappedPoints(source: GraphSource): number {
  let mapped = 0;
  for (const cluster of source.clusters) for (const p of cluster.points) if (p.asset_id !== null) mapped++;
  for (const p of source.ungrouped) if (p.asset_id !== null) mapped++;
  return mapped;
}

/**
 * W12c: the source card. Six lines of FIXED height (the stylesheet sets each in px; graph-source-card.css has the table and the measured result), so the card fits the
 * room `SOURCE_H` keeps for it and a line that changes its words (a status, "Seen ... 9 min ago" -> "10 min ago") moves nothing:
 *   head: the fold (a chevron, on the LEFT), the protocol icon as a tile, the short title on up to TWO lines (w14; the full name in its `title` and in every accessible name), the
 *         "Source actions" menu button at the right end when the page gave the node an `onMenu`;
 *   protocol and where it listens; the status dot, its WORD and the origin (the word is the signal, the dot decoration); "N of M mapped" in words with a 4px bar under
 *   them (decoration); Details when the page gave `onSelect`; the last-seen line when there is one.
 * (w33) A source the newest scan of its range did not find wears `gsrc-not-seen` (a quieter ground and edge, nothing taller), and its last line is the same one line: `Not seen in scan #7
 * (last seen in #5, 4 days ago)`, or, when something is mapped, `Mapped: move it or delete it on Sources` with both sentences in the tooltip (`seenCard`).
 * (w33) A new source that looks like an old one that stopped answering says so on that same last line (`Looks like <old name>`; the whole sentence in the tooltip) and, for a person who may
 * edit sources, gets a Move... button beside Details in the same 20px row; two such old sources, or another server answering at the address, replace the seen line in the same way
 * (the latter in the warning ink, `gsrc-warn`). The card is no taller (`seenCard`).
 * (w36) A source with `large` (the server sends it for a source over 1,000 points, which then holds only its mapped points and their twins) says `15,000 points, 800 mapped` in the words line, from
 * `large` and from nothing it draws, and a Map by shape button (`onShapes`, given to a person who may open that page) is the LAST button of the same 20px row: no line is added, the card is no taller.
 * (w36) With `large.rules_new` above 0 (new tags in a shape the owner already decided about) the words read `15,000 points, 800 mapped, 12 new` and the same button reads `Review 12 new`; the page sends it to ?rules=1.
 * Create assets and Remove are not drawn: they are items of the menu the page opens from the `⋯` button (and from a right click), so `onCreateAssets`, `onRemove` and
 * `groups` stay in the data for the page and are not read here.
 */
function SourceNode({ id, data }: NodeProps<Node<SourceNodeData, "source">>) {
  const { source, expanded, onToggle, onSelect, onMenu, onMoveSource, onShapes, seen, looks } = data;
  const status = sourceStatus(source);
  const protocol = protocolLabel(source.connector_type);
  const address = sourceAddress(source);
  const facts = address ? `${protocol} · ${address}` : protocol;
  // (w36) A large source draws only its mapped points and their twins, so what it holds comes from `large` (the server's), never from the points drawn or from `point_count`.
  const large = source.large ?? null;
  const total = large ? large.points : source.point_count;
  // The count that came with the source can lag behind the points the graph holds; the share never passes the whole.
  const mapped = useMemo(() => Math.min(total, large ? large.mapped : mappedPoints(source)), [source, total, large]);
  const share = total > 0 ? Math.round((mapped / total) * 100) : 0;
  // (w36) New tags that match the owner's saved rules ride on the same line (`, 12 new`) and turn the Map by shape button into `Review 12 new`: no line, no row is added. An older server sends no `rules_new`.
  const fresh = large?.rules_new ?? 0;
  const words = large
    ? `${countNumber(total)} ${total === 1 ? "point" : "points"}, ${countNumber(mapped)} mapped${fresh > 0 ? `, ${countNumber(fresh)} new` : ""}`
    : total > 0 ? `${mapped} of ${total} mapped` : "No points yet";
  // (w33) A source the newest scan of its range did not find is drawn quieter (graph-source-card.css); a mapped one swaps its seen line for what to do about it (graph.ts `seenCard`).
  const missing = isNotSeen(source);
  const last = seen ? seenCard(source, seen, looks) : null;
  // (w33) A new source that looks like an old one: its Move... button stands beside Details (the same 20px row, so the card is no taller), for a person who may edit sources (the page gives the callback).
  const offer = onMoveSource ? moveOfferFor(source) : null;
  // (w36) Map by shape: a large source's third button, the last of the same row (the page gives the callback to a person who may open the page).
  const shapes = large && onShapes ? onShapes : null;
  return (
    <div className={missing ? `gnode gnode-source ${source.origin} gsrc-not-seen` : `gnode gnode-source ${source.origin}`}>
      <Handles>
        <div className="gsrc-body">
          <div className="gsrc-head">
            <Toggle id={id} name={source.name} expanded={expanded} onToggle={onToggle} fold />
            <NodeIcon name={protocolIcon(source.connector_type)} className="gsrc-tile" />
            <div className="node-title gsrc-title" title={source.name}>{sourceTitle(source)}</div>
            <MenuButton name={source.name} label={`Source actions for ${source.name}`} onMenu={onMenu} />
          </div>
          <div className="gsrc-sub muted" title={facts}>{facts}</div>
          <div className="gsrc-status">
            <span className={`gdot gdot-${status.key}`} aria-hidden="true" title={status.label} />
            <span className={status.key === "credentials" ? "gsrc-word gsrc-attn" : "gsrc-word"}>{status.label}</span>
            {` · ${source.origin}`}
          </div>
          <div className="gsrc-mapped">
            <div className="gsrc-words" title={large ? words : undefined}>{words}</div>
            <div className="gsrc-bar" aria-hidden="true"><span className="gsrc-fill" style={{ width: `${share}%` }} /></div>
          </div>
          {(onSelect || offer || shapes) && (
            <div className="gsrc-actions">
              {onSelect && <button type="button" className="nodrag gsrc-details" aria-label={`Details for ${source.name}`} onClick={press(() => onSelect(id))}>Details</button>}
              {offer && onMoveSource && (
                <button type="button" className="nodrag gsrc-move" aria-label={`Move ${offer.from_name} to ${source.name}...`} onClick={press(() => onMoveSource(id))}>Move...</button>
              )}
              {shapes && (
                <button
                  type="button" className="nodrag gsrc-shapes" onClick={press(() => shapes(id))}
                  aria-label={fresh > 0 ? `Review ${countNumber(fresh)} new ${fresh === 1 ? "tag that matches" : "tags that match"} your rules` : `Map by shape for ${source.name}`}
                >
                  {fresh > 0 ? `Review ${countNumber(fresh)} new` : "Map by shape"}
                </button>
              )}
            </div>
          )}
          {last && <div className={last.tone === "warn" ? "gsrc-seen gsrc-warn warning" : "gsrc-seen muted"} title={last.title}>{last.line}</div>}
        </div>
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
          <Title icon={clusterIcon}>{`${label} (${count})`}</Title>
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
  const { point, twinOf, onMap, onNewAsset, onMenu } = data;
  // (w34) The same tag as a mapped point: that sentence takes the detail line (the node is no taller than an unmapped one, which has its Map row), and no Map / New asset is drawn.
  const detail = twinOf !== undefined ? `Already mapped as ${twinOf}` : [point.unit_hint, point.mapped_metric && `→ ${point.mapped_metric}`].filter(Boolean).join(" ");
  return (
    <div className={onMenu ? "gnode gnode-point gnode-hasmenu" : "gnode gnode-point"}>
      <Handles>
        <Title icon={metricIcon(pointMetric(point))}>{point.name}</Title>
        <MenuButton name={point.name} onMenu={onMenu} />
        {detail && <div className={twinOf !== undefined ? "muted gnode-twin" : "muted"} title={twinOf !== undefined ? detail : undefined}>{detail}</div>}
        <MapButtons id={id} name={point.name} onMap={twinOf === undefined ? onMap : undefined} onNewAsset={twinOf === undefined ? onNewAsset : undefined} />
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
            <Title icon={assetIcon(asset)}>{asset.name}</Title>
            {badge && <span className="gnode-mapped" title={`${mappedInside} mapped inside`}>{`${mappedInside} mapped`}</span>}
            {toggle && (
              <Toggle id={id} name={asset.name} expanded={!collapsed} onToggle={onToggleAssets} label={`${collapsed ? "Show" : "Hide"} sub-assets of ${asset.name}`} fold />
            )}
          </div>
        ) : (
          <Title icon={assetIcon(asset)}>{asset.name}</Title>
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
        <Title icon="sources">{`${data.host}:${data.port} — unidentified service`}</Title>
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
