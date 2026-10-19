import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import type { RangePreset, WidgetData, WidgetFocus } from "../../api/types";
import { downloadCsv } from "../../lib/download";
import { breakdownBlock, breakdownData, config, valueRow, valuesData } from "../../test/dashboardFixtures";
import { mockFetch } from "../../test/fetchMock";
import { holdFetch } from "../../test/holdFetch";
import { FocusContext, type FocusState } from "./FocusContext";
import { WidgetView, type WidgetViewProps } from "./WidgetView";

// w25: a card that follows the focus asset (scope "focus" or "children") and a card that keeps its own assets, under a hand-made focus context.
const held = { ids: new Set<string>(["assets.view"]) };
vi.mock("../../auth/AuthProvider", () => ({ useAuth: () => ({ can: (id: string) => held.ids.has(id) }) }));
vi.mock("../../lib/download", () => ({ downloadCsv: vi.fn() }));

vi.mock("echarts-for-react", () => ({
  default: (props: { option: { series?: { type?: string }[] } }) => (
    <pre data-testid="chart" data-kind={props.option.series?.[0]?.type}>{JSON.stringify(props.option)}</pre>
  ),
}));

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;

const reportGone = vi.fn();
/** One identity for `reportGone` in every context of a test, as the provider keeps. */
const ctxOf = (over: Partial<FocusState> = {}): FocusState => ({ focus: null, allowed: true, assets: undefined, name: null, notice: null, anyFollowing: true, setFocus: vi.fn(), reportGone, ...over });
const at = (focus: number | null): FocusState => ctxOf({ focus, name: focus === null ? null : `Hall ${focus}` });

const FOLLOWS = config({ assets: [], source: "energy", metric: null, aggregation: "sum", range: "this_month", scope: "focus" });
const CHILDREN = config({ assets: [], source: "energy", metric: null, aggregation: "sum", range: "this_month", scope: "children" });
const FIXED = config({ assets: [5, 6] });

const props = (over: Partial<WidgetViewProps> = {}): WidgetViewProps => ({
  widgetKey: "w1", type: "table", title: "Hall", config: FOLLOWS, dashboardRange: "this_month", timezone: "Asia/Qatar", ...over,
});
function Harness({ ctx, ...over }: { ctx: FocusState } & Partial<WidgetViewProps>) {
  return <FocusContext.Provider value={ctx}><WidgetView {...props(over)} /></FocusContext.Provider>;
}
const show = (ctx: FocusState, over: Partial<WidgetViewProps> = {}) => {
  const view = render(<Harness ctx={ctx} {...over} />, { wrapper });
  return { ...view, again: (next: FocusState, more: Partial<WidgetViewProps> = over) => view.rerender(<Harness ctx={next} {...more} />) };
};

const block = (id: number, over: Partial<WidgetFocus> = {}): WidgetFocus => ({ asset: { id, name: `Hall ${id}`, path: `Site / Hall ${id}` }, state: "ok", children: null, top_level: null, ...over });
/** What the server answers for a following table: one row named after the focus asset it was asked about. */
const answerFor = (focus: number | undefined, over: Partial<WidgetData> = {}): WidgetData =>
  valuesData({ type: "table", source: "energy", metric: null, unit: "kWh", range: { preset: "this_month", start: "2026-10-01T00:00:00+03:00", end: "2026-10-18T00:00:00+03:00" }, values: [valueRow({ asset_id: focus ?? 1, name: `Row ${focus ?? "site"}`, point_id: null })], focus: focus === undefined ? null : block(focus), ...over });
const byFocus = ({ body }: { url: string; body: unknown }) => ({ body: answerFor((body as { focus?: number }).focus) });
const sent = (calls: { path: string; body: unknown }[]) => calls.filter((c) => c.path === "/api/widget-data").map((c) => c.body as Record<string, unknown>);
const bodyOfCard = () => document.querySelector(".widget-body") as HTMLElement;
const footOfCard = () => document.querySelector(".widget-foot") as HTMLElement | null;
const everything = (method: string, path: string) => method === "POST" && path === "/api/widget-data";

