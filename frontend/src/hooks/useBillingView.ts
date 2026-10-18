import { useMemo } from "react";
import type { BillingCosts } from "../api/types";
import { billingHasRows, billingModel, visibleRows, type VisibleRows } from "../lib/billingRows";
import { sizeDefaultFold, type FoldModel } from "../lib/foldLevels";

/** What the controls bar and the table both read: the fold model, the fold in effect, and the rows that are on screen. */
export interface BillingView {
  model: FoldModel;
  /** The branches that are folded now (a size default or the remembered fold, restricted to this month's rows). */
  effective: ReadonlySet<number>;
  view: VisibleRows;
}

/** The ids a month can fold: only rows that have something below them, so what is remembered never holds a stray id. */
function restricted(model: FoldModel, folded: ReadonlySet<number>): Set<number> {
  return new Set(model.foldable.filter((id) => folded.has(id)));
}

/**
 * The state the Billing toolbar and the table share, computed once by the page. `folded` is the remembered fold, or null when nothing is
 * remembered (a long month then opens folded to a level; a visit remembers nothing). `filter` is the text the rows follow (the page defers it).
 * Null while there are no costs and for the two empty months (no assets, or no energy data), where there is no table and no bar to drive.
 * The same inputs give the same object, so what reads it is not drawn again for nothing.
 */
export function useBillingView(costs: BillingCosts | undefined, folded: ReadonlySet<number> | null, filter: string): BillingView | null {
  const assets = costs?.assets;
  const hasRows = costs !== undefined && billingHasRows(costs);
  const model = useMemo(() => (hasRows && assets ? billingModel(assets) : null), [hasRows, assets]);
  const effective = useMemo(
    () => (model === null ? null : folded === null ? sizeDefaultFold(model) : restricted(model, folded)),
    [folded, model],
  );
  const view = useMemo(
    () => (model !== null && effective !== null && assets ? visibleRows(assets, model, effective, filter) : null),
    [assets, model, effective, filter],
  );
  return useMemo(() => (model !== null && effective !== null && view !== null ? { model, effective, view } : null), [model, effective, view]);
}
