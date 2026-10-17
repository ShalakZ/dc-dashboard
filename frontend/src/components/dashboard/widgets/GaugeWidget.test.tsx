import { render, screen } from "@testing-library/react";
import { config, valueRow, valuesData } from "../../../test/dashboardFixtures";
import { LiveValuesContext } from "../LiveValuesContext";
import { GaugeWidget, gaugeFigure, gaugeFillPath, gaugeShare, scaleText } from "./GaugeWidget";

const cfg = config({ aggregation: "last", min: 0, max: 200 });
const stream = (value: number | null, quality = 0) => ({
  values: new Map([[7, { ts: "2026-10-08T06:00:00.000Z", value, quality }]]), connected: true, register: () => {},
});
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const gaugeOf = (data = valuesData({ type: "gauge" }), over = cfg) => render(<GaugeWidget data={data} config={over} live={false} />);
const fill = (container: HTMLElement) => container.querySelector("path.gauge-fill");
const figure = (container: HTMLElement) => container.querySelector(".gauge-figure") as HTMLElement;
/** Where the fill ends, from its path: "M 6 50 A 44 44 0 0 1 x y". */
const endOf = (path: Element): [number, number] => {
  const m = /^M 6 50 A 44 44 0 0 1 (\S+) (\S+)$/.exec(path.getAttribute("d") ?? "");
  expect(m, "the fill is an arc of the track's circle from its left end").not.toBeNull();
  return [Number(m![1]), Number(m![2])];
};

describe("gaugeShare: how much of the scale is filled", () => {
  it("is the share of the scale, 0 to 1", () => {
    expect(gaugeShare(50, 0, 100)).toBe(0.5);
    expect(gaugeShare(12.5, 10, 20)).toBe(0.25);
    expect(gaugeShare(0, 0, 100)).toBe(0);
    expect(gaugeShare(100, 0, 100)).toBe(1);
  });
  it("clamps a value outside the scale, and is 0 for a scale with no width", () => {
    expect(gaugeShare(250, 0, 200)).toBe(1);
    expect(gaugeShare(-5, 0, 200)).toBe(0);
    expect(gaugeShare(5, 10, 10)).toBe(0);
    expect(gaugeShare(5, 10, 3)).toBe(0);
    expect(gaugeShare(Number.NaN, 0, 100)).toBe(0);
  });
});

describe("gaugeFillPath: the filled part of the arc, a path of its own (a dash would be read in screen pixels under a non-scaling stroke)", () => {
  const end = (share: number) => /(\S+) (\S+)$/.exec(gaugeFillPath(share))!.slice(1).map(Number);
  it("runs round the circle of the track (centre 50 50, radius 44) from the left end, over the top", () => {
    expect(gaugeFillPath(1)).toBe("M 6 50 A 44 44 0 0 1 94 50"); // the whole arc, the track's own path
    expect(end(0.5)).toEqual([50, 6]);
    const [x, y] = end(0.25);
    expect(x).toBeCloseTo(50 - 44 * Math.SQRT1_2, 2);
    expect(y).toBeCloseTo(50 - 44 * Math.SQRT1_2, 2);
    for (const share of [0.0525, 0.3, 0.9]) {
      const [ex, ey] = end(share);
      expect(Math.hypot(ex - 50, ey - 50)).toBeCloseTo(44, 2);
    }
  });
  it("is a hair long at 0, so a measured minimum still shows its round cap, and never runs past the right end", () => {
    const [, y] = end(0);
    expect(y).toBeLessThan(50); // an end that differs from the start, or the arc is omitted and no cap is drawn
    expect(y).toBeGreaterThan(49.5);
    expect(end(1.7)).toEqual([94, 50]);
  });
});

describe("scaleText: the ends of the scale are settings, written as the config states them", () => {
  it("drops the decimals of a whole number and keeps at most two of any other", () => {
    expect(scaleText(0)).toBe("0");
    expect(scaleText(200)).toBe("200");
    expect(scaleText(49)).toBe("49");
    expect(scaleText(0.5)).toBe("0.5");
    expect(scaleText(0.125)).toBe("0.13");
    expect(scaleText(-10)).toBe("-10");
    expect(scaleText(-0)).toBe("0");
  });
});

