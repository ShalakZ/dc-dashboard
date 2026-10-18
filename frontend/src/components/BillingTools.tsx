import { useId, useRef } from "react";
import { foldedForLevel, levelOfFold, type FoldModel } from "../lib/foldLevels";
import { InfoTip } from "./InfoTip";

export const FOLD_TIP = "A folded row still shows its own totals, which already include everything below it.";

const CrossIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
);

interface LiveTools {
  idle?: false;
  /** What the person has typed so far (the box shows this at once; the rows follow a moment later). */
  typed: string;
  onFilter: (text: string) => void;
  model: FoldModel;
  /** The branches that are folded now (a size default or the remembered fold, restricted to this month's rows). */
  effective: ReadonlySet<number>;
  onFold: (next: ReadonlySet<number>) => void;
  /** The words beside the controls: how many rows are on screen, or how many match. */
  line: string;
}

const noop = () => {};
const NO_MODEL: FoldModel = { roots: [], depth: new Map(), children: new Map(), below: new Map(), foldable: [], maxDepth: 0, total: 0 };

/**
 * The bar over the Billing table: the filter box, Collapse all and Expand all, the Show levels select with its tip, and the rows line.
 * One row that may wrap, never a form (a form would be a grid, and Enter would submit). With `idle` it is the same markup with no data,
 * inert and hidden from assistive technology, drawn (hidden) while the costs load or when there is no table, so the room it takes is the same box.
 *
 * Collapse all, Expand all and the select are natively disabled while the filter has text (the focus is in the filter then, and the filter has
 * its own view of the rows) and when no row has anything below it.
 */
export function BillingTools(props: { idle: true } | LiveTools) {
  const live = props.idle === true ? null : props; // idle: the same markup, with no data behind it
  const idle = live === null;
  const typed = live?.typed ?? "";
  const onFilter = live?.onFilter ?? noop;
  const onFold = live?.onFold ?? noop;
  const model = live?.model ?? NO_MODEL;
  const line = live?.line ?? " ";
  const level = live ? levelOfFold(live.model, live.effective) : "all";
  const filterId = useId();
  const levelsId = useId();
  const input = useRef<HTMLInputElement>(null);

  const hasText = typed !== "";
  const locked = typed.trim() !== "" || model.maxDepth === 0;
  const value = level === null ? "custom" : String(level);

  return (
    <div className={idle ? "billing-tools is-idle" : "billing-tools"} inert={idle || undefined} aria-hidden={idle || undefined}>
      <div className="tools-filter">
        <label htmlFor={filterId} className="sr-only">Filter assets</label>
        <input
          ref={input}
          id={filterId}
          type="search"
          placeholder="Filter by asset name"
          autoComplete="off"
          value={typed}
          onChange={(event) => onFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !hasText) return;
            event.preventDefault(); // (a search box's own Escape would clear it too; this one is the same on every browser)
            onFilter("");
          }}
        />
        {hasText && (
          <button
            type="button"
            className="icon-btn tools-clear"
            aria-label="Clear filter"
            onClick={() => { onFilter(""); input.current?.focus({ preventScroll: true }); }}
          >
            <CrossIcon />
          </button>
        )}
      </div>
      <button type="button" disabled={locked} onClick={() => onFold(foldedForLevel(model, 1))}>Collapse all</button>
      <button type="button" disabled={locked} onClick={() => onFold(new Set())}>Expand all</button>
      <span className="tools-levels">
        <label htmlFor={levelsId}>Show levels</label>
        <select
          id={levelsId}
          value={value}
          disabled={locked}
          onChange={(event) => onFold(event.target.value === "all" ? new Set() : foldedForLevel(model, Number(event.target.value)))}
        >
          <option value="all">All</option>
          {Array.from({ length: model.maxDepth }, (_, i) => <option key={i + 1} value={String(i + 1)}>{i + 1}</option>)}
          {level === null && <option value="custom" disabled>Custom</option>}
        </select>
        <InfoTip>{FOLD_TIP}</InfoTip>
      </span>
      <span className="tools-count" aria-live="polite">{line}</span>
    </div>
  );
}
