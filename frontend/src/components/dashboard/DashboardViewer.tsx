import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { Dashboard, RangePreset } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { guideSeen, rememberGuide } from "../../lib/guideMemory";
import { RANGE_LABELS, RANGE_PRESETS } from "../../lib/ranges";
import { InfoTip } from "../InfoTip";
import { DashboardGuide, guideApplies, guideFacts, guideLines } from "./DashboardGuide";
import { FocusDialog } from "./FocusDialog";
import { useFocus } from "./FocusContext";
import { LiveValuesContext } from "./LiveValuesContext";
import { StaticGrid } from "./StaticGrid";
import { WidgetCard } from "./WidgetCard";

const FOCUS_TIP = "Pick an asset: the cards that follow the focus show it, and the others keep their own.";

/**
 * The read-only dashboard: name, the live indicator, the text button that opens the guide, the range select (this visit only), the Focus button (with its tip)
 * and the link to the focus asset's page (for a role that can open assets), optional Edit button, the guide panel when it is due, and the widgets.
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
  // The guide (w27, R10). Whether the panel is open is decided in the FIRST render, from this browser's memory, so it is never inserted after the cards have been
  // laid out; with storage blocked it is open and Got it still closes it for this page's life. The header button reopens it and the heading takes the focus.
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const facts = useMemo(() => guideFacts(dashboard.widgets), [dashboard.widgets]);
  const offered = guideApplies(facts);
  const [guideOpen, setGuideOpen] = useState(() => offered && !guideSeen(userId));
  const guideButton = useRef<HTMLButtonElement>(null);
  const guideHeading = useRef<HTMLHeadingElement>(null);
  const headingWanted = useRef(false);
  useEffect(() => {
    if (guideOpen && headingWanted.current) guideHeading.current?.focus();
    headingWanted.current = false;
  }, [guideOpen]);
  const reopenGuide = () => {
    if (guideOpen) guideHeading.current?.focus();
    else {
      headingWanted.current = true;
      setGuideOpen(true);
    }
  };
  const gotIt = () => {
    rememberGuide(userId);
    guideButton.current?.focus(); // before the panel (and the button that has the focus) goes: the focus lands on something named
    setGuideOpen(false);
  };
  return (
    <>
      <div className="row dash-head">
        <h1>{dashboard.name}</h1>
        <span className="spacer" />
        {connected && <span className="muted">live</span>}
        {offered && <button ref={guideButton} type="button" className="quiet" onClick={reopenGuide}>How to read this</button>}
        <label htmlFor={rangeId}>Dashboard range</label>
        <select id={rangeId} value={range} onChange={(e) => setPicked(e.target.value as RangePreset)}>
          {RANGE_PRESETS.map((p) => <option key={p} value={p}>{RANGE_LABELS[p]}</option>)}
        </select>
        {allowed && (
          <>
            <button ref={focusButton} type="button" aria-haspopup="dialog" onClick={() => setChoosing(true)}>Focus</button>
            <InfoTip>{FOCUS_TIP}</InfoTip>
          </>
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
      {offered && guideOpen && <DashboardGuide lines={guideLines(facts, allowed)} headingRef={guideHeading} onGotIt={gotIt} />}
      {items.length === 0 ? (
        <p className="muted">{onEdit ? "This dashboard has no widgets yet. Use Edit, then Add widget." : "This dashboard has no widgets yet."}</p>
      ) : (
        <StaticGrid
          items={items}
          render={(w) => <WidgetCard widget={w} widgetKey={w.key} dashboardRange={range} timezone={timezone} />}
        />
      )}
    </>
  );
}
