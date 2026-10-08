/** Today's energy. When nothing was recorded (`no_data`) the 0.00 is shown muted: it is not a measurement. */
export function EnergyTile({ energy }: { energy: { kwh: number; estimated: boolean; no_data: boolean } | null }) {
  return (
    <div className="tile">
      <div className="muted">Energy today</div>
      {energy === null ? <div className="big">no energy data</div> : (
        <div className={energy.no_data ? "big muted" : "big"} title={energy.no_data ? "no data" : undefined}>
          {energy.kwh.toFixed(2)} kWh{energy.estimated && <small className="muted"> (estimated)</small>}
        </div>
      )}
    </div>
  );
}
