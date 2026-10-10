import { Link } from "react-router";
import type { TreeNode } from "../lib/tree";

export function AssetTree({ nodes, selectedId, onSelect, onAddChild }: {
  nodes: TreeNode[]; selectedId: number | null; onSelect?: (id: number) => void; onAddChild?: (id: number) => void;
}) {
  if (nodes.length === 0) return null;
  return (
    <ul className="tree">
      {nodes.map((node) => (
        <li key={node.id}>
          <Link to={`/assets/${node.id}`} className={node.id === selectedId ? "selected" : undefined}
            onClick={(e) => { if (onSelect) { e.preventDefault(); onSelect(node.id); } }}>
            {node.name}
          </Link>{" "}
          <span className="muted">{node.kind}</span>
          {onAddChild && (
            <>{" "}<button type="button" aria-label={`Add child of ${node.name}`} onClick={() => onAddChild(node.id)}>+</button></>
          )}
          <AssetTree nodes={node.children} selectedId={selectedId} onSelect={onSelect} onAddChild={onAddChild} />
        </li>
      ))}
    </ul>
  );
}
