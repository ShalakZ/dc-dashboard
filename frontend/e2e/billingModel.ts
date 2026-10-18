// The month the W17 spec feeds the Billing page and the asset list the Assets Tree cases feed the tree: GET /api/billing/costs and GET /api/assets are answered from this
// through page.route, so the spec depends on nothing the shared stack holds and writes nothing to it. The shapes of the responses are written here again (as graphModel.ts does):
// importing them from src/ would pull the app's files into the strict e2e type-check.
//
// The shape is the pilot hall of the dev seeder (docs/developing.md "The pilot hall"), 370 assets in tree PRE-ORDER, the order the API lists them in:
//   Site                                     depth 0
//   Hall 1, Hall 2, Electrical               depth 1   (Hall 1 gets 59 racks, Hall 2 gets 58)
//   Pod A and Pod B of each hall; 8 panels   depth 2
//   Row 1 .. Row 4 of each hall              depth 3   (Pod A holds Row 1 and 2, Pod B Row 3 and 4)
//   Rack 01 ..                               depth 4   (117, numbered across the hall)
//   Feed A, Feed B of each rack              depth 5   (229: one rack has no feeds, a free rack with no meter; three racks have Feed A only)
// so the rows per level are 1, 4, 16, 24, 141 and 370 (ROWS_BY_LEVEL), and the deepest level with at most 60 rows (what a big month opens at) is level 4.
//
// The figures are deterministic (no random). Only the feeds and the panels have figures of their own; a rack, row, pod, hall, the Electrical group and the Site SUM their children. Every
// day is a multiple of 0.5 kWh and cost = kWh x 0.25 (both exact in binary), so a parent's figures are EXACTLY the sum of its children's; and every meter's month is a multiple of 2 kWh
// (a cost of a multiple of 0.5), so even the cost text at two decimals of a parent is exactly the sum of its children's texts. A handful of Hall 2's figures are estimated (the `~` mark).
//
// The ids are synthetic and far from any row the pilot-hall seed has (7,000 and up), so even a stray click could not name a real asset.

export type ApiFigure = { kwh: number; cost: number | null; estimated: boolean; partial: boolean; no_data: boolean };
export interface ApiCostRow {
  asset_id: number; parent_id: number | null; name: string; path: string; rate_per_kwh: number | null; days: (ApiFigure | null)[]; total: ApiFigure | null;
}
export interface ApiClosed { id: number; closed_name: string; closed_at: string; note: string; total_kwh: number; total_cost: number | null }
/** GET /api/billing/costs?month= (src/api/types.ts BillingCosts). */
export interface ApiCosts {
  month: string; timezone: string; currency: string | null; days: string[]; assets: ApiCostRow[]; closed: ApiClosed | null; live: null;
}
/** GET /api/assets (src/api/types.ts Asset). */
export interface ApiTreeAsset { id: number; parent_id: number | null; name: string; kind: string; sort_order: number; icon: string | null; kind_icon: string | null }

export interface ModelNode {
  id: number; parent_id: number | null; name: string; kind: string; sort_order: number; depth: number;
  /** `Site / Hall 1 / Pod A`: the names from the root down, ending with this one. */
  path: string;
  /** A meter (a feed or a panel): the only rows that have figures of their own. */
  meter: boolean;
  /** 1 or 2 for the rows under a hall, else 0. */
  hall: number;
  /** The meter's number among the meters, in tree order (it seeds its figures). */
  seed: number;
}

const BASE_ID = 7_000;
const RATE = 0.25;

function builder() {
  const nodes: ModelNode[] = [];
  const childCount: number[] = [];
  let meters = 0;
  const add = (parent: number | null, name: string, kind: string, extra: { meter?: boolean; hall?: number } = {}): number => {
    const index = nodes.length;
    const up = parent === null ? null : nodes[parent];
    nodes.push({
      id: BASE_ID + index,
      parent_id: up ? up.id : null,
      name,
      kind,
      sort_order: parent === null ? 0 : childCount[parent],
      depth: up ? up.depth + 1 : 0,
      path: up ? `${up.path} / ${name}` : name,
      meter: extra.meter ?? false,
      hall: extra.hall ?? 0,
      seed: extra.meter ? meters++ : -1,
    });
    childCount.push(0);
    if (parent !== null) childCount[parent]++;
    return index;
  };
  return { nodes, add };
}

const two = (n: number) => String(n).padStart(2, "0");

