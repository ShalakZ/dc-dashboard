import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useValueTip, VALUE_DWELL_MS, type ValueTip } from "../../hooks/useValueTip";
import type { MappingLatest } from "../../hooks/useMappingLatest";
import { holdFetch } from "../../test/holdFetch";
import { mockFetch, type Routes } from "../../test/fetchMock";
import { manualTimers } from "../../test/manualTimers";
import { PointValueTip } from "./PointValueTip";

afterEach(() => vi.useRealTimers());

const latest = (over: Partial<MappingLatest> = {}): MappingLatest => ({
  mapping_id: 7, value: 12.4, unit: "kW", ts: "2026-10-17T10:00:00Z", quality: 0, age_seconds: 3, stale: false, ...over,
});
const route = (id: number, body: MappingLatest): Routes => ({ [`GET /api/mappings/${id}/latest`]: { body } });
const READ = "/api/mappings/7/latest";
const reads = (calls: { path: string }[]) => calls.filter((c) => c.path.endsWith("/latest")).map((c) => c.path);
const RF_DESCRIPTION = "react-flow__node-desc-1";

function Harness({ canView = true, timers, capture, dismissed }: { canView?: boolean; timers: ReturnType<typeof manualTimers>["timers"]; capture: (tip: ValueTip) => void; dismissed?: () => void }) {
  const tip = useValueTip(timers);
  capture(tip);
  return (
    <>
      <div className="react-flow__node" data-id="p:1" aria-describedby={RF_DESCRIPTION}><button type="button">Point one</button></div>
      <div className="react-flow__node" data-id="p:2"><button type="button">Point two</button></div>
      <PointValueTip target={tip.target} canView={canView} onDismiss={() => { dismissed?.(); tip.hide(); }} />
    </>
  );
}

function setup(over: { canView?: boolean; dismissed?: () => void } = {}) {
  const clock = manualTimers();
  let current!: ValueTip;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (canView: boolean) => (
    <QueryClientProvider client={client}>
      <Harness canView={canView} timers={clock.timers} capture={(tip) => { current = tip; }} dismissed={over.dismissed} />
    </QueryClientProvider>
  );
  const view = render(tree(over.canView ?? true));
  const node = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
  const tip = () => current;
  const enter = (id: string, mappingId: number) => act(() => { tip().enter(id, mappingId, node(id)); });
  const leave = () => act(() => { tip().leave(); });
  const advance = (ms: number) => act(() => clock.advance(ms));
  return { ...view, clock, node, tip, enter, leave, advance, setCanView: (canView: boolean) => view.rerender(tree(canView)) };
}
const card = () => screen.queryByRole("tooltip");

