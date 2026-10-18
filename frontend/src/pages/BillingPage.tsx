import { useCallback, useDeferredValue, useEffect, useId, useRef, useState } from "react";
import { useBillingCosts, useBillingMonthCheck, useBillingMonths, useSite } from "../api/queries";
import type { BillingClosed, BillingLive } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { meets } from "../auth/need";
import { BillingTable } from "../components/BillingTable";
import { BillingTools } from "../components/BillingTools";
import { CloseMonthDialog } from "../components/CloseMonthDialog";
import { MonthCheckDrawer } from "../components/MonthCheckDrawer";
import { PAGE_NEED } from "../components/navItems";
import { PageHeader } from "../components/PageHeader";
import { ReopenMonthDialog } from "../components/ReopenMonthDialog";
import { ActionsSpace, TableSkeleton } from "../components/Skeleton";
import { useToast } from "../components/Toasts";
import { useBillingView } from "../hooks/useBillingView";
import {
  clampMonth, closedOnText, liveDeltaText, MONTH_NAMES, monthLabel, monthsOfYear, SAME_FIGURES_TEXT, shiftMonth, yearsBetween,
} from "../lib/billing";
import { BILLING_FOLD_KEY } from "../lib/billingRows";
import { downloadCsv } from "../lib/download";
import { readFoldMemory, writeFoldMemory } from "../lib/foldMemory";
import { checkLineText, countSlotText, describedByText, type MonthCheckStatus } from "../lib/monthCheck";
import { siteMonth } from "../lib/siteTime";

// Inline SVG, 24-unit viewBox, decoration only (the words next to each one say everything).
const ChevronIcon = ({ dir }: { dir: "left" | "right" }) => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d={dir === "left" ? "m14.5 6-6 6 6 6" : "m9.5 6 6 6-6 6"} /></svg>
);
const LockIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9.5" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
);
const CheckIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="m9 14 2 2 4-4" /></svg>
);
const DownloadIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" /></svg>
);

/**
 * What a closed month says about itself, above its table: who closed it and when (the date on the site's wall clock) and the note on its own line,
 * then, quieter, what today's tree and rates would give. The line is always there, so its room never appears or goes when the minute poll brings
 * another answer: "the same figures" when nothing differs, the difference when something does, and an empty line that keeps its height when today's
 * tree cannot be priced (it never claims "the same" then). Plain text with no role: the page's one status is the missing-rate banner.
 * `currency` is the one the month was closed in.
 */
