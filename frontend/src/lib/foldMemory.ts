import { readStored, writeStored } from "./sidebarState";

/** More than this is not something this app wrote. */
export const MAX_REMEMBERED = 5000;

/** The text kept for "the person opened everything": an empty list would read the same as the `[]` the Assets Tree wrote on every visit before this. */
const NOTHING_FOLDED = "none";

/**
 * What a list left folded last time, in three shapes:
 * `null` = nothing remembered (nothing stored, junk, a storage that throws, more than 5000 entries, a list with no whole number in it, which includes the old `[]`);
 * an empty Set = remembered "nothing folded" (the text `none`);
 * otherwise the Set of the whole numbers in the stored list (anything else in it is dropped).
 */
export function readFoldMemory(key: string): Set<number> | null {
  const raw = readStored(key);
  if (raw === null) return null;
  if (raw === NOTHING_FOLDED) return new Set();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(value) || value.length > MAX_REMEMBERED) return null;
  const ids = value.filter((id): id is number => Number.isInteger(id));
  return ids.length === 0 ? null : new Set(ids);
}

/** Remembers the folded ids (sorted, each once, at most 5000) as a JSON list; an empty set is remembered as `none`, never `[]`. A full or blocked storage is not an error. */
export function writeFoldMemory(key: string, ids: Iterable<number>): void {
  const list = [...new Set(ids)].sort((x, y) => x - y).slice(0, MAX_REMEMBERED);
  writeStored(key, list.length === 0 ? NOTHING_FOLDED : JSON.stringify(list));
}
