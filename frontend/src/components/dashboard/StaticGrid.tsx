import type { ReactNode } from "react";
import { cellStyle, gridStyle, readingOrder, type Cell } from "../../lib/gridMetrics";
import { compactVertical } from "../../lib/layout";

/** The read-only grid: a CSS grid driven by x, y, w, h (see lib/gridMetrics), closed up vertically like the editor. Cells are in reading order. */
export function StaticGrid<T extends Cell & { key: string }>({ items, render }: { items: readonly T[]; render: (item: T) => ReactNode }) {
  return (
    <div className="dash-grid" style={gridStyle}>
      {readingOrder(compactVertical(items)).map((item) => (
        <div key={item.key} className="dash-cell" style={cellStyle(item)}>{render(item)}</div>
      ))}
    </div>
  );
}