/** One very long name on one rack: it proves the name cell's ellipsis (60+ characters). */
export const LONG_NAME = "Rack 07 - Customer cage reserved for Meridian Hosting Partners (long-term lease, East Wing)";
/** The rack with no meter (no feeds, no figures at all) and the racks that have Feed A only: "Hall <n>/<rack number>". */
const FREE_RACK = "1/20";
const ONE_FEED = new Set(["1/33", "2/12", "2/40"]);
const RACKS_PER_ROW: readonly (readonly number[])[] = [[15, 15, 15, 14], [15, 15, 14, 14]];

function pilotHall(): ModelNode[] {
  const { nodes, add } = builder();
  const site = add(null, "Site", "site");
  for (const hall of [1, 2]) {
    const h = add(site, `Hall ${hall}`, "room", { hall });
    let rack = 0;
    ["Pod A", "Pod B"].forEach((podName, podIndex) => {
      const pod = add(h, podName, "pod", { hall });
      for (const rowInPod of [0, 1]) {
        const rowIndex = podIndex * 2 + rowInPod;
        const row = add(pod, `Row ${rowIndex + 1}`, "row", { hall });
        for (let k = 0; k < RACKS_PER_ROW[hall - 1][rowIndex]; k++) {
          rack++;
          const key = `${hall}/${rack}`;
          const name = hall === 1 && rack === 7 ? LONG_NAME : `Rack ${two(rack)}`;
          const r = add(row, name, "rack", { hall });
          if (key === FREE_RACK) continue;
          add(r, "Feed A", "circuit", { meter: true, hall });
          if (!ONE_FEED.has(key)) add(r, "Feed B", "circuit", { meter: true, hall });
        }
      }
    });
  }
  const electrical = add(site, "Electrical", "group");
  for (const panel of ["1A", "1B", "2A", "2B", "3A", "3B", "4A", "4B"]) add(electrical, `Panel ${panel}`, "panel", { meter: true });
  return nodes;
}

/** A month of five rows: the Site and four meters under it (nothing below depth 1). */
function smallMonth(): ModelNode[] {
  const { nodes, add } = builder();
  const site = add(null, "Site", "site");
  for (const name of ["Hall 1", "Hall 2", "Electrical", "Lab"]) add(site, name, "room", { meter: true, hall: name === "Hall 2" ? 2 : 1 });
  return nodes;
}

/** The 370 assets in tree pre-order. */
export const NODES: readonly ModelNode[] = pilotHall();
export const TOTAL_ROWS = NODES.length;
/** The rows a level shows (level L shows the rows at depth below L): 1, 4, 16, 24, 141, 370. The spec checks that NODES yields exactly these first. */
export const ROWS_BY_LEVEL: readonly number[] = [1, 4, 16, 24, 141, 370];
/** The rows per level as NODES gives them, for the self-check. */
export const rowsByLevelOf = (nodes: readonly ModelNode[]): number[] => {
  const deepest = Math.max(...nodes.map((n) => n.depth));
  return Array.from({ length: deepest + 1 }, (_, i) => nodes.filter((n) => n.depth < i + 1).length);
};
/** The node with this path (`Site / Hall 1 / Pod A`); throws when there is none, so a slip in the spec is loud. */
export function nodeAt(path: string, nodes: readonly ModelNode[] = NODES): ModelNode {
  const found = nodes.find((n) => n.path === path);
  if (!found) throw new Error(`the model has no asset at ${path}`);
  return found;
}
/** The rows under a node (its descendants), what the twisty's name says. */
export const belowOf = (node: ModelNode, nodes: readonly ModelNode[] = NODES): number => nodes.filter((n) => n.path.startsWith(`${node.path} / `)).length;
/** The children of a node, in tree order. */
export const childrenOf = (node: ModelNode, nodes: readonly ModelNode[] = NODES): ModelNode[] => nodes.filter((n) => n.parent_id === node.id);

const daysOf = (month: string): string[] => {
  const [year, number] = month.split("-").map(Number);
  const length = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return Array.from({ length }, (_, d) => `${month}-${two(d + 1)}`);
};

interface Sum { kwh: number; estimated: boolean }
const sumOf = (parts: readonly (Sum | null)[]): Sum | null => {
  const some = parts.filter((p): p is Sum => p !== null);
  return some.length === 0 ? null : { kwh: some.reduce((a, p) => a + p.kwh, 0), estimated: some.some((p) => p.estimated) };
};

