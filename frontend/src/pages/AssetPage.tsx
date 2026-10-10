import { lazy, Suspense, useMemo } from "react";
import { Link, useParams } from "react-router";
import { useSummary } from "../api/queries";
import { CostTile } from "../components/CostTile";
import { EnergyTile } from "../components/EnergyTile";
import { fmt, MetricsTable } from "../components/MetricsTable";
import { useStream } from "../hooks/useStream";
import { rollupNote, rollupPower } from "../lib/rollup";

const TrendChart = lazy(() => import("../components/TrendChart").then((m) => ({ default: m.TrendChart })));

export function AssetPage() {
  const id = Number(useParams().id);
  const { data, error, isLoading } = useSummary(id);
  const wanted = useMemo(() => {
    const ids = (data?.metrics ?? []).map((m) => m.point_id);
    // The roll-up's meters are read only when the asset has no power meter of its own (its own reading is shown then).
    if (!data?.metrics.some((m) => m.metric === "active_power_kw")) ids.push(...(data?.power_rollup?.sources ?? []).map((s) => s.point_id));
    return new Set(ids);
  }, [data]);
  const { values: live, connected } = useStream(wanted);

  if (isLoading) return <p className="muted">loading…</p>;
  if (error || !data) return <p className="error" role="alert">{error?.message ?? "not found"}</p>;
  const power = data.metrics.find((m) => m.metric === "active_power_kw");
  // A stream entry wins even when its value is null (bad quality); only fall back when the stream has no entry yet.
  const livePower = power ? (live.has(power.point_id) ? live.get(power.point_id)!.value : power.value) : null;
  const sources = power ? [] : data.power_rollup?.sources ?? [];
  const rollup = sources.length > 0 ? rollupPower(sources, live) : null;
  const note = rollup && rollupNote(rollup, sources);
  return (
    <>
      <p><Link to="/assets">Assets</Link> / {data.asset.name}</p>
      <div className="row"><h1>{data.asset.name}</h1>{wanted.size > 0 && <span className="muted">{connected ? "live" : "reconnecting…"}</span>}</div>
      <div className="tile">
        <div className="muted">Live power</div>
        <div className="big">{power ? `${fmt(livePower)} kW` : rollup?.kw != null ? `${fmt(rollup.kw)} kW` : "—"}</div>
        {note && <small className="muted" title={note.title}>{note.text}</small>}
        {note?.silent && <div className="muted"><small>Not reporting: {note.silent}</small></div>}
      </div>
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
