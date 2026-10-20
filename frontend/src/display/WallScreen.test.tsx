import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { WidgetData } from "../api/types";
import { markerHint } from "../lib/widgetFormat";
import { compareSeriesData, compareStatData, config, dataFor, seriesData, valueRow, valuesData } from "../test/dashboardFixtures";
import { manualTimers } from "../test/manualTimers";
import type { DisplayItem, DisplayWidget } from "./displayApi";
import { fitWall, naturalHeight } from "./fit";
import { WallScreen } from "./WallScreen";
import type { CardState, Wall, WallSnapshot } from "./wallTypes";

// The wall's view is drawn from a hand-made snapshot by a fake wall: the controller is another file's business, and nothing here starts, stops or feeds it.
// ECharts is a stub that shows the pixel ratio the chart was asked to draw at.
vi.mock("echarts-for-react", () => ({
  default: (props: { opts?: { devicePixelRatio?: number } }) => <div data-testid="chart" data-dpr={props.opts === undefined ? "none" : String(props.opts.devicePixelRatio)} />,
}));

const ZONE = "Asia/Qatar"; // UTC+3
const NOW = Date.UTC(2026, 9, 20, 11, 3); // 14:03 in Qatar
const UPDATED = Date.UTC(2026, 9, 20, 11, 2); // 14:02
const HD = { width: 1920, height: 1080, dpr: 1 };
const UHD = { width: 3840, height: 2160, dpr: 1 };

const dw = (id: number, type: string, over: Partial<DisplayWidget> = {}): DisplayWidget => ({ id, type, title: `Card ${id}`, config: config(), x: 0, y: 0, w: 4, h: 4, ...over });
/** 8 rows (a Power-like dashboard): a stat, a table and a gauge over a text heading and a chart. */
const POWER: DisplayWidget[] = [
  dw(1, "stat", { x: 0, y: 0 }),
  dw(2, "table", { x: 4, y: 0 }),
  dw(3, "gauge", { x: 8, y: 0, config: config({ min: 0, max: 100 }) }),
  dw(4, "text", { x: 0, y: 4, w: 4, h: 1, title: "Heading", config: { style: "heading", text: "Cooling plant" } }),
  dw(5, "timeseries", { x: 4, y: 4, w: 8, h: 4 }),
];
const item = (over: Partial<DisplayItem> = {}, widgets: DisplayWidget[] = POWER): DisplayItem => ({
  id: 11, seconds: 20, skipped: null, focus: null, dashboard: { id: 3, name: "Power", range: "24h", widgets }, ...over,
});
const answered = (data: WidgetData, over: Partial<CardState> = {}): CardState => ({ status: "ok", data, answeredAt: UPDATED, failingSince: null, notUpdated: false, ...over });
/** The test table carries an estimated row; the cards of a dashboard that has no mark at all use this one. */
const PLAIN_TABLE = valuesData({ type: "table", values: [valueRow(), valueRow({ asset_id: 6, name: "LV Panel 2", value: 4.25, point_id: 8 })] });
const POWER_CARDS: Record<number, CardState> = {
  1: answered(dataFor("stat")), 2: answered(PLAIN_TABLE), 3: answered(dataFor("gauge")), 5: answered(seriesData()),
};
const snapshot = (over: Partial<WallSnapshot> = {}): WallSnapshot => ({
  item: item(), position: { index: 2, of: 3 }, phase: "in", cards: POWER_CARDS, timezone: ZONE, now: NOW, updatedAt: UPDATED, band: null, emptyText: null, ...over,
});

/** A wall that holds a snapshot the test replaces by hand; it counts what the view does to it. */
function fakeWall(first: WallSnapshot) {
  let current = first;
  const listeners = new Set<() => void>();
  const wall: Wall = {
    start: vi.fn(), stop: vi.fn(), feed: vi.fn(), wake: vi.fn(),
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    wall,
    listeners,
    set(over: Partial<WallSnapshot>) {
      current = { ...current, ...over };
      act(() => listeners.forEach((listener) => listener()));
    },
  };
}

