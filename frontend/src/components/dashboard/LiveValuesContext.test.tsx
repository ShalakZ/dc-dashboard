import { act, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { mockFetch } from "../../test/fetchMock";
import { LiveValuesProvider, useLiveRegistration, useLiveValue } from "./LiveValuesContext";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CLOSED = 2;
  readyState = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; this.readyState = 2; }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent); }
}
const open = () => FakeEventSource.instances.filter((s) => !s.closed);
const settle = () => act(() => { vi.advanceTimersByTime(60); });

function Owner({ id, points }: { id: string; points: number[] }) {
  useLiveRegistration(id, points);
  return null;
}
function Reader({ point }: { point: number }) {
  const live = useLiveValue(point);
  return <output data-testid={`point-${point}`}>{live ? String(live.value) : "none"}</output>;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  mockFetch({});
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("LiveValuesProvider", () => {
  it("opens nothing until a widget registers, then one stream for everything registered in a burst", () => {
    const { rerender } = render(<LiveValuesProvider><Reader point={7} /></LiveValuesProvider>);
    settle();
    expect(FakeEventSource.instances).toHaveLength(0);
    // Widgets finish loading one after the other: the stream must not be opened (and re-opened) once per widget.
    rerender(<LiveValuesProvider><Reader point={7} /><Owner id="a" points={[7]} /></LiveValuesProvider>);
    act(() => { vi.advanceTimersByTime(20); });
    rerender(<LiveValuesProvider><Reader point={7} /><Owner id="a" points={[7]} /><Owner id="b" points={[8]} /></LiveValuesProvider>);
    act(() => { vi.advanceTimersByTime(20); });
    rerender(<LiveValuesProvider><Reader point={7} /><Owner id="a" points={[7]} /><Owner id="b" points={[8]} /><Owner id="c" points={[9, 7]} /></LiveValuesProvider>);
    expect(FakeEventSource.instances).toHaveLength(0);
    settle();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(open()[0].url).toBe("/api/stream");
  });

  it("filters the stream by the union of the registered points", () => {
    render(
      <LiveValuesProvider>
        <Owner id="a" points={[7]} /><Owner id="b" points={[8]} />
        <Reader point={7} /><Reader point={8} /><Reader point={9} />
      </LiveValuesProvider>,
    );
    settle();
    act(() => { open()[0].onopen?.(); });
    act(() => { open()[0].emit([[7, 1_760_000_000, 1.5, 0], [8, 1_760_000_000, 2.5, 0], [9, 1_760_000_000, 3.5, 0]]); });
    expect(screen.getByTestId("point-7")).toHaveTextContent("1.5");
    expect(screen.getByTestId("point-8")).toHaveTextContent("2.5");
    expect(screen.getByTestId("point-9")).toHaveTextContent("none"); // nobody asked for it
  });

  it("ignores what the stream said while it is not connected, and uses it again once it is", () => {
    render(<LiveValuesProvider><Owner id="a" points={[7]} /><Reader point={7} /></LiveValuesProvider>);
    settle();
    act(() => { open()[0].emit([[7, 1_760_000_000, 1.5, 0]]); });
    expect(screen.getByTestId("point-7")).toHaveTextContent("none"); // not open yet
    act(() => { open()[0].onopen?.(); });
    expect(screen.getByTestId("point-7")).toHaveTextContent("1.5");
    act(() => { open()[0].onerror?.(); });
    expect(screen.getByTestId("point-7")).toHaveTextContent("none"); // the stream dropped: fetched figures take over
    act(() => { open()[0].onopen?.(); });
    expect(screen.getByTestId("point-7")).toHaveTextContent("1.5");
  });

  it("follows owners that leave: the stream narrows, and closes when nobody is left", () => {
    const tree = (ids: Record<string, number[]>) => (
      <LiveValuesProvider>{Object.entries(ids).map(([id, points]) => <Owner key={id} id={id} points={points} />)}<Reader point={8} /></LiveValuesProvider>
    );
    const { rerender } = render(tree({ a: [7], b: [8] }));
    settle();
    act(() => { open()[0].onopen?.(); });
    rerender(tree({ a: [7] }));
    settle();
    expect(FakeEventSource.instances.map((s) => s.closed)).toEqual([true, false]); // re-opened for {7} only
    act(() => { open()[0].onopen?.(); });
    act(() => { open()[0].emit([[8, 1_760_000_000, 2.5, 0]]); });
    expect(screen.getByTestId("point-8")).toHaveTextContent("none");
    rerender(tree({}));
    settle();
    expect(open()).toHaveLength(0);
  });

  it("does nothing without a provider: nothing is live and registering is harmless", () => {
    render(<><Owner id="a" points={[7]} /><Reader point={7} /></>);
    settle();
    expect(screen.getByTestId("point-7")).toHaveTextContent("none");
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("clears its pending timer when the dashboard goes away", () => {
    const { unmount } = render(<LiveValuesProvider><Owner id="a" points={[7]} /></LiveValuesProvider>);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("still applies its registrations under StrictMode's development double mount", () => {
    render(<StrictMode><LiveValuesProvider><Owner id="a" points={[7]} /><Reader point={7} /></LiveValuesProvider></StrictMode>);
    settle();
    expect(open()).toHaveLength(1);
    act(() => { open()[0].onopen?.(); });
    act(() => { open()[0].emit([[7, 1_760_000_000, 1.5, 0]]); });
    expect(screen.getByTestId("point-7")).toHaveTextContent("1.5");
  });
});
