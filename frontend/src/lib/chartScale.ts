import type { WidgetData } from "../api/types";
import { familyOf, pickScale, tickText, type Scale } from "./figures";

/*
 * The value axis of a dashboard chart (w27, D3). The DATA stays in base units; only the axis speaks in the scale the chart's largest value picks: its labels are
 * the values divided by the scale's divisor, printed on the tick face ("18,000", "250"), and its name is the scale's ("kWh", "MWh", "k QAR"). One scale per
 * axis, so an axis never mixes units. Tooltips and accessible text never come through here: they stay on the exact face.
 */

/** The largest magnitude of the figures; missing and non-finite members are ignored, and a chart with none is 0. */
export function largestAbs(values: Iterable<number | null | undefined>): number {
  let top = 0;
  for (const value of values) if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) > top) top = Math.abs(value);
  return top;
}

/** What a chart's value axis is given: the scale, the axis name (undefined where the unit has none) and the label formatter. */
export interface ValueAxis { scale: Scale; name: string | undefined; format: (value: number) => string }

/** Below this the tick face's two decimals would print real ticks as "0" (0.001 on a 0.004 axis), so such an axis prints the value itself. */
const FINE_BELOW = 0.1;

/**
 * The axis for a chart that draws `values` (every bar and series point, both months of a comparison, a metric's min and max): the scale comes from the
 * LARGEST magnitude only, so a small point never pulls the axis back to a smaller unit. The unit and the family come from the response, as for a card.
 */
export function valueAxisFor(data: Pick<WidgetData, "unit" | "source">, values: Iterable<number | null | undefined>): ValueAxis {
  const top = largestAbs(values);
  const scale = pickScale(familyOf(data.unit, data.source), data.unit, [top]);
  const fine = top > 0 && top < FINE_BELOW;
  return {
    scale,
    name: scale.axisName ?? undefined,
    format: fine ? (value) => String(Number(value.toPrecision(6))) : (value) => tickText(value, scale.divisor),
  };
}
