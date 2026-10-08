import type { CSSProperties } from "react";
import { GRID_COLS } from "./layout";

/** Shared by the read-only CSS grid (Task 9) and the react-grid-layout editor (Task 10) so both lay widgets out identically. */
export const ROW_HEIGHT = 80;
export const GRID_GAP = 10;

export interface Cell { x: number; y: number; w: number; h: number }

/** CSS-grid placement of one widget (1-based lines); a widget never spills past the last column. */
export function cellStyle({ x, y, w, h }: Cell): CSSProperties {
  const column = Math.min(Math.max(x, 0), GRID_COLS - 1);
  const span = Math.max(1, Math.min(w, GRID_COLS - column));
  return { gridColumn: `${column + 1} / span ${span}`, gridRow: `${Math.max(y, 0) + 1} / span ${Math.max(h, 1)}` };
}

/** Row height and gap as inline style; `display: grid` and the 12 columns live in app.css (`.dash-grid`). */
export const gridStyle: CSSProperties = { gridAutoRows: `${ROW_HEIGHT}px`, gap: GRID_GAP };

/** Reading order (also the DOM and tab order): top to bottom, then left to right. */
export function readingOrder<T extends Pick<Cell, "x" | "y">>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x);
}
