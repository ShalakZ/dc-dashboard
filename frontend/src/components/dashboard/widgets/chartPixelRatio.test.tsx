import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { keys } from "../../../api/queries";
import { breakdownData, compareSeriesData, seriesData, valuesData } from "../../../test/dashboardFixtures";
import { FocusContext, type FocusState } from "../FocusContext";
import { BarWidget } from "./BarWidget";
import { ChartPixelRatioContext, useChartOpts } from "./chartPixelRatio";
import { TimeSeriesWidget } from "./TimeSeriesWidget";

// w29 R5: the wall's charts are drawn at devicePixelRatio * the wall's scale; the app's charts get no option at all. echarts-for-react is a stub that keeps
// every props object it was handed, so the tests read what each chart of the two widgets was given as `opts`.
const drawn = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock("echarts-for-react", () => ({
  default: (props: Record<string, unknown>) => {
    drawn.props.push(props);
    return <div data-testid="chart" />;
  },
}));
const TZ = "Asia/Qatar";

beforeEach(() => {
  drawn.props.length = 0;
});

describe("useChartOpts", () => {
  it("is undefined without a provider (the app's charts)", () => {
    const { result } = renderHook(() => useChartOpts());
    expect(result.current).toBeUndefined();
  });

  it("is { devicePixelRatio } inside a provider", () => {
    const { result } = renderHook(() => useChartOpts(), {
      wrapper: ({ children }: { children: ReactNode }) => <ChartPixelRatioContext.Provider value={2.5}>{children}</ChartPixelRatioContext.Provider>,
    });
    expect(result.current).toEqual({ devicePixelRatio: 2.5 });
  });

  it("keeps the same object across renders while the value is the same, and gives a new one when it changes", () => {
    let ratio = 2.5;
    const { result, rerender } = renderHook(() => useChartOpts(), {
      wrapper: ({ children }: { children: ReactNode }) => <ChartPixelRatioContext.Provider value={ratio}>{children}</ChartPixelRatioContext.Provider>,
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    ratio = 4;
    rerender();
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual({ devicePixelRatio: 4 });
  });
});

const ASSET_FOCUS: FocusState = { focus: null, allowed: true, assets: undefined, name: null, notice: null, anyFollowing: true, setFocus: () => {}, reportGone: () => {} };

/** One chart of each kind the two widgets draw: a card is drawn the way the dashboard does (asset list cached, so the drilling bars ask nobody). */
const CHARTS: [string, () => ReactElement][] = [
  ["the time series chart", () => <TimeSeriesWidget data={seriesData()} timezone={TZ} />],
  ["the month comparison chart", () => <TimeSeriesWidget data={compareSeriesData(3, 3)} timezone={TZ} />],
  ["the bars of a metric", () => <BarWidget data={valuesData({ type: "bar" })} timezone={TZ} />],
  ["the plain bars of a breakdown", () => <BarWidget data={breakdownData(3)} timezone={TZ} splitDisabled />],
  ["the bars of a breakdown that open assets", () => <BarWidget data={breakdownData(3)} timezone={TZ} />],
];

function draw(element: ReactElement, ratio?: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(keys.assets, []);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FocusContext.Provider value={ASSET_FOCUS}>
          <ChartPixelRatioContext.Provider value={ratio}>{element}</ChartPixelRatioContext.Provider>
        </FocusContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe.each(CHARTS)("%s", (_name, element) => {
  it("gets no option without a provider: opts is undefined, exactly what the app passes", () => {
    draw(element());
    expect(drawn.props.length).toBeGreaterThan(0);
    for (const props of drawn.props) expect(props.opts).toBeUndefined();
  });

  it("is handed { devicePixelRatio } inside a provider", () => {
    draw(element(), 2.814);
    expect(drawn.props.length).toBeGreaterThan(0);
    for (const props of drawn.props) expect(props.opts).toEqual({ devicePixelRatio: 2.814 });
  });

  it("keeps the same opts object when the card draws again", () => {
    const shown = draw(element(), 2);
    const first = drawn.props.at(-1)!.opts;
    expect(first).toEqual({ devicePixelRatio: 2 });
    shown.rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}>
        <MemoryRouter>
          <FocusContext.Provider value={ASSET_FOCUS}>
            <ChartPixelRatioContext.Provider value={2}>{element()}</ChartPixelRatioContext.Provider>
          </FocusContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(drawn.props.at(-1)!.opts).toBe(first);
  });
});
