import { useState, type ReactNode } from "react";
import type { RangePreset, WidgetConfig, WidgetType } from "../../api/types";
import { downloadCsv } from "../../lib/download";
import { noMetricText, removedText } from "../../lib/widgetFormat";
import { Icon } from "../Icon";
import { WidgetSkeleton } from "../Skeleton";

export interface CsvSource { type: WidgetType; config: WidgetConfig; range: RangePreset }

interface Props {
  title: string;
  loading: boolean;
  error: Error | null;
  /** How many configured assets no longer exist (`missing.length` of the response). */
  missing: number;
  /** How many existing assets have no reading of the widget's metric (`no_metric.length`). */
  noMetric?: number;
  /** What the "~" and "*" in the figures mean (`markerHint` of the response); shown whatever the body draws, since a chart legend may be off. */
  hint?: string;
  /** The window an energy or cost widget really covers on a rolling range, e.g. "since 10:00". */
  since?: string;
  /** Present = show the CSV button; this is the query the export repeats. */
  csv?: CsvSource;
  /** Present = show the Details button, which calls this with the button itself (the drawer gives focus back to it). It waits (aria-disabled) while the data loads. */
  details?: (opener: HTMLElement) => void;
  /** The widget's type: the shape of the loading skeleton. */
  type?: WidgetType;
  /** Keep the footer line's room while loading, for a widget whose "since" line is known before its data (rolling energy and cost). */
  footSpace?: boolean;
  /** Extra header buttons (the editor's Edit and Delete); the caller wraps them in `.widget-actions`. */
  actions?: ReactNode;
  /** Mark the header as the grab area of the editor's grid. */
  dragHandle?: boolean;
  children?: ReactNode;
}

/** A chip: the words for the card that has room, the bare count (hidden from a screen reader, which reads the words) for a narrow one. */
function Chip({ title, words, count }: { title: string; words: string; count: number }) {
  return (
    <span className="chip chip-warn" title={title}>
      <span className="chip-long">{words}</span>
      <span className="chip-short" aria-hidden="true">{count}</span>
    </span>
  );
}

/**
 * The widget's CSV download, one function for the card's button and the Details drawer's: it repeats the widget's own query on the server.
 * `run` is guarded (a button that waits is aria-disabled, which keeps its focus, so its click still arrives); `error` is the last failure's text.
 */
export function useCsvExport(csv: CsvSource | undefined): { busy: boolean; error: string | null; run: () => Promise<void> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!csv || busy) return;
    setBusy(true);
    setError(null);
    try {
      await downloadCsv("/api/widget-data/csv", { method: "POST", body: { type: csv.type, config: csv.config, range: csv.range } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** The box around every widget: title, Details and CSV buttons, the warning chips, the footer line, and the loading and error states. */
export function WidgetFrame({ title, loading, error, missing, noMetric = 0, hint = "", since = "", csv, details, type, footSpace = false, actions, dragHandle = false, children }: Props) {
  const { busy, error: csvError, run: exportCsv } = useCsvExport(csv);
  return (
    <section className="widget-frame" aria-label={title}>
      <header className={dragHandle ? "widget-head widget-drag-handle" : "widget-head"}>
        {dragHandle && <span className="widget-grip" aria-hidden="true"><Icon name="grip" /></span>}
        <h2 className="widget-title" title={title}>{title}</h2>
        {(missing > 0 || noMetric > 0) && (
          <span className="widget-chips">
            {missing > 0 && <Chip title="Assets this widget used were deleted; it shows the rest." words={removedText(missing)} count={missing} />}
            {noMetric > 0 && <Chip title="These assets have no reading of this metric; they are left out." words={noMetricText(noMetric)} count={noMetric} />}
          </span>
        )}
        <span className="spacer" />
        <span className="widget-tools">
          {details && (
            <button
              type="button" className="icon-btn widget-details-btn" aria-label={`Details for ${title}`} aria-haspopup="dialog"
              aria-disabled={loading ? true : undefined} onClick={(e) => { if (!loading) details(e.currentTarget); }}
            >
              <Icon name="info" />
            </button>
          )}
          {csv && (
            <button type="button" className="icon-btn widget-csv-btn" aria-label={`Download CSV for ${title}`} aria-disabled={busy ? true : undefined} onClick={exportCsv}>
              <Icon name="download" />
            </button>
          )}
          {actions}
        </span>
      </header>
      {csvError && <p className="error" role="alert">CSV export failed: {csvError}</p>}
      {loading ? (
        <>
          <WidgetSkeleton type={type} label={`Loading ${title}`} />
          {footSpace && <p className="widget-foot" aria-hidden="true" />}
        </>
      ) : (
        <>
          <div className="widget-body">
            {error && <p className="widget-error" role="alert"><Icon name="alert" />{error.message}</p>}
            {children}
          </div>
          {(since || hint) && (
            <p className="widget-foot">
              {since && <small className="widget-since" title={since}>{since}</small>}
              {since && hint && <span className="widget-dot"> · </span>}
              {hint && <small className="widget-hint" title={hint}>{hint}</small>}
            </p>
          )}
        </>
      )}
    </section>
  );
}
