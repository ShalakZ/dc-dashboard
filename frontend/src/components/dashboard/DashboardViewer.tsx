import { useContext, useId, useState } from "react";
import type { Dashboard, RangePreset } from "../../api/types";
import { RANGE_LABELS, RANGE_PRESETS } from "../../lib/ranges";
import { LiveValuesContext } from "./LiveValuesContext";
import { StaticGrid } from "./StaticGrid";
import { WidgetView } from "./WidgetView";

/** The read-only dashboard: name, range select (this visit only), live indicator, optional Edit button, and the widgets. */
export function DashboardViewer({ dashboard, timezone, onEdit }: { dashboard: Dashboard; timezone: string; onEdit?: () => void }) {
  const rangeId = useId();
  const { connected } = useContext(LiveValuesContext);
  const [picked, setPicked] = useState<RangePreset | null>(null);
  const range = picked ?? dashboard.range;
  const items = dashboard.widgets.map((w) => ({ ...w, key: String(w.id) }));
  return (
    <>
      <div className="row dash-head">
        <h1>{dashboard.name}</h1>
        <span className="spacer" />
        {connected && <span className="muted">live</span>}
        <label htmlFor={rangeId}>Dashboard range</label>
        <select id={rangeId} value={range} onChange={(e) => setPicked(e.target.value as RangePreset)}>
          {RANGE_PRESETS.map((p) => <option key={p} value={p}>{RANGE_LABELS[p]}</option>)}
        </select>
        {onEdit && <button type="button" onClick={onEdit}>Edit</button>}
      </div>
      {picked !== null && picked !== dashboard.range && (
        <p className="muted">Showing {RANGE_LABELS[picked]} for this visit only. Edit the dashboard to change its saved range.</p>
      )}
      {items.length === 0 ? (
        <p className="muted">This dashboard has no widgets yet.</p>
      ) : (
        <StaticGrid
          items={items}
          render={(w) => <WidgetView widgetKey={w.key} type={w.type} title={w.title} config={w.config} dashboardRange={range} timezone={timezone} />}
        />
      )}
    </>
  );
}