describe("gaugeFigure: the strings the figure shows (the ones the ECharts detail formatter used to return)", () => {
  it("is the figure with its markers, and the unit after it", () => {
    expect(gaugeFigure({ value: 12.5, unit: "kW" })).toEqual({ num: "12.50", unit: " kW" });
    expect(gaugeFigure({ value: 12.5, unit: "kW", estimated: true, partial: true })).toEqual({ num: "~12.50*", unit: " kW" });
    expect(gaugeFigure({ value: 0.9, unit: "" })).toEqual({ num: "0.90", unit: "" });
    expect(gaugeFigure({ value: 3, unit: null })).toEqual({ num: "3.00", unit: "" });
  });
  it("says 'no data' for a metric that recorded nothing, the dash for a missing value, and never a unit after either", () => {
    expect(gaugeFigure({ value: null, unit: "kW", noData: true })).toEqual({ num: "no data", unit: "" });
    expect(gaugeFigure({ value: null, unit: "QAR" })).toEqual({ num: "—", unit: "" });
  });
});

describe("the gauge is a meter", () => {
  it("names the asset, carries the scale and the reading, and says the figure with its unit", () => {
    gaugeOf();
    const meter = screen.getByRole("meter", { name: "LV Panel 1" });
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "200");
    expect(meter).toHaveAttribute("aria-valuenow", "10.5");
    expect(meter).toHaveAttribute("aria-valuetext", "10.50 kW");
  });

  it("repeats the markers in the spoken text", () => {
    gaugeOf(valuesData({ type: "gauge", values: [valueRow({ estimated: true, partial: true })] }));
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuetext", "~10.50* kW");
  });

  it("clamps the reading to the scale and says when it is above or below it, with the real figure", () => {
    const { unmount } = gaugeOf(valuesData({ type: "gauge", values: [valueRow({ value: 250 })] }));
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "200");
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuetext", "250.00 kW, above the scale");
    unmount();
    gaugeOf(valuesData({ type: "gauge", values: [valueRow({ value: -5 })] }));
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuetext", "-5.00 kW, below the scale");
  });

  it("is an image, with no reading attributes, when there is no value", () => {
    gaugeOf(valuesData({ type: "gauge", values: [valueRow({ value: null, no_data: true })] }));
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    const img = screen.getByRole("img", { name: "LV Panel 1: no data" });
    expect(img).not.toHaveAttribute("aria-valuenow");
  });

  it("says 'no value' for the plain dash", () => {
    gaugeOf(valuesData({ type: "gauge", values: [valueRow({ value: null })] }));
    expect(screen.getByRole("img", { name: "LV Panel 1: no value" })).toBeInTheDocument();
  });
});