const show = (over: Partial<WallSnapshot> = {}, viewport = HD) => {
  const fake = fakeWall(snapshot(over));
  const clock = manualTimers();
  const view = render(<WallScreen wall={fake.wall} timers={clock.timers} viewport={viewport} />);
  return { ...fake, clock, view, main: () => view.container.querySelector("main.wall") as HTMLElement };
};
const cssVar = (el: HTMLElement, name: string) => Number(el.style.getPropertyValue(name));

describe("the header", () => {
  it("names the dashboard (an h1), its place and the site's clock and 'Updated' time", () => {
    const { main } = show();
    expect(screen.getByRole("heading", { level: 1, name: "Power" })).toHaveClass("wall-title");
    expect(screen.getByText("2 of 3")).toHaveClass("wall-position");
    expect(screen.getByText("Updated 14:02")).toHaveClass("wall-updated");
    expect(screen.getByText("14:03")).toHaveClass("wall-clock");
    expect(main()).toHaveAttribute("aria-label", "Display");
  });

  it("adds the focus asset's name after a comma", () => {
    show({ item: item({ focus: { id: 2, name: "Hall 1", trail: ["Site", "Hall 1"] } }) });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Power, Hall 1");
  });

  it("says no 'Updated' while nothing was answered", () => {
    show({ updatedAt: null, cards: {} });
    expect(screen.queryByText(/Updated/)).not.toBeInTheDocument();
    expect(screen.getByText("14:03")).toBeInTheDocument();
  });

  it("draws no clock and no 'Updated' for a zone the browser does not know (nothing instead of a wrong time)", () => {
    const { view } = show({ timezone: "" });
    expect(screen.queryByText(/Updated/)).not.toBeInTheDocument();
    expect(view.container.querySelector(".wall-clock")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Power" })).toBeInTheDocument(); // the rest of the wall is drawn
    expect(view.container.querySelector(".wall-grid")).not.toBeNull();
  });

  it("follows the snapshot: a new place, a new name and a new minute", () => {
    const fake = show();
    fake.set({ item: item({ id: 12, dashboard: { id: 4, name: "Cost", range: "24h", widgets: POWER } }), position: { index: 3, of: 3 }, now: NOW + 60_000 });
    expect(screen.getByRole("heading", { level: 1, name: "Cost" })).toBeInTheDocument();
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    expect(screen.getByText("14:04")).toBeInTheDocument();
  });

  it("has one h1; the card titles are h2", () => {
    show();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const titles = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(titles).toEqual(expect.arrayContaining(["Card 1", "Card 2", "Card 3", "Card 5", "Cooling plant"]));
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
  });
});

describe("the legend", () => {
  const legend = (c: HTMLElement) => c.querySelector(".wall-legend");

  it("is absent when no card on screen carries a mark", () => {
    const { view } = show();
    expect(legend(view.container)).toBeNull();
  });

  it("uses the app's own words for the marks the cards carry, with the full text as its title", () => {
    const estimated = answered(valuesData({ values: [valueRow({ estimated: true })] }));
    const fake = show({ cards: { ...POWER_CARDS, 1: estimated } });
    const text = markerHint({ estimated: true, partial: false });
    expect(legend(fake.view.container)).toHaveTextContent(text);
    expect(legend(fake.view.container)).toHaveAttribute("title", text);
    fake.set({ cards: { ...POWER_CARDS, 1: estimated, 2: answered(valuesData({ type: "table", values: [valueRow({ partial: true })] })) } });
    const both = markerHint({ estimated: true, partial: true });
    expect(both).toContain("~ estimated");
    expect(both).toContain("* partial");
    expect(legend(fake.view.container)).toHaveTextContent(both);
  });

  it("clears when the card that carried the mark no longer does", () => {
    const fake = show({ cards: { ...POWER_CARDS, 1: answered(valuesData({ values: [valueRow({ estimated: true })] })) } });
    expect(legend(fake.view.container)).not.toBeNull();
    fake.set({ cards: POWER_CARDS });
    expect(legend(fake.view.container)).toBeNull();
  });

  it("does not count a * on a comparison of energy (the card draws none)", () => {
    const stars = compareStatData({ values: [valueRow({ value: 1500, point_id: null, partial: true })] });
    const fake = show({ cards: { ...POWER_CARDS, 1: answered(stars) } });
    expect(legend(fake.view.container)).toBeNull();
  });

  it("does not count a card that shows a sentence instead of its figures, nor one that cannot be read", () => {
    const sentence = answered({ ...valuesData({ values: [valueRow({ estimated: true })] }), focus: { asset: null, state: "choose", children: null, top_level: 3 } });
    const followers = [dw(1, "stat", { config: config({ scope: "focus", assets: [] }) })];
    const { view } = show({ item: item({}, followers), cards: { 1: sentence } });
    expect(legend(view.container)).toBeNull();
  });

  it("survives a card whose answer or config is malformed: that card is skipped, the wall stays up", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = answered({ ...dataFor("stat"), breakdown: { more: null } } as unknown as WidgetData);
    const widgets = [dw(1, "stat"), dw(2, "stat", { config: null, y: 4 })];
    const { view } = show({ item: item({}, widgets), cards: { 1: broken, 2: answered(valuesData({ values: [valueRow({ estimated: true })] })) } });
    expect(screen.getByRole("heading", { level: 1, name: "Power" })).toBeInTheDocument();
    expect(legend(view.container)).toBeNull();
  });
});

