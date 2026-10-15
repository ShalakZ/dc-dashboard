import { ViewportPortal } from "@xyflow/react";
import { useEffect, useState } from "react";
import type { Guides } from "../../lib/graphGuides";

/** What the page gets: call `set` with the guides of the current drag frame, or `null` when the drag ends. */
export interface AlignGuidesHandle { set(guides: Guides | null): void }

/**
 * The thin alignment guides shown while a node is dragged, in the canvas's own coordinates (they follow pan and zoom). Visual only.
 * The guides live in THIS component's state and the page reaches it through `handleRef`, so a drag frame re-renders these few lines and
 * not the whole canvas a second time. One `svg` of 0x0 at the origin (absolute: an inline svg would sit on the text baseline, a line-height too low) whose lines overflow it; `vector-effect: non-scaling-stroke` keeps
 * them 1px thick at every zoom. Nothing is drawn without guides.
 */
export function AlignGuides({ handleRef }: { handleRef: { current: AlignGuidesHandle | null } }) {
  const [guides, setGuides] = useState<Guides | null>(null);

  useEffect(() => {
    handleRef.current = { set: setGuides };
    return () => { handleRef.current = null; };
  }, [handleRef]);

  if (!guides || (guides.vertical.length === 0 && guides.horizontal.length === 0)) return null;
  return (
    <ViewportPortal>
      <svg className="graph-guides" width={0} height={0} aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}>
        {guides.vertical.map((g, i) => (
          <line key={`v${i}`} x1={g.at} y1={g.from} x2={g.at} y2={g.to} vectorEffect="non-scaling-stroke" />
        ))}
        {guides.horizontal.map((g, i) => (
          <line key={`h${i}`} x1={g.from} y1={g.at} x2={g.to} y2={g.at} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
    </ViewportPortal>
  );
}
