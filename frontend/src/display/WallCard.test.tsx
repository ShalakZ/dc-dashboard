import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import type { WidgetData } from "../api/types";
import { breakdownData, config, dataFor, seriesData, valueRow, valuesData } from "../test/dashboardFixtures";
import { childrenNote, chooseText, leafText, NO_ASSETS_TEXT, ownAssetsNote } from "../lib/focus";
import type { DisplayWidget } from "./displayApi";
import { GONE_TEXT, WallCard, wallFocusView } from "./WallCard";
import type { CardState } from "./wallTypes";

// The wall's cards are drawn with NO provider around them (no router, no query client, no auth): a card that reached for one would throw here. The charts are
// lazy chunks of ECharts, which a stub stands in for.
vi.mock("echarts-for-react", () => ({
  default: (props: { option: { series?: { type?: string }[] } }) => <div data-testid="chart" data-kind={props.option.series?.[0]?.type} />,
}));

const TZ = "UTC";
const AT = Date.UTC(2026, 9, 20, 14, 2); // 14:02 in UTC
const dw = (id: number, type: string, over: Partial<DisplayWidget> = {}): DisplayWidget => ({ id, type, title: `Card ${id}`, config: config(), x: 0, y: 0, w: 4, h: 3, ...over });
const kept = (data: WidgetData, over: Partial<CardState> = {}): CardState => ({ status: "ok", data, answeredAt: AT, failingSince: null, notUpdated: false, ...over });
const FOCUS = { id: 2, name: "Hall 1" };

let fetchStub: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchStub = vi.fn();
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const card = (widget: DisplayWidget, state: CardState | undefined, focus: typeof FOCUS | null = null) =>
  render(<WallCard widget={widget} card={state} timezone={TZ} focus={focus} />);

