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

/** Where the canvas remembers the "Unmapped only" filter: "on" or "off", per browser (a per-account store would need a backend change). */
export const UNMAPPED_ONLY_KEY = "dcdash.discovery.unmapped-only";
/** Where it remembers which asset subtrees are folded: a JSON array of asset ids, per browser. */
export const ASSETS_CLOSED_KEY = "dcdash.discovery.assets-closed";

/** The filter is off unless the browser remembers "on" (nothing stored, junk, or a storage that fails all mean off). */
export function readUnmappedOnly(): boolean {
  return readStored(UNMAPPED_ONLY_KEY) === "on";
}

export function writeUnmappedOnly(on: boolean): void {
  writeStored(UNMAPPED_ONLY_KEY, on ? "on" : "off");
}

/** The folded asset ids. Nothing stored, a value that is not a JSON list, or a storage that fails all mean none; entries that are not whole numbers are dropped. */
export function readAssetsClosed(): Set<number> {
  const raw = readStored(ASSETS_CLOSED_KEY);
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is number => Number.isSafeInteger(id))) : new Set();
  } catch {
    return new Set();
  }
}

/** Remember the folded asset ids (sorted, each once). With `known`, only ids in it are kept: an asset deleted since then is not carried along for ever. */
export function writeAssetsClosed(ids: Iterable<number>, known?: ReadonlySet<number>): void {
  const kept = new Set<number>();
  for (const id of ids) if (!known || known.has(id)) kept.add(id);
  writeStored(ASSETS_CLOSED_KEY, JSON.stringify([...kept].sort((a, b) => a - b)));
}