describe("the arc", () => {
  it("draws a track, and a fill that is the share of the scale", () => {
    const { container } = gaugeOf();
    expect(container.querySelector("path.gauge-track")).not.toBeNull();
    const arc = fill(container)!;
    expect(arc).not.toHaveAttribute("stroke-dasharray");
    expect(arc.getAttribute("d")).toBe(gaugeFillPath(0.0525)); // 10.5 of 0 to 200
    expect(container.querySelector("path.gauge-track")).toHaveAttribute("d", "M 6 50 A 44 44 0 0 1 94 50");
    expect(container.querySelector("svg.gauge-svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("is full above the scale and empty below it (the figure still says the real number)", () => {
    const high = gaugeOf(valuesData({ type: "gauge", values: [valueRow({ value: 250 })] }));
    expect(endOf(fill(high.container)!)).toEqual([94, 50]);
    high.unmount();
    const low = gaugeOf(valuesData({ type: "gauge", values: [valueRow({ value: -5 })] }));
    expect(endOf(fill(low.container)!)[1]).toBeGreaterThan(49.5); // the hair at the left end, not a run round the arc
    expect(figure(low.container)).toHaveTextContent("-5.00 kW");
  });

  it("draws no fill for a missing value, only the track: a gauge parked at zero would read as a measured zero", () => {
    for (const row of [valueRow({ value: null, no_data: true }), valueRow({ value: null })]) {
      const { container, unmount } = gaugeOf(valuesData({ type: "gauge", values: [row] }));
      expect(container.querySelector("path.gauge-track")).not.toBeNull();
      expect(fill(container)).toBeNull();
      unmount();
    }
  });

  it("shows the ends of the scale as text, the unit once at the max", () => {
    const { container } = gaugeOf();
    const ends = [...container.querySelectorAll(".gauge-scale > *")].map((e) => e.textContent);
    expect(ends).toEqual(["0", "200 kW"]);
  });

  it("falls back to a scale of 100 above the minimum when the config has no max", () => {
    const { container } = gaugeOf(valuesData({ type: "gauge" }), config({ aggregation: "last", min: 10, max: null }));
    expect([...container.querySelectorAll(".gauge-scale > *")].map((e) => e.textContent)).toEqual(["10", "110 kW"]);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuemax", "110");
  });
});

describe("the gauge when there is no figure", () => {
  it("says 'no data', as words, muted, for a metric with no reading", () => {
    const { container } = gaugeOf(valuesData({ type: "gauge", values: [valueRow({ value: null, no_data: true })] }));
    expect(figure(container)).toHaveTextContent(/^no data$/);
    expect(figure(container)).toHaveClass("muted", "none");
    expect(figure(container)).toHaveAttribute("title", "no data");
  });

  it("says 'no data' too when the live reading goes bad", () => {
    const { container } = render(<LiveValuesContext.Provider value={stream(7, 1)}><GaugeWidget data={valuesData({ type: "gauge" })} config={cfg} live /></LiveValuesContext.Provider>);
    expect(figure(container)).toHaveTextContent(/^no data$/);
    expect(figure(container)).toHaveClass("muted");
    expect(fill(container)).toBeNull();
  });

  it("keeps the dash for a cost without a rate, which means no rate and nothing else", () => {
    const { container } = gaugeOf(valuesData({ type: "gauge", source: "cost", metric: null, unit: "QAR", values: [valueRow({ value: null, no_data: true, point_id: null })] }));
    expect(figure(container)).toHaveTextContent(/^—$/);
  });

  it("keeps the dash for a value that is missing without being marked silent, as before", () => {
    const { container } = gaugeOf(valuesData({ type: "gauge", values: [valueRow({ value: null })] }));
    expect(figure(container)).toHaveTextContent(/^—$/);
    expect(figure(container)).not.toHaveClass("none");
  });

  it("draws the gauge of a widget with no asset yet: the dash, no fill, a name that says so", () => {
    const { container } = gaugeOf(valuesData({ type: "gauge", values: [] }));
    expect(figure(container)).toHaveTextContent(/^—$/);
    expect(fill(container)).toBeNull();
    expect(screen.getByRole("img")).toHaveAccessibleName("Gauge: no value");
  });
});

describe("the figure and the name", () => {
  it("shows a measured figure in the normal colour, its unit apart, and the asset name below it", () => {
    const { container } = gaugeOf();
    expect(figure(container)).toHaveTextContent("10.50 kW");
    expect(figure(container)).not.toHaveClass("muted");
    expect(figure(container)).not.toHaveAttribute("title");
    expect(screen.getByText("10.50")).toHaveClass("stat-num");
    expect(screen.getByText("kW")).toHaveClass("stat-unit");
    expect(container.querySelector(".gauge-name")).toHaveTextContent("LV Panel 1");
  });

  it("draws a measured figure's markers", () => {
    gaugeOf(valuesData({ type: "gauge", values: [valueRow({ estimated: true, partial: true })] }));
    expect(screen.getByText("~10.50*")).toBeInTheDocument();
  });

  it("dims a stale figure and says how old it is, after the name", () => {
    const { container } = gaugeOf(valuesData({ type: "gauge", values: [valueRow({ ts: minutesAgo(12), stale: true })] }), config({ aggregation: "last" }));
    expect(figure(container)).toHaveClass("muted");
    expect(screen.getByText("12 min ago")).toBeInTheDocument();
    expect(container.querySelector(".gauge-name")).toHaveTextContent(/^LV Panel 1.*12 min ago$/);
  });

  it("shows no age for a fresh reading", () => {
    gaugeOf(valuesData({ type: "gauge", values: [valueRow({ ts: minutesAgo(0), stale: false })] }));
    expect(screen.queryByText(/ago|just now/)).not.toBeInTheDocument();
  });
});