beforeEach(() => {
  client.clear();
  held.ids = new Set(["assets.view"]);
  reportGone.mockReset();
  vi.mocked(downloadCsv).mockReset();
  vi.mocked(downloadCsv).mockResolvedValue(undefined);
});

describe("WidgetView with a focus: the request", () => {
  it("a card that follows the focus asks about it, in the body of the request", async () => {
    const calls = mockFetch({ "POST /api/widget-data": byFocus });
    show(at(7));
    expect(await screen.findByText("Row 7")).toBeInTheDocument();
    expect(sent(calls)).toEqual([{ type: "table", config: FOLLOWS, range: "this_month", focus: 7 }]);
  });

  it("the children of the focus follow it too", async () => {
    const calls = mockFetch({ "POST /api/widget-data": byFocus });
    show(at(7), { config: CHILDREN });
    await screen.findByText("Row 7");
    expect(sent(calls)[0]).toMatchObject({ focus: 7 });
  });

  it("with no focus the request is the one it always was: the key is not there", async () => {
    const calls = mockFetch({ "POST /api/widget-data": byFocus });
    show(at(null));
    await screen.findByText("Row site");
    expect(Object.keys(sent(calls)[0])).toEqual(["type", "config", "range"]);
  });

  it("a card with its own assets never sends a focus, and a change of focus makes no request at all", async () => {
    const calls = mockFetch({ "POST /api/widget-data": byFocus });
    const view = show(at(null), { config: FIXED });
    await screen.findByText("Row site");
    view.again(at(7), { config: FIXED });
    view.again(at(9), { config: FIXED });
    view.again(at(null), { config: FIXED });
    await waitFor(() => expect(screen.getByText("Row site")).toBeInTheDocument());
    expect(sent(calls)).toHaveLength(1);
    expect(Object.keys(sent(calls)[0])).toEqual(["type", "config", "range"]);
  });

  it("a card that follows the focus asks again for a new focus", async () => {
    const calls = mockFetch({ "POST /api/widget-data": byFocus });
    const view = show(at(7));
    await screen.findByText("Row 7");
    view.again(at(9));
    await screen.findByText("Row 9");
    expect(sent(calls).map((body) => body.focus)).toEqual([7, 9]);
  });

  it("the CSV of the card and the CSV of its Details panel repeat the request with the focus", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    show(at(7));
    await screen.findByText("Row 7");
    await userEvent.click(screen.getByRole("button", { name: "Download CSV for Hall" }));
    expect(vi.mocked(downloadCsv).mock.calls[0]).toEqual(["/api/widget-data/csv", { method: "POST", body: { type: "table", config: FOLLOWS, range: "this_month", focus: 7 } }]);
    await userEvent.click(screen.getByRole("button", { name: "Details for Hall" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Download CSV" }));
    expect(vi.mocked(downloadCsv).mock.calls[1]).toEqual(["/api/widget-data/csv", { method: "POST", body: { type: "table", config: FOLLOWS, range: "this_month", focus: 7 } }]);
  });

  it("the CSV of a card with no focus, or with its own assets, has no focus key either", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    const view = show(at(null));
    await screen.findByText("Row site");
    await userEvent.click(screen.getByRole("button", { name: "Download CSV for Hall" }));
    view.again(at(7), { config: FIXED });
    await userEvent.click(screen.getByRole("button", { name: "Download CSV for Hall" }));
    for (const [, init] of vi.mocked(downloadCsv).mock.calls) expect(Object.keys((init as { body: object }).body)).toEqual(["type", "config", "range"]);
  });

  it("closes the Details panel when the focus changes, and leaves a card with its own assets alone", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    const view = show(at(7));
    await screen.findByText("Row 7");
    await userEvent.click(screen.getByRole("button", { name: "Details for Hall" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    view.again(at(9));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    view.unmount();
    client.clear();
    const fixed = show(at(null), { config: FIXED });
    await screen.findByText("Row site");
    await userEvent.click(screen.getByRole("button", { name: "Details for Hall" }));
    fixed.again(at(9), { config: FIXED });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("WidgetView with a focus: dimming", () => {
  it("keeps the previous figures but dims them and says busy while the answer for a new focus loads", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    const view = show(at(7));
    await screen.findByText("Row 7");
    expect(bodyOfCard()).not.toHaveAttribute("aria-busy");
    expect(bodyOfCard()).not.toHaveClass("follow-stale");
    const gate = holdFetch(everything);
    view.again(at(9));
    expect(screen.getByText("Row 7")).toBeInTheDocument(); // the old figures stay, never a skeleton
    expect(bodyOfCard()).toHaveAttribute("aria-busy", "true");
    expect(bodyOfCard()).toHaveClass("follow-stale");
    gate.release();
    await screen.findByText("Row 9");
    expect(bodyOfCard()).not.toHaveAttribute("aria-busy");
    expect(bodyOfCard()).not.toHaveClass("follow-stale");
  });

  it("does not dim a focus seen earlier: it comes from the cache as a real answer", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    const view = show(at(7));
    await screen.findByText("Row 7");
    view.again(at(9));
    await screen.findByText("Row 9");
    const gate = holdFetch(everything); // even a background read of 7 does not dim what 7 already has
    view.again(at(7));
    expect(screen.getByText("Row 7")).toBeInTheDocument();
    expect(bodyOfCard()).not.toHaveAttribute("aria-busy");
    expect(bodyOfCard()).not.toHaveClass("follow-stale");
    gate.release();
    await waitFor(() => expect(bodyOfCard()).not.toHaveAttribute("aria-busy"));
  });

  it("dims when the focus goes away too (the old figures belong to the old trail)", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    const view = show(at(7));
    await screen.findByText("Row 7");
    const gate = holdFetch(everything);
    view.again(at(null));
    expect(screen.getByText("Row 7")).toBeInTheDocument();
    expect(bodyOfCard()).toHaveAttribute("aria-busy", "true");
    gate.release();
    await screen.findByText("Row site");
    expect(bodyOfCard()).not.toHaveAttribute("aria-busy");
  });

  it("does not dim a change of range: that placeholder is the one it always was (the focus is the same)", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    const view = show(at(7), { dashboardRange: "7d" as RangePreset, config: { ...FOLLOWS, range: null } });
    await screen.findByText("Row 7");
    const gate = holdFetch(everything);
    view.again(at(7), { dashboardRange: "30d" as RangePreset, config: { ...FOLLOWS, range: null } });
    expect(screen.getByText("Row 7")).toBeInTheDocument();
    expect(bodyOfCard()).not.toHaveAttribute("aria-busy");
    expect(bodyOfCard()).not.toHaveClass("follow-stale");
    gate.release();
  });

  it("dims a change of focus and of range together, since the old figures are for another focus", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    const view = show(at(7), { dashboardRange: "7d" as RangePreset, config: { ...FOLLOWS, range: null } });
    await screen.findByText("Row 7");
    const gate = holdFetch(everything);
    view.again(at(9), { dashboardRange: "30d" as RangePreset, config: { ...FOLLOWS, range: null } });
    expect(bodyOfCard()).toHaveAttribute("aria-busy", "true");
    gate.release();
    await screen.findByText("Row 9");
  });

  it("does not dim the breakdown's Split by either: the pick keeps the old bars undimmed until the new ones land (the focus is the same)", async () => {
    const lookUnder = config({ assets: [], source: "energy", metric: null, aggregation: "sum", bars: "kind", kind: "Rack", range: "this_month", scope: "focus" });
    mockFetch({
      "POST /api/widget-data": ({ body }) => {
        const { config: asked, focus } = body as { config: { kind: string }; focus: number };
        return { body: breakdownData(1, { values: [valueRow({ asset_id: 10, name: `${asked.kind} A`, value: 7, point_id: null })], breakdown: breakdownBlock({ kind: asked.kind }), focus: block(focus) }) };
      },
    });
    show(at(7), { type: "bar", config: lookUnder });
    expect(await screen.findByTestId("chart")).toHaveTextContent("Rack A");
    const gate = holdFetch(everything);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Split by" }), "Panel");
    expect(screen.getByTestId("chart")).toHaveTextContent("Rack A"); // the previous answer, kept
    expect(bodyOfCard()).not.toHaveAttribute("aria-busy");
    expect(bodyOfCard()).not.toHaveClass("follow-stale");
    gate.release();
    await waitFor(() => expect(screen.getByTestId("chart")).toHaveTextContent("Panel A"));
    expect(bodyOfCard()).not.toHaveAttribute("aria-busy");
  });

  it("does not open the Details panel on the previous focus's figures while the new answer loads, and opens it on the new ones once it lands", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    const view = show(at(7));
    await screen.findByText("Row 7");
    const gate = holdFetch(everything);
    view.again(at(9));
    const button = screen.getByRole("button", { name: "Details for Hall" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    await userEvent.click(button);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    gate.release();
    await screen.findByText("Row 9");
    expect(screen.getByRole("button", { name: "Details for Hall" })).not.toHaveAttribute("aria-disabled");
    await userEvent.click(screen.getByRole("button", { name: "Details for Hall" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText("Row 9").length).toBeGreaterThan(0);
    expect(within(dialog).queryByText("Row 7")).not.toBeInTheDocument();
  });

  it("never dims a card with its own assets, whatever else changes", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    const view = show(at(7), { config: { ...FIXED, range: null }, dashboardRange: "7d" as RangePreset });
    await screen.findByText("Row site");
    const gate = holdFetch(everything);
    view.again(at(9), { config: { ...FIXED, range: null }, dashboardRange: "30d" as RangePreset });
    expect(screen.getByText("Row site")).toBeInTheDocument();
    expect(bodyOfCard()).not.toHaveAttribute("aria-busy");
    expect(bodyOfCard()).not.toHaveClass("follow-stale");
    gate.release();
  });

  it("dims the footer line with the body, since its sentence names the old focus", async () => {
    mockFetch({ "POST /api/widget-data": ({ body }) => ({ body: answerFor((body as { focus: number }).focus, { focus: block((body as { focus: number }).focus, { children: { shown: 20, count: 34 } }) }) }) });
    const view = show(at(7), { config: CHILDREN });
    await screen.findByText("20 of 34 children of Hall 7 shown");
    expect(footOfCard()).not.toHaveClass("follow-stale");
    const gate = holdFetch(everything);
    view.again(at(9), { config: CHILDREN });
    expect(screen.getByText("20 of 34 children of Hall 7 shown")).toBeInTheDocument();
    expect(footOfCard()).toHaveClass("follow-stale");
    gate.release();
    await screen.findByText("20 of 34 children of Hall 9 shown");
    expect(footOfCard()).not.toHaveClass("follow-stale");
  });
});

describe("WidgetView with a focus: the sentences", () => {
  const choose = (top_level: number | null) => ({ body: answerFor(undefined, { values: [], focus: { asset: null, state: "choose", children: null, top_level } }) });
  const noButton = () => expect(screen.queryByRole("button", { name: "Details for Hall" })).not.toBeInTheDocument();

  it("asks for a focus when the site has several top-level assets, and draws no table (and no Details button)", async () => {
    mockFetch({ "POST /api/widget-data": choose(3) });
    show(at(null));
    expect(await screen.findByText("This site has 3 top-level assets: choose a focus to see this figure.")).toHaveClass("widget-empty");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("No data in this range.")).not.toBeInTheDocument();
    noButton();
  });

  it("says a role that cannot choose a focus cannot", async () => {
    mockFetch({ "POST /api/widget-data": choose(3) });
    show(ctxOf({ allowed: false }));
    expect(await screen.findByText("This site has 3 top-level assets, so this figure needs a focus asset, and your role cannot choose one.")).toBeInTheDocument();
  });

  it("says the site is empty for no top-level asset", async () => {
    mockFetch({ "POST /api/widget-data": choose(0) });
    show(at(null));
    expect(await screen.findByText("This site has no assets yet.")).toBeInTheDocument();
  });

  it("says a focus asset with no children has none, by its path, and the same card still shows other assets' children normally", async () => {
    mockFetch({ "POST /api/widget-data": { body: answerFor(undefined, { values: [], focus: block(8, { asset: { id: 8, name: "Feed A", path: "Site / Rack 05 / Feed A" }, children: { shown: 0, count: 0 } }) }) } });
    show(at(8), { config: CHILDREN });
    expect(await screen.findByText("Site / Rack 05 / Feed A has no children.")).toHaveClass("widget-empty");
    expect(screen.queryByText("No data in this range.")).not.toBeInTheDocument();
    noButton();
  });

  it("says an empty site has no assets for a children card with no focus asset", async () => {
    mockFetch({ "POST /api/widget-data": { body: answerFor(undefined, { values: [], focus: { asset: null, state: "ok", children: { shown: 0, count: 0 }, top_level: 0 } }) } });
    show(at(null), { config: CHILDREN });
    expect(await screen.findByText("This site has no assets yet.")).toBeInTheDocument();
  });

  it("draws nothing for a focus that is gone: no body, no sentence, no 'removed' chip, no Details button", async () => {
    mockFetch({ "POST /api/widget-data": { body: answerFor(undefined, { values: [], missing: [7], focus: { asset: null, state: "gone", children: null, top_level: null } }) } });
    show(at(7));
    await waitFor(() => expect(reportGone).toHaveBeenCalled());
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/removed/)).not.toBeInTheDocument();
    expect(document.querySelector(".widget-empty")).toBeNull();
    expect(document.querySelector(".chip")).toBeNull();
    noButton();
  });

  it("does not say 'choose a focus' once a focus is picked: the dimmed body is empty until the real answer lands", async () => {
    mockFetch({ "POST /api/widget-data": (req) => ((req.body as { focus?: number }).focus === undefined ? choose(3) : byFocus(req)) });
    const view = show(at(null));
    await screen.findByText("This site has 3 top-level assets: choose a focus to see this figure.");
    const gate = holdFetch(everything);
    view.again(at(1));
    expect(screen.queryByText(/choose a focus/)).not.toBeInTheDocument();
    expect(bodyOfCard()).toBeEmptyDOMElement();
    expect(bodyOfCard()).toHaveClass("follow-stale");
    expect(bodyOfCard()).toHaveAttribute("aria-busy", "true");
    noButton();
    gate.release();
    await screen.findByText("Row 1");
    expect(bodyOfCard()).not.toHaveClass("follow-stale");
    expect(screen.getByRole("button", { name: "Details for Hall" })).toBeInTheDocument();
  });

  it("does not say the asset it just left has no children while the answer for the next one loads", async () => {
    const leaf = { body: answerFor(undefined, { values: [], focus: block(8, { asset: { id: 8, name: "Feed A", path: "Site / Rack 05 / Feed A" }, children: { shown: 0, count: 0 } }) }) };
    mockFetch({ "POST /api/widget-data": (req) => ((req.body as { focus?: number }).focus === 8 ? leaf : byFocus(req)) });
    const view = show(at(8), { config: CHILDREN });
    await screen.findByText("Site / Rack 05 / Feed A has no children.");
    const gate = holdFetch(everything);
    view.again(at(5), { config: CHILDREN });
    expect(screen.queryByText(/has no children/)).not.toBeInTheDocument();
    expect(bodyOfCard()).toBeEmptyDOMElement();
    expect(bodyOfCard()).toHaveClass("follow-stale");
    gate.release();
    await screen.findByText("Row 5");
    expect(screen.queryByText(/has no children/)).not.toBeInTheDocument();
  });

  it("does not say 'No Panels under <the asset it just left>' while the breakdown of the next focus loads: an empty dimmed body until the real answer lands (W9)", async () => {
    const lookUnder = config({ assets: [], source: "energy", metric: null, aggregation: "sum", bars: "kind", kind: "Panel", range: "this_month", scope: "focus" });
    mockFetch({
      "POST /api/widget-data": ({ body }) => {
        const { focus } = body as { focus: number };
        const root = { id: focus, name: `Hall ${focus}` };
        return {
          body: focus === 7
            ? breakdownData(0, { values: [], breakdown: breakdownBlock({ kind: "Panel", root, count: 0, shown: 0, kinds: [{ kind: "Rack", count: 4 }] }), focus: block(7) })
            : breakdownData(1, { values: [valueRow({ asset_id: 10, name: "Panel A", value: 7, point_id: null })], breakdown: breakdownBlock({ kind: "Panel", root }), focus: block(focus) }),
        };
      },
    });
    const view = show(at(7), { type: "bar", config: lookUnder });
    expect(await screen.findByText(/No Panels under Hall 7/)).toBeInTheDocument();
    const gate = holdFetch(everything);
    view.again(at(9), { type: "bar", config: lookUnder });
    expect(screen.queryByText(/No Panels/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Split by/)).not.toBeInTheDocument();
    expect(bodyOfCard()).toBeEmptyDOMElement();
    expect(bodyOfCard()).toHaveClass("follow-stale");
    expect(bodyOfCard()).toHaveAttribute("aria-busy", "true");
    gate.release();
    expect(await screen.findByTestId("chart")).toHaveTextContent("Panel A");
    expect(bodyOfCard()).not.toHaveClass("follow-stale");
  });

  it("keeps the previous figures, dimmed, when the previous answer had some (no sentence takes their place)", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    const view = show(at(7), { config: CHILDREN });
    await screen.findByText("Row 7");
    const gate = holdFetch(everything);
    view.again(at(null), { config: CHILDREN });
    expect(screen.getByText("Row 7")).toBeInTheDocument();
    expect(bodyOfCard()).toHaveClass("follow-stale");
    expect(document.querySelector(".widget-empty")).toBeNull();
    gate.release();
    await screen.findByText("Row site");
  });

  it("draws the figures of an ordinary answer, with the Details button", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    show(at(7), { config: CHILDREN });
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Details for Hall" })).toBeInTheDocument();
    expect(document.querySelector(".widget-empty")).toBeNull();
  });
});

