import type { CostToday } from "../api/types";
import { fmtCost } from "../lib/billing";
import { Figure } from "./Figure";

/**
 * Today's cost for the asset page. A dash means "no rate" (or no cost data at all), never zero. A figure whose
 * day recorded nothing (`no_data`) stays a number but is muted, because its 0.00 is not a measurement.
 */
export function CostTile({ cost, currency }: { cost: CostToday | null; currency: string | null }) {
  return (
    <div className="tile">
      <div className="muted">Cost today</div>
      {cost === null && (
        <>
          <div className="big">—</div>
          <small className="muted">no cost data</small>
        </>
      )}
      {cost !== null && cost.cost === null && (
        <>
          <div className={cost.no_data ? "big muted" : "big"} title={cost.no_data ? "no data" : undefined}>—</div>
          <small className="muted">no rate set</small>
        </>
      )}
      {cost !== null && cost.cost !== null && (
        <>
          <div className={cost.no_data ? "big muted" : "big"} title={cost.no_data ? "no data" : undefined}>
            <Figure text={fmtCost(cost.cost)} estimated={cost.estimated} partial={cost.partial} />
            {currency && <small className="muted"> {currency}</small>}
          </div>
          {!currency && <small className="muted">currency not set</small>}
        </>
      )}
    </div>
  );
}
