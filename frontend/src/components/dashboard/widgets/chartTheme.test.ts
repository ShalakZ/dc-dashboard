import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { baseTokens, resolveVar } from "../../../test/themeTools";
import { axisParts, chartBase, LIGHT_CHART, legendParts, readChartTheme, seriesLook, tipHead, tipRow, useChartTheme, type ChartTheme } from "./chartTheme";

const ROOT = document.documentElement;
const TOKENS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6", "--chart-7", "--chart-8", "--accent", "--chart-axis-text", "--chart-axis-line", "--chart-grid", "--chart-tip-bg", "--chart-tip-text", "--chart-tip-border", "--chart-band-opacity"];

afterEach(() => {
  cleanup(); // the charts go first, so restoring the page below does not reach a mounted hook
  for (const name of TOKENS) ROOT.style.removeProperty(name);
  ROOT.removeAttribute("data-mode");
  ROOT.removeAttribute("data-theme");
  vi.restoreAllMocks();
});

describe("LIGHT_CHART", () => {
  const token = (name: string) => resolveVar(baseTokens, name);

  it("is the light value of every token it stands for in app.css, so the fallback cannot drift from the stylesheet", () => {
    expect(LIGHT_CHART.palette).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => token(`chart-${n}`)));
    expect(LIGHT_CHART.accent).toBe(token("accent"));
    expect(LIGHT_CHART.axisText).toBe(token("chart-axis-text"));
    expect(LIGHT_CHART.axisLine).toBe(token("chart-axis-line"));
    expect(LIGHT_CHART.grid).toBe(token("chart-grid"));
    expect(LIGHT_CHART.tipBg).toBe(token("chart-tip-bg"));
    expect(LIGHT_CHART.tipText).toBe(token("chart-tip-text"));
    expect(LIGHT_CHART.tipBorder).toBe(token("chart-tip-border"));
    expect(LIGHT_CHART.bandOpacity).toBe(Number(token("chart-band-opacity")));
  });
});

describe("readChartTheme", () => {
  it("falls back to the light theme where the page has no stylesheet (jsdom), field by field", () => {
    expect(readChartTheme()).toEqual(LIGHT_CHART);
  });

  it("reads each token the page gives, and trims it", () => {
    ROOT.style.setProperty("--chart-3", "  #112233 ");
    ROOT.style.setProperty("--accent", "#445566");
    ROOT.style.setProperty("--chart-tip-bg", "#262b33");
    ROOT.style.setProperty("--chart-band-opacity", "0.22");
    const theme = readChartTheme();
    expect(theme.palette[2]).toBe("#112233");
    expect(theme.palette[0]).toBe(LIGHT_CHART.palette[0]);
    expect(theme.accent).toBe("#445566");
    expect(theme.tipBg).toBe("#262b33");
    expect(theme.bandOpacity).toBe(0.22);
  });

  it("ignores a band opacity that is not a number", () => {
    ROOT.style.setProperty("--chart-band-opacity", "thick");
    expect(readChartTheme().bandOpacity).toBe(LIGHT_CHART.bandOpacity);
  });
});

describe("useChartTheme", () => {
  it("gives the light theme to a server render and never asks the page for styles there", () => {
    const spy = vi.spyOn(window, "getComputedStyle");
    const Probe = () => createElement("i", null, useChartTheme().palette[0]);
    expect(renderToString(createElement(Probe))).toContain(LIGHT_CHART.palette[0]);
    expect(spy).not.toHaveBeenCalled();
  });

  /** Changes the page and lets the observer (a microtask) report it inside act. */
  const change = (fn: () => void) => act(async () => { fn(); await new Promise((r) => setTimeout(r, 0)); });

  it("returns the same object until a value differs, then a new one when the look changes (no reload)", async () => {
    const { result } = renderHook(() => useChartTheme());
    const first = result.current;
    expect(first).toEqual(LIGHT_CHART);
    await change(() => ROOT.setAttribute("data-mode", "light")); // an attribute changed, no token did
    expect(result.current).toBe(first);
    await change(() => {
      ROOT.style.setProperty("--chart-axis-text", "#a3adbd");
      ROOT.setAttribute("data-mode", "dark");
    });
    expect(result.current).not.toBe(first);
    expect(result.current.axisText).toBe("#a3adbd");
    expect(result.current.palette).toEqual(first.palette);
    const second = result.current;
    await change(() => ROOT.setAttribute("data-theme", "desert-gold"));
    expect(result.current).toBe(second);
  });

  it("shares one observer between charts and disconnects it when the last chart goes", () => {
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const a = renderHook(() => useChartTheme());
    const b = renderHook(() => useChartTheme());
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0]).toBe(ROOT);
    expect(observe.mock.calls[0][1]).toMatchObject({ attributes: true, attributeFilter: ["data-mode", "data-theme"] });
    a.unmount();
    expect(disconnect).not.toHaveBeenCalled();
    b.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("re-reads the page when a chart mounts after the look changed while none was shown", () => {
    const first = renderHook(() => useChartTheme());
    first.unmount();
    ROOT.style.setProperty("--chart-1", "#abcdef");
    const second = renderHook(() => useChartTheme());
    expect(second.result.current.palette[0]).toBe("#abcdef");
  });
});

