import { useMemo } from "react";
import { useAssets } from "../api/queries";
import type { WidgetData } from "../api/types";
import { hasRepeatedNames, parentNamesOf, type ParentNames } from "../lib/widgetFormat";

/**
 * The parent names a card needs to tell its repeated asset names apart (w27 R6), from the asset list the top bar's quick find already holds (the same query, so no
 * request of its own in the app). `allowed` is `assets.view`. Until the list is here, and for a role without the permission, it is undefined and every label is
 * the old "Rack 04 (#12)": the text changes at most once, when the list arrives. A card whose answer repeats no name does not ask for the list at all.
 */
export function useParentNames(data: WidgetData | undefined, allowed: boolean): ParentNames | undefined {
  const needed = allowed && data !== undefined && hasRepeatedNames(data.mode === "series" ? data.series : data.values);
  const list = useAssets(needed).data;
  return useMemo(() => (needed && list ? parentNamesOf(list) : undefined), [needed, list]);
}
