import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState, type ReactNode } from "react";
import { useAssets } from "../../api/queries";
import type { Asset } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { FOCUS_DENIED_NOTICE, FOCUS_GONE_NOTICE } from "../../lib/focus";
import type { PermissionId } from "../../lib/permissions";
import { authed } from "../../test/dashboardFixtures";
import { mockFetch, type Routes } from "../../test/fetchMock";
import { holdFetch } from "../../test/holdFetch";
import { renderWithDataRouter } from "../../test/render";
import { userFor } from "../../test/users";
import { FocusNotice, FocusProvider, useFocus, type FocusState } from "./FocusContext";

const a = (id: number, parent_id: number | null, name: string, sort_order = 0): Asset => ({ id, parent_id, name, kind: "generic", sort_order });
/** Two top-level assets (1 and 2), and 3 under 1. */
const forest = [a(1, null, "Hall 1"), a(2, null, "Hall 2", 1), a(3, 1, "Row 1")];
/** One top-level asset (1), with 2 and 3 under it. */
const single = [a(1, null, "Site"), a(2, 1, "Hall 1"), a(3, 1, "Hall 2", 1)];

/** What the provider offers right now; the Probe below keeps it current, and the tests call its functions. */
let ctx: FocusState;
function Probe() {
  ctx = useFocus();
  return (
    <>
      <output data-testid="focus">{String(ctx.focus)}</output>
      <output data-testid="allowed">{String(ctx.allowed)}</output>
      <output data-testid="assets">{ctx.assets ? String(ctx.assets.length) : "none"}</output>
      <output data-testid="name">{String(ctx.name)}</output>
      <FocusNotice />
    </>
  );
}
/** Renders its children once the signed-in user is known, so that "no request" and "no notice" are checked after the account has loaded. */
function Known({ children }: { children: ReactNode }) {
  return useAuth().user ? <>{children}</> : null;
}

type Call = { method: string; path: string; body: unknown };
const listCalls = (calls: Call[]) => calls.filter((c) => c.path === "/api/assets");
const custom = (permissions: PermissionId[]): Routes => ({ "GET /api/me": { body: userFor("custom", { permissions }) } });

function open(entry: string, { over = {}, strict = false }: { over?: Routes; strict?: boolean } = {}) {
  const calls = mockFetch({ ...authed("viewer"), "GET /api/assets": { body: forest }, ...over });
  const page = <Known><FocusProvider><Probe /></FocusProvider></Known>;
  const view = renderWithDataRouter(strict ? <StrictMode>{page}</StrictMode> : page, { route: entry, path: "/x" });
  // Every location the router has been in (by key), to count navigations.
  const keys = new Set<string>([view.router.state.location.key]);
  view.router.subscribe((state) => keys.add(state.location.key));
  const where = () => view.router.state.location.pathname + view.router.state.location.search;
  return { calls, ...view, where, navigations: () => keys.size - 1 };
}
const text = (id: string) => screen.getByTestId(id).textContent;

