// The graphs the W7u spec feeds the Discovery page: GET /api/discovery/graph is answered from one of these through page.route, so the spec depends on
// nothing the shared stack holds and writes nothing to it. The shapes of the response are written here again (as w7t does for the pieces it reads): importing
// them from src/ would pull the app's files into the strict e2e type-check.
//
// The ids are synthetic and far from any row a real stack has (9,000,000 and up), so even a stray click on Remove or Create mappings could not name a real
// source, point or asset. They are plain numbers; the node ids the page builds from them are written by the `node` helpers below, the same words as
// `nodeId` in src/lib/graph.ts.

export interface XY { x: number; y: number }

export type Metric = "active_power_kw" | "energy_kwh" | "voltage_v" | "current_a" | "power_factor" | "frequency_hz" | "reactive_power_kvar" | "apparent_power_kva" | "custom";

export interface ApiPoint {
  id: number; address: string; name: string; unit_hint: string | null; mapping_id: number | null; asset_id: number | null; mapped_metric: Metric | null;
  suggestion: { metric: Metric; scale: number; interval_seconds: number; custom_unit: string | null };
}
export interface ApiCluster { key: string; points: ApiPoint[] }
export interface ApiSource {
  id: number; name: string; connector_type: string; config: Record<string, unknown>; origin: "manual" | "discovered"; enabled: boolean; status: string;
  last_error: string | null; has_secret: boolean; needs_credentials: boolean; point_count: number; clusters: ApiCluster[]; ungrouped: ApiPoint[];
  last_scan: { scan_id: number; at: string } | null;
}
/**
 * W12c: an asset of the graph carries `icon` (the one somebody chose; null is Automatic) and `kind_icon` (the registry's icon for its kind; null when the kind is not
 * registered), the same two fields `/api/assets` serves: the node draws `assetIcon({ kind, icon, kind_icon })`.
 */
export interface ApiAsset { id: number; parent_id: number | null; name: string; kind: string; icon: string | null; kind_icon: string | null }
export interface ApiGraphModel {
  sources: ApiSource[];
  unidentified: { host: string; port: number; scan_id: number }[];
  assets: ApiAsset[];
  layout: Record<string, XY>;
}

/**
 * W12c: the answer of `GET /api/mappings/{id}/latest`, the newest reading of a mapped point (value already multiplied by the scale), which the value card asks for after a point node has
 * been hovered or focused for a moment. The mappings of a generated graph do not exist on the stack, so a spec that stubs the graph answers this route too (`page.route`) with a body from here.
 * `value`, `ts`, `quality` and `age_seconds` are null when the point has no reading yet.
 */
export interface ApiLatest {
  mapping_id: number; value: number | null; unit: string; ts: string | null; quality: number | null; age_seconds: number | null; stale: boolean;
}
export const latestBody = (mappingId: number, over: Partial<ApiLatest> = {}): ApiLatest => ({
  mapping_id: mappingId, value: 12.4, unit: "kW", ts: "2026-10-17T10:00:00+00:00", quality: 0, age_seconds: 3, stale: false, ...over,
});

/** The ids the page gives its nodes (src/lib/graph.ts `nodeId`). */
export const node = {
  source: (id: number) => `src:${id}`,
  cluster: (sourceId: number, key: string) => `cluster:${sourceId}:${key}`,
  point: (id: number) => `point:${id}`,
  asset: (id: number) => `asset:${id}`,
};
/** The key of the pseudo-group that holds the points a source has no group for (src/lib/graph.ts UNGROUPED). */
export const UNGROUPED = "__ungrouped__";

const BASE = 9_000_000;
/** An old, fixed time for `last_scan`: "Seen in scan #7, N months ago" (the words do not matter, the line's height does). */
const SEEN = { scan_id: 7, at: "2026-07-01T08:00:00+00:00" };

interface PointSpec { id: number; name: string; metric: Metric; asset?: number; mapping?: number }

function point(spec: PointSpec): ApiPoint {
  return {
    id: spec.id, address: `ns=2;s=${spec.name.replace(/\s+/g, "_")}`, name: spec.name, unit_hint: null,
    mapping_id: spec.mapping ?? null, asset_id: spec.asset ?? null, mapped_metric: spec.asset === undefined ? null : spec.metric,
    // A different metric for every point of a group: a repeated one starts unchecked in the bulk dialog, and a group with nothing checked has no Create assets button.
    suggestion: { metric: spec.metric, scale: 1, interval_seconds: 5, custom_unit: null },
  };
}
const METRIC_CYCLE: Metric[] = ["active_power_kw", "energy_kwh", "voltage_v", "current_a", "power_factor", "frequency_hz", "reactive_power_kvar", "apparent_power_kva"];