describe("the bands", () => {
  it("shows the band as the one status, with its text, and dims the cards", () => {
    const { main, view } = show({ band: { kind: "readings", text: "Readings stopped arriving at 13:52." } });
    const band = screen.getByRole("status");
    expect(band).toHaveClass("wall-band");
    expect(within(band).getByText("Readings stopped arriving at 13:52.")).toHaveClass("wall-band-text");
    expect(main()).toHaveAttribute("data-dim", "true");
    expect(view.container.querySelectorAll("[role=status]")).toHaveLength(1);
  });

  it("is not there, and nothing is dimmed, without a band", () => {
    const { main, view } = show();
    expect(view.container.querySelector(".wall-band")).toBeNull();
    expect(main()).not.toHaveAttribute("data-dim");
  });

  it("goes away with the snapshot that clears it", () => {
    const fake = show({ band: { kind: "screen", text: "This screen has not been updated since 14:02. Trying again..." } });
    expect(screen.getByRole("status")).toBeInTheDocument();
    fake.set({ band: null });
    expect(fake.view.container.querySelector(".wall-band")).toBeNull();
    expect(fake.main()).not.toHaveAttribute("data-dim");
  });
});

describe("nothing to show", () => {
  it("draws the one sentence in the display screen's box, as a polite live region", () => {
    const sentence = "Nothing to show. Every dashboard in playlist Wall A is skipped or the playlist is empty. An administrator can change it on the Displays page.";
    const { view } = show({ item: null, position: null, cards: {}, emptyText: sentence, updatedAt: null });
    const text = screen.getByText(sentence);
    expect(text).toHaveClass("display-screen-text");
    expect(text).toHaveAttribute("aria-live", "polite");
    expect(text.parentElement).toHaveClass("display-screen");
    expect(view.container.querySelector("main.wall")).toBeNull();
  });

  it("says 'Connecting...' quietly when there is no sentence either", () => {
    show({ item: null, position: null, cards: {}, emptyText: null });
    expect(screen.getByText("Connecting...")).toHaveClass("display-screen-quiet");
  });

  it("changes to the wall when an item arrives and back when it goes", () => {
    const fake = show({ item: null, position: null, cards: {}, emptyText: "Nothing to show." });
    expect(fake.view.container.querySelector("main.wall")).toBeNull();
    fake.set({ item: item(), position: { index: 1, of: 1 }, cards: POWER_CARDS, emptyText: null });
    expect(fake.view.container.querySelector("main.wall")).not.toBeNull();
    fake.set({ item: null, position: null, cards: {}, emptyText: "Nothing to show." });
    expect(screen.getByText("Nothing to show.")).toBeInTheDocument();
  });
});

describe("the swap", () => {
  it("marks the canvas with the phase of the fade", () => {
    const fake = show();
    const canvas = () => fake.view.container.querySelector(".wall-canvas") as HTMLElement;
    expect(canvas()).toHaveAttribute("data-phase", "in");
    fake.set({ phase: "out" });
    expect(canvas()).toHaveAttribute("data-phase", "out");
    fake.set({ phase: "in" });
    expect(canvas()).toHaveAttribute("data-phase", "in");
  });
});