describe("FocusProvider: reading the address", () => {
  it("with no parameter: no focus, no notice and no request for the asset list", async () => {
    const { calls } = open("/x");
    await screen.findByTestId("focus");
    expect(text("focus")).toBe("null");
    expect(text("allowed")).toBe("true");
    expect(text("assets")).toBe("none");
    expect(screen.queryByText(FOCUS_GONE_NOTICE)).not.toBeInTheDocument();
    expect(screen.queryByText(FOCUS_DENIED_NOTICE)).not.toBeInTheDocument();
    expect(listCalls(calls)).toHaveLength(0);
  });

  it("with a valid id and assets.view: one list request, the id is the focus, and the list and the asset's name are offered", async () => {
    const { calls, where, navigations } = open("/x?asset=3&range=7d");
    await screen.findByTestId("focus");
    expect(text("focus")).toBe("3"); // before the list is here: widgets never wait for it
    await waitFor(() => expect(text("assets")).toBe("3"));
    expect(text("name")).toBe("Row 1");
    expect(listCalls(calls)).toHaveLength(1);
    expect(where()).toBe("/x?asset=3&range=7d");
    expect(navigations()).toBe(0);
    expect(screen.queryByText(FOCUS_GONE_NOTICE)).not.toBeInTheDocument();
  });

  it("an id that is not in the list: the focus is cleared with a replace (other parameters kept) and the notice stays", async () => {
    const { where, router } = open("/x?asset=99&range=7d");
    expect(await screen.findByText(FOCUS_GONE_NOTICE)).toBeInTheDocument();
    expect(where()).toBe("/x?range=7d");
    expect(router.state.historyAction).toBe("REPLACE");
    expect(text("focus")).toBe("null");
  });

  it.each([["abc"], [""], ["0"], ["007"], ["2147483648"], ["-1"]])("an invalid parameter (%j): the same, and no list request", async (raw) => {
    const { calls, where, router } = open(`/x?asset=${raw}&range=7d`);
    expect(await screen.findByText(FOCUS_GONE_NOTICE)).toBeInTheDocument();
    expect(where()).toBe("/x?range=7d");
    expect(router.state.historyAction).toBe("REPLACE");
    expect(text("focus")).toBe("null");
    expect(listCalls(calls)).toHaveLength(0);
  });

  it("without assets.view: no list request, the denied notice, no focus, and the address is left alone", async () => {
    const { calls, where, navigations } = open("/x?asset=3", { over: custom(["dashboards.view"]) });
    expect(await screen.findByText(FOCUS_DENIED_NOTICE)).toBeInTheDocument();
    expect(text("allowed")).toBe("false");
    expect(text("focus")).toBe("null");
    expect(text("assets")).toBe("none");
    expect(screen.queryByText(FOCUS_GONE_NOTICE)).not.toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(listCalls(calls)).toHaveLength(0);
    expect(where()).toBe("/x?asset=3");
    expect(navigations()).toBe(0);
  });

  it("without assets.view, an invalid parameter gets the denied notice too, and nothing is cleared or chosen", async () => {
    const { where, navigations } = open("/x?asset=abc", { over: custom(["dashboards.view"]) });
    expect(await screen.findByText(FOCUS_DENIED_NOTICE)).toBeInTheDocument();
    act(() => { ctx.setFocus(2); ctx.reportGone(2); });
    expect(where()).toBe("/x?asset=abc");
    expect(navigations()).toBe(0);
  });

  it("without assets.view and without a parameter there is no notice", async () => {
    open("/x", { over: custom(["dashboards.view"]) });
    await screen.findByTestId("focus");
    expect(screen.queryByText(FOCUS_DENIED_NOTICE)).not.toBeInTheDocument();
  });

  it("decides nothing before the signed-in user is known", async () => {
    const calls = mockFetch({ ...authed("viewer"), "GET /api/assets": { body: forest } });
    const held = holdFetch((_method, path) => path === "/api/me");
    const { router } = renderWithDataRouter(<FocusProvider><Probe /></FocusProvider>, { route: "/x?asset=abc", path: "/x" });
    await screen.findByTestId("focus");
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(router.state.location.search).toBe("?asset=abc");
    expect(screen.queryByText(FOCUS_DENIED_NOTICE)).not.toBeInTheDocument();
    expect(screen.queryByText(FOCUS_GONE_NOTICE)).not.toBeInTheDocument();
    held.release();
    expect(await screen.findByText(FOCUS_GONE_NOTICE)).toBeInTheDocument();
    expect(router.state.location.search).toBe("");
    expect(listCalls(calls)).toHaveLength(0);
  });

  it("one top-level asset that is the focus: the parameter is removed with a replace and nothing is said (R5)", async () => {
    const { where, router } = open("/x?asset=1&range=7d", { over: { "GET /api/assets": { body: single } } });
    await waitFor(() => expect(where()).toBe("/x?range=7d"));
    expect(router.state.historyAction).toBe("REPLACE");
    expect(text("focus")).toBe("null");
    expect(screen.queryByText(FOCUS_GONE_NOTICE)).not.toBeInTheDocument();
  });

  it("one top-level asset and a focus below it: the parameter stays", async () => {
    const { where, navigations } = open("/x?asset=2", { over: { "GET /api/assets": { body: single } } });
    await waitFor(() => expect(text("assets")).toBe("3"));
    expect(where()).toBe("/x?asset=2");
    expect(text("focus")).toBe("2");
    expect(navigations()).toBe(0);
  });

  it("two top-level assets: the parameter stays, whichever of them it names", async () => {
    const { where, navigations } = open("/x?asset=1");
    await waitFor(() => expect(text("assets")).toBe("3"));
    expect(where()).toBe("/x?asset=1");
    expect(text("focus")).toBe("1");
    expect(navigations()).toBe(0);
  });

  it("under StrictMode a gone id, an invalid one and a sole top-level one each make exactly one navigation", async () => {
    for (const [entry, over, said] of [
      ["/x?asset=99", {}, true],
      ["/x?asset=abc", {}, true],
      ["/x?asset=1", { "GET /api/assets": { body: single } }, false],
    ] as const) {
      const { navigations, where, unmount } = open(entry, { over, strict: true });
      await waitFor(() => expect(where()).toBe("/x"));
      if (said) expect(await screen.findAllByText(FOCUS_GONE_NOTICE)).toHaveLength(1);
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
      expect(navigations(), entry).toBe(1);
      unmount();
    }
  });
});

