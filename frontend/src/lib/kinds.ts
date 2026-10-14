import type { IconName } from "../components/Icon";
import { assetIcon } from "./assetIcons";

export const DEFAULT_KIND = "generic";
/** The kinds the registry was seeded with (migration 0010) besides the ones assets use; kindIcon.test.ts checks each has a drawing. */
export const STARTER_KINDS = ["Site", "Building", "Room", "Row", "Rack", "Panel", "Meter", "Circuit", "Other equipment"] as const;

/** The comparison key of a kind: ignores case, surrounding blanks and repeated inner blanks; Unicode-NFC. */
export function kindKey(kind: string): string {
  return kind.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** The text to store for a typed kind: trimmed, inner blanks collapsed. */
export function cleanKind(kind: string): string {
  return kind.trim().replace(/\s+/g, " ");
}

// Code-point comparison: deterministic across runtimes (localeCompare depends on ICU collation).
const compare = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/**
 * The options of the Kind select once kinds are data: the names in the registry (one per kindKey, sorted by kindKey) and DEFAULT_KIND
 * when the registry has no kind with that key (the form's starting value must be listed). Kinds that assets use but the registry
 * lacks are NOT offered; typing one under "Other…" registers it. `current` is the kind of the asset being edited, offered exactly as
 * stored (replacing the registry's spelling of its key, so a save without a change never rewrites it). Blank names are ignored.
 */
export function kindChoices(kinds: ReadonlyArray<{ name: string }>, current?: string): string[] {
  const chosen = new Map<string, string>();
  for (const { name } of kinds) {
    const key = kindKey(name);
    if (key !== "" && !chosen.has(key)) chosen.set(key, name);
  }
  if (!chosen.has(kindKey(DEFAULT_KIND))) chosen.set(kindKey(DEFAULT_KIND), DEFAULT_KIND);
  if (current !== undefined && kindKey(current) !== "") chosen.set(kindKey(current), current);
  return [...chosen].sort(([a], [b]) => compare(a, b)).map(([, name]) => name);
}

/**
 * Whether saving an asset with `kind` adds that kind to the registry (the asset dialog says so beforehand, and the page does it afterwards).
 * Only a kind the registry lacks, that is new to this asset (`was`: the text the dialog opened with; null for a new asset, or one whose
 * stored kind was blank), and never DEFAULT_KIND: an unrelated edit of an asset whose kind nobody registered must not write a registry
 * row (and an audit row) nobody asked for, and a deleted `generic` stays deleted. A blank kind never registers.
 */
export function registersKind(kind: string, kinds: ReadonlyArray<{ name: string }>, was: string | null): boolean {
  const key = kindKey(kind);
  if (key === "" || key === kindKey(DEFAULT_KIND)) return false;
  if (was !== null && kind === was) return false;
  return !kinds.some((entry) => kindKey(entry.name) === key);
}

/**
 * The drawing for a kind NAME that is not an asset (the fleet summary's "By kind" list, the kind dialog): the registry's icon for the
 * kind with the same kindKey, else the keyword guess. The same rule as an asset's, so a list and the tree beside it cannot disagree.
 */
export function kindIconForName(name: string, kinds: ReadonlyArray<{ name: string; icon: string }> | undefined): IconName {
  const key = kindKey(name);
  const match = kinds?.find((kind) => kindKey(kind.name) === key);
  return assetIcon({ kind: name, kind_icon: match?.icon ?? null });
}

/** The kind to store for text typed under "Other…": the spelling of an option with the same kindKey, else cleanKind(typed). Blank typed text gives "". */
export function resolveKind(typed: string, options: readonly string[]): string {
  const key = kindKey(typed);
  if (key === "") return "";
  return options.find((o) => kindKey(o) === key) ?? cleanKind(typed);
}
