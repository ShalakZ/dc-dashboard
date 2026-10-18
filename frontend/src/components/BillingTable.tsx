import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router";
import type { BillingAssetRow, BillingCosts, CostFigure } from "../api/types";
import { fmtCost, fmtKwh, fmtRate } from "../lib/billing";
import { billingModel, noMatchText, rowsLine, twistyLabel, visibleRows } from "../lib/billingRows";
import { sizeDefaultFold, type FoldModel } from "../lib/foldLevels";
import { formatSiteDay } from "../lib/siteTime";
import { BillingTools } from "./BillingTools";
import { ESTIMATED_TIP, Figure, PARTIAL_TIP } from "./Figure";

// Inline SVG, 24-unit viewBox, decoration only (the words next to each one say everything).
const WarnIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 10v4.5M12 17.5h.01" /></svg>
);
const ReceiptIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6M9 16h3" /></svg>
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

/** The ids a month can fold: only rows that have something below them, so what is remembered never holds a stray id. */
function restricted(model: FoldModel, folded: ReadonlySet<number>): Set<number> {
  return new Set(model.foldable.filter((id) => folded.has(id)));
}

const CaretIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5" /></svg>
);

/** `caret` is the decorative arrow a row has while a filter is on (it is shown open, and there is nothing to press). */
type RowMode = "leaf" | "open" | "folded" | "caret";

interface RowProps {
  row: BillingAssetRow;
  depth: number;
  mode: RowMode;
  /** Shown only because a row under it matches the filter. */
  context: boolean;
  /** The number of rows under it, folded or not. */
  below: number;
  days: readonly string[];
  /** Stable: a fold redraws the row that was pressed and the rows that appear, not the rest. */
  onToggle: (id: number) => void;
}

/**
 * One asset. The name cell is the row header: the indent stays on the `th`, the twisty and the name sit in a flex box inside it, and `aria-labelledby`
 * names the row by the asset's name alone (the twisty has a name of its own). The twisty is ONE button for open and folded, so a press never replaces
 * it and the focus stays on it; a leaf has a spacer of the same width. The figure cells are the same as ever.
 */
const BillingRow = memo(function BillingRow({ row, depth, mode, context, below, days, onToggle }: RowProps) {
  const id = row.asset_id;
  // A null day is "no meter" for an asset without any figure, otherwise a day that has not been reached yet.
  const emptyTitle = row.total === null ? "no meter" : "not yet";
  return (
    <tr>
      <th scope="row" title={row.path} style={{ paddingLeft: 8 + depth * 16 }} aria-labelledby={`billing-asset-${id}`}>
        <span className="bill-name">
          {mode === "leaf" ? <span className="twisty-sp" /> : mode === "caret" ? (
            <span className="twisty-sp bill-caret" aria-hidden="true"><CaretIcon /></span>
          ) : (
            <button
              type="button"
              className="twisty"
              aria-expanded={mode === "open"}
              aria-label={twistyLabel(row.name, mode === "open", below)}
              onClick={() => onToggle(id)}
            >
              <CaretIcon />
            </button>
          )}
          <span id={`billing-asset-${id}`} className={context ? "bill-label is-context" : "bill-label"}>{row.name}</span>
        </span>
      </th>
      <td className="num">{fmtRate(row.rate_per_kwh)}</td>
      <FigureCell figure={row.total} emptyTitle={emptyTitle} />
      {row.days.map((d, i) => <FigureCell key={days[i]} figure={d} emptyTitle={emptyTitle} />)}
    </tr>
  );
});

/**
 * `canSetRates`: the person may open the Tariffs page AND change a rate on it, so the note links to it; for anyone else it says to ask.
 * `folded` is the remembered fold, or null when nothing is remembered (a long month then opens folded to a level; a visit remembers nothing).
 * `filter` is the text the rows and the line follow (the page defers it so typing stays quick); `typed` is what the box shows.
 * Only the rows that are visible are drawn, never hidden ones. The costs, the totals and the CSV are the month's, whatever is folded or filtered.
 */
export function BillingTable({ costs, canSetRates, folded, onFold, filter, typed, onFilter }: {
  costs: BillingCosts;
  canSetRates: boolean;
  folded: ReadonlySet<number> | null;
  onFold: (next: ReadonlySet<number>) => void;
  filter: string;
  typed: string;
  onFilter: (text: string) => void;
}) {
  const model = useMemo(() => billingModel(costs.assets), [costs.assets]);
  const effective = useMemo(() => (folded === null ? sizeDefaultFold(model) : restricted(model, folded)), [folded, model]);
  const view = useMemo(() => visibleRows(costs.assets, model, effective, filter), [costs.assets, model, effective, filter]);

  // The press handler never changes, so the rows that are not touched by a fold are not drawn again.
  const latest = useRef({ effective, onFold });
  latest.current = { effective, onFold };
  const onToggle = useCallback((id: number) => {
    const { effective: now, onFold: change } = latest.current;
    const next = new Set(now);
    if (!next.delete(id)) next.add(id);
    change(next);
  }, []);

  // A new filter shows other rows: the box starts at the top (a fold or the first draw leaves it where it is).
  const scroller = useRef<HTMLDivElement>(null);
  const seen = useRef(filter);
  useEffect(() => {
    if (seen.current === filter) return;
    seen.current = filter;
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [filter]);

  // The two empty states keep the bar's room (an inert copy), so the page does not move when a month with rows is paged to.
  if (costs.assets.length === 0) return <><BillingTools idle /><Empty text="No assets yet." /></>;
  if (costs.assets.every((a) => a.total === null)) return <><BillingTools idle /><Empty text="No energy data for this month." /></>;
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
      <BillingTools typed={typed} onFilter={onFilter} model={model} effective={effective} onFold={onFold} line={rowsLine(view)} />
      <div className="table-scroll table-wrap" ref={scroller}>
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
            {view.rows.length === 0 ? (
              <tr>
                <td colSpan={3 + costs.days.length}><span className="bill-nomatch">{noMatchText(filter)}</span></td>
              </tr>
            ) : view.rows.map((r) => (
              <BillingRow
                key={r.asset.asset_id}
                row={r.asset}
                depth={r.depth}
                mode={view.filtering && r.mode === "open" ? "caret" : r.mode}
                context={r.context}
                below={r.below}
                days={costs.days}
                onToggle={onToggle}
              />
            ))}
          </tbody>
        </table>
      </div>
      <Legend />
    </>
  );
}