describe("FocusProvider: a list that was cached before the screen mounted (F1)", () => {
  /** Loads the asset list on its own first, then mounts the provider: the provider finds a list that it did not fetch. */
  function CachedFirst() {
    const list = useAssets();
    const [loaded, setLoaded] = useState(false); // stays mounted when a later read of the list fails
    if (list.isSuccess && !loaded) setLoaded(true);
    return loaded ? <FocusProvider><Probe /></FocusProvider> : null;
  }
  const withNine = [...forest, a(9, 1, "Row 9", 1)];

  /** The first list request answers `first` at once; every later one (the provider's own read) is held back until `held.release()` and then answers `second`. */
  function openCached(first: Asset[], second: Routes[string], entry = "/x?asset=9") {
    let call = 0;
    let armed = false;
    const calls = mockFetch({
      ...authed("viewer"),
      "GET /api/assets": (req) => {
        if (call++ === 0) {
          armed = true;
          return { body: first };
        }
        return typeof second === "function" ? second(req) : second;
      },
    });
    const held = holdFetch((_method, path) => armed && path === "/api/assets");
    const view = renderWithDataRouter(<Known><CachedFirst /></Known>, { route: entry, path: "/x" });
    return { calls, held, ...view };
  }
  const pause = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  it("does not call an id gone because a stale list lacks it; the fresh read decides", async () => {
    const { held, router } = openCached(forest, { body: withNine });
    await screen.findByTestId("focus"); // mounted on the cached list, which lacks 9; its own read is held back
    await pause();
    expect(router.state.location.search).toBe("?asset=9");
    expect(text("focus")).toBe("9");
    expect(screen.queryByText(FOCUS_GONE_NOTICE)).not.toBeInTheDocument();
    held.release();
    await waitFor(() => expect(text("assets")).toBe("4"));
    expect(text("name")).toBe("Row 9");
    await pause();
    expect(router.state.location.search).toBe("?asset=9");
    expect(screen.queryByText(FOCUS_GONE_NOTICE)).not.toBeInTheDocument();
  });

  it("clears the focus when the fresh read still lacks the id", async () => {
    const { held, router } = openCached(forest, { body: forest });
    await screen.findByTestId("focus");
    held.release();
    expect(await screen.findByText(FOCUS_GONE_NOTICE)).toBeInTheDocument();
    expect(router.state.location.search).toBe("");
  });

  it("does not clear the focus on the strength of the old list when the fresh read fails", async () => {
    const { calls, held, router } = openCached(forest, { status: 500, body: { detail: "down" } });
    await screen.findByTestId("focus");
    held.release();
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    await pause();
    expect(router.state.location.search).toBe("?asset=9");
    expect(screen.queryByText(FOCUS_GONE_NOTICE)).not.toBeInTheDocument();
  });

  it("does not take a sole top-level asset for the whole site on the strength of the old list either", async () => {
    // The cached list has one root (1); the real one has two. Until the fresh read lands the parameter stays.
    const { held, router } = openCached(single, { body: forest }, "/x?asset=1");
    await screen.findByTestId("focus");
    await pause();
    expect(router.state.location.search).toBe("?asset=1");
    held.release();
    await waitFor(() => expect(text("assets")).toBe("3"));
    await pause();
    expect(router.state.location.search).toBe("?asset=1"); // the fresh list has two roots
    expect(text("focus")).toBe("1");
  });

  it("does take a sole top-level asset for the whole site once the fresh read agrees", async () => {
    const { held, router } = openCached(forest, { body: single }, "/x?asset=1");
    await screen.findByTestId("focus");
    await pause();
    expect(router.state.location.search).toBe("?asset=1");
    held.release();
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(screen.queryByText(FOCUS_GONE_NOTICE)).not.toBeInTheDocument();
  });

  it("does not take the sole top-level asset of the old list for the whole site when it is chosen: only a fresh list may say so", async () => {
    const { held, router } = openCached(single, { body: forest }, "/x?asset=2");
    await screen.findByTestId("focus");
    act(() => ctx.setFocus(1));
    await waitFor(() => expect(router.state.location.search).toBe("?asset=1")); // the cached list may be stale: the choice stands
    held.release();
    await waitFor(() => expect(text("assets")).toBe("3"));
    await pause();
    expect(router.state.location.search).toBe("?asset=1"); // the fresh list has two roots
    expect(text("focus")).toBe("1");
  });
});

