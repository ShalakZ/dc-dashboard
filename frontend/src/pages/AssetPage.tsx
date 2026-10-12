import { lazy, Suspense, useMemo } from "react";
import { useParams } from "react-router";
import { ApiError } from "../api/client";
import { useAssets, useSummary } from "../api/queries";
import { CostTile } from "../components/CostTile";
import type { Crumb } from "../components/Crumbs";
import { EnergyTile } from "../components/EnergyTile";
import { Icon } from "../components/Icon";
import { fmt, MetricsTable } from "../components/MetricsTable";
import { PageHeader } from "../components/PageHeader";
import { Pending } from "../components/Pending";
import { useStream } from "../hooks/useStream";
import { kindIcon } from "../lib/kindIcon";
import { rollupNote, rollupPower } from "../lib/rollup";
import { assetTrail, parseAssetId } from "../lib/tree";
import { assetActions, useAssetsContext } from "./AssetsPage";

const NOT_FOUND = "Asset not found."; // one sentence for an id that cannot be one and for an asset the API does not know

const TrendChart = lazy(() => import("../components/TrendChart").then((m) => ({ default: m.TrendChart })));

export function AssetPage() {
  const id = parseAssetId(useParams().id);
  if (id === null) return <p className="error" role="alert">{NOT_FOUND}</p>; // no request goes out for an id that cannot be one
  // Keyed by the id: this one route element stays mounted from asset to asset, and the stream's values must not follow the user.
  return <AssetView key={id} id={id} />;
}

function AssetView({ id }: { id: number }) {
  const workspace = useAssetsContext(); // null when the page is mounted alone: then it has no admin buttons
  const { data, error, isLoading } = useSummary(id);
  const { data: assets } = useAssets();
  const trail = useMemo(() => assetTrail(assets ?? [], id), [assets, id]);
  const wanted = useMemo(() => {
    const ids = (data?.metrics ?? []).map((m) => m.point_id);
    // The roll-up's meters are read only when the asset has no power meter of its own (its own reading is shown then).
    if (!data?.metrics.some((m) => m.metric === "active_power_kw")) ids.push(...(data?.power_rollup?.sources ?? []).map((s) => s.point_id));
    return new Set(ids);
  }, [data]);
  const { values: live, connected } = useStream(wanted);

  if (isLoading) return <p className="muted">loading…</p>;
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
  // The ancestors come from the cached list. Until the list has the asset (just created, or not loaded) the trail is Assets / the asset, which the page always knows.
  const crumbs: Crumb[] = [
    { label: "Assets", to: "/assets" },
    ...trail.slice(0, -1).map((a) => ({ label: a.name, to: `/assets/${a.id}` })),
    { label: data.asset.name },
  ];
  // The direct sub-assets are counted only when the list has the asset: a count taken from a list that lacks it would be a guess.
  const subCount = assets && trail.length > 0 ? assets.filter((a) => a.parent_id === id).length : null;
  const sub = [data.asset.kind.trim(), subCount === null ? "" : `${subCount} sub-asset${subCount === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  return (
    <div className="asset-page">
      <PageHeader
        title={data.asset.name}
        icon={kindIcon(data.asset.kind)}
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
      <Suspense fallback={<><Pending /><p className="muted">loading chart…</p></>}>
        <TrendChart assetId={id} metrics={data.metrics} />
      </Suspense>
      <h2>Metrics</h2>
      <MetricsTable metrics={data.metrics} live={live} />
    </div>
  );
}
