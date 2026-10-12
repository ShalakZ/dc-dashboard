import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ReactNode } from "react";
import { Link, MemoryRouter } from "react-router";
import { createProgress, FADE_MS, FINISH_MS, MIN_SWEEP_MS, SETTLE_MS, SHOW_DELAY_MS } from "../lib/progress";
import { manualTimers } from "../test/manualTimers";
import { TopProgress } from "./TopProgress";

/** A promise the test settles by hand. */
function deferred<T = string>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup(children?: ReactNode, { strict = false } = {}) {
  const clock = manualTimers();
  const store = createProgress(clock.timers);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const tree = (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/a"]}>
        <TopProgress store={store} />
        <Link to="/a">to a</Link>
        <Link to="/b">to b</Link>
        <Link to="/a?x=1">same page</Link>
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  const phase = () => document.querySelector(".top-progress")?.getAttribute("data-phase");
  const tick = (ms: number) => act(() => clock.advance(ms));
  return { clock, store, client, phase, tick, ...view };
}

describe("TopProgress: loads", () => {
  it("shows an initial load after the delay and finishes when it resolves", async () => {
    const reply = deferred();
    function Probe() {
      useQuery({ queryKey: ["probe"], queryFn: () => reply.promise });
      return null;
    }
    const { store, phase, tick } = setup(<Probe />);
    await waitFor(() => expect(store.getCount("fetching")).toBe(1));
    await tick(SHOW_DELAY_MS - 1);
    expect(phase()).toBe("idle");
    await tick(1);
    expect(phase()).toBe("run");
    await act(async () => reply.resolve("done"));
    await waitFor(() => expect(store.getCount("fetching")).toBe(0));
    await tick(SETTLE_MS);
    expect(phase()).toBe("finish");
    await tick(FINISH_MS);
    expect(phase()).toBe("fade");
    await tick(FADE_MS);
    expect(phase()).toBe("idle");
  });

  it("never shows a query that has data and refetches by itself (polling)", async () => {
    let calls = 0;
    function Probe() {
      useQuery({
        queryKey: ["poll"],
        queryFn: async () => { calls += 1; await new Promise((done) => setTimeout(done, 30)); return calls; }, // in flight for a visible while
        initialData: 0,
        refetchInterval: 60,
      });
      return null;
    }
    const { clock, store, phase } = setup(<Probe />);
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(3), { timeout: 3000 });
    await act(async () => {}); // let the last notification land
    expect(phase()).toBe("idle");
    expect(clock.scheduled, "no timer was ever armed").toBe(0);
    expect(store.getCount("fetching")).toBe(0);
  });

  it("does not show a refetch of a query that already has data", async () => {
    const reply = deferred();
    const { client, clock, phase } = setup();
    client.setQueryData(["warm"], "old");
    let refetch!: Promise<unknown>;
    act(() => { refetch = client.fetchQuery({ queryKey: ["warm"], queryFn: () => reply.promise, staleTime: 0 }); });
    await waitFor(() => expect(client.isFetching()).toBe(1));
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); }); // long enough for the bar to have heard of it
    expect(phase()).toBe("idle");
    await act(async () => { reply.resolve("new"); await refetch; });
    expect(clock.scheduled).toBe(0);
  });

  it("ends the busy state when a query fails", async () => {
    const reply = deferred();
    function Probe() {
      useQuery({ queryKey: ["bad"], queryFn: () => reply.promise });
      return null;
    }
    const { store, phase, tick } = setup(<Probe />);
    await waitFor(() => expect(store.getCount("fetching")).toBe(1));
    await tick(SHOW_DELAY_MS);
    expect(phase()).toBe("run");
    await act(async () => reply.reject(new Error("boom")));
    await waitFor(() => expect(store.getCount("fetching")).toBe(0));
    await tick(SETTLE_MS);
    expect(phase()).toBe("finish");
  });

  it("shows a running mutation", async () => {
    const reply = deferred();
    function Probe() {
      const save = useMutation({ mutationFn: () => reply.promise });
      return <button onClick={() => save.mutate()}>save</button>;
    }
    const { store, phase, tick } = setup(<Probe />);
    await userEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(store.getCount("mutating")).toBe(1));
    await tick(SHOW_DELAY_MS);
    expect(phase()).toBe("run");
    await act(async () => reply.resolve("saved"));
    await waitFor(() => expect(store.getCount("mutating")).toBe(0));
    await tick(SETTLE_MS);
    expect(phase()).toBe("finish");
  });

  it("counts two overlapping loads and finishes after the last", async () => {
    const first = deferred();
    const second = deferred();
    function Probe() {
      useQuery({ queryKey: ["one"], queryFn: () => first.promise });
      useQuery({ queryKey: ["two"], queryFn: () => second.promise });
      return null;
    }
    const { store, phase, tick } = setup(<Probe />);
    await waitFor(() => expect(store.getCount("fetching")).toBe(2));
    await tick(SHOW_DELAY_MS);
    await act(async () => first.resolve("a"));
    await waitFor(() => expect(store.getCount("fetching")).toBe(1));
    await tick(1000);
    expect(phase()).toBe("run");
    await act(async () => second.resolve("b"));
    await waitFor(() => expect(store.getCount("fetching")).toBe(0));
    await tick(SETTLE_MS);
    expect(phase()).toBe("finish");
  });

  it("takes its counts back when it unmounts", async () => {
    const reply = deferred();
    function Probe() {
      useQuery({ queryKey: ["gone"], queryFn: () => reply.promise });
      return null;
    }
    const { clock, store, unmount } = setup(<Probe />);
    await waitFor(() => expect(store.getCount("fetching")).toBe(1));
    unmount();
    expect(store.getCount("fetching")).toBe(0);
    expect(store.getCount("mutating")).toBe(0);
    expect(clock.count).toBe(0);
    expect(store.getPhase()).toBe("idle");
  });
});

