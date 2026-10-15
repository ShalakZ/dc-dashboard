import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { ApiError } from "../api/client";
import { keys, useAssetKinds, useAssets, useSummary } from "../api/queries";
import type { Asset, Summary, SummaryMetric } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { CostTile } from "../components/CostTile";
import type { Crumb } from "../components/Crumbs";
import { EnergyTile } from "../components/EnergyTile";
import { Icon } from "../components/Icon";
import { fmt, metricName, MetricsTable } from "../components/MetricsTable";
import { PageHeader } from "../components/PageHeader";
import { Pending } from "../components/Pending";
import { AssetSkeleton, SkeletonRegion, TrendSkeleton } from "../components/Skeleton";
import { useMappingActions } from "../hooks/useMappingActions";
import { useStream } from "../hooks/useStream";
import { assetIcon } from "../lib/assetIcons";
import { rollupNote, rollupPower } from "../lib/rollup";
import { assetTrail, parseAssetId } from "../lib/tree";
import { assetActions, useAssetsContext } from "./AssetsPage";

const NOT_FOUND = "Asset not found."; // one sentence for an id that cannot be one and for an asset the API does not know
const NO_ASSETS: Asset[] = []; // a stable empty list: the mapping actions memoise on it

// One request for the chart's chunk, shared by the lazy component and the page's early start of it.
let chunk: Promise<{ default: typeof import("../components/TrendChart").TrendChart }> | null = null;
const loadTrendChart = () => (chunk ??= import("../components/TrendChart").then((m) => ({ default: m.TrendChart })));
const TrendChart = lazy(loadTrendChart);

export function AssetPage() {
  const id = parseAssetId(useParams().id);
  if (id === null) return <p className="error" role="alert">{NOT_FOUND}</p>; // no request goes out for an id that cannot be one
  // Keyed by the id: this one route element stays mounted from asset to asset, and the stream's values must not follow the user.
  return <AssetView key={id} id={id} />;
}