describe("WidgetView with a focus: the footer line", () => {
  it("says on a card with its own assets that they are not the focus asset's (R11), after the 'since' line", async () => {
    const energy = answerFor(undefined, { range: { preset: "1h", start: "2026-10-08T10:00:00+03:00", end: "2026-10-08T10:30:00+03:00" } });
    mockFetch({ "POST /api/widget-data": { body: energy } });
    show(at(1), { config: { ...FIXED, source: "energy", metric: null, aggregation: "sum" }, dashboardRange: "1h" });
    const note = await screen.findByText("Its own assets, not Hall 1");
    expect(note).toHaveClass("follow-note");
    expect(note.parentElement).toHaveClass("widget-foot");
    expect(note.parentElement).toHaveTextContent("since 10:00 · Its own assets, not Hall 1");
  });

  it("says nothing until the focus asset's name is known, but keeps the line's room (an empty line), and has none with no focus", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    const view = show(ctxOf({ focus: 7, name: null }), { config: FIXED });
    await screen.findByText("Row site");
    expect(footOfCard()).toHaveAttribute("aria-hidden", "true");
    expect(footOfCard()?.textContent).toBe("");
    expect(screen.queryByText(/Its own assets/)).not.toBeInTheDocument();
    view.again(at(null), { config: FIXED });
    expect(footOfCard()).toBeNull();
    view.again(at(7), { config: FIXED });
    expect(await screen.findByText("Its own assets, not Hall 7")).toBeInTheDocument();
  });

  it("reserves the line while the card loads, so the card does not move when the answer lands", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    const gate = holdFetch(everything);
    show(at(7), { config: FIXED });
    expect(footOfCard()).toHaveAttribute("aria-hidden", "true");
    gate.release();
    expect(await screen.findByText("Its own assets, not Hall 7")).toBeInTheDocument();
  });

  it("reserves the line on the focus, not on the name: with the asset list still loading, both the loading card and the loaded one hold the room, and the note fills the same line", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    const gate = holdFetch(everything);
    const view = show(ctxOf({ focus: 7, name: null }), { config: FIXED });
    expect(footOfCard()).toHaveAttribute("aria-hidden", "true"); // the skeleton's line
    gate.release();
    await screen.findByText("Row site");
    const reserved = footOfCard();
    expect(reserved).toHaveAttribute("aria-hidden", "true"); // the loaded card's empty line, before the name arrives
    view.again(at(7), { config: FIXED });
    expect(await screen.findByText("Its own assets, not Hall 7")).toBeInTheDocument();
    expect(footOfCard()).toBe(reserved);
    expect(footOfCard()).not.toHaveAttribute("aria-hidden");
  });

  it("holds the line of a card that shows the children of the focus whether or not it has a count to say: Hall 1 (a note) to Row 2 (none) and the skeleton", async () => {
    const children = { 1: { shown: 20, count: 34 }, 2: { shown: 5, count: 5 } } as const;
    mockFetch({ "POST /api/widget-data": ({ body }) => { const id = (body as { focus: 1 | 2 }).focus; return { body: answerFor(id, { focus: block(id, { children: children[id] }) }) }; } });
    const view = show(at(1), { config: CHILDREN });
    await screen.findByText("20 of 34 children of Hall 1 shown");
    view.again(at(2), { config: CHILDREN });
    await screen.findByText("Row 2");
    expect(footOfCard()).toHaveAttribute("aria-hidden", "true"); // no note for Row 2, and the line is still there
    expect(footOfCard()?.textContent).toBe("");
    view.unmount();
    client.clear();
    const loading = holdFetch(everything);
    show(at(1), { config: CHILDREN });
    expect(footOfCard()).toHaveAttribute("aria-hidden", "true"); // the skeleton holds it too
    loading.release();
    await screen.findByText("20 of 34 children of Hall 1 shown");
  });

  it("does not say it on a card that follows the focus", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    show(at(7));
    await screen.findByText("Row 7");
    expect(screen.queryByText(/Its own assets/)).not.toBeInTheDocument();
  });

  it("does not say it on a card whose own assets are exactly the focus asset (W4), and then says it when the focus moves on, in the line it already holds", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    const view = show(at(7), { config: config({ ...FIXED, assets: [7] }) });
    await screen.findByText("Row site");
    expect(screen.queryByText(/Its own assets/)).not.toBeInTheDocument();
    const reserved = footOfCard();
    expect(reserved).toHaveAttribute("aria-hidden", "true"); // the line is held: the body must not move when the focus leaves
    view.again(at(9), { config: config({ ...FIXED, assets: [7] }) });
    expect(await screen.findByText("Its own assets, not Hall 9")).toBeInTheDocument();
    expect(footOfCard()).toBe(reserved);
  });

  it("still says it when the focus asset is only one of several, or the card has another asset (W4)", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    show(at(7), { config: config({ ...FIXED, assets: [7, 8] }) });
    expect(await screen.findByText("Its own assets, not Hall 7")).toBeInTheDocument();
    cleanup();
    show(at(7), { config: config({ ...FIXED, assets: [8] }) });
    expect(await screen.findByText("Its own assets, not Hall 7")).toBeInTheDocument();
  });

  it("leaves it out of a fixed breakdown whose root is the focus asset, and keeps it for another root or the whole site (W4)", async () => {
    mockFetch({ "POST /api/widget-data": ({ body }) => ({ body: breakdownData(1, { values: [valueRow({ asset_id: 10, name: "Rack A", value: 7, point_id: null })], breakdown: breakdownBlock({ kind: "Rack" }), focus: (body as { focus?: number }).focus === undefined ? null : block(7) }) }) });
    const under = (root: number | null) => config({ assets: [], source: "energy", metric: null, aggregation: "sum", bars: "kind", kind: "Rack", range: "this_month", root });
    show(at(7), { type: "bar", config: under(7) });
    await screen.findByTestId("chart");
    expect(screen.queryByText(/Its own assets/)).not.toBeInTheDocument();
    cleanup();
    show(at(7), { type: "bar", config: under(8) });
    expect(await screen.findByText("Its own assets, not Hall 7")).toBeInTheDocument();
    cleanup();
    show(at(7), { type: "bar", config: under(null) });
    expect(await screen.findByText("Its own assets, not Hall 7")).toBeInTheDocument();
  });

  it("counts the children shown when a card cannot show them all (R6), by the focus asset's name", async () => {
    mockFetch({ "POST /api/widget-data": { body: answerFor(undefined, { focus: block(1, { children: { shown: 20, count: 34 } }) }) } });
    show(at(1), { config: CHILDREN });
    const note = await screen.findByText("20 of 34 children of Hall 1 shown");
    expect(note.parentElement).toHaveClass("widget-foot");
  });

  it("counts the top-level assets when there is no focus asset", async () => {
    mockFetch({ "POST /api/widget-data": { body: answerFor(undefined, { focus: { asset: null, state: "ok", children: { shown: 20, count: 34 }, top_level: 34 } }) } });
    show(at(null), { config: CHILDREN });
    expect(await screen.findByText("20 of 34 top-level assets shown")).toBeInTheDocument();
  });

  it("says nothing when all the children are shown (the line stays, empty)", async () => {
    mockFetch({ "POST /api/widget-data": { body: answerFor(undefined, { focus: block(1, { children: { shown: 5, count: 5 } }) }) } });
    show(at(1), { config: CHILDREN });
    await screen.findByRole("table");
    expect(footOfCard()).toHaveAttribute("aria-hidden", "true");
    expect(footOfCard()?.textContent).toBe("");
  });

  it("holds no line for a card that follows the focus itself (scope focus) when it has nothing to say", async () => {
    mockFetch({ "POST /api/widget-data": byFocus });
    show(at(7));
    await screen.findByText("Row 7");
    expect(footOfCard()).toBeNull();
  });
});