function source(over: Partial<ApiSource> & Pick<ApiSource, "id" | "name">): ApiSource {
  return {
    connector_type: "opcua", config: {}, origin: "discovered", enabled: true, status: "unknown", last_error: null, has_secret: false, needs_credentials: false,
    point_count: 0, clusters: [], ungrouped: [], last_scan: SEEN, ...over,
  };
}
const withCount = (s: ApiSource): ApiSource => ({ ...s, point_count: s.ungrouped.length + s.clusters.reduce((n, c) => n + c.points.length, 0) });

// ---------------------------------------------------------------------------------------------------------------------------------
// The small fixed model: one source per status, a mapped and an unmapped point, an asset with a sub-asset.

export const SMALL = {
  /** Online and polled: a green dot, flowing edges, OPC UA. Two groups: LVP01 (1 of 3 points mapped, to the rack) and LVP02 (3 of 6, to the hall). */
  alpha: BASE + 101,
  /** Polled and offline: a red dot, Modbus. One group RACK-B of two points, nothing mapped (it can be removed, and it can have assets created from it). */
  bravo: BASE + 102,
  /** Needs credentials: an amber dot and the badge. Two points with no group. */
  charlie: BASE + 103,
  /** Added by hand and not enabled: a grey dot, a simulator. One group SIM-D of two points. */
  delta: BASE + 104,
  hall: BASE + 901,
  rack: BASE + 902,
  /** LVP01's first point: mapped to the rack. Hovering it lights alpha, LVP01, this point and the rack, and nothing else. */
  alphaMapped: BASE + 1001,
  alphaPlain: BASE + 1002,
  /** LVP02's first point (mapped to the hall). */
  alphaSecond: BASE + 1011,
  bravoVoltage: BASE + 2002,
  bravoPower: BASE + 2001,
  charlieStatus: BASE + 3001,
  deltaPower: BASE + 4001,
  deltaEnergy: BASE + 4002,
} as const;

export const SMALL_NAMES = {
  alpha: "W7u Alpha", bravo: "W7u Bravo", charlie: "W7u Charlie", delta: "W7u Delta", hall: "W7u Hall", rack: "W7u Rack 1",
} as const;

/** The groups of the small model, by the key the page shows. */
export const SMALL_GROUPS = { lvp01: "LVP01", lvp02: "LVP02", rackB: "RACK-B", simD: "SIM-D" } as const;