/** A meter's days in kWh: multiples of 0.5, never below 2, and the month adds up to a multiple of 2 (the last day takes up the difference). */
function meterDays(seed: number, length: number, monthNumber: number): number[] {
  const kwh = Array.from({ length }, (_, d) => 0.5 * (4 + ((seed * 7 + d * 5 + ((seed * d) % 11) + monthNumber) % 23)));
  const rest = kwh.reduce((a, v) => a + v, 0) % 2;
  if (rest !== 0) kwh[length - 1] += 2 - rest;
  return kwh;
}

/** A few of Hall 2's feeds are estimated on a few days (every 23rd meter, on days 5, 14, 23 ...): about twenty figures. */
const estimatedOn = (node: ModelNode, d: number): boolean => node.hall === 2 && node.seed % 23 === 0 && d % 9 === 4;

const asFigure = (sum: Sum | null): ApiFigure | null =>
  sum === null ? null : { kwh: sum.kwh, cost: sum.kwh * RATE, estimated: sum.estimated, partial: false, no_data: false };

function rowsFor(nodes: readonly ModelNode[], month: string): ApiCostRow[] {
  const days = daysOf(month);
  const monthNumber = Number(month.slice(5));
  const perDay = new Map<number, (Sum | null)[]>();
  const kids = new Map<number, ModelNode[]>();
  for (const node of nodes) if (node.parent_id !== null) kids.set(node.parent_id, [...(kids.get(node.parent_id) ?? []), node]);
  // Children come after their parent in pre-order, so walking backwards meets every child before its parent.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    const below = kids.get(node.id) ?? [];
    if (below.length > 0) {
      perDay.set(node.id, days.map((_, d) => sumOf(below.map((child) => perDay.get(child.id)![d]))));
    } else if (node.meter) {
      const kwh = meterDays(node.seed, days.length, monthNumber);
      perDay.set(node.id, kwh.map((v, d) => ({ kwh: v, estimated: estimatedOn(node, d) })));
    } else {
      perDay.set(node.id, days.map(() => null)); // a rack with no meter: no figure on any day, and no month total
    }
  }
  return nodes.map((node) => {
    const day = perDay.get(node.id)!;
    return {
      asset_id: node.id, parent_id: node.parent_id, name: node.name, path: node.path, rate_per_kwh: RATE,
      days: day.map(asFigure), total: asFigure(sumOf(day)),
    };
  });
}

function bodyFor(nodes: readonly ModelNode[], month: string, closed: boolean): ApiCosts {
  const assets = rowsFor(nodes, month);
  const roots = assets.filter((a) => a.parent_id === null);
  const next = (() => {
    const [year, number] = month.split("-").map(Number);
    return number === 12 ? `${year + 1}-01` : `${year}-${two(number + 1)}`;
  })();
  return {
    month, timezone: "UTC", currency: "USD", days: daysOf(month), assets,
    closed: closed
      ? {
          id: 1, closed_name: "w17 spec", closed_at: `${next}-02T09:30:00+00:00`, note: "Closed for the monthly invoice run.",
          total_kwh: roots.reduce((a, r) => a + (r.total?.kwh ?? 0), 0), total_cost: roots.reduce((a, r) => a + (r.total?.cost ?? 0), 0),
        }
      : null,
    live: null,
  };
}

/** The body of GET /api/billing/costs?month=YYYY-MM for the pilot hall: 370 rows, one column per day of the month. `closed` gives the month a closed record (and `live: null`). */
export const costsFor = (month: string, opts: { closed?: boolean } = {}): ApiCosts => bodyFor(NODES, month, opts.closed === true);
/** The same for a month of five rows (the Site and four meters): nothing to fold, so the month opens whole. */
export const smallCostsFor = (month: string, opts: { closed?: boolean } = {}): ApiCosts => bodyFor(smallMonth(), month, opts.closed === true);
/** The names of the small month, in order. */
export const SMALL_NAMES: readonly string[] = smallMonth().map((n) => n.name);

/** The body of GET /api/assets for the same 370 assets (parents first, in tree order). */
export const assetsList = (): ApiTreeAsset[] =>
  NODES.map((n) => ({ id: n.id, parent_id: n.parent_id, name: n.name, kind: n.kind, sort_order: n.sort_order, icon: null, kind_icon: null }));
