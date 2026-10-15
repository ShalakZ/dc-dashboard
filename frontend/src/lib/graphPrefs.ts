import { readStored, writeStored } from "./sidebarState";

/** Where the canvas remembers whether dragging snaps to the grid: "on" or "off", per browser. */
export const SNAP_KEY = "dcdash.discovery.snap";
/** The snap grid, in graph pixels. Every default place of `buildGraph` is a multiple of it. */
export const SNAP_GRID = 8;

/** Snap is on unless the browser remembers "off" (nothing stored, junk, or a storage that fails all mean on). */
export function readSnap(): boolean {
  return readStored(SNAP_KEY) !== "off";
}

export function writeSnap(on: boolean): void {
  writeStored(SNAP_KEY, on ? "on" : "off");
}
