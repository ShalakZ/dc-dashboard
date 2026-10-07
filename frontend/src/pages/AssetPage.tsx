import { useMemo } from "react";
import { Link, useParams } from "react-router";
import { useSummary } from "../api/queries";
import { EnergyTile } from "../components/EnergyTile";
import { fmt, MetricsTable } from "../components/MetricsTable";
import { TrendChart } from "../components/TrendChart";
import { useStream } from "../hooks/useStream";

export function AssetPage() {
  const id = Number(useParams().id);
  const { data, error, isLoading } = useSummary(id);
  const wanted = useMemo(() => new Set((data?.metrics ?? []).map((m) => m.point_id)), [data]);
  const live = useStream(wanted);

  if (isLoading) return <p className="muted">loading…</p>;
  if (error || !data) return <p className="error" role="alert">{error?.message ?? "not found"}</p>;
  const power = data.metrics.find((m) => m.metric === "active_power_kw");
  const livePower = power ? (live.get(power.point_id)?.value ?? power.value) : null;
  return (
    <>
      <p><Link to="/assets">Assets</Link> / {data.asset.name}</p>
      <h1>{data.asset.name}</h1>
      <div className="tile"><div className="muted">Live power</div><div className="big">{power ? `${fmt(livePower)} kW` : "—"}</div></div>
      <EnergyTile energy={data.energy_today} />
      <h2>Trend</h2>
      <TrendChart assetId={id} metrics={data.metrics} />
      <h2>Metrics</h2>
      <MetricsTable metrics={data.metrics} live={live} />
    </>
  );
}
