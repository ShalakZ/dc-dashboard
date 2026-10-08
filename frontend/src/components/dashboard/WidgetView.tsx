import type { ReactNode } from "react";
import { useWidgetData } from "../../api/queries";
import type { RangePreset, WidgetConfig, WidgetType } from "../../api/types";
import { isLiveWidget, pointIdsOf } from "../../lib/live";
import { isRolling } from "../../lib/ranges";
import { flagsOf, markerHint, sinceText } from "../../lib/widgetFormat";
import { useLiveRegistration } from "./LiveValuesContext";
import { WidgetBody } from "./WidgetBody";
import { WidgetFrame } from "./WidgetFrame";

export interface WidgetViewProps {
  /** Unique within the page; names this widget in the live registry. */
  widgetKey: string;
  type: WidgetType;
  title: string;
  config: WidgetConfig;
  /** The range a widget without its own `config.range` inherits. */
  dashboardRange: RangePreset;
  timezone: string;
  /** Show the CSV button (default true). */
  csv?: boolean;
  /** Follow the dashboard's live stream when eligible (default true). The editor preview and edit mode turn it off. */
  live?: boolean;
  actions?: ReactNode;
  dragHandle?: boolean;
}

const NO_IDS: number[] = [];

/** Fetch and show one widget: query by the effective range, register for live updates, draw it inside a WidgetFrame. */
export function WidgetView({ widgetKey, type, title, config, dashboardRange, timezone, csv = true, live = true, actions, dragHandle }: WidgetViewProps) {
  const preset = config.range ?? dashboardRange;
  const query = useWidgetData(type, config, preset);
  const data = query.data;
  const following = live && isLiveWidget(type, config, preset);
  useLiveRegistration(widgetKey, following ? pointIdsOf(data) : NO_IDS);
  return (
    <WidgetFrame
      title={title}
      loading={query.isLoading}
      error={query.error}
      missing={data?.missing.length ?? 0}
      noMetric={data?.no_metric.length ?? 0}
      // A stat and a table explain the markers next to their own figures; a chart has only its legend, which may be off.
      hint={data && type !== "stat" && type !== "table" ? markerHint(flagsOf(data)) : ""}
      // Rolling energy and cost windows start at a whole hour, not at "now minus the range": say where.
      since={data && data.source !== "metric" && isRolling(data.range.preset) ? sinceText(data.range.start, data.range.end, timezone) : ""}
      csv={csv ? { type, config, range: preset } : undefined}
      actions={actions}
      dragHandle={dragHandle}
    >
      {data && <WidgetBody type={type} data={data} config={config} timezone={timezone} live={following} />}
    </WidgetFrame>
  );
}
