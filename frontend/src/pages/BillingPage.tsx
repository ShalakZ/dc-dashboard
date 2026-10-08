import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useBillingCosts, useSite } from "../api/queries";
import type { BillingCosts, CostFigure } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { ESTIMATED_TIP, Figure, PARTIAL_TIP } from "../components/Figure";
import { depthsByAsset, fmtCost, fmtKwh, fmtRate, monthLabel, shiftMonth } from "../lib/billing";
import { downloadCsv } from "../lib/download";
import { formatSiteDay, siteMonth } from "../lib/siteTime";

/**
 * One day (or the month) of one asset: kWh above, cost below.
 * - A dash is only ever a cost with no rate (`cost === null` inside a figure); it is never a zero.
 * - A figure that recorded nothing (`no_data`) keeps its 0 but is muted and titled "no data".
 * - No figure at all (`null`) is an empty muted cell: an asset without a meter, or a day not reached yet.
 */
function FigureCell({ figure, emptyTitle }: { figure: CostFigure | null; emptyTitle: "no meter" | "not yet" }) {
  if (figure === null) return <td className="num muted" title={emptyTitle} />;
  return (
    <td className={figure.no_data ? "num muted" : "num"} title={figure.no_data ? "no data" : undefined}>
      <div><Figure text={fmtKwh(figure.kwh)} estimated={figure.estimated} partial={false} /></div>
      <div className="muted">
        {figure.cost === null ? "—" : <Figure text={fmtCost(figure.cost)} estimated={figure.estimated} partial={figure.partial} />}
      </div>
    </td>
  );
}

function Legend() {
  return (
    <ul className="legend muted">
      <li><abbr title={ESTIMATED_TIP}>~</abbr> estimated from average power (no energy counter)</li>
      <li><abbr title={PARTIAL_TIP}>*</abbr> partial: some consumption had no rate</li>
      <li>— no rate</li>
      <li>shaded cell: no data was recorded, so the 0 is not a measurement</li>
      <li>empty cell: no meter, or the day has not been reached yet</li>
    </ul>
  );
}

function BillingTable({ costs, isAdmin }: { costs: BillingCosts; isAdmin: boolean }) {
  const depth = useMemo(() => depthsByAsset(costs.assets), [costs.assets]);
  if (costs.assets.length === 0) return <p className="muted">No assets yet.</p>;
  if (costs.assets.every((a) => a.total === null)) return <p className="muted">No energy data for this month.</p>;
  const missingRate = costs.assets.some((a) => a.total !== null && a.total.kwh > 0 && (a.total.cost === null || a.total.partial));
  return (
    <>
      {missingRate && (isAdmin ? (
        <p role="status">
          Some consumption has no rate (shown as — or *). <Link to="/tariffs">Set a rate on the Tariffs page</Link>.
        </p>
      ) : (
        <p role="status" className="muted">Some consumption has no rate (shown as — or *). Ask an administrator to set one.</p>
      ))}
      <div className="table-scroll">
        <table className="billing">
          <caption className="muted">
            Each cell shows kWh above and cost{costs.currency ? ` in ${costs.currency}` : ""} below.
          </caption>
          <thead>
            <tr>
              <th>Asset</th>
              <th>{costs.currency ? `Rate (${costs.currency}/kWh)` : "Rate (per kWh)"}</th>
              <th>Month total</th>
              {costs.days.map((day) => <th key={day} title={formatSiteDay(day)}>{Number(day.slice(8))}</th>)}
            </tr>
          </thead>
          <tbody>
            {costs.assets.map((a) => {
              // A null day is "no meter" for an asset without any figure, otherwise a day that has not been reached yet.
              const emptyTitle = a.total === null ? "no meter" : "not yet";
              return (
                <tr key={a.asset_id}>
                  <th scope="row" title={a.path} style={{ paddingLeft: 8 + (depth.get(a.asset_id) ?? 0) * 16 }}>{a.name}</th>
                  <td className="num">{fmtRate(a.rate_per_kwh)}</td>
                  <FigureCell figure={a.total} emptyTitle={emptyTitle} />
                  {a.days.map((d, i) => <FigureCell key={costs.days[i]} figure={d} emptyTitle={emptyTitle} />)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Legend />
    </>
  );
}

export function BillingPage() {
  const { hasRole } = useAuth();
  const site = useSite();
  const [picked, setPicked] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // "This month" is decided on the site's wall clock: near a month end it differs from the browser's and from UTC.
  const current = site.data ? siteMonth(new Date(), site.data.timezone) : null;
  const month = picked ?? current;
  const costs = useBillingCosts(month);

  const exportCsv = async () => {
    if (month === null) return;
    setExporting(true);
    setExportError(null);
    try {
      await downloadCsv(`/api/billing/costs.csv?month=${month}`);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <section>
      <h1>Billing</h1>
      {site.isError && <p className="error" role="alert">{site.error.message}</p>}
      {month !== null && (
        <div className="row">
          <button type="button" onClick={() => setPicked(shiftMonth(month, -1))}>Previous month</button>
          <strong aria-live="polite">{monthLabel(month)}</strong>
          <button type="button" onClick={() => setPicked(shiftMonth(month, 1))} disabled={current !== null && month >= current}>
            Next month
          </button>
          <button type="button" onClick={exportCsv} disabled={exporting}>Download CSV</button>
        </div>
      )}
      {exportError && <p className="error" role="alert">{exportError}</p>}
      {(site.isPending || (month !== null && costs.isPending)) && <p className="muted">loading…</p>}
      {costs.isError && <p className="error" role="alert">{costs.error.message}</p>}
      {costs.data && <BillingTable costs={costs.data} isAdmin={hasRole("admin")} />}
    </section>
  );
}