describe("seriesLook", () => {
  const theme: ChartTheme = { ...LIGHT_CHART, accent: "#123456" };

  it("uses the accent for a chart of one series", () => {
    expect(seriesLook(theme, 0, 1)).toEqual({ color: "#123456", type: "solid" });
  });

  it("uses colours 1 to 5 solid, then 6 to 8 dashed", () => {
    const looks = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => seriesLook(theme, i, 8));
    expect(looks.map((l) => l.color)).toEqual(theme.palette);
    expect(looks.map((l) => l.type)).toEqual(["solid", "solid", "solid", "solid", "solid", "dashed", "dashed", "dashed"]);
  });

  it("lets series 9 and later reuse colours 1 to 5, dotted", () => {
    expect(seriesLook(theme, 8, 11)).toEqual({ color: theme.palette[0], type: "dotted" });
    expect(seriesLook(theme, 12, 13)).toEqual({ color: theme.palette[4], type: "dotted" });
    expect(seriesLook(theme, 13, 14)).toEqual({ color: theme.palette[0], type: "dotted" });
  });
});

describe("the shared option parts", () => {
  const dark: ChartTheme = { ...LIGHT_CHART, axisText: "#a3adbd", axisLine: "#2b313b", grid: "#222831", tipBg: "#262b33", tipText: "#e6e9ef", tipBorder: "#4a5261" };

  it("styles the tooltip from the theme, keeps it inside the chart, and draws no animation", () => {
    const base = chartBase(dark);
    expect(base.animation).toBe(false);
    expect(base.tooltip).toMatchObject({
      trigger: "axis", confine: true, backgroundColor: "#262b33", borderColor: "#4a5261", borderWidth: 1,
      textStyle: { color: "#e6e9ef", fontSize: 13 },
    });
  });

  it("gives the axes 12px labels in the axis ink, the axis line, and solid 1px grid lines", () => {
    const parts = axisParts(dark);
    expect(parts.axisLabel).toMatchObject({ color: "#a3adbd", fontSize: 12 });
    expect(parts.axisLine).toEqual({ lineStyle: { color: "#2b313b" } });
    expect(parts.axisTick).toEqual({ lineStyle: { color: "#2b313b" } });
    expect(parts.nameTextStyle).toMatchObject({ color: "#a3adbd", fontSize: 12 });
    expect(parts.splitLine).toEqual({ lineStyle: { color: "#222831", width: 1, type: "solid" } });
  });

  it("draws the legend at the bottom, scrolling, in 12px axis ink: a 12x3 line for lines, a 10x10 square for bars", () => {
    const line = legendParts(dark, "line");
    expect(line).toMatchObject({ bottom: 0, type: "scroll", textStyle: { color: "#a3adbd", fontSize: 12 }, inactiveColor: "#2b313b", icon: "rect", itemWidth: 12, itemHeight: 3, tooltip: { show: true } });
    const bar = legendParts(dark, "bar");
    expect(bar).toMatchObject({ icon: "roundRect", itemWidth: 10, itemHeight: 10 });
  });
});

describe("tooltip rows", () => {
  it("puts the time first in the axis ink and escapes it", () => {
    const html = tipHead("<b>10:00</b>", LIGHT_CHART);
    expect(html).toContain(LIGHT_CHART.axisText);
    expect(html).toContain("&lt;b&gt;10:00&lt;/b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("puts the marker and name on the left, the value on the right, and the state in words after the value", () => {
    const html = tipRow("<i>m</i>", "<b>Rack</b>", "12.30* kW", "partial", LIGHT_CHART);
    expect(html).toContain("<i>m</i>");
    expect(html).toContain("&lt;b&gt;Rack&lt;/b&gt;");
    expect(html).not.toContain("<b>");
    expect(html.indexOf("Rack")).toBeLessThan(html.indexOf("12.30* kW"));
    expect(html.indexOf("12.30* kW")).toBeLessThan(html.indexOf("partial"));
    expect(html).toContain("justify-content:space-between");
    expect(html).toContain("tabular-nums");
  });

  it("writes no state when there is none, and no name when the row has none (a bar per asset)", () => {
    const html = tipRow("<i>m</i>", "", "10.00 kWh", "", LIGHT_CHART);
    expect(html).toContain("10.00 kWh");
    expect(html).not.toMatch(/estimated|partial|no rate/);
  });
});
