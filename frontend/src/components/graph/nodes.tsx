import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { MouseEvent } from "react";
import { Icon } from "../Icon";
import type {
  AssetNodeData, ClusterNodeData, NodeActions, PointNodeData, SourceNodeData, UnidentifiedNodeData,
} from "../../lib/graph";

function Handles({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      {children}
      <Handle type="source" position={Position.Right} />
    </>
  );
}

// `nodrag` keeps a click on a button from starting a drag; stopPropagation keeps it from also selecting the node.
const press = (action: () => void) => (event: MouseEvent) => {
  event.stopPropagation();
  action();
};

function Toggle({ id, name, expanded, onToggle }: { id: string; name: string; expanded: boolean; onToggle?: NodeActions["onToggle"] }) {
  if (!onToggle) return null;
  return (
    <button type="button" className="nodrag" aria-label={`${expanded ? "Collapse" : "Expand"} ${name}`} onClick={press(() => onToggle(id))}>
      {expanded ? "−" : "+"}
    </button>
  );
}

function MapButtons({ id, name, onMap, onNewAsset }: { id: string; name: string } & Pick<NodeActions, "onMap" | "onNewAsset">) {
  if (!onMap && !onNewAsset) return null;
  return (
    <div className="row">
      {onMap && <button type="button" className="nodrag" aria-label={`Map ${name} to asset…`} onClick={press(() => onMap(id))}>Map…</button>}
      {onNewAsset && <button type="button" className="nodrag" aria-label={`New asset from ${name}…`} onClick={press(() => onNewAsset(id))}>New asset…</button>}
    </div>
  );
}

function SourceNode({ id, data }: NodeProps<Node<SourceNodeData, "source">>) {
  const { source, expanded, onToggle, onSelect, onCreateAssets, onRemove, groups = 0, seen } = data;
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
        <div className="muted">{source.connector_type} · {source.origin} · {source.status} · {source.point_count} points</div>
        {seen && <div className="muted gnode-seen" title={seen}>{seen}</div>}
        {source.needs_credentials && <span className="badge">needs credentials</span>}
      </Handles>
    </div>
  );
}

function ClusterNode({ id, data }: NodeProps<Node<ClusterNodeData, "cluster">>) {
  const { label, count, mappedCount, expanded, onToggle, onMap, onNewAsset } = data;
  return (
    <div className="gnode gnode-cluster">
      <Handles>
        <div className="row">
          <div className="node-title">{`${label} (${count})`}</div>
          <Toggle id={id} name={label} expanded={expanded} onToggle={onToggle} />
        </div>
        <div className="muted">{mappedCount} mapped</div>
        <MapButtons id={id} name={label} onMap={onMap} onNewAsset={onNewAsset} />
      </Handles>
    </div>
  );
}

function PointNode({ id, data }: NodeProps<Node<PointNodeData, "point">>) {
  const { point, onMap, onNewAsset } = data;
  const detail = [point.unit_hint, point.mapped_metric && `→ ${point.mapped_metric}`].filter(Boolean).join(" ");
  return (
    <div className="gnode gnode-point">
      <Handles>
        <div className="node-title">{point.name}</div>
        {detail && <div className="muted">{detail}</div>}
        <MapButtons id={id} name={point.name} onMap={onMap} onNewAsset={onNewAsset} />
      </Handles>
    </div>
  );
}

function AssetNode({ data }: NodeProps<Node<AssetNodeData, "asset">>) {
  return (
    <div className="gnode gnode-asset">
      <Handles>
        <div className="node-title">{data.asset.name}</div>
      </Handles>
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

/** Defined once at module level: React Flow warns (and re-mounts every node) if this object changes between renders. */
export const nodeTypes = {
  source: SourceNode,
  cluster: ClusterNode,
  point: PointNode,
  asset: AssetNode,
  unidentified: UnidentifiedNode,
};