describe("the fit", () => {
  const natural = naturalHeight(POWER);

  it.each([
    ["1920x1080", HD],
    ["3840x2160 at DPR 1", UHD],
    ["1920x1080 at DPR 2", { ...HD, dpr: 2 }],
  ])("scales the dashboard to fit at %s: the scale, the unit, the box and where it sits", (_name, viewport) => {
    const { main, view } = show({}, viewport);
    const fit = fitWall(viewport, natural);
    expect(cssVar(main(), "--wall-s")).toBeCloseTo(fit.scale, 6);
    expect(cssVar(main(), "--wall-unit")).toBeCloseTo(fit.unit, 6);
    const stage = view.container.querySelector(".wall-stage") as HTMLElement;
    expect(parseFloat(stage.style.top)).toBeCloseTo(fit.top, 4);
    expect(parseFloat(stage.style.height)).toBeCloseTo(natural * fit.scale, 4);
    const canvas = view.container.querySelector(".wall-canvas") as HTMLElement;
    expect(parseFloat(canvas.style.width)).toBeCloseTo(fit.logicalWidth, 4);
    expect(canvas.style.transform).toBe(`scale(${fit.scale})`);
    expect(canvas.style.transformOrigin).toMatch(/^0(px)? 0(px)?$/);
  });

  it("is the same picture at twice the size: the scale doubles, the unit doubles", () => {
    const small = show({}, HD);
    const sScale = cssVar(small.main(), "--wall-s");
    small.view.unmount();
    const big = show({}, UHD);
    expect(cssVar(big.main(), "--wall-s")).toBeCloseTo(sScale * 2, 6);
    expect(cssVar(big.main(), "--wall-unit")).toBe(2);
  });

  it("asks the charts to draw at the device pixel ratio times the scale, and nowhere else", async () => {
    show({}, { ...HD, dpr: 2 });
    const chart = await screen.findByTestId("chart");
    expect(Number(chart.getAttribute("data-dpr"))).toBeCloseTo(2 * fitWall(HD, natural).scale, 6);
  });

  it("lays the cards out on the dashboard's own grid, in reading order", () => {
    const { view } = show();
    const cells = [...view.container.querySelectorAll(".wall-grid > .wall-cell")] as HTMLElement[];
    expect(cells).toHaveLength(POWER.length);
    expect(cells[0].style.gridColumn).toBe("1 / span 4");
    expect(cells[0].style.gridRow).toBe("1 / span 4");
    expect(cells[1].style.gridColumn).toBe("5 / span 4");
    expect(cells.map((cell) => within(cell).queryAllByRole("heading", { level: 2 })[0]?.textContent)).toEqual(["Card 1", "Card 2", "Card 3", "Cooling plant", "Card 5"]);
    expect((view.container.querySelector(".wall-grid") as HTMLElement).style.gridAutoRows).toBe("80px");
  });

  it("follows the window when it is resized, and lets go of the listener on unmount", () => {
    const fake = fakeWall(snapshot());
    const clock = manualTimers();
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    Object.defineProperty(window, "innerWidth", { value: 1920, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 1080, configurable: true });
    const { container, unmount } = render(<WallScreen wall={fake.wall} timers={clock.timers} />);
    const main = () => container.querySelector("main.wall") as HTMLElement;
    expect(cssVar(main(), "--wall-s")).toBeCloseTo(fitWall({ width: 1920, height: 1080 }, naturalHeight(POWER)).scale, 6);
    expect(add.mock.calls.some(([type]) => type === "resize")).toBe(true);
    Object.defineProperty(window, "innerWidth", { value: 3840, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 2160, configurable: true });
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(cssVar(main(), "--wall-s")).toBeCloseTo(fitWall({ width: 3840, height: 2160 }, naturalHeight(POWER)).scale, 6);
    unmount();
    expect(remove.mock.calls.some(([type]) => type === "resize")).toBe(true);
  });
});

