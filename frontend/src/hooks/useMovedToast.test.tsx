import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { UNDO_MS } from "../lib/mappingActions";
import { mockFetch, type Routes } from "../test/fetchMock";
import { moveDone, moveUndone, NEW_NAME, OLD_NAME } from "../test/moveFixtures";
import { spyToasts } from "../test/toasts";
import { useMovedToast } from "./useMovedToast";

function setup(routes: Routes = {}) {
  const toasts = spyToasts();
  const calls = mockFetch(routes);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const refreshed = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{toasts.wrap(<>{children}</>)}</QueryClientProvider>;
  const view = renderHook(() => useMovedToast(), { wrapper });
  const undoCalls = () => calls.filter((c) => c.method === "POST" && c.path === "/api/sources/moves/31/undo");
  const refreshedKeys = () => refreshed.mock.calls.map(([filter]) => (filter as { queryKey: readonly unknown[] }).queryKey[0]);
  const pressUndo = () => toasts.calls[0].options!.action!.onAction();
  return { ...view, toasts, calls, undoCalls, refreshedKeys, pressUndo };
}

describe("useMovedToast (w33): the toast after a move, with an Undo for 10 seconds", () => {
  it("says what moved and how many mappings were kept, with an Undo button that lives as long as the other Undo toasts", () => {
    const { result, toasts, undoCalls } = setup();
    result.current(moveDone(), 12);
    expect(toasts.calls).toHaveLength(1);
    expect(toasts.calls[0]).toMatchObject({
      kind: "success",
      text: `Moved "${NEW_NAME}" to 172.20.0.5:4840. 12 mappings kept.`,
      options: { durationMs: UNDO_MS, action: { label: "Undo", title: "Undo this move" } },
    });
    expect(UNDO_MS).toBe(10_000);
    expect(undoCalls()).toHaveLength(0); // nothing is undone until the button is pressed
  });

  it("leaves the count out when the opener does not have it", () => {
    const { result, toasts } = setup();
    result.current(moveDone());
    expect(toasts.calls[0].text).toBe(`Moved "${NEW_NAME}" to 172.20.0.5:4840.`);
  });

  it("posts the Undo of this move, says the server's sentence in a second toast and reads the lists again", async () => {
    const { result, toasts, undoCalls, refreshedKeys, pressUndo } = setup({
      "POST /api/sources/moves/31/undo": { body: moveUndone({ readings_since_move: 120 }) },
    });
    result.current(moveDone(), 12);
    pressUndo();
    await waitFor(() => expect(toasts.calls).toHaveLength(2));
    expect(undoCalls()).toHaveLength(1);
    expect(toasts.calls[1]).toEqual({ kind: "success", text: `Moved "${OLD_NAME}" back to 172.20.0.3:4840. 120 readings taken at the new address stay.` });
    // sources (and so their points), graph, scans, audit log and System events: A11
    await waitFor(() => expect(refreshedKeys()).toEqual(["sources", "graph", "scans", "audit", "events"]));
  });

  it.each([
    [409, "this move was already undone", "This move was already undone."],
    [409, "the source was changed after the move: its address is not 172.20.0.5:4840 any more", "The source was changed after the move: its address is not 172.20.0.5:4840 any more."],
    [410, "this move is older than 24 hours", "This move is older than 24 hours."],
    [404, "no such move", "No such move."],
  ])("shows the server's %s sentence as an error toast and reads the lists again (%s)", async (status, detail, shown) => {
    const { result, toasts, undoCalls, refreshedKeys, pressUndo } = setup({ "POST /api/sources/moves/31/undo": { status, body: { detail } } });
    result.current(moveDone(), 12);
    pressUndo();
    await waitFor(() => expect(toasts.calls).toHaveLength(2));
    expect(toasts.calls[1]).toEqual({ kind: "error", text: shown });
    expect(undoCalls()).toHaveLength(1);
    await waitFor(() => expect(refreshedKeys()).toEqual(["sources", "graph", "scans", "audit", "events"])); // a refusal means the lists on screen are out of date too
  });

  it("still works when the page that raised the toast is gone (the Undo runs up to 10 seconds later)", async () => {
    const { result, toasts, unmount, pressUndo } = setup({ "POST /api/sources/moves/31/undo": { body: moveUndone() } });
    result.current(moveDone(), 3);
    unmount();
    pressUndo();
    await waitFor(() => expect(toasts.calls).toHaveLength(2));
    expect(toasts.calls[1].kind).toBe("success");
  });

  describe("the focus, which would fall to the page when the toast's button leaves", () => {
    afterEach(() => { document.body.innerHTML = ""; });

    const page = () => {
      document.body.innerHTML = `
        <h1 tabindex="-1">Sources</h1>
        <table><tr data-source="2"><td><button type="button" class="row-menu-btn">Actions for x</button></td></tr></table>
        <div class="toast"><button type="button" class="toast-action">Undo</button></div>
        <button type="button" class="elsewhere">Elsewhere</button>`;
    };

    it("goes from the Undo button to the source's row menu button, as long as the page still shows the row", async () => {
      page();
      const { result, toasts, pressUndo } = setup({ "POST /api/sources/moves/31/undo": { body: moveUndone() } });
      result.current(moveDone(), 12);
      document.querySelector<HTMLElement>(".toast-action")!.focus();
      pressUndo();
      expect(document.querySelector(".row-menu-btn")).toHaveFocus();
      await waitFor(() => expect(toasts.calls).toHaveLength(2));
    });

    it("goes to the page heading when the row is gone", async () => {
      page();
      document.querySelector("tr")!.remove();
      const { result, toasts, pressUndo } = setup({ "POST /api/sources/moves/31/undo": { body: moveUndone() } });
      result.current(moveDone(), 12);
      document.querySelector<HTMLElement>(".toast-action")!.focus();
      pressUndo();
      expect(document.querySelector("h1")).toHaveFocus();
      await waitFor(() => expect(toasts.calls).toHaveLength(2));
    });

    it("leaves a focus the person put somewhere else alone", async () => {
      page();
      const { result, toasts, pressUndo } = setup({ "POST /api/sources/moves/31/undo": { body: moveUndone() } });
      result.current(moveDone(), 12);
      document.querySelector<HTMLElement>(".elsewhere")!.focus();
      pressUndo();
      expect(document.querySelector(".elsewhere")).toHaveFocus();
      await waitFor(() => expect(toasts.calls).toHaveLength(2));
    });
  });
});
