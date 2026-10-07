import { Link } from "react-router";
import type { TreeNode } from "../lib/tree";

export function AssetTree({ nodes, selectedId, onSelect }: {
  nodes: TreeNode[]; selectedId: number | null; onSelect?: (id: number) => void;
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
          <AssetTree nodes={node.children} selectedId={selectedId} onSelect={onSelect} />
        </li>
      ))}
    </ul>
  );
}
