import { useRef, useState, type ReactNode } from "react";
import { useWidgetData } from "../../api/queries";
import type { RangePreset, WidgetConfig, DataWidgetType } from "../../api/types";
import { isLiveWidget, pointIdsOf } from "../../lib/live";
import { isRolling } from "../../lib/ranges";
import { flagsOf, markerHint, sinceText } from "../../lib/widgetFormat";
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
  const query = useWidgetData(type, config, preset);
  const data = query.data;
  // The Details drawer. `opener` is the button that opened it: focus goes back there on close (a browser may not focus a clicked button).
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  // The button waits (aria-disabled) while the first answer loads; with no answer and none coming (an error) there is nothing to show, so no button.
  const canOpen = details && (query.isLoading || data !== undefined);
  const following = live && isLiveWidget(type, config, preset);
  useLiveRegistration(widgetKey, following ? pointIdsOf(data) : NO_IDS);
  // Rolling energy and cost windows start at a whole hour, not at "now minus the range": say where. The config already tells whether the line will come, before the data does.
  const sinceExpected = config.source !== "metric" && isRolling(preset);
  const csvSource = csv ? { type, config, range: preset } : undefined;
  return (
    <>
      <WidgetFrame
        title={title}
        type={type}
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
        {data && <WidgetBody type={type} data={data} config={config} timezone={timezone} live={following} />}
      </WidgetFrame>
      {open && canOpen && data && (
        <WidgetDetails
          title={title} type={type} data={data} config={config} timezone={timezone} following={following} csv={csvSource}
          onClose={() => setOpen(false)} returnFocus={() => opener.current}
        />
      )}
    </>
  );
}