describe("a data card with no provider", () => {
  it("draws a stat from its answer, under an h2 title", () => {
    const { container } = card(dw(1, "stat"), kept(dataFor("stat")));
    expect(screen.getByRole("heading", { level: 2, name: "Card 1" })).toBeInTheDocument();
    expect(container.querySelector(".stat-num")).toHaveTextContent("10.5");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("draws a table from its answer", () => {
    card(dw(2, "table"), kept(dataFor("table")));
    const table = screen.getByRole("table");
    expect(within(table).getByText("LV Panel 1")).toBeInTheDocument();
    expect(within(table).getByText("LV Panel 2")).toBeInTheDocument();
  });

  it("draws a gauge from its answer", () => {
    const { container } = card(dw(3, "gauge", { config: config({ min: 0, max: 100 }) }), kept(dataFor("gauge")));
    expect(container.querySelector(".gauge-figure")).toHaveTextContent("10.5");
  });

  it.each([
    ["a time series", "timeseries", seriesData()],
    ["a bar chart", "bar", dataFor("bar")],
  ])("draws %s as a chart (a lazy chunk)", async (_name, type, data) => {
    card(dw(4, type), kept(data));
    expect(await screen.findByTestId("chart")).toBeInTheDocument();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("draws a breakdown by kind as plain bars: no request, no console error, and its Split by select is the disabled one", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = card(dw(5, "bar", { config: config({ bars: "kind", assets: [], kind: "Rack", root: 2 }) }), kept(breakdownData()));
    expect(await screen.findByTestId("chart")).toBeInTheDocument();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    for (const select of container.querySelectorAll("select")) expect(select).toBeDisabled();
    expect(container.querySelector("button, a, input, textarea")).toBeNull();
  });

  it("shows the skeleton while it has no answer (no card yet, or a first request in flight)", () => {
    const { unmount } = card(dw(6, "stat"), undefined);
    expect(screen.getByText("Loading Card 6")).toBeInTheDocument();
    unmount();
    card(dw(6, "stat"), { status: "loading", data: null, answeredAt: null, failingSince: null, notUpdated: false });
    expect(screen.getByText("Loading Card 6")).toBeInTheDocument();
  });

  it("says it could not be loaded when it failed and keeps nothing", () => {
    card(dw(7, "stat"), { status: "error", data: null, answeredAt: null, failingSince: AT, notUpdated: false });
    expect(screen.getByText("This card could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText(/Not updated/)).not.toBeInTheDocument();
  });

  it("never prints a promise of when it tries again (the wall retries on its own schedule, 5 to 20 seconds, and says nothing of it)", () => {
    const states: [string, CardState | undefined][] = [
      ["loading", undefined],
      ["failed with nothing kept", { status: "error", data: null, answeredAt: null, failingSince: AT, notUpdated: false }],
      ["failed with an answer kept", kept(dataFor("stat"), { status: "error", failingSince: AT + 30_000 })],
      ["not updated for 120 s", kept(dataFor("stat"), { failingSince: AT + 1_000, notUpdated: true })],
      ["refused by the server", { status: "unavailable", data: null, answeredAt: null, failingSince: null, notUpdated: false }],
    ];
    for (const [name, state] of states) {
      const { container, unmount } = card(dw(7, "stat"), state);
      expect(container.textContent, name).not.toMatch(/tries again|second|minute/i);
      unmount();
    }
  });

  it("says nothing when a request failed but an answer is kept: the figures stay, no error text, no tag, not dimmed (R8)", () => {
    const { container } = card(dw(8, "stat"), kept(dataFor("stat"), { failingSince: AT + 30_000 }));
    expect(container.querySelector(".stat-num")).toHaveTextContent("10.5");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Not updated/)).not.toBeInTheDocument();
    expect(container.querySelector(".wall-card-stale")).toBeNull();
  });

  it("dims a card that has not updated for 120 s and tags it with the time of its last answer, figures kept", () => {
    const { container } = card(dw(9, "stat"), kept(dataFor("stat"), { failingSince: AT + 1_000, notUpdated: true }));
    expect(screen.getByText("Not updated since 14:02")).toHaveClass("wall-card-tag");
    expect(container.querySelector(".wall-card-stale")).not.toBeNull();
    expect(container.querySelector(".wall-card-stale .stat-num")).toHaveTextContent("10.5");
    // the dim and the tag are the whole message: no sentence under the head (it would push the figures out of the card)
    expect(screen.queryByText(/could not be/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the figures and says nothing else when a failure comes with an answer kept, even if the card says error", () => {
    const { container } = card(dw(9, "stat"), kept(dataFor("stat"), { status: "error", failingSince: AT + 1_000 }));
    expect(container.querySelector(".stat-num")).toHaveTextContent("10.5");
    expect(screen.queryByText(/could not be/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("draws 'This card cannot be shown.' for a widget the server refuses, with no tag", () => {
    card(dw(10, "stat"), { status: "unavailable", data: null, answeredAt: null, failingSince: null, notUpdated: false });
    expect(screen.getByText("This card cannot be shown.")).toBeInTheDocument();
    expect(screen.queryByText(/Not updated/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
  });

  it("shows the chip for assets that were deleted", () => {
    card(dw(12, "stat"), kept(valuesData({ missing: [9, 10] })));
    expect(screen.getByText("2 assets removed")).toBeInTheDocument();
  });
});

describe("a text card", () => {
  it.each([
    ["heading", "Cooling plant"],
    ["paragraph", "Maintenance on Friday"],
  ] as const)("draws a %s and makes no request", (style, text) => {
    render(<WallCard widget={dw(20, "text", { title: "Notes", config: { style, text } })} card={undefined} timezone={TZ} focus={null} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("draws a divider and makes no request", () => {
    render(<WallCard widget={dw(21, "text", { title: "Line", config: { style: "divider", text: "" } })} card={undefined} timezone={TZ} focus={null} />);
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("a card that cannot be drawn", () => {
  it("shows the fallback for a config that is not an object and leaves its sibling alone; nothing is logged by the card", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {}); // React itself reports a caught render error; the boundary adds nothing
    const bad = dw(30, "stat", { config: null });
    render(
      <>
        <WallCard widget={bad} card={kept(dataFor("stat"))} timezone={TZ} focus={null} />
        <WallCard widget={dw(31, "stat")} card={kept(dataFor("stat"))} timezone={TZ} focus={null} />
      </>,
    );
    expect(screen.getByText("This card cannot be shown.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Card 31" })).toBeInTheDocument();
    expect(errors.mock.calls.every(([message]) => !String(message).includes("cannot be shown"))).toBe(true);
  });

  it.each([
    ["an unknown type", dw(32, "radar")],
    ["an array for a config", dw(33, "stat", { config: [] })],
    ["a text widget with a style it does not know", dw(34, "text", { config: { style: "banner", text: "x" } })],
    ["a text widget with no text", dw(35, "text", { config: { style: "heading" } })],
  ])("falls back for %s", (_name, widget) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<WallCard widget={widget} card={undefined} timezone={TZ} focus={null} />);
    expect(screen.getByText("This card cannot be shown.")).toBeInTheDocument();
  });

  it("tries the card again when a new answer arrives (the boundary resets on the answer's time)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stat = dw(36, "stat");
    // A card whose body throws for a malformed answer and is fine once the next answer is well formed.
    const broken = kept({ ...dataFor("stat"), values: null } as unknown as WidgetData);
    const { rerender, container } = render(<WallCard widget={stat} card={broken} timezone={TZ} focus={null} />);
    expect(screen.getByText("This card cannot be shown.")).toBeInTheDocument();
    rerender(<WallCard widget={stat} card={kept(dataFor("stat"), { answeredAt: AT + 30_000 })} timezone={TZ} focus={null} />);
    expect(screen.queryByText("This card cannot be shown.")).not.toBeInTheDocument();
    expect(container.querySelector(".stat-num")).toHaveTextContent("10.5");
  });

  it("does not remount a healthy card when a new answer arrives (a chart is not drawn from scratch every 30 seconds)", () => {
    const stat = dw(37, "stat");
    const { container, rerender } = render(<WallCard widget={stat} card={kept(dataFor("stat"))} timezone={TZ} focus={null} />);
    const before = container.querySelector(".stat-num");
    rerender(<WallCard widget={stat} card={kept(dataFor("stat"), { answeredAt: AT + 30_000 })} timezone={TZ} focus={null} />);
    expect(container.querySelector(".stat-num")).toBe(before);
  });
});

describe("wallFocusView (the focus state of a card, as the app's WidgetView computes it)", () => {
  const follows = (over = {}) => ({ config: config({ scope: "focus", assets: [], ...over }) });
  const withFocus = (focus: WidgetData["focus"]) => ({ ...dataFor("stat"), focus });
  const hall = { id: 2, name: "Hall 1", path: "Site / Hall 1" };

  it("a plain card has no sentence and no note", () => {
    expect(wallFocusView({ config: config() }, dataFor("stat"), null)).toEqual({ sentence: null, note: "", bare: false, gone: false });
    expect(wallFocusView({ config: config() }, null, FOCUS)).toMatchObject({ sentence: null, bare: false });
  });

  it("'choose' says the figure needs a focus, in the wall's words (no link to follow)", () => {
    const view = wallFocusView(follows(), withFocus({ asset: null, state: "choose", children: null, top_level: 3 }), null);
    expect(view).toMatchObject({ sentence: chooseText(3, false), bare: true, gone: false });
    expect(view.sentence).not.toMatch(/choose a focus to see/i);
    expect(wallFocusView(follows(), withFocus({ asset: null, state: "choose", children: null, top_level: 0 }), null).sentence).toBe(NO_ASSETS_TEXT);
  });

  it("a children card whose focus has no children says so", () => {
    const view = wallFocusView(follows({ scope: "children" }), withFocus({ asset: hall, state: "ok", children: { shown: 0, count: 0 }, top_level: null }), FOCUS);
    expect(view).toMatchObject({ sentence: leafText("Site / Hall 1"), bare: true });
    expect(wallFocusView(follows({ scope: "children" }), withFocus({ asset: null, state: "ok", children: { shown: 0, count: 0 }, top_level: null }), null).sentence).toBe(NO_ASSETS_TEXT);
  });

  it("a gone focus replaces the body by a sentence, and its removed-asset chip is not counted", () => {
    const view = wallFocusView(follows(), withFocus({ asset: null, state: "gone", children: null, top_level: null }), FOCUS);
    expect(view).toMatchObject({ sentence: GONE_TEXT, bare: true, gone: true });
  });

  it("a children card that shows only some of its children carries the note", () => {
    const view = wallFocusView(follows({ scope: "children" }), withFocus({ asset: hall, state: "ok", children: { shown: 20, count: 34 }, top_level: null }), FOCUS);
    expect(view).toMatchObject({ sentence: null, bare: false, note: childrenNote(20, 34, "Hall 1") });
    expect(wallFocusView(follows({ scope: "children" }), withFocus({ asset: hall, state: "ok", children: { shown: 34, count: 34 }, top_level: null }), FOCUS).note).toBe("");
  });

  it("a card with its own assets, on a dashboard that has a focus, says so unless its asset IS the focus", () => {
    expect(wallFocusView({ config: config({ assets: [5] }) }, dataFor("stat"), FOCUS).note).toBe(ownAssetsNote("Hall 1"));
    expect(wallFocusView({ config: config({ assets: [2] }) }, dataFor("stat"), FOCUS).note).toBe("");
    expect(wallFocusView({ config: config({ assets: [5] }) }, dataFor("stat"), null).note).toBe("");
    expect(wallFocusView({ config: config({ bars: "kind", assets: [], kind: "Rack", root: 2 }) }, dataFor("stat"), FOCUS).note).toBe("");
    expect(wallFocusView({ config: config({ bars: "kind", assets: [], kind: "Rack", root: 7 }) }, dataFor("stat"), FOCUS).note).toBe(ownAssetsNote("Hall 1"));
  });

  it("does not trip over a stored config that lacks its assets list", () => {
    const bare = { config: {} as ReturnType<typeof config> };
    expect(wallFocusView(bare, dataFor("stat"), FOCUS).note).toBe(ownAssetsNote("Hall 1"));
  });
});

describe("a card on a dashboard with a focus", () => {
  it("draws the sentence instead of the figure for a 'choose' answer", () => {
    const answer = { ...dataFor("stat"), focus: { asset: null, state: "choose" as const, children: null, top_level: 3 } };
    const { container } = card(dw(40, "stat", { config: config({ scope: "focus", assets: [] }) }), kept(answer));
    expect(screen.getByText(chooseText(3, false))).toHaveClass("widget-empty");
    expect(container.querySelector(".stat")).toBeNull();
  });

  it("draws the sentence for a gone focus and for a leaf", () => {
    const gone = { ...dataFor("stat"), focus: { asset: null, state: "gone" as const, children: null, top_level: null } };
    const { unmount } = card(dw(41, "stat", { config: config({ scope: "focus", assets: [] }) }), kept(gone));
    expect(screen.getByText(GONE_TEXT)).toBeInTheDocument();
    unmount();
    const leaf = { ...seriesData(), focus: { asset: { id: 2, name: "Hall 1", path: "Site / Hall 1" }, state: "ok" as const, children: { shown: 0, count: 0 }, top_level: null } };
    card(dw(42, "timeseries", { config: config({ scope: "children", assets: [] }) }), kept(leaf));
    expect(screen.getByText(leafText("Site / Hall 1"))).toBeInTheDocument();
  });

  it("puts a note in the card head as a chip, never in a footer line", () => {
    const some = { ...seriesData(), focus: { asset: { id: 2, name: "Hall 1", path: "Site / Hall 1" }, state: "ok" as const, children: { shown: 20, count: 34 }, top_level: null } };
    const { container } = card(dw(43, "timeseries", { config: config({ scope: "children", assets: [] }) }), kept(some), FOCUS);
    const chip = screen.getByText(childrenNote(20, 34, "Hall 1"));
    expect(chip.closest(".wall-card-note")).toHaveClass("chip", "chip-warn");
    expect(chip.closest("header")).not.toBeNull();
    expect(container.querySelector(".widget-foot")).toBeNull();
  });

  it("notes that a card with its own assets does not follow the focus", () => {
    card(dw(44, "stat"), kept(dataFor("stat")), FOCUS);
    expect(screen.getByText(ownAssetsNote("Hall 1")).closest(".wall-card-note")).toHaveClass("chip");
  });
});

describe("the card has no footer line", () => {
  it("draws no footer for marks, since or notes, even when the answer carries marks", () => {
    const marked = valuesData({ values: [valueRow({ estimated: true })] });
    const { container } = card(dw(50, "stat"), kept(marked));
    expect(container.querySelector(".widget-foot")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("the files stay on the display side of the wall", () => {
  it("import nothing of the app's client, queries or auth", () => {
    for (const file of ["src/display/WallCard.tsx", "src/display/WallScreen.tsx"]) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/from\s+["'][^"']*(api\/client|api\/queries|\/auth\/|hooks\/useParentNames)/);
      expect(text, file).not.toMatch(/useWidgetData|useAssets|useNavigate|useAuth|useParentNames/);
    }
  });
});
