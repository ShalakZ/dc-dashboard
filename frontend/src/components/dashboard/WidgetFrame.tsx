import { useState, type ReactNode } from "react";
import type { RangePreset, WidgetConfig, WidgetType } from "../../api/types";
import { downloadCsv } from "../../lib/download";
import { noMetricText, removedText } from "../../lib/widgetFormat";

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
  /** Extra header buttons (the editor's Edit and Delete). */
  actions?: ReactNode;
  /** Mark the header as the grab area of the editor's grid. */
  dragHandle?: boolean;
  children?: ReactNode;
}

/** The box around every widget: title, CSV button, the warning chips, the marker hint, and the loading and error states. */
export function WidgetFrame({ title, loading, error, missing, noMetric = 0, hint = "", since = "", csv, actions, dragHandle = false, children }: Props) {
  const [busy, setBusy] = useState(false);
  const [csvError, setCsvError] = useState<string | null>(null);
  const exportCsv = async () => {
    if (!csv) return;
    setBusy(true);
    setCsvError(null);
    try {
      await downloadCsv("/api/widget-data/csv", { method: "POST", body: { type: csv.type, config: csv.config, range: csv.range } });
    } catch (e) {
      setCsvError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="widget-frame" aria-label={title}>
      <header className={dragHandle ? "widget-head widget-drag-handle" : "widget-head"}>
        <h3>{title}</h3>
        {missing > 0 && <span className="chip chip-warn" title="Assets this widget used were deleted; it shows the rest.">{removedText(missing)}</span>}
        {noMetric > 0 && <span className="chip chip-warn" title="These assets have no reading of this metric; they are left out.">{noMetricText(noMetric)}</span>}
        <span className="spacer" />
        {csv && <button type="button" onClick={exportCsv} disabled={busy} aria-label={`Download CSV for ${title}`}>CSV</button>}
        {actions}
      </header>
      {csvError && <p className="error" role="alert">CSV export failed: {csvError}</p>}
      {(since || hint) && (
        <p className="widget-notes muted">
          {since && <small>{since}</small>}
          {hint && <small>{hint}</small>}
        </p>
      )}
      <div className="widget-body">
        {error && <p className="error" role="alert">{error.message}</p>}
        {loading ? <p className="muted">loading…</p> : children}
      </div>
    </section>
  );
}
