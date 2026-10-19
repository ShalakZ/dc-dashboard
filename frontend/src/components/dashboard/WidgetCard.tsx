import type { ReactNode } from "react";
import type { RangePreset } from "../../api/types";
import type { DraftWidget } from "../../lib/layout";
import { TextWidgetView } from "./TextWidgetView";
import { WidgetView } from "./WidgetView";

/** The three fields a card needs, kept as one member per widget kind (a plain Pick of the union would forget which config goes with which type). */
type Shown<W extends { type: unknown; title: string; config: unknown }> = W extends unknown ? Pick<W, "type" | "title" | "config"> : never;

export interface WidgetCardProps {
  widget: Shown<DraftWidget>;
  /** Unique within the page; names a data widget in the live registry. */
  widgetKey: string;
  dashboardRange: RangePreset;
  timezone: string;
  /** Data widgets only: the CSV button, the live stream and the Details button (all default to on). A text widget has none of them. */
  csv?: boolean;
  live?: boolean;
  details?: boolean;
  actions?: ReactNode;
  dragHandle?: boolean;
}

/**
 * The one place that decides which card a widget gets: a text widget is drawn without any hook of the data path, every other type is
 * the data view. It calls no hook itself. The three places that draw a widget (the viewer, the editor's grid and the dialog's preview) use it.
 */
export function WidgetCard({ widget, widgetKey, dashboardRange, timezone, csv, live, details, actions, dragHandle }: WidgetCardProps) {
  if (widget.type === "text") return <TextWidgetView title={widget.title} config={widget.config} actions={actions} dragHandle={dragHandle} />;
  return (
    <WidgetView
      widgetKey={widgetKey} type={widget.type} title={widget.title} config={widget.config} dashboardRange={dashboardRange} timezone={timezone}
      csv={csv} live={live} details={details} actions={actions} dragHandle={dragHandle}
    />
  );
}