function ClosedNotice({ closed, live, currency, timezone }: {
  closed: BillingClosed; live: BillingLive | null | undefined; currency: string | null; timezone: string;
}) {
  const delta = live?.differs === false ? SAME_FIGURES_TEXT : liveDeltaText(live, closed, currency) ?? "";
  return (
    <div className="closed-box">
      <div className="banner banner-info">
        <LockIcon />
        <span>
          <span className="closed-line">Closed by {closed.closed_name} on {closedOnText(closed.closed_at, timezone)}.</span>
          {closed.note !== "" && <span className="closed-line closed-note">{closed.note}</span>}
        </span>
      </div>
      <p className="muted live-delta">{delta}</p>
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
  // The Reopen dialog takes a copy of what the page says about the closed month at the click (its figures, today's difference, its currency): it
  // keeps saying that while the 60-second poll moves the page behind it, and still has it after the reopen refetch turns the month open.
  const [dialog, setDialog] = useState<
    { kind: "close"; month: string; checkLine: string } | { kind: "reopen"; month: string; closed: BillingClosed; live: BillingLive | null | undefined; currency: string | null } | null
  >(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const [checking, setChecking] = useState(false); // the month check drawer is open
  const checkNoteId = useId();
  // The fold and the filter live here, not in the table: paging to another month unmounts the table while the new month loads, and both must still be there.
  // `folded` is null while nothing is remembered (the table then folds a long month to a level and writes nothing); the first thing the person does writes it.
  const [folded, setFolded] = useState<ReadonlySet<number> | null>(() => readFoldMemory(BILLING_FOLD_KEY));
  const [filter, setFilter] = useState("");
  const deferred = useDeferredValue(filter); // the box shows the live text; the rows and the line follow it a moment later
  const changeFold = useCallback((next: ReadonlySet<number>) => {
    setFolded(next);
    writeFoldMemory(BILLING_FOLD_KEY, next);
  }, []);
  // "This month" is decided on the site's wall clock: near a month end it differs from the browser's and from UTC.
  const current = site.data ? siteMonth(new Date(), site.data.timezone) : null;
  const month = picked ?? current;
  const costs = useBillingCosts(month);
  // The month check is read once here: the button's count, the sentence behind it, the Close month dialog's line and the drawer all come from this one answer.
  // A failure shows as an empty count and as the message in the drawer; it never touches the table.
  const monthCheck = useBillingMonthCheck(month);
  const checkStatus: MonthCheckStatus = monthCheck.isError ? { status: "error", message: monthCheck.error.message }
    : monthCheck.isPending ? { status: "loading" } : { status: "ready", data: monthCheck.data };
  // What the controls bar and the table both read (the fold and the visible rows), worked out once here; null when there is no table to draw.
  const shown = useBillingView(costs.data, folded, deferred);
  // The first month with data only narrows what Previous and the selects offer; while it is unknown (pending, failed, none) nothing is limited.
  const firstMonth = useBillingMonths().data?.first_month ?? null;

  const canClose = can("billing.close");
  // The month's own button, from the server's answer (it is the real judge): Reopen for a closed month, Close for a finished open one. Neither while the costs load.
  // Each has its own key: React would otherwise keep one element and only change its words, and the focus would stay on a button that now means the opposite.
  const closed = costs.data?.closed ?? null;
  const live = costs.data?.live;
  const frozenCurrency = costs.data?.currency ?? null; // for a closed month, the currency it was closed in
  const finished = month !== null && current !== null && month < current;
  const monthAction = !canClose || month === null || !costs.data ? null : closed !== null ? (
    <button key="reopen" type="button" aria-haspopup="dialog" onClick={() => setDialog({ kind: "reopen", month, closed, live, currency: frozenCurrency })}>Reopen month…</button>
  ) : finished ? (
    <button key="close" type="button" aria-haspopup="dialog" onClick={() => setDialog({ kind: "close", month, checkLine: checkLineText(checkStatus) })}>Close month…</button>
  ) : null;
  // Check month is for everybody who can see the page. Its name is exactly "Check month": the count is a decoration (aria-hidden) in a slot that keeps its width,
  // and the number reaches a screen reader as the button's description. It is not the primary button: Download CSV stays the page's one.
  const slot = countSlotText(checkStatus);
  const checkMonth = month === null ? null : (
    <button key="check" ref={checkButton} type="button" aria-haspopup="dialog" aria-describedby={checkNoteId} onClick={() => setChecking(true)}>
      <CheckIcon />Check month<span className="check-count" aria-hidden="true" data-zero={slot === "0" || undefined}>{slot}</span>
    </button>
  );
  const download = canExport && month !== null ? (
    <button type="button" className="primary" onClick={exportCsv} disabled={exporting}><DownloadIcon />Download CSV</button>
  ) : null;

  // Once the month is known every viewer has Check month; until then the header keeps the height of a button.
  const holdsSpace = site.isPending;

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
        // Close or Reopen sits left of Check month and Download CSV: only the month button comes and goes, so those two keep their places whatever the month.
        actions={monthAction || checkMonth || download ? <>{monthAction}{checkMonth}{download}</>
          : holdsSpace ? <ActionsSpace /> /* the buttons wait for the site's month; their height does not */ : undefined}
      />
      {checkMonth && <span id={checkNoteId} className="sr-only">{describedByText(checkStatus)}</span>}
      {site.isError && <p className="error" role="alert">{site.error.message}</p>}
      {/* One size container for everything under the header: the stylesheet switches the toolbar between stacked and one row on its width.
          The dialogs stay outside it. */}
      <div className="billing-main">
        {(site.isPending || month !== null) && (
          // The month bar and the table's controls bar, side by side when the window is wide and stacked when it is not. The controls bar is the
          // inert copy while the costs load or fail and for the two empty months (the room it takes is the same box), the real one when there is a table.
          <div className="billing-toolbar">
            {month === null ? <div className="row billing-bar" aria-hidden="true"><ActionsSpace /></div> : (
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
            {shown !== null
              ? <BillingTools typed={filter} onFilter={setFilter} model={shown.model} effective={shown.effective} onFold={changeFold} />
              : <BillingTools idle />}
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
            {costs.data.closed && (
              <ClosedNotice closed={costs.data.closed} live={costs.data.live} currency={costs.data.currency} timezone={site.data?.timezone ?? costs.data.timezone} />
            )}
            <BillingTable
              costs={costs.data}
              canSetRates={can("tariffs.edit") && meets(PAGE_NEED.tariffs, can)}
              shown={shown}
              filter={deferred}
              onFold={changeFold}
            />
          </>
        )}
      </div>
      {dialog?.kind === "close" && <CloseMonthDialog month={dialog.month} checkLine={dialog.checkLine} onClose={() => setDialog(null)} />}
      {dialog?.kind === "reopen" && (
        <ReopenMonthDialog month={dialog.month} closed={dialog.closed} live={dialog.live} currency={dialog.currency} onClose={() => setDialog(null)} />
      )}
      {checking && month !== null && (
        <MonthCheckDrawer
          month={month} timezone={site.data?.timezone ?? monthCheck.data?.timezone ?? "UTC"} status={checkStatus}
          onClose={() => setChecking(false)} returnFocus={() => checkButton.current}
        />
      )}
    </section>
  );
}