export function smallModel(): ApiGraphModel {
  const alpha = source({
    id: SMALL.alpha, name: SMALL_NAMES.alpha, connector_type: "opcua", status: "online", enabled: true, config: { endpoint: "opc.tcp://10.20.0.11:4840" },
    clusters: [
      {
        key: SMALL_GROUPS.lvp01,
        points: [
          point({ id: SMALL.alphaMapped, name: "LVP01 kW", metric: "active_power_kw", asset: SMALL.rack, mapping: BASE + 501 }),
          point({ id: SMALL.alphaPlain, name: "LVP01 kWh", metric: "energy_kwh" }),
          point({ id: BASE + 1003, name: "LVP01 V", metric: "voltage_v" }),
        ],
      },
      {
        key: SMALL_GROUPS.lvp02,
        points: [
          point({ id: SMALL.alphaSecond, name: "LVP02 kW", metric: "active_power_kw", asset: SMALL.hall, mapping: BASE + 502 }),
          point({ id: BASE + 1012, name: "LVP02 kWh", metric: "energy_kwh", asset: SMALL.hall, mapping: BASE + 503 }),
          point({ id: BASE + 1013, name: "LVP02 V", metric: "voltage_v", asset: SMALL.hall, mapping: BASE + 504 }),
          point({ id: BASE + 1014, name: "LVP02 A", metric: "current_a" }),
          point({ id: BASE + 1015, name: "LVP02 PF", metric: "power_factor" }),
          point({ id: BASE + 1016, name: "LVP02 Hz", metric: "frequency_hz" }),
        ],
      },
    ],
  });
  const bravo = source({
    id: SMALL.bravo, name: SMALL_NAMES.bravo, connector_type: "modbus", status: "offline", enabled: true, config: { host: "10.20.0.12", port: 502 },
    clusters: [{
      key: SMALL_GROUPS.rackB,
      points: [
        point({ id: SMALL.bravoPower, name: "RACK-B power", metric: "active_power_kw" }),
        point({ id: SMALL.bravoVoltage, name: "RACK-B voltage", metric: "voltage_v" }),
      ],
    }],
  });
  const charlie = source({
    id: SMALL.charlie, name: SMALL_NAMES.charlie, connector_type: "opcua", status: "unknown", enabled: true, needs_credentials: true, config: { endpoint: "opc.tcp://10.20.0.13:4840" },
    ungrouped: [
      point({ id: SMALL.charlieStatus, name: "Status", metric: "custom" }),
      point({ id: BASE + 3002, name: "Heartbeat", metric: "custom" }),
    ],
  });
  const delta = source({
    id: SMALL.delta, name: SMALL_NAMES.delta, connector_type: "simulator", origin: "manual", status: "unknown", enabled: false, last_scan: null, config: { url: "sim://w7u" },
    clusters: [{
      key: SMALL_GROUPS.simD,
      points: [
        point({ id: SMALL.deltaPower, name: "SIM-D power", metric: "active_power_kw" }),
        point({ id: SMALL.deltaEnergy, name: "SIM-D energy", metric: "energy_kwh" }),
      ],
    }],
  });
  return {
    sources: [alpha, bravo, charlie, delta].map(withCount),
    unidentified: [],
    assets: [
      // The hall is Automatic (no chosen icon: the kind's, the generic one); the rack has the Rack icon CHOSEN over its kind's (the node must draw the chosen one).
      { id: SMALL.hall, parent_id: null, name: SMALL_NAMES.hall, kind: "generic", icon: null, kind_icon: "generic" },
      { id: SMALL.rack, parent_id: SMALL.hall, name: SMALL_NAMES.rack, kind: "generic", icon: "rack", kind_icon: "generic" },
    ],
    layout: {},
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Big graphs, for the measurements.

export interface Shape {
  groups: number;
  pointsPerGroup: number;
  /** The points of each group, one number per group, instead of `groups` x `pointsPerGroup` (then `groups` is the list's length and `pointsPerGroup` is not read). */
  groupSizes?: readonly number[];
  /** `online` (the default) makes the source live: its edges flow, up to the page's limit. `offline` keeps them still. */
  status?: "online" | "offline";
}

/** The key and the point names `bigModel` gives: `GRP-<source>-<group>` and `PT-<source>-<group>-<point>` (1-based, the point number in four digits). */
export const bigGroup = (source: number, group: number) => `GRP-${source}-${group}`;
export const bigPoint = (source: number, group: number, point: number) => `PT-${source}-${group}-${String(point).padStart(4, "0")}`;
export const bigSourceId = (source: number) => BASE + 100 + source;
/** The points of the group `group` (1-based) of a shape. */
const sizeOf = (shape: Shape, group: number): number => shape.groupSizes ? shape.groupSizes[group - 1] : shape.pointsPerGroup;
/** The points of all the groups of a shape. */
const totalOf = (shape: Shape): number => shape.groupSizes ? shape.groupSizes.reduce((sum, n) => sum + n, 0) : shape.groups * shape.pointsPerGroup;
/** The id of a point of `bigModel`: sources hold at most 1,000,000 points between them. */
export const bigPointId = (shapes: readonly Shape[], source: number, group: number, point: number): number => {
  let before = 0;
  for (let s = 1; s < source; s++) before += totalOf(shapes[s - 1]);
  for (let g = 1; g < group; g++) before += sizeOf(shapes[source - 1], g);
  return BASE + 1_000_000 + before + (point - 1);
};

/**
 * `shapes.length` sources named `W7u Big <n>`, the n-th with `groups` groups of `pointsPerGroup` points and nothing mapped, and `assets` root assets.
 * Every source is enabled, so the page treats the online ones as live.
 */
export function bigModel(shapes: readonly Shape[], assets = 12): ApiGraphModel {
  const sources = shapes.map((shape, index) => {
    const s = index + 1;
    const clusters: ApiCluster[] = [];
    for (let g = 1; g <= shape.groups; g++) {
      const points: ApiPoint[] = [];
      for (let p = 1; p <= sizeOf(shape, g); p++) {
        points.push(point({ id: bigPointId(shapes, s, g, p), name: bigPoint(s, g, p), metric: METRIC_CYCLE[(p - 1) % METRIC_CYCLE.length] }));
      }
      clusters.push({ key: bigGroup(s, g), points });
    }
    return withCount(source({
      id: bigSourceId(s), name: `W7u Big ${s}`, connector_type: s % 2 === 1 ? "opcua" : "modbus", status: shape.status ?? "online",
      config: s % 2 === 1 ? { endpoint: `opc.tcp://10.30.0.${s}:4840` } : { host: `10.30.0.${s}`, port: 502 }, clusters,
    }));
  });
  const list: ApiAsset[] = [];
  for (let a = 1; a <= assets; a++) list.push({ id: BASE + 800 + a, parent_id: null, name: `W7u Big asset ${a}`, kind: "generic", icon: null, kind_icon: "generic" });
  return { sources, unidentified: [], assets: list, layout: {} };
}

/** About 2,000 nodes once a few groups are open: ten sources, the first with 6,000 points in six groups and the second with 60, the other eight with twenty. */
export const PERF_SHAPES: readonly Shape[] = [
  { groups: 6, pointsPerGroup: 1000, status: "offline" },
  { groups: 6, pointsPerGroup: 10 },
  ...Array.from({ length: 8 }, (): Shape => ({ groups: 4, pointsPerGroup: 5 })),
];

/**
 * About 2,000 nodes once everything is open, and no group over a page (49 points, the page is 50), so paging changes nothing: ten offline sources of four groups of
 * 49 points. Open it with repeated Expand all clicks (one press stops at 600 new nodes). The drag and the toggle cases of the W7u and W12b specs use it.
 */
export const DRAG_SHAPES: readonly Shape[] = Array.from({ length: 10 }, (): Shape => ({ groups: 4, pointsPerGroup: 49, status: "offline" }));

/**
 * One offline source with three groups, of 120, 260 and 1,000 points: the paging and the dash-limit cases (a group over 50 points opens with 50 points and a
 * Show 50 more node; a group over 150 draws solid fan-out edges). Its groups are `bigGroup(1, 1)` to `bigGroup(1, 3)`.
 */
export const PAGED_SHAPES: readonly Shape[] = [{ groups: 3, pointsPerGroup: 0, groupSizes: [120, 260, 1000], status: "offline" }];

/**
 * The idle-CPU graph: one online source of 100 groups of 2 points. One Expand all draws 301 nodes and 300 dashed edges, but only the 100 source to group
 * edges flow (the group to point edges never do): exactly the page's limit of flowing ones.
 */
export const LIVE_SHAPES: readonly Shape[] = [{ groups: 100, pointsPerGroup: 2 }];

// ---------------------------------------------------------------------------------------------------------------------------------
// (w37) The owner's shape: Discovery with hundreds of mapped assets.

/** What the server adds to a source of more than 1,000 points (backend `large_of`): the graph then sends only its mapped points and says how many there are in all. */
export interface ApiLarge { points: number; mapped: number; unmapped: number; rules_new: number }
export type ApiLargeSource = ApiSource & { large: ApiLarge };

/**
 * The ids of `familyModel` (assets from 9,037,100, points from 12,700,000, mappings from 12,900,000: far from every other helper's).
 * `small` is the 60-point simulator and comes FIRST, as on the owner's stack; `large` is the 15,000-tag shape simulator.
 */
export const FAMILY = {
  small: BASE + 37_001,
  large: BASE + 37_002,
  mv2: BASE + 37_100,
  room1: BASE + 37_101,
  room2: BASE + 37_102,
  room3: BASE + 37_103,
} as const;
export const FAMILY_NAMES = { small: "W37 Small", large: "W37 Large", mv2: "MV2", room1: "Room 1", room2: "Room 2", room3: "Room 3" } as const;
/** The ten racks (1 to 5 under Room 1, 6 to 10 under Room 2). */
export const familyRack = (n: number): number => BASE + 37_110 + n;
const familyRackName = (n: number): string => `Rack ${n <= 5 ? 1 : 2}.${n <= 5 ? n : n - 5}`;
/**
 * The 400 PDUs under Room 3 as the owner's data names them: `PDUA01` ... `PDUA99`, `PDUA100` ... `PDUA200`, `PDUB01` ... `PDUB99`, `PDUB100` ... `PDUB200` (two digits up to 99, three after).
 * `familyPdu(n)` and `familyPduName(n)` are the n-th child of Room 3 (n from 1 to 400) in the order the server lists a parent's children (`sort_order, name, id`; every sort order is 0 here), and the
 * model sends them in that order. The order is a plain code-point compare of the names, an APPROXIMATION of the database collation: `PDUA01` ... `PDUA09`, `PDUA10`, `PDUA100` ... `PDUA109`, `PDUA11`,
 * `PDUA110` ... and so on, so the first page of 50 ends at `PDUA136` and the last PDU is `PDUB99`. Nothing may name a PDU by its number: ask for the n-th and read its name from here.
 */
const PDU_NAMES: readonly string[] = ["A", "B"]
  .flatMap((hall) => Array.from({ length: 200 }, (_, index) => `PDU${hall}${String(index + 1).padStart(2, "0")}`))
  .sort(); // no comparator: UTF-16 code-unit order, which is the code-point order for these ASCII names
export const familyPdu = (n: number): number => BASE + 37_200 + n;
export const familyPduName = (n: number): string => {
  const name = PDU_NAMES[n - 1];
  if (name === undefined) throw new Error(`Room 3 has 400 PDUs: there is no number ${n}`);
  return name;
};
/** The ten groups of the small source, one per meter: `MTR01` ... `MTR10` (the tenth has nothing mapped). */
export const familyGroup = (n: number): string => `MTR${String(n).padStart(2, "0")}`;
/** The id of the summary node the page draws under the asset `parentId` (src/lib/graph.ts `nodeId.moreAssets`). */
export const summaryId = (parentId: number): string => `more:asset:${parentId}`;

const FAMILY_METERS: readonly (readonly [Metric, string])[] = [
  ["active_power_kw", "kW"], ["energy_kwh", "kWh"], ["voltage_v", "V"], ["current_a", "A"], ["power_factor", "PF"], ["frequency_hz", "Hz"],
];

/**
 * The owner's shape as the graph route sends it: one root `MV2`; under it `Room 1`, `Room 2` and `Room 3`; five racks under each of the first two; 400 PDUs under `Room 3`.
 * Two sources: the small one (ten groups of six points; groups 1 to 9 are mapped, six metrics each, onto racks 1 to 9; `MTR10` has nothing mapped, so a drop of it can open the Review)
 * and the large one (`large` says 15,000 points, 400 mapped; the graph holds only those 400, in the Ungrouped bag, each mapped to its PDU as the energy counter). The assets come in the
 * server's order (sort order, name, id), which puts the PDUs before the racks and the rooms.
 */
export function familyModel(): ApiGraphModel {
  const asset = (id: number, parent: number | null, name: string): ApiAsset => ({ id, parent_id: parent, name, kind: "generic", icon: null, kind_icon: "generic" });
  const rackParent = (n: number): number => (n <= 5 ? FAMILY.room1 : FAMILY.room2);
  const assets: ApiAsset[] = [asset(FAMILY.mv2, null, FAMILY_NAMES.mv2)];
  for (let n = 1; n <= 400; n++) assets.push(asset(familyPdu(n), FAMILY.room3, familyPduName(n)));
  for (let n = 1; n <= 10; n++) assets.push(asset(familyRack(n), rackParent(n), familyRackName(n)));
  assets.push(asset(FAMILY.room1, FAMILY.mv2, FAMILY_NAMES.room1), asset(FAMILY.room2, FAMILY.mv2, FAMILY_NAMES.room2), asset(FAMILY.room3, FAMILY.mv2, FAMILY_NAMES.room3));

  const small = withCount(source({
    id: FAMILY.small, name: FAMILY_NAMES.small, connector_type: "simulator", origin: "manual", status: "online", config: { url: "sim://w37" },
    clusters: Array.from({ length: 10 }, (_, index): ApiCluster => {
      const g = index + 1;
      return {
        key: familyGroup(g),
        points: FAMILY_METERS.map(([metric, unit], m) => point({
          id: BASE + 3_800_000 + g * 10 + m, name: `${familyGroup(g)} ${unit}`, metric,
          ...(g <= 9 ? { asset: familyRack(g), mapping: BASE + 3_900_000 + g * 10 + m } : {}),
        })),
      };
    }),
  }));

  const mapped: ApiPoint[] = Array.from({ length: 400 }, (_, index) => {
    const n = index + 1;
    return point({ id: BASE + 3_700_000 + n, name: `${familyPduName(n)}_PM0_PENRG`, metric: "energy_kwh", asset: familyPdu(n), mapping: BASE + 3_950_000 + n });
  });
  const large: ApiLargeSource = {
    ...source({
      id: FAMILY.large, name: FAMILY_NAMES.large, connector_type: "opcua", status: "online", config: { endpoint: "opc.tcp://10.37.0.2:4840" }, ungrouped: mapped,
    }),
    point_count: 15_000,
    large: { points: 15_000, mapped: 400, unmapped: 14_600, rules_new: 0 },
  };
  return { sources: [small, large], unidentified: [], assets, layout: {} };
}
