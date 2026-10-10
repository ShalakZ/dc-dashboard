import { Link } from "react-router";
import type { TreeNode } from "../lib/tree";

export function AssetTree({ nodes, selectedId, onSelect, onAddChild, disabled }: {
  nodes: TreeNode[]; selectedId: number | null; onSelect?: (id: number) => void; onAddChild?: (id: number) => void;
  /** Disables the + buttons (the page is busy with something that must not get a dialog next to it). */
  disabled?: boolean;
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
            <>{" "}<button type="button" aria-label={`Add child of ${node.name}`} disabled={disabled} onClick={() => onAddChild(node.id)}>+</button></>
          )}
          <AssetTree nodes={node.children} selectedId={selectedId} onSelect={onSelect} onAddChild={onAddChild} disabled={disabled} />
        </li>
      ))}
    </ul>
  );
}
