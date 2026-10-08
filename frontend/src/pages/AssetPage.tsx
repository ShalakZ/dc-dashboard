import { lazy, Suspense, useMemo } from "react";
import { Link, useParams } from "react-router";
import { useSummary } from "../api/queries";
import { CostTile } from "../components/CostTile";
import { EnergyTile } from "../components/EnergyTile";
import { fmt, MetricsTable } from "../components/MetricsTable";
import { useStream } from "../hooks/useStream";

const TrendChart = lazy(() => import("../components/TrendChart").then((m) => ({ default: m.TrendChart })));

export function AssetPage() {
  const id = Number(useParams().id);
  const { data, error, isLoading } = useSummary(id);
  const wanted = useMemo(() => new Set((data?.metrics ?? []).map((m) => m.point_id)), [data]);
  const { values: live, connected } = useStream(wanted);

  if (isLoading) return <p className="muted">loading…</p>;
  if (error || !data) return <p className="error" role="alert">{error?.message ?? "not found"}</p>;
  const power = data.metrics.find((m) => m.metric === "active_power_kw");
  // A stream entry wins even when its value is null (bad quality); only fall back when the stream has no entry yet.
  const livePower = power ? (live.has(power.point_id) ? live.get(power.point_id)!.value : power.value) : null;
  return (
    <>
      <p><Link to="/assets">Assets</Link> / {data.asset.name}</p>
      <div className="row"><h1>{data.asset.name}</h1><span className="muted">{connected ? "live" : "reconnecting…"}</span></div>
      <div className="tile"><div className="muted">Live power</div><div className="big">{power ? `${fmt(livePower)} kW` : "—"}</div></div>
      <EnergyTile energy={data.energy_today} />
      <CostTile cost={data.cost_today ?? null} currency={data.currency ?? null} />
      <h2>Trend</h2>
      <Suspense fallback={<p className="muted">loading chart…</p>}>
        <TrendChart assetId={id} metrics={data.metrics} />
      </Suspense>
      <h2>Metrics</h2>
      <MetricsTable metrics={data.metrics} live={live} />
    </>
  );
}
