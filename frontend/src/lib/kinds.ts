export const DEFAULT_KIND = "generic";
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
 * The options of the Kind select: DEFAULT_KIND, the starter kinds and every kind in use by `assets`, one per kindKey, sorted by
 * kindKey. One spelling per key: the most used spelling among `assets` (ties: code-point order) wins over a starter's and over
 * DEFAULT_KIND's; a starter or DEFAULT_KIND only fills a key nobody uses.
 * `current` is the kind of the asset being edited: it is offered exactly as stored (so a save without a change never rewrites it),
 * replacing the spelling of its key. Blank kinds (in `assets`, or `current` with kindKey "") are ignored.
 */
export function kindOptions(assets: ReadonlyArray<{ kind: string }>, current?: string): string[] {
  const spellings = new Map<string, Map<string, number>>();
  for (const { kind } of assets) {
    const key = kindKey(kind);
    if (key === "") continue;
    const counts = spellings.get(key) ?? new Map<string, number>();
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    spellings.set(key, counts);
  }
  const chosen = new Map<string, string>();
  for (const [key, counts] of spellings) {
    const best = [...counts].sort(([a, n], [b, m]) => m - n || compare(a, b))[0][0];
    chosen.set(key, best);
  }
  for (const kind of [DEFAULT_KIND, ...STARTER_KINDS]) {
    const key = kindKey(kind);
    if (!chosen.has(key)) chosen.set(key, kind);
  }
  if (current !== undefined && kindKey(current) !== "") chosen.set(kindKey(current), current);
  return [...chosen].sort(([a], [b]) => compare(a, b)).map(([, kind]) => kind);
}

/** The kind to store for text typed under "Other…": the spelling of an option with the same kindKey, else cleanKind(typed). Blank typed text gives "". */
export function resolveKind(typed: string, options: readonly string[]): string {
  const key = kindKey(typed);
  if (key === "") return "";
  return options.find((o) => kindKey(o) === key) ?? cleanKind(typed);
}
