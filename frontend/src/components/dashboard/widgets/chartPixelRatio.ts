import { createContext, useContext, useMemo } from "react";

/**
 * The pixel ratio the wall wants its charts drawn at (w29 R5): `window.devicePixelRatio * the wall's scale`, because a canvas is a bitmap and the wall
 * enlarges its box with a transform, which would otherwise stretch the bitmap. There is NO default: the app never provides this context, so its charts get
 * no option at all and ECharts keeps choosing the ratio itself.
 */
export const ChartPixelRatioContext = createContext<number | undefined>(undefined);

/**
 * The `opts` prop for every `ReactECharts` of a card: undefined without a provider (exactly what the app passes), else `{ devicePixelRatio }`. The object is
 * memoised on the value, because echarts-for-react starts the chart again when `opts` changes (deeply), and a card that draws again must not do that.
 */
export function useChartOpts(): { devicePixelRatio: number } | undefined {
  const devicePixelRatio = useContext(ChartPixelRatioContext);
  return useMemo(() => (devicePixelRatio === undefined ? undefined : { devicePixelRatio }), [devicePixelRatio]);
}