describe("FocusProvider: setFocus and reportGone", () => {
  it("setFocus pushes: the address changes, other parameters stay, and Back returns to the old focus", async () => {
    const { where, router } = open("/x?asset=1&range=7d");
    await waitFor(() => expect(text("assets")).toBe("3"));
    act(() => ctx.setFocus(2));
    await waitFor(() => expect(where()).toBe("/x?asset=2&range=7d"));
    expect(router.state.historyAction).toBe("PUSH");
    expect(text("focus")).toBe("2");
    await act(async () => { await router.navigate(-1); });
    await waitFor(() => expect(where()).toBe("/x?asset=1&range=7d"));
    expect(text("focus")).toBe("1");
  });

  it("setFocus(null) pushes the address without the parameter", async () => {
    const { where, router } = open("/x?asset=1&range=7d");
    await waitFor(() => expect(text("assets")).toBe("3"));
    act(() => ctx.setFocus(null));
    await waitFor(() => expect(where()).toBe("/x?range=7d"));
    expect(router.state.historyAction).toBe("PUSH");
    expect(text("focus")).toBe("null");
    expect(screen.queryByText(FOCUS_GONE_NOTICE)).not.toBeInTheDocument();
  });

  it("setFocus sets a focus from none, and does nothing for the value it already has", async () => {
    const { where, navigations } = open("/x");
    await screen.findByTestId("focus");
    act(() => ctx.setFocus(null));
    expect(navigations()).toBe(0);
    act(() => ctx.setFocus(3));
    await waitFor(() => expect(where()).toBe("/x?asset=3"));
    act(() => { ctx.setFocus(3); ctx.setFocus(3); });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(navigations()).toBe(1);
  });

  it("a pushed entry never carries the router state (an edit request), and keeps the hash-less path", async () => {
    const { router, where } = open("/x?k=1");
    await screen.findByTestId("focus");
    await act(async () => { await router.navigate("/x?k=1", { replace: true, state: { edit: true } }); });
    act(() => ctx.setFocus(2));
    await waitFor(() => expect(where()).toBe("/x?k=1&asset=2"));
    expect(router.state.location.state).toBeNull();
  });

  it("reportGone for the current focus clears it with a replace, keeps the router state, and Back does not return to it", async () => {
    const { where, router } = open("/x?asset=1");
    await waitFor(() => expect(text("assets")).toBe("3"));
    act(() => ctx.setFocus(2));
    await waitFor(() => expect(where()).toBe("/x?asset=2"));
    await act(async () => { await router.navigate("/x?asset=2", { replace: true, state: { edit: true } }); });
    act(() => ctx.reportGone(2));
    await waitFor(() => expect(where()).toBe("/x"));
    expect(router.state.historyAction).toBe("REPLACE");
    expect(router.state.location.state).toEqual({ edit: true });
    expect(await screen.findByText(FOCUS_GONE_NOTICE)).toBeInTheDocument();
    await act(async () => { await router.navigate(-1); });
    await waitFor(() => expect(where()).toBe("/x?asset=1"));
  });

  it("reportGone for another asset does nothing", async () => {
    const { where, navigations } = open("/x?asset=1");
    await waitFor(() => expect(text("assets")).toBe("3"));
    act(() => ctx.reportGone(2));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(where()).toBe("/x?asset=1");
    expect(navigations()).toBe(0);
    expect(text("focus")).toBe("1");
    expect(screen.queryByText(FOCUS_GONE_NOTICE)).not.toBeInTheDocument();
  });

  it("a gone answer for an asset the user has already left does nothing (F2)", async () => {
    const { where, navigations } = open("/x?asset=1");
    await waitFor(() => expect(text("assets")).toBe("3"));
    // The answer for asset 1 is still on its way when the user pushes asset 2: both happen before the screen re-renders.
    act(() => { ctx.setFocus(2); ctx.reportGone(1); });
    await waitFor(() => expect(where()).toBe("/x?asset=2"));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(where()).toBe("/x?asset=2");
    expect(navigations()).toBe(1);
    expect(screen.queryByText(FOCUS_GONE_NOTICE)).not.toBeInTheDocument();
    // And after the render, still nothing for the old one.
    act(() => ctx.reportGone(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(where()).toBe("/x?asset=2");
    expect(navigations()).toBe(1);
  });

  it("three cards reporting the same gone asset make one replace and one notice (F2)", async () => {
    const { where, navigations, router } = open("/x?asset=1");
    await waitFor(() => expect(text("assets")).toBe("3"));
    act(() => { ctx.reportGone(1); ctx.reportGone(1); ctx.reportGone(1); });
    await waitFor(() => expect(where()).toBe("/x"));
    act(() => ctx.reportGone(1)); // and a late fourth, after the render
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(navigations()).toBe(1);
    expect(router.state.historyAction).toBe("REPLACE");
    expect(screen.getAllByText(FOCUS_GONE_NOTICE)).toHaveLength(1);
  });

  describe("choosing the only top-level asset (the whole site)", () => {
    /** Loads the asset list beside the provider, as the Focus dialog does: the provider's own read is off (no asset in the address) but it sees a list fetched after it mounted. */
    function Loader() {
      useAssets();
      return null;
    }
    function openWithList(entry: string, list: Asset[]) {
      const calls = mockFetch({ ...authed("viewer"), "GET /api/assets": { body: list } });
      const view = renderWithDataRouter(<Known><FocusProvider><Probe /><Loader /></FocusProvider></Known>, { route: entry, path: "/x" });
      const keys = new Set<string>([view.router.state.location.key]);
      view.router.subscribe((state) => keys.add(state.location.key));
      return { calls, ...view, where: () => view.router.state.location.pathname + view.router.state.location.search, navigations: () => keys.size - 1 };
    }

    it("is the whole site already: a fresh list that shows the id is the only root makes no navigation, so Back has no duplicate entry to land on", async () => {
      const { where, navigations, router } = openWithList("/x", single);
      await waitFor(() => expect(text("assets")).toBe("3"));
      act(() => ctx.setFocus(1));
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      expect(where()).toBe("/x");
      expect(navigations()).toBe(0);
      expect(router.state.historyAction).toBe("POP");
      expect(text("focus")).toBe("null");
    });

    it("from a focus below it goes to the address without the parameter in one push, never through ?asset=<the root>", async () => {
      const { where, navigations, router } = openWithList("/x?asset=2&range=7d", single);
      await waitFor(() => expect(text("assets")).toBe("3"));
      act(() => ctx.setFocus(1));
      await waitFor(() => expect(where()).toBe("/x?range=7d"));
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      expect(navigations()).toBe(1);
      expect(router.state.historyAction).toBe("PUSH");
      expect(text("focus")).toBe("null");
      await act(async () => { await router.navigate(-1); });
      expect(where()).toBe("/x?asset=2&range=7d");
    });

    it("still pushes a root when the site has several", async () => {
      const { where, router } = openWithList("/x", forest);
      await waitFor(() => expect(text("assets")).toBe("3"));
      act(() => ctx.setFocus(1));
      await waitFor(() => expect(where()).toBe("/x?asset=1"));
      expect(router.state.historyAction).toBe("PUSH");
    });
  });

  it("keeps setFocus and reportGone the same functions across renders", async () => {
    open("/x?asset=1");
    await waitFor(() => expect(text("assets")).toBe("3"));
    const before = ctx;
    act(() => ctx.setFocus(2));
    await waitFor(() => expect(text("focus")).toBe("2"));
    expect(ctx.setFocus).toBe(before.setFocus);
    expect(ctx.reportGone).toBe(before.reportGone);
  });
});

describe("useFocus without a provider", () => {
  it("follows nothing, says nothing and changes nothing", () => {
    render(<Probe />);
    expect(text("focus")).toBe("null");
    expect(text("allowed")).toBe("false");
    expect(text("assets")).toBe("none");
    expect(text("name")).toBe("null");
    expect(() => { ctx.setFocus(3); ctx.reportGone(3); }).not.toThrow();
    expect(ctx.notice).toBeNull();
  });
});
