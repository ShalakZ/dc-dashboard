import { useContext, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import type { Dashboard, RangePreset } from "../../api/types";
import { RANGE_LABELS, RANGE_PRESETS } from "../../lib/ranges";
import { FocusDialog } from "./FocusDialog";
import { useFocus } from "./FocusContext";
import { LiveValuesContext } from "./LiveValuesContext";
import { StaticGrid } from "./StaticGrid";
import { WidgetCard } from "./WidgetCard";

/**
 * The read-only dashboard: name, range select (this visit only), live indicator, the Focus button and the link to the focus asset's page (for a role
 * that can open assets), optional Edit button, and the widgets.
 */
export function DashboardViewer({ dashboard, timezone, onEdit }: { dashboard: Dashboard; timezone: string; onEdit?: () => void }) {
  const rangeId = useId();
  const { connected } = useContext(LiveValuesContext);
  const [picked, setPicked] = useState<RangePreset | null>(null);
  const { allowed, focus, name } = useFocus();
  const [choosing, setChoosing] = useState(false);
  const focusButton = useRef<HTMLButtonElement>(null);
  const wasChoosing = useRef(false);
  // The dialog gives the focus back to what had it when it opened; a click does not focus a button in every browser, so the button is named here.
  useEffect(() => {
    if (wasChoosing.current && !choosing) focusButton.current?.focus();
    wasChoosing.current = choosing;
  }, [choosing]);
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
        {allowed && (
          <button ref={focusButton} type="button" aria-haspopup="dialog" onClick={() => setChoosing(true)}>Focus</button>
        )}
        {allowed && focus !== null && (
          // Until the asset list is here the id stands for the name, so the link is in its place from the first paint.
          <Link className="focus-open" to={`/assets/${focus}`} title={`Open ${name ?? `Asset #${focus}`} page`}>{`Open ${name ?? `Asset #${focus}`} page`}</Link>
        )}
        {onEdit && <button type="button" onClick={onEdit}>Edit</button>}
      </div>
      {choosing && <FocusDialog onClose={() => setChoosing(false)} />}
      {picked !== null && picked !== dashboard.range && (
        <p className="muted">Showing {RANGE_LABELS[picked]} for this visit only. Edit the dashboard to change its saved range.</p>
      )}
      {items.length === 0 ? (
        <p className="muted">This dashboard has no widgets yet.</p>
      ) : (
        <StaticGrid
          items={items}
          render={(w) => <WidgetCard widget={w} widgetKey={w.key} dashboardRange={range} timezone={timezone} />}
        />
      )}
    </>
  );
}
