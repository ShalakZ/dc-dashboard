import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useBillingCosts, useBillingMonths, useSite } from "../api/queries";
import type { BillingClosed, BillingCosts, BillingLive, CostFigure } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { meets } from "../auth/need";
import { CloseMonthDialog } from "../components/CloseMonthDialog";
import { ESTIMATED_TIP, Figure, PARTIAL_TIP } from "../components/Figure";
import { PAGE_NEED } from "../components/navItems";
import { PageHeader } from "../components/PageHeader";
import { ReopenMonthDialog } from "../components/ReopenMonthDialog";
import { ActionsSpace, TableSkeleton } from "../components/Skeleton";
import { useToast } from "../components/Toasts";
import {
  clampMonth, closedOnText, depthsByAsset, fmtCost, fmtKwh, fmtRate, liveDeltaText, MONTH_NAMES, monthLabel, monthsOfYear, shiftMonth, yearsBetween,
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
const LockIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9.5" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
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

/** `canSetRates`: the person may open the Tariffs page AND change a rate on it, so the note links to it; for anyone else it says to ask. */
function BillingTable({ costs, canSetRates }: { costs: BillingCosts; canSetRates: boolean }) {
  const depth = useMemo(() => depthsByAsset(costs.assets), [costs.assets]);
  if (costs.assets.length === 0) return <Empty text="No assets yet." />;
  if (costs.assets.every((a) => a.total === null)) return <Empty text="No energy data for this month." />;
  const missingRate = costs.assets.some((a) => a.total !== null && a.total.kwh > 0 && (a.total.cost === null || a.total.partial));
  return (
    <>
      {missingRate && (costs.closed ? (
        <div role="status" className="banner banner-warn">
          <WarnIcon />
          <span>Some consumption has no rate (shown as — or *). This month is closed, so a rate set now changes it only if the month is reopened.</span>
        </div>
      ) : canSetRates ? (
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
 * What a closed month says about itself, above its table: who closed it and when (the date on the site's wall clock) and the note on its own line,
 * then, quieter, what today's tree and rates would give when that differs. Plain text with no role: the page's one status is the missing-rate banner.
 */
function ClosedNotice({ closed, live, timezone }: { closed: BillingClosed; live: BillingLive | null | undefined; timezone: string }) {
  const delta = liveDeltaText(live, closed);
  return (
    <div className="closed-box">
      <div className="banner banner-info">
        <LockIcon />
        <span>
          <span className="closed-line">Closed by {closed.closed_name} on {closedOnText(closed.closed_at, timezone)}.</span>
          {closed.note !== "" && <span className="closed-line closed-note">{closed.note}</span>}
        </span>
      </div>
      {delta !== null && <p className="muted live-delta">{delta}</p>}
    </div>
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
  const toast = useToast();
  const [picked, setPicked] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: "close" | "reopen"; month: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // "This month" is decided on the site's wall clock: near a month end it differs from the browser's and from UTC.
  const current = site.data ? siteMonth(new Date(), site.data.timezone) : null;
  const month = picked ?? current;
  const costs = useBillingCosts(month);
  // The first month with data only narrows what Previous and the selects offer; while it is unknown (pending, failed, none) nothing is limited.
  const firstMonth = useBillingMonths().data?.first_month ?? null;

  const canClose = can("billing.close");
  // The month's own button, from the server's answer (it is the real judge): Reopen for a closed month, Close for a finished open one. Neither while the costs load.
  // Each has its own key: React would otherwise keep one element and only change its words, and the focus would stay on a button that now means the opposite.
  const closed = costs.data?.closed ?? null;
  const finished = month !== null && current !== null && month < current;
  const monthAction = !canClose || month === null || !costs.data ? null : closed !== null ? (
    <button key="reopen" type="button" aria-haspopup="dialog" onClick={() => setDialog({ kind: "reopen", month })}>Reopen month…</button>
  ) : finished ? (
    <button key="close" type="button" aria-haspopup="dialog" onClick={() => setDialog({ kind: "close", month })}>Close month…</button>
  ) : null;
  const download = canExport && month !== null ? (
    <button type="button" className="primary" onClick={exportCsv} disabled={exporting}><DownloadIcon />Download CSV</button>
  ) : null;

  const holdsSpace = canClose ? site.isPending || month !== null : canExport && site.isPending;

  // After a dialog is gone the focus goes back to its opener (the dialog does that itself); when the opener is gone too (closing a month swaps
  // Close for Reopen) the page heading takes it, so the focus never falls to the body.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (dialog !== null) { wasOpen.current = true; return; }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const at = document.activeElement;
    if (!at || at === document.body) heading.current?.focus();
  }, [dialog]);

  async function exportCsv() {
    if (month === null) return;
    setExporting(true);
    setExportError(null);
    try {
      await downloadCsv(`/api/billing/costs.csv?month=${month}`);
      toast.info("CSV downloaded"); // a failure keeps its inline line
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "export failed");
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="billing-page">
      <PageHeader
        title="Billing"
        headingRef={heading}
        // Close or Reopen sits left of Download CSV, so the download button keeps its place whatever the month. A person who may close but not export
        // has no other button to give the header its height: the space stays, even on a month with nothing to close.
        actions={monthAction || download ? <>{monthAction}{download}</>
          : holdsSpace ? <ActionsSpace /> /* the buttons wait for the site's month and the costs; their height does not */ : undefined}
      />
      {site.isError && <p className="error" role="alert">{site.error.message}</p>}
      {month === null && site.isPending && <div className="row billing-bar" aria-hidden="true"><ActionsSpace height={38} /></div>}
      {month !== null && (
        <div className="row billing-bar">
          <button type="button" onClick={() => setPicked(shiftMonth(month, -1))} disabled={firstMonth !== null && month <= firstMonth}>
            <ChevronIcon dir="left" />Previous month
          </button>
          <strong className="month-label" aria-live="polite">{monthLabel(month)}</strong>
          {/* The chip's room is always there, so Next and the selects keep their place when a closed month is paged to. */}
          <span className="month-state">{closed !== null && <span className="chip closed-chip">Closed</span>}</span>
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
      {costs.data && (
        // One render with the table: the banner never turns up after it.
        <>
          {costs.data.closed && <ClosedNotice closed={costs.data.closed} live={costs.data.live} timezone={site.data?.timezone ?? costs.data.timezone} />}
          <BillingTable costs={costs.data} canSetRates={can("tariffs.edit") && meets(PAGE_NEED.tariffs, can)} />
        </>
      )}
      {dialog?.kind === "close" && <CloseMonthDialog month={dialog.month} onClose={() => setDialog(null)} />}
      {dialog?.kind === "reopen" && <ReopenMonthDialog month={dialog.month} onClose={() => setDialog(null)} />}
    </section>
  );
}