function AssetView({ id }: { id: number }) {
  const workspace = useAssetsContext(); // null when the page is mounted alone: then it has no edit or delete buttons
  const { can } = useAuth();
  const client = useQueryClient();
  const { data, error, isLoading, errorUpdateCount } = useSummary(id);
  const { data: assets, isLoading: assetsLoading } = useAssets();
  const { data: kinds } = useAssetKinds(can("assets.view"));
  const maps = useMappingActions({ assets: assets ?? NO_ASSETS, kinds }); // the row menu of the metrics table (assets.edit)
  const page = useRef<HTMLDivElement>(null);
  const metricsHeading = useRef<HTMLHeadingElement>(null);
  // Where the focus goes once a change is done: the changed row's position in the table before the change. The refetched summary is in the
  // cache when `after` runs but React draws it a moment later, so the focus waits until the page shows what the cache holds.
  const [refocus, setRefocus] = useState<number | null>(null);
  useEffect(() => {
    if (refocus === null || data !== client.getQueryData<Summary>(keys.summary(id))) return;
    // The changed row and its menu button are gone, so the focus goes to the row that took its place (the next one), else the one before it,
    // else the heading (an empty table has no button). A refused change left the row where it was: the same position is the same row.
    const buttons = page.current?.querySelectorAll<HTMLElement>(".metrics-table tbody .row-menu-btn");
    (buttons?.[refocus] ?? buttons?.[refocus - 1] ?? metricsHeading.current)?.focus({ preventScroll: true });
    setRefocus(null);
  }, [refocus, data, client, id]);
  // The chart's chunk starts loading with the page, so by the time the summary is in, its fallback is rarely needed.
  useEffect(() => { loadTrendChart().catch(() => {}); }, []);
  const trail = useMemo(() => assetTrail(assets ?? [], id), [assets, id]);
  const wanted = useMemo(() => {
    const ids = (data?.metrics ?? []).map((m) => m.point_id);
    // The roll-up's meters are read only when the asset has no power meter of its own (its own reading is shown then).
    if (!data?.metrics.some((m) => m.metric === "active_power_kw")) ids.push(...(data?.power_rollup?.sources ?? []).map((s) => s.point_id));
    return new Set(ids);
  }, [data]);
  const { values: live, connected } = useStream(wanted);

  // The crumbs need the asset list too. A summary that failed before and is tried again by its poll is pending for a second, with no error:
  // the skeleton would take turns with the error at every poll, so that case keeps the plain line.
  if (isLoading || (assetsLoading && !error)) {
    return errorUpdateCount === 0 ? <AssetSkeleton label="Loading the asset" canEdit={maps.canEdit} /> : <p className="muted">loading…</p>;
  }
  if (error instanceof ApiError && error.status === 404) return <p className="error" role="alert">{NOT_FOUND}</p>;
  if (error || !data) return <p className="error" role="alert">{error?.message ?? "not found"}</p>;
  const power = data.metrics.find((m) => m.metric === "active_power_kw");
  // A stream entry wins even when its value is null (bad quality); only fall back when the stream has no entry yet.
  const livePower = power ? (live.has(power.point_id) ? live.get(power.point_id)!.value : power.value) : null;
  const sources = power ? [] : data.power_rollup?.sources ?? [];
  const rollup = sources.length > 0 ? rollupPower(sources, live) : null;
  const note = rollup && rollupNote(rollup, sources);
  const chip = wanted.size > 0 ? <span className={connected ? "chip chip-ok" : "chip chip-warn"}>{connected ? "live" : "reconnecting…"}</span> : null;
  const buttons = assetActions(workspace, data.asset);
  // The ancestors come from the cached list. Until the list has the asset (just created, or not loaded) the trail is Assets Tree / the asset, which the page always knows.
  const crumbs: Crumb[] = [
    { label: "Assets Tree", to: "/assets", icon: "assets" },
    ...trail.slice(0, -1).map((a) => ({ label: a.name, to: `/assets/${a.id}`, icon: assetIcon(a) })),
    { label: data.asset.name, icon: assetIcon(data.asset) },
  ];
  // The direct sub-assets are counted only when the list has the asset: a count taken from a list that lacks it would be a guess.
  const subCount = assets && trail.length > 0 ? assets.filter((a) => a.parent_id === id).length : null;
  const sub = [data.asset.kind.trim(), subCount === null ? "" : `${subCount} sub-asset${subCount === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  // The summary names no point, so a sentence names the metric. Both open a confirmation or a dialog; the table's row is looked up again by its position when the change is done.
  const mappingRef = (m: SummaryMetric) => ({ id: m.mapping_id, name: metricName(m, data.metrics), assetId: id });
  const afterChange = (m: SummaryMetric) => {
    const index = data.metrics.findIndex((x) => x.mapping_id === m.mapping_id);
    return () => setRefocus(index);
  };
  const rowActions = maps.canEdit
    ? {
        onUnmap: (m: SummaryMetric) => maps.unmap([mappingRef(m)], { after: afterChange(m) }),
        onMove: (m: SummaryMetric) => maps.move([{ ...mappingRef(m), metric: m.metric }], { after: afterChange(m) }),
      }
    : undefined;
  return (
    <div className="asset-page" ref={page}>
      <PageHeader
        title={data.asset.name}
        icon={assetIcon(data.asset)}
        crumbs={crumbs}
        sub={sub || undefined}
        actions={chip || buttons ? <>{chip}{buttons}</> : undefined}
      />
      <div className="tiles">
        <div className="tile">
          <div className="muted tile-label"><Icon name="rate" />Live power</div>
          <div className="big">{power ? `${fmt(livePower)} kW` : rollup?.kw != null ? `${fmt(rollup.kw)} kW` : "—"}</div>
          {note && <small className="muted" title={note.title}>{note.text}</small>}
          {note?.silent && <div className="muted"><small>Not reporting: {note.silent}</small></div>}
        </div>
        <EnergyTile energy={data.energy_today} />
        <CostTile cost={data.cost_today ?? null} currency={data.currency ?? null} />
      </div>
      <h2>Trend</h2>
      <Suspense fallback={<><Pending /><SkeletonRegion label="Loading the chart"><TrendSkeleton /></SkeletonRegion></>}>
        <TrendChart assetId={id} metrics={data.metrics} />
      </Suspense>
      <h2 id="metrics-heading" ref={metricsHeading} tabIndex={-1}>Metrics</h2>
      <MetricsTable metrics={data.metrics} live={live} actions={rowActions} />
      {maps.dialogs}
    </div>
  );
}
