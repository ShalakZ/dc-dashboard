export function EnergyTile({ energy }: { energy: { kwh: number; estimated: boolean } | null }) {
  return (
    <div className="tile">
      <div className="muted">Energy today</div>
      {energy === null ? <div className="big">no energy data</div> : (
        <div className="big">{energy.kwh.toFixed(2)} kWh{energy.estimated && <small className="muted"> (estimated)</small>}</div>
      )}
    </div>
  );
}
