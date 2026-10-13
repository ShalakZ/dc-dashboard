import { useId, useMemo, useState } from "react";
import { Link } from "react-router";
import { useBillingCosts, useBillingMonths, useSite } from "../api/queries";
import type { BillingCosts, CostFigure } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { meets } from "../auth/need";
import { ESTIMATED_TIP, Figure, PARTIAL_TIP } from "../components/Figure";
import { PAGE_NEED } from "../components/navItems";
import { PageHeader } from "../components/PageHeader";
import { ActionsSpace, TableSkeleton } from "../components/Skeleton";
import {
  clampMonth, depthsByAsset, fmtCost, fmtKwh, fmtRate, MONTH_NAMES, monthLabel, monthsOfYear, shiftMonth, yearsBetween,
} from "../lib/billing";
import { downloadCsv } from "../lib/download";
import { formatSiteDay, siteMonth } from "../lib/siteTime";

// Inline SVG, 24-unit viewBox, decoration only (the words next to each one say everything).
const WarnIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 10v4.5M12 17.5h.01" /></svg>
);
const ReceiptIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6M9 16h3" /></svg>
);
const ChevronIcon = ({ dir }: { dir: "left" | "right" }) => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d={dir === "left" ? "m14.5 6-6 6 6 6" : "m9.5 6 6 6-6 6"} /></svg>
);
const DownloadIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" /></svg>
);

function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <div className="empty-icon"><ReceiptIcon /></div>
      <p>{text}</p>
    </div>
  );
}

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

/** `canSetRates`: the person may open the Tariffs page, so the note links to it; for anyone else it says to ask. */
function BillingTable({ costs, canSetRates }: { costs: BillingCosts; canSetRates: boolean }) {
  const depth = useMemo(() => depthsByAsset(costs.assets), [costs.assets]);
  if (costs.assets.length === 0) return <Empty text="No assets yet." />;
  if (costs.assets.every((a) => a.total === null)) return <Empty text="No energy data for this month." />;
  const missingRate = costs.assets.some((a) => a.total !== null && a.total.kwh > 0 && (a.total.cost === null || a.total.partial));
  return (
    <>
      {missingRate && (canSetRates ? (
        <div role="status" className="banner banner-warn">
          <WarnIcon />
          <span>Some consumption has no rate (shown as — or *). <Link to="/tariffs">Set a rate on the Tariffs page</Link>.</span>
        </div>
      ) : (
        <div role="status" className="banner banner-warn">
          <WarnIcon />
          <span>Some consumption has no rate (shown as — or *). Ask an administrator to set one.</span>
        </div>
      ))}
      <div className="table-scroll table-wrap">
        <table className="billing">
          <caption className="muted">
            Each cell shows kWh above and cost{costs.currency ? ` in ${costs.currency}` : ""} below.
          </caption>
          <thead>
            <tr>
              <th>Asset</th>
              <th className="num">{costs.currency ? `Rate (${costs.currency}/kWh)` : "Rate (per kWh)"}</th>
              <th className="num">Month total</th>
              {costs.days.map((day) => <th key={day} className="num" title={formatSiteDay(day)}>{Number(day.slice(8))}</th>)}
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

/**
 * The Year and Month selects. Their bounds widen to the month on screen, so they always hold it even when a time-zone change
 * leaves it outside [first month with data, current month]; picking clamps into those same bounds.
 */
function MonthJump({ month, firstMonth, current, onPick }: {
  month: string; firstMonth: string | null; current: string | null; onPick: (month: string) => void;
}) {
  const yearId = useId();
  const monthId = useId();
  const low = [month, firstMonth, current].filter((m): m is string => m !== null).sort()[0];
  const high = current !== null && current > month ? current : month;
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5));
  const pick = (y: number, m: number) => onPick(clampMonth(`${y}-${String(m).padStart(2, "0")}`, low, high));
  return (
    <div className="billing-jump">
      <span className="jump-field">
        <label htmlFor={yearId}>Year</label>
        <select id={yearId} value={year} disabled={current === null} onChange={(e) => pick(Number(e.target.value), monthNumber)}>
          {yearsBetween(low, high).map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </span>
      <span className="jump-field">
        <label htmlFor={monthId}>Month</label>
        <select id={monthId} value={monthNumber} disabled={current === null} onChange={(e) => pick(year, Number(e.target.value))}>
          {monthsOfYear(year, low, high).map((m) => <option key={m} value={m}>{MONTH_NAMES[m - 1]}</option>)}
        </select>
      </span>
    </div>
  );
}

export function BillingPage() {
  const { can } = useAuth();
  const canExport = can("billing.export");
  const site = useSite();
  const [picked, setPicked] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // "This month" is decided on the site's wall clock: near a month end it differs from the browser's and from UTC.
  const current = site.data ? siteMonth(new Date(), site.data.timezone) : null;
  const month = picked ?? current;
  const costs = useBillingCosts(month);
  // The first month with data only narrows what Previous and the selects offer; while it is unknown (pending, failed, none) nothing is limited.
  const firstMonth = useBillingMonths().data?.first_month ?? null;

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
    <section className="billing-page">
      <PageHeader
        title="Billing"
        actions={!canExport ? undefined : month !== null ? (
          <button type="button" className="primary" onClick={exportCsv} disabled={exporting}><DownloadIcon />Download CSV</button>
        ) : site.isPending ? <ActionsSpace /> : undefined /* the button waits for the site's month; its height does not */}
      />
      {site.isError && <p className="error" role="alert">{site.error.message}</p>}
      {month === null && site.isPending && <div className="row billing-bar" aria-hidden="true"><ActionsSpace height={38} /></div>}
      {month !== null && (
        <div className="row billing-bar">
          <button type="button" onClick={() => setPicked(shiftMonth(month, -1))} disabled={firstMonth !== null && month <= firstMonth}>
            <ChevronIcon dir="left" />Previous month
          </button>
          <strong className="month-label" aria-live="polite">{monthLabel(month)}</strong>
          <button type="button" onClick={() => setPicked(shiftMonth(month, 1))} disabled={current !== null && month >= current}>
            Next month<ChevronIcon dir="right" />
          </button>
          <MonthJump month={month} firstMonth={firstMonth} current={current} onPick={setPicked} />
        </div>
      )}
      {exportError && <p className="error" role="alert">{exportError}</p>}
      {(site.isPending || (month !== null && costs.isPending)) && (
        // The costs poll sets a query that failed before pending again for a second, with no error: the skeleton and the error would take turns.
        costs.errorUpdateCount === 0 ? <TableSkeleton columns={7} rows={5} label="Loading billing" caption /> : <p className="muted">loading…</p>
      )}
      {costs.isError && <p className="error" role="alert">{costs.error.message}</p>}
      {costs.data && <BillingTable costs={costs.data} canSetRates={meets(PAGE_NEED.tariffs, can)} />}
    </section>
  );
}