describe("the cursor", () => {
  it("hides after 3 seconds without a move, on the injected timers, and comes back on a pointer move", () => {
    const { main, clock } = show();
    expect(main()).not.toHaveClass("wall-cursor-hidden");
    act(() => clock.advance(2_999));
    expect(main()).not.toHaveClass("wall-cursor-hidden");
    act(() => clock.advance(1));
    expect(main()).toHaveClass("wall-cursor-hidden");
    fireEvent.pointerMove(main());
    expect(main()).not.toHaveClass("wall-cursor-hidden");
    act(() => clock.advance(3_000));
    expect(main()).toHaveClass("wall-cursor-hidden");
    fireEvent.mouseMove(main());
    expect(main()).not.toHaveClass("wall-cursor-hidden");
  });

  it("restarts the wait on every move", () => {
    const { main, clock } = show();
    act(() => clock.advance(2_000));
    fireEvent.pointerMove(main());
    act(() => clock.advance(2_000));
    expect(main()).not.toHaveClass("wall-cursor-hidden");
    act(() => clock.advance(1_000));
    expect(main()).toHaveClass("wall-cursor-hidden");
  });

  it("leaves no timer behind when the wall is gone", () => {
    const { view, clock } = show();
    expect(clock.count).toBeGreaterThan(0);
    view.unmount();
    expect(clock.count).toBe(0);
  });
});

describe("a page with nothing to press", () => {
  it("has no button, link, field or select for a whole dashboard, and never starts, stops, feeds or wakes the wall", () => {
    const { view, wall } = show();
    expect(view.container.querySelectorAll("button, a, input, select, textarea")).toHaveLength(0);
    expect(wall.start).not.toHaveBeenCalled();
    expect(wall.stop).not.toHaveBeenCalled();
    expect(wall.feed).not.toHaveBeenCalled();
    expect(wall.wake).not.toHaveBeenCalled();
  });

  it("has none in the other variants either: comparisons, bars by asset, a paragraph and a divider", async () => {
    const widgets = [
      dw(1, "stat", { x: 0, y: 0, config: config({ source: "energy", compare: "same_days_last_month" }) }),
      dw(2, "timeseries", { x: 4, y: 0, config: config({ source: "energy", compare: "same_days_last_month" }) }),
      dw(3, "bar", { x: 8, y: 0 }),
      dw(4, "text", { x: 0, y: 4, w: 6, h: 2, title: "Notes", config: { style: "paragraph", text: "Maintenance on Friday" } }),
      dw(5, "text", { x: 6, y: 4, w: 6, h: 1, title: "Line", config: { style: "divider", text: "" } }),
    ];
    const cards = { 1: answered(compareStatData()), 2: answered(compareSeriesData()), 3: answered(dataFor("bar")) };
    const { view } = show({ item: item({}, widgets), cards });
    await waitFor(() => expect(screen.getAllByTestId("chart")).toHaveLength(2));
    expect(screen.getByText("Maintenance on Friday")).toBeInTheDocument();
    expect(view.container.querySelectorAll("button, a, input, select, textarea, [tabindex]")).toHaveLength(0);
  });

  it("draws every card with no provider and makes no request of its own", () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    show();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("the cards of one dashboard", () => {
  it("draws each card from its own state: one loading, one failed, one stale, the rest answered", () => {
    const cards: Record<number, CardState> = {
      1: answered(dataFor("stat")),
      2: { status: "error", data: null, answeredAt: null, failingSince: UPDATED, notUpdated: false },
      3: answered(dataFor("gauge"), { notUpdated: true, failingSince: UPDATED }),
    };
    const { view } = show({ cards });
    expect(screen.getByText("Loading Card 5")).toBeInTheDocument(); // no entry at all: still loading
    expect(screen.getByText(/This card could not be loaded\./)).toBeInTheDocument();
    expect(screen.getByText("Not updated since 14:02")).toBeInTheDocument();
    expect(view.container.querySelectorAll(".wall-card-stale")).toHaveLength(1);
  });

  it("passes the item's focus to the cards that follow it", () => {
    const followers = [dw(1, "stat", { config: config({ scope: "focus", assets: [] }) }), dw(2, "stat", { y: 4 })];
    show({
      item: item({ focus: { id: 2, name: "Hall 1", trail: ["Hall 1"] } }, followers),
      cards: { 1: answered(dataFor("stat")), 2: answered(dataFor("stat")) },
    });
    expect(screen.getAllByText("Its own assets, not Hall 1")).toHaveLength(1); // the card with its own assets; the one that follows the focus has none to say
  });
});