describe("PointValueTip", () => {
  it("asks nothing and draws nothing before the 350 ms dwell, then shows the value and its age", async () => {
    const calls = mockFetch(route(7, latest()));
    const { enter, advance } = setup();
    enter("p:1", 7);
    advance(VALUE_DWELL_MS - 1);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(reads(calls)).toEqual([]);
    expect(card()).toBeNull();
    advance(1);
    expect(await screen.findByText("12.40 kW, 3 s ago")).toBeInTheDocument();
    expect(reads(calls)).toEqual([READ]);
    expect(card()).toHaveAttribute("role", "tooltip");
    expect(card()!.parentElement).toBe(document.body);
  });

  it("leaving before the dwell asks nothing", async () => {
    const calls = mockFetch(route(7, latest()));
    const { enter, leave, advance } = setup();
    enter("p:1", 7);
    advance(200);
    leave();
    advance(2000);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(reads(calls)).toEqual([]);
    expect(card()).toBeNull();
  });

  it("keeps counting the age while the card stays", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    mockFetch(route(7, latest({ age_seconds: 3 })));
    const { enter, advance } = setup();
    enter("p:1", 7);
    advance(VALUE_DWELL_MS);
    expect(await screen.findByText("12.40 kW, 3 s ago")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(screen.getByText("12.40 kW, 8 s ago")).toBeInTheDocument();
  });

  it("marks a stale reading with the word stale", async () => {
    mockFetch(route(7, latest({ age_seconds: 400, stale: true })));
    const { enter, advance } = setup();
    enter("p:1", 7);
    advance(VALUE_DWELL_MS);
    expect(await screen.findByText("12.40 kW, 6 min ago, stale")).toBeInTheDocument();
  });

  it("says bad reading for a quality other than 0", async () => {
    mockFetch(route(7, latest({ quality: 1 })));
    const { enter, advance } = setup();
    enter("p:1", 7);
    advance(VALUE_DWELL_MS);
    expect(await screen.findByText(/bad reading/)).toBeInTheDocument();
  });

  it("says no reading yet for a point without a row", async () => {
    mockFetch(route(7, latest({ value: null, ts: null, quality: null, age_seconds: null })));
    const { enter, advance } = setup();
    enter("p:1", 7);
    advance(VALUE_DWELL_MS);
    expect(await screen.findByText("No reading yet")).toBeInTheDocument();
  });

  it("says a failed read could not be read, and does not retry it", async () => {
    const calls = mockFetch({ [`GET ${READ}`]: { status: 500, body: { detail: "boom" } } });
    const { enter, advance } = setup();
    enter("p:1", 7);
    advance(VALUE_DWELL_MS);
    expect(await screen.findByText("Could not read the value")).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(reads(calls)).toEqual([READ]);
  });

  it("draws nothing and asks nothing when the role may not see values", async () => {
    const calls = mockFetch(route(7, latest()));
    const { enter, advance } = setup({ canView: false });
    enter("p:1", 7);
    advance(VALUE_DWELL_MS);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(card()).toBeNull();
    expect(reads(calls)).toEqual([]);
  });

  it("stops at once when the permission goes while the card is up", async () => {
    mockFetch(route(7, latest()));
    const { enter, advance, setCanView } = setup();
    enter("p:1", 7);
    advance(VALUE_DWELL_MS);
    expect(await screen.findByText("12.40 kW, 3 s ago")).toBeInTheDocument();
    setCanView(false);
    expect(card()).toBeNull();
  });

  it("shows only the new node's value when the pointer moves on while the first read is in flight", async () => {
    mockFetch({ ...route(7, latest()), ...route(8, latest({ mapping_id: 8, value: 99, unit: "A" })) });
    const slow = holdFetch((_m, path) => path === READ);
    const { enter, leave, advance } = setup();
    enter("p:1", 7);
    advance(VALUE_DWELL_MS);
    leave();
    enter("p:2", 8);
    advance(VALUE_DWELL_MS);
    expect(await screen.findByText("99.00 A, 3 s ago")).toBeInTheDocument();
    slow.release();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText("12.40 kW, 3 s ago")).toBeNull();
    expect(screen.getByText("99.00 A, 3 s ago")).toBeInTheDocument();
  });

  it("sits under the node's rectangle", async () => {
    mockFetch(route(7, latest()));
    const { enter, advance, node } = setup();
    vi.spyOn(node("p:1"), "getBoundingClientRect").mockReturnValue({ left: 100, top: 40, right: 220, bottom: 80, width: 120, height: 40, x: 100, y: 40, toJSON: () => ({}) });
    enter("p:1", 7);
    advance(VALUE_DWELL_MS);
    await screen.findByText("12.40 kW, 3 s ago");
    expect(card()).toHaveStyle({ top: "86px", left: "100px" });
  });

  it("hides on Escape, and that Escape goes no further", async () => {
    mockFetch(route(7, latest()));
    const heard = vi.fn();
    document.addEventListener("keydown", heard);
    const { enter, advance } = setup();
    enter("p:1", 7);
    advance(VALUE_DWELL_MS);
    await screen.findByText("12.40 kW, 3 s ago");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(card()).toBeNull();
    expect(heard).not.toHaveBeenCalled();
    document.removeEventListener("keydown", heard);
  });

  it("an Escape with no card up is nobody's business", () => {
    mockFetch({});
    const heard = vi.fn();
    document.addEventListener("keydown", heard);
    setup();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(heard).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", heard);
  });

  it("hides on a scroll and on a resize, and tells the caller", async () => {
    mockFetch(route(7, latest()));
    const dismissed = vi.fn();
    const { enter, advance } = setup({ dismissed });
    enter("p:1", 7);
    advance(VALUE_DWELL_MS);
    await screen.findByText("12.40 kW, 3 s ago");
    fireEvent.scroll(window);
    expect(card()).toBeNull();
    expect(dismissed).toHaveBeenCalledTimes(1);
    enter("p:2", 7);
    advance(VALUE_DWELL_MS);
    await screen.findByText("12.40 kW, 3 s ago");
    fireEvent(window, new Event("resize"));
    expect(card()).toBeNull();
  });

  it("hides when its node leaves the DOM, and tells the caller", async () => {
    mockFetch(route(7, latest()));
    const dismissed = vi.fn();
    const { enter, advance, node } = setup({ dismissed });
    // A node React Flow draws outside this harness's own tree, so the test may take it away the way a collapse does.
    const layer = document.body.appendChild(document.createElement("div"));
    layer.innerHTML = '<div class="react-flow__node" data-id="p:3"></div>';
    enter("p:3", 7);
    advance(VALUE_DWELL_MS);
    await screen.findByText("12.40 kW, 3 s ago");
    act(() => { node("p:3").remove(); });
    await waitFor(() => expect(card()).toBeNull());
    expect(dismissed).toHaveBeenCalled();
    layer.remove();
  });

  describe("aria-describedby of the node wrapper", () => {
    it("appends the card's id to React Flow's own value while shown and restores it exactly on hide", async () => {
      mockFetch(route(7, latest()));
      const { enter, advance, node, tip } = setup();
      enter("p:1", 7);
      expect(node("p:1")).toHaveAttribute("aria-describedby", RF_DESCRIPTION);
      advance(VALUE_DWELL_MS);
      await screen.findByText("12.40 kW, 3 s ago");
      const tokens = node("p:1").getAttribute("aria-describedby")!.split(" ");
      expect(tokens).toHaveLength(2);
      expect(tokens[0]).toBe(RF_DESCRIPTION);
      expect(tokens[1]).toBe(card()!.id);
      act(() => { tip().hide(); });
      expect(node("p:1")).toHaveAttribute("aria-describedby", RF_DESCRIPTION);
    });

    it("sets the card's id alone on a wrapper that had none, and removes the attribute again", async () => {
      mockFetch(route(7, latest()));
      const { enter, advance, node, tip } = setup();
      enter("p:2", 7);
      advance(VALUE_DWELL_MS);
      await screen.findByText("12.40 kW, 3 s ago");
      expect(node("p:2")).toHaveAttribute("aria-describedby", card()!.id);
      act(() => { tip().hide(); });
      expect(node("p:2")).not.toHaveAttribute("aria-describedby");
    });

    it("restores the wrapper when the whole thing unmounts", async () => {
      mockFetch(route(7, latest()));
      const { enter, advance, unmount } = setup();
      enter("p:1", 7);
      advance(VALUE_DWELL_MS);
      await screen.findByText("12.40 kW, 3 s ago");
      const wrapper = document.querySelector<HTMLElement>('[data-id="p:1"]')!;
      unmount();
      expect(wrapper.isConnected).toBe(false);
      expect(wrapper.getAttribute("aria-describedby")).toBe(RF_DESCRIPTION);
    });
  });
});
