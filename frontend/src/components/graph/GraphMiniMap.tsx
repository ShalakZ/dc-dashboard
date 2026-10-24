import { MiniMap, useStore } from "@xyflow/react";

/** Under this canvas width the minimap would cover too much of the graph (and the SourcePanel open leaves little): it is not drawn. */
export const MINIMAP_MIN_WIDTH = 700;

const COLOURS: Record<string, string> = {
  source: "var(--accent)",
  cluster: "var(--text-2)",
  point: "var(--border-strong)",
  asset: "var(--text)",
  moreAssets: "var(--text)", // (w37) the summary of a parent with many sub-assets: the asset's colour
  unidentified: "var(--field-border)",
};

/** A node's colour in the minimap: a token, so the light, dark and preset looks all follow (the library writes it in the rect's style). */
export const miniMapColor = (node: { type?: string }) => COLOURS[node.type ?? ""] ?? "var(--border-strong)";

const width = (state: { width: number }) => state.width;

/** The overview of the whole graph: click or drag in it to move, wheel to zoom. Hidden on a narrow canvas. */
export function GraphMiniMap() {
  const canvasWidth = useStore(width);
  if (canvasWidth < MINIMAP_MIN_WIDTH) return null;
  return <MiniMap className="graph-minimap" pannable zoomable ariaLabel="Overview of the whole graph" nodeColor={miniMapColor} />;
}