describe("WidgetView with a focus: a focus that is gone", () => {
  const gone = { body: answerFor(undefined, { values: [], missing: [7], focus: { asset: null, state: "gone", children: null, top_level: null } }) };

  it("tells the page once, with the focus it asked about, however often it draws again", async () => {
    mockFetch({ "POST /api/widget-data": gone });
    const view = show(at(7));
    await waitFor(() => expect(reportGone).toHaveBeenCalledTimes(1));
    view.again(ctxOf({ focus: 7, name: "Hall 7" }));
    view.again(ctxOf({ focus: 7, name: "Hall 7", notice: "x" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reportGone).toHaveBeenCalledTimes(1);
    expect(reportGone).toHaveBeenCalledWith(7);
  });

  it("does not tell the page from a placeholder: only the real answer for the new focus counts", async () => {
    mockFetch({ "POST /api/widget-data": ({ body }) => ((body as { focus?: number }).focus === 9 ? gone : byFocus({ url: "", body })) });
    const view = show(at(7));
    await screen.findByText("Row 7");
    const gate = holdFetch(everything);
    view.again(at(9));
    expect(reportGone).not.toHaveBeenCalled();
    gate.release();
    await waitFor(() => expect(reportGone).toHaveBeenCalledWith(9));
    expect(reportGone).toHaveBeenCalledTimes(1);
  });

  it("tells the page again when the same gone focus comes back later (a link opened twice)", async () => {
    mockFetch({ "POST /api/widget-data": ({ body }) => ((body as { focus?: number }).focus === 7 ? gone : byFocus({ url: "", body })) });
    const view = show(at(7));
    await waitFor(() => expect(reportGone).toHaveBeenCalledTimes(1));
    view.again(at(null));
    await screen.findByText("Row site");
    view.again(at(7));
    await waitFor(() => expect(reportGone).toHaveBeenCalledTimes(2));
  });

  it("is not the business of a card with its own assets", async () => {
    mockFetch({ "POST /api/widget-data": gone });
    show(at(7), { config: FIXED });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(reportGone).not.toHaveBeenCalled();
  });
});
