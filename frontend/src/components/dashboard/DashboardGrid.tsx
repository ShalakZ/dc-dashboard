import ReactGridLayout, { useContainerWidth, verticalCompactor, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import type { ReactNode } from "react";
import { GRID_GAP, ROW_HEIGHT } from "../../lib/gridMetrics";
import { applyGrid, compactVertical, GRID_COLS, toGrid, type DraftWidget } from "../../lib/layout";

interface Props {
  drafts: DraftWidget[];
  onChange: (next: DraftWidget[]) => void;
  /** The widget box for one draft; the grid moves and resizes it (grab it by `.widget-drag-handle`). */
  renderWidget: (draft: DraftWidget) => ReactNode;
}

/**
 * The editor's grid: 12 columns, drag by the widget's title bar, resize from the corner and edges. The library's vertical
 * compactor lets the other widgets make room while dragging, and every reported result goes through `compactVertical` (the
 * same function the read-only grid uses), so the saved x/y/w/h are exactly what is on screen and the CSS grid draws the same
 * cells (the container padding is 0 for that reason: the library would otherwise indent the grid by the margin). Only
 * finished drags and resizes are reported (the library also reports on mount, which would make every dashboard look edited).
 */
export function DashboardGrid({ drafts, onChange, renderWidget }: Props) {
  const { width, containerRef, mounted } = useContainerWidth();
  // applyGrid takes the library's readonly layout as it is and returns the same drafts when nothing moved; compactVertical
  // likewise returns its input when it is closed up already, so a drop where it started is still not an edit.
  const commit = (layout: Layout) => onChange(compactVertical(applyGrid(drafts, layout)));
  return (
    <div ref={containerRef} className="dash-grid-edit">
      {mounted && (
        <ReactGridLayout
          width={width}
          layout={toGrid(drafts)}
          gridConfig={{ cols: GRID_COLS, rowHeight: ROW_HEIGHT, margin: [GRID_GAP, GRID_GAP], containerPadding: [0, 0] }}
          dragConfig={{ enabled: true, handle: ".widget-drag-handle", cancel: ".widget-actions" }}
          resizeConfig={{ enabled: true, handles: ["se", "e", "s"] }}
          compactor={verticalCompactor}
          onDragStop={commit}
          onResizeStop={commit}
        >
          {drafts.map((draft) => <div key={draft.key}>{renderWidget(draft)}</div>)}
        </ReactGridLayout>
      )}
    </div>
  );
}
