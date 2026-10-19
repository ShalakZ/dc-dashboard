import { useState, type ReactNode } from "react";
import type { RangePreset, WidgetConfig, DataWidgetType } from "../../api/types";
import { downloadCsv } from "../../lib/download";
import { noMetricText, removedText, type SkeletonShape } from "../../lib/widgetFormat";
import { Icon } from "../Icon";
import { WidgetSkeleton } from "../Skeleton";

/** `focus` is present only for a card that follows the dashboard's focus asset (w25): the export repeats that request, so it must name the same asset. */
export interface CsvSource { type: DataWidgetType; config: WidgetConfig; range: RangePreset; focus?: number }

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
  /** A last quiet sentence in the footer line after `since` and `hint` (w25: "Its own assets, not Hall 1", "20 of 34 children of Hall 1 shown"). */
  note?: string;
  /** The body still shows the answer for another focus asset while the new one loads (w25): dimmed, and announced as busy, until the real answer lands. */
  stale?: boolean;
  /** Present = show the CSV button; this is the query the export repeats. */
  csv?: CsvSource;
  /** Present = show the Details button, which calls this with the button itself (the drawer gives focus back to it). It waits (aria-disabled) while the data loads, and while the body is the previous focus's answer (`stale`). */
  details?: (opener: HTMLElement) => void;
  /** The widget's type: the shape of the loading skeleton. */
  type?: DataWidgetType;
  /** The skeleton's variant when the loaded card has more rows than its type's plain shape (a comparison, a breakdown by kind). */
  shape?: SkeletonShape;
  /** Keep the footer line's room while loading, for a widget whose "since" line is known before its data (rolling energy and cost). */
  footSpace?: boolean;
  /** Keep the footer line's room in the loaded card too, as an empty line, when it has nothing to say now but may have the next moment (w25: a note about the focus that comes and goes), so the body does not move. */
  footKeep?: boolean;
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
      await downloadCsv("/api/widget-data/csv", { method: "POST", body: csv.focus === undefined ? { type: csv.type, config: csv.config, range: csv.range } : { type: csv.type, config: csv.config, range: csv.range, focus: csv.focus } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** The box around every widget: title, Details and CSV buttons, the warning chips, the footer line, and the loading and error states. */
export function WidgetFrame({ title, loading, error, missing, noMetric = 0, hint = "", since = "", note = "", stale = false, csv, details, type, shape, footSpace = false, footKeep = false, actions, dragHandle = false, children }: Props) {
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
              aria-disabled={loading || stale ? true : undefined} onClick={(e) => { if (!loading && !stale) details(e.currentTarget); }}
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
          <WidgetSkeleton type={type} shape={shape} label={`Loading ${title}`} />
          {footSpace && <p className="widget-foot" aria-hidden="true" />}
        </>
      ) : (
        <>
          <div className={stale ? "widget-body follow-stale" : "widget-body"} aria-busy={stale ? true : undefined}>
            {error && <p className="widget-error" role="alert"><Icon name="alert" />{error.message}</p>}
            {children}
          </div>
          {(since || hint || note) ? (
            <p className={stale ? "widget-foot follow-stale" : "widget-foot"}>
              {since && <small className="widget-since" title={since}>{since}</small>}
              {since && hint && <span className="widget-dot"> · </span>}
              {hint && <small className="widget-hint" title={hint}>{hint}</small>}
              {/* The dot before the sentence is the sentence's own (focus-follow.css draws it as ::before when something comes first), so it shrinks and goes with the sentence. */}
              {note && <small className={since || hint ? "follow-note follow-note-after" : "follow-note"} title={note}>{note}</small>}
            </p>
          ) : footKeep && <p className="widget-foot" aria-hidden="true" />}
        </>
      )}
    </section>
  );
}
