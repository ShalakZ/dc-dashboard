import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useWidgetData } from "../../api/queries";
import type { RangePreset, WidgetConfig, DataWidgetType } from "../../api/types";
import { withoutEnergyStars } from "../../lib/compare";
import { isLiveWidget, pointIdsOf } from "../../lib/live";
import { isRolling } from "../../lib/ranges";
import { flagsOf, markerHint, sinceText, skeletonShape } from "../../lib/widgetFormat";
import { useLiveRegistration } from "./LiveValuesContext";
import { WidgetBody } from "./WidgetBody";
import { WidgetDetails } from "./WidgetDetails";
import { WidgetFrame } from "./WidgetFrame";

export interface WidgetViewProps {
  /** Unique within the page; names this widget in the live registry. */
  widgetKey: string;
  type: DataWidgetType;
  title: string;
  config: WidgetConfig;
  /** The range a widget without its own `config.range` inherits. */
  dashboardRange: RangePreset;
  timezone: string;
  /** Show the CSV button (default true). */
  csv?: boolean;
  /** Follow the dashboard's live stream when eligible (default true). The editor preview and edit mode turn it off. */
  live?: boolean;
  /** Show the Details button and its panel (default true); the editor preview and edit mode turn it off. */
  details?: boolean;
  actions?: ReactNode;
  dragHandle?: boolean;
}

const NO_IDS: number[] = [];

/** Fetch and show one widget: query by the effective range, register for live updates, draw it inside a WidgetFrame. */
export function WidgetView({ widgetKey, type, title, config, dashboardRange, timezone, csv = true, live = true, details = true, actions, dragHandle }: WidgetViewProps) {
  const preset = config.range ?? dashboardRange;
  // "Split by" on a breakdown by kind: the viewer's pick lasts for this visit only (not saved, not in the address, like the dashboard range) and is tied to the
  // kind the widget is saved with, so a saved change of that kind (an edit) drops the pick. The asked-for config, the CSV and the Details panel all follow it.
  const [pick, setPick] = useState<{ stored: string | undefined; kind: string } | null>(null);
  const kind = config.bars === "kind" && pick !== null && pick.stored === config.kind ? pick.kind : config.kind;
  const shown = useMemo(() => (kind === config.kind ? config : { ...config, kind }), [config, kind]);
  const onKind = useCallback((next: string) => setPick({ stored: config.kind, kind: next }), [config.kind]);
  const query = useWidgetData(type, shown, preset);
  // A comparison of energy draws no `*` (a cost mark), whatever flag its answer carries: cleared once here, for the card, the footer and the Details panel alike.
  const answer = query.data;
  const data = useMemo(() => (answer ? withoutEnergyStars(answer) : undefined), [answer]);
  // The Details drawer. `opener` is the button that opened it: focus goes back there on close (a browser may not focus a clicked button).
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  // The button waits (aria-disabled) while the first answer loads; with no answer and none coming (an error) there is nothing to show, so no button.
  const canOpen = details && (query.isLoading || data !== undefined);
  const following = live && isLiveWidget(type, shown, preset);
  useLiveRegistration(widgetKey, following ? pointIdsOf(data) : NO_IDS);
  // Rolling energy and cost windows start at a whole hour, not at "now minus the range": say where. The config already tells whether the line will come, before the data does.
  const sinceExpected = config.source !== "metric" && isRolling(preset);
  const csvSource = csv ? { type, config: shown, range: preset } : undefined;
  return (
    <>
      <WidgetFrame
        title={title}
        type={type}
        shape={skeletonShape(type, config)}
        footSpace={sinceExpected}
        loading={query.isLoading}
        error={query.error}
        missing={data?.missing.length ?? 0}
        noMetric={data?.no_metric.length ?? 0}
        // The footer explains the markers for every type: a chart's legend may be off, and a figure carries only its mark.
        hint={data ? markerHint(flagsOf(data)) : ""}
        since={data && data.source !== "metric" && isRolling(data.range.preset) ? sinceText(data.range.start, data.range.end, timezone) : ""}
        csv={csvSource}
        details={canOpen ? (button) => { opener.current = button; setOpen(true); } : undefined}
        actions={actions}
        dragHandle={dragHandle}
      >
        {data && <WidgetBody type={type} data={data} config={shown} timezone={timezone} live={following} onKind={onKind} splitDisabled={!details} />}
      </WidgetFrame>
      {open && canOpen && data && (
        <WidgetDetails
          title={title} type={type} data={data} config={shown} timezone={timezone} following={following} csv={csvSource}
          onClose={() => setOpen(false)} returnFocus={() => opener.current}
        />
      )}
    </>
  );
}