describe("TopProgress: navigation", () => {
  it("shows run on a path change and holds it for the minimum sweep", async () => {
    const { phase, tick } = setup();
    expect(phase()).toBe("idle");
    await userEvent.click(screen.getByRole("link", { name: "to b" }));
    expect(phase()).toBe("run");
    await tick(MIN_SWEEP_MS - 1);
    expect(phase()).toBe("run");
    await tick(1 + SETTLE_MS);
    expect(phase()).toBe("finish");
  });

  it("does not show for a change of the search parameters only", async () => {
    const { clock, phase } = setup();
    await userEvent.click(screen.getByRole("link", { name: "same page" }));
    expect(phase()).toBe("idle");
    expect(clock.scheduled).toBe(0);
  });

  it("does not pulse when StrictMode mounts it twice", async () => {
    const { clock, phase, store } = setup(undefined, { strict: true });
    expect(phase()).toBe("idle");
    expect(clock.scheduled).toBe(0);
    await userEvent.click(screen.getByRole("link", { name: "to b" }));
    expect(phase()).toBe("run");
    expect(store.getPhase()).toBe("run");
  });

  it("starts again from zero when a page change comes during the finish", async () => {
    const { store, phase, tick } = setup();
    await userEvent.click(screen.getByRole("link", { name: "to b" }));
    await tick(MIN_SWEEP_MS + SETTLE_MS);
    expect(phase()).toBe("finish");
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getPhase()));
    await userEvent.click(screen.getByRole("link", { name: "to a" }));
    expect(seen).toEqual(["reset", "run"]); // the layout effect advanced it after flushing the reset style
    expect(phase()).toBe("run");
    await tick(MIN_SWEEP_MS + SETTLE_MS);
    expect(phase()).toBe("finish");
  });
});

describe("TopProgress: the element", () => {
  it("is hidden from assistive technology and has no role", () => {
    setup();
    const bar = document.querySelector(".top-progress");
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(bar).not.toHaveAttribute("role");
    expect(bar?.textContent).toBe("");
    expect(bar?.querySelector(":scope > span")).not.toBeNull();
  });

  it("in StrictMode a load still shows and nothing is left running after unmount", async () => {
    const reply = deferred();
    function Probe() {
      useQuery({ queryKey: ["strict"], queryFn: () => reply.promise });
      return null;
    }
    const { clock, store, phase, tick, unmount } = setup(<Probe />, { strict: true });
    await waitFor(() => expect(store.getCount("fetching")).toBe(1));
    await tick(SHOW_DELAY_MS);
    expect(phase()).toBe("run");
    unmount();
    expect(clock.count).toBe(0);
    expect(store.getPhase()).toBe("idle");
  });
});
