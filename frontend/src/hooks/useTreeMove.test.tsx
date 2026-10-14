import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useRef } from "react";
import { useAssets } from "../api/queries";
import type { Asset, MovePreview, MoveResult } from "../api/types";
import type { AssetTreeMove } from "../components/AssetTree";
import { holdFetch } from "../test/holdFetch";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { spyToasts } from "../test/toasts";
import { userFor } from "../test/users";
import { useTreeMove } from "./useTreeMove";

// Site
//   Hall A: Rack 1, Rack 2
//   Hall B: Rack 1
// Yard
const asset = (id: number, parent_id: number | null, name: string): Asset => ({ id, parent_id, name, kind: "room", sort_order: 0 });
const ASSETS: Asset[] = [
  asset(1, null, "Site"), asset(2, 1, "Hall A"), asset(3, 1, "Hall B"),
  asset(4, 2, "Rack 1"), asset(5, 2, "Rack 2"), asset(6, 3, "Rack 1"), asset(7, null, "Yard"),
];

const preview = (over: Partial<MovePreview> = {}): MovePreview => ({
  assets: 1, unchanged: [], currency: "USD", rate_changes: false,
  roots: [{
    id: 4, name: "Rack 1", subtree_assets: 1, from_parent_id: 2, from_parent_name: "Hall A", to_parent_id: 7, to_parent_name: "Yard",
    change: "parent", rate_before: 0.18, rate_after: 0.12, rate_changes_today: false, rate_changes_other_days: false,
  }],
  expect: { assets: 1, parents: { "4": 2 }, rate_changes: false },
  ...over,
});
const RATE_CHANGE = preview({
  rate_changes: true,
  roots: [{ ...preview().roots[0], rate_changes_today: true, rate_changes_other_days: true }],
  expect: { assets: 1, parents: { "4": 2 }, rate_changes: true },
});
const moved = (over: Partial<MoveResult> = {}): MoveResult => ({
  request_id: "r-1", assets: 1, unchanged: [],
  moved: [{ id: 4, name: "Rack 1", from_parent_id: 2, to_parent_id: 7, from_parent_name: "Hall A", to_parent_name: "Yard", change: "parent" }],
  undo: { moves: [{ ids: [4], parent_id: 2, before_id: 5 }], expect: { assets: 1, parents: { "4": 7 } } },
  ...over,
});
const UNDONE = moved({
  request_id: "r-2",
  moved: [{ id: 4, name: "Rack 1", from_parent_id: 7, to_parent_id: 2, from_parent_name: "Yard", to_parent_name: "Hall A", change: "parent" }],
});

/**
 * What the Assets page and its tree do around the hook. The tree is not here: this is the part of it the hook talks to. `opener` is disabled
 * while `busy` (the page locks the tree's buttons), and the effect on `moved` is the tree's "focus the first moved root".
 */
function Harness({ canEdit = true, locked = false, blurOpener = false, capture }: { canEdit?: boolean; locked?: boolean; blurOpener?: boolean; capture?: (move: AssetTreeMove | undefined) => void }) {
  const { data: assets = [] } = useAssets();
  const { move, dialogs, busy } = useTreeMove({ assets, canEdit, locked });
  const link = useRef<HTMLAnchorElement>(null);
  capture?.(move);
  // A LAYOUT effect: the strictest case. It runs before a passive clean-up such as the Modal's "give the focus back to the opener", so only a
  // hook that closes its dialog in an earlier commit than the signal leaves the focus on the moved root.
  useLayoutEffect(() => { if (move?.moved) link.current?.focus(); }, [move?.moved]);
  return (
    <div>
      <button type="button" onClick={() => void move?.onDrop([4], { parent_id: 7, before_id: null })}>drop</button>
      <button type="button" disabled={busy} onClick={(e) => { move?.onMoveTo([4], e.currentTarget); if (blurOpener) e.currentTarget.blur(); }}>open</button>
      <a ref={link} href="/assets/4">Rack 1 link</a>
      <span data-testid="assets">{assets.length}</span>
      <span data-testid="busy">{String(busy)}</span>
      <span data-testid="moved">{move?.moved ? String(move.moved.firstId) : "none"}</span>
      <span data-testid="has-move">{String(move !== undefined)}</span>
      {dialogs}
    </div>
  );
}
const busy = () => screen.getByTestId("busy").textContent;
const movedSignal = () => screen.getByTestId("moved").textContent;
const posts = (calls: { method: string; path: string; body: unknown }[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

const GROUP = { ids: [4], parent_id: 7, before_id: null };
const base: Routes = { "GET /api/me": { body: userFor("admin") }, "GET /api/setup": { body: { needed: false } }, "GET /api/assets": { body: ASSETS } };

function setup(routes: Routes = {}, props: { canEdit?: boolean; locked?: boolean; blurOpener?: boolean } = {}) {
  const calls = mockFetch({ ...base, ...routes });
  const spy = spyToasts();
  const captured: { move: AssetTreeMove | undefined }[] = [];
  const view = renderWithProviders(<Harness {...props} capture={(move) => captured.push({ move })} />, { toasts: spy.api });
  return { calls, spy, captured, view };
}
/** The assets are in the hook (its index is built from them), and its effects have run. */
const settled = async (_calls?: unknown) => { await waitFor(() => expect(screen.getByTestId("assets")).toHaveTextContent(String(ASSETS.length))); await act(async () => {}); };
const lastMove = (captured: { move: AssetTreeMove | undefined }[]) => captured[captured.length - 1].move!;

describe("useTreeMove", () => {
  it("gives the tree no move at all without permission", () => {
    setup({}, { canEdit: false });
    expect(screen.getByTestId("has-move")).toHaveTextContent("false");
  });

  it("gives the tree a move with permission", () => {
    setup();
    expect(screen.getByTestId("has-move")).toHaveTextContent("true");
  });

  describe("a drop", () => {
    it("with no rate change: a preview, then the move with the preview's expect, a toast with Undo for 8 seconds, and the tree is told the first moved root", async () => {
      const { calls, spy } = setup({ "POST /api/assets/move-preview": { body: preview() }, "POST /api/assets/move": { body: moved() } });
      await settled(calls);
      await userEvent.click(screen.getByRole("button", { name: "drop" }));
      await waitFor(() => expect(movedSignal()).toBe("4"));
      expect(posts(calls, "/api/assets/move-preview")[0].body).toEqual({ moves: [GROUP] });
      expect(posts(calls, "/api/assets/move")[0].body).toEqual({ moves: [GROUP], expect: preview().expect });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); // no confirmation without a rate change
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]).toMatchObject({ kind: "success", text: "Moved Rack 1 to Yard", options: { durationMs: 8000, action: { label: "Undo" } } });
      expect(busy()).toBe("false");
    });

    it("sends the ROOTS only: an asset picked with its parent travels inside the parent", async () => {
      const { calls, captured } = setup({ "POST /api/assets/move-preview": { body: preview() }, "POST /api/assets/move": { body: moved() } });
      await settled(calls);
      await act(async () => { await lastMove(captured).onDrop([4, 2, 5], { parent_id: 7, before_id: null }); });
      expect(posts(calls, "/api/assets/move-preview")[0].body).toEqual({ moves: [{ ids: [2], parent_id: 7, before_id: null }] });
    });

    it("the signal is a new object after every move, and the handlers keep their identity", async () => {
      const { calls, captured } = setup({ "POST /api/assets/move-preview": { body: preview() }, "POST /api/assets/move": { body: moved() } });
      await settled(calls);
      const first = lastMove(captured);
      await act(async () => { await first.onDrop([4], { parent_id: 7, before_id: null }); });
      const one = lastMove(captured).moved;
      await act(async () => { await lastMove(captured).onDrop([4], { parent_id: 7, before_id: null }); });
      const two = lastMove(captured).moved;
      expect(one).toEqual({ firstId: 4 });
      expect(two).toEqual({ firstId: 4 });
      expect(two).not.toBe(one);
      expect(lastMove(captured).onDrop).toBe(first.onDrop);
      expect(lastMove(captured).onMoveTo).toBe(first.onMoveTo);
    });

    it("refreshes the asset list after a move (the mutation settles the lists)", async () => {
      const { calls } = setup({ "POST /api/assets/move-preview": { body: preview() }, "POST /api/assets/move": { body: moved() } });
      await settled(calls);
      const before = calls.filter((c) => c.path === "/api/assets").length;
      await userEvent.click(screen.getByRole("button", { name: "drop" }));
      await waitFor(() => expect(calls.filter((c) => c.path === "/api/assets").length).toBeGreaterThan(before));
    });

    it("ignores a second drop while the first is out, and is busy meanwhile", async () => {
      const { calls, captured } = setup({ "POST /api/assets/move-preview": { body: preview() }, "POST /api/assets/move": { body: moved() } });
      await settled(calls);
      const held = holdFetch((method, path) => method === "POST" && path === "/api/assets/move-preview");
      let first!: Promise<void>;
      act(() => { first = Promise.resolve(lastMove(captured).onDrop([4], { parent_id: 7, before_id: null })); });
      expect(busy()).toBe("true");
      await act(async () => { await lastMove(captured).onDrop([5], { parent_id: 7, before_id: null }); });
      await act(async () => { held.release(); await first; });
      expect(posts(calls, "/api/assets/move-preview")).toHaveLength(1);
      expect(busy()).toBe("false");
    });

    it("does nothing while the page is locked", async () => {
      const { calls, captured, spy } = setup({}, { locked: true });
      await settled(calls);
      await act(async () => { await lastMove(captured).onDrop([4], { parent_id: 7, before_id: null }); });
      act(() => lastMove(captured).onMoveTo([4], null));
      expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(spy.calls).toEqual([]);
    });

    it("nothing to move (no known id) asks nothing", async () => {
      const { calls, captured } = setup();
      await settled(calls);
      await act(async () => { await lastMove(captured).onDrop([999], { parent_id: 7, before_id: null }); });
      expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    });

    describe("that changes a rate", () => {
      const routes: Routes = { "POST /api/assets/move-preview": { body: RATE_CHANGE }, "POST /api/assets/move": { body: moved() } };

      it("asks first (title, the message in names and rates, Move anyway), moves nothing before the answer, and counts as busy", async () => {
        const { calls, spy } = setup(routes);
        await settled(calls);
        await userEvent.click(screen.getByRole("button", { name: "drop" }));
        const confirm = await screen.findByRole("dialog", { name: "This changes the rate" });
        expect(confirm).toHaveTextContent('Moving "Rack 1" changes its rate from 0.18 USD to 0.12 USD per kWh. Past periods are recalculated at the new place, and the totals of both branches change.');
        expect(within(confirm).getByRole("button", { name: "Move anyway" })).not.toHaveClass("danger");
        expect(busy()).toBe("true");
        expect(posts(calls, "/api/assets/move")).toEqual([]);
        await userEvent.click(within(confirm).getByRole("button", { name: "Move anyway" }));
        await waitFor(() => expect(movedSignal()).toBe("4"));
        expect(posts(calls, "/api/assets/move")[0].body).toEqual({ moves: [GROUP], expect: RATE_CHANGE.expect });
        expect(spy.calls.map((c) => c.text)).toEqual(["Moved Rack 1 to Yard"]);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      it("Cancel moves nothing: no toast, no signal, no dialog, and the focus is back where it was", async () => {
        const { calls, spy } = setup(routes);
        await settled(calls);
        const drop = screen.getByRole("button", { name: "drop" });
        await userEvent.click(drop);
        await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(posts(calls, "/api/assets/move")).toEqual([]);
        expect(spy.calls).toEqual([]);
        expect(movedSignal()).toBe("none");
        expect(busy()).toBe("false");
        expect(drop).toHaveFocus();
      });

      it("Escape on the confirmation leaves no dialog and the focus on a named element, not on the page body", async () => {
        const { calls } = setup(routes);
        await settled(calls);
        const drop = screen.getByRole("button", { name: "drop" });
        await userEvent.click(drop);
        await screen.findByRole("dialog", { name: "This changes the rate" });
        await userEvent.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(posts(calls, "/api/assets/move")).toEqual([]);
        expect(document.activeElement).toBe(drop);
      });

      it("a drag does not leave the focus on the body: after a Cancel it goes to the first dragged root's link", async () => {
        const { calls, captured } = setup(routes);
        await settled(calls);
        (document.activeElement as HTMLElement | null)?.blur();
        act(() => { void lastMove(captured).onDrop([4], { parent_id: 7, before_id: null }); });
        await screen.findByRole("dialog", { name: "This changes the rate" });
        await userEvent.keyboard("{Escape}");
        await waitFor(() => expect(screen.getByRole("link", { name: "Rack 1 link" })).toHaveFocus());
      });
    });

    describe("that the server refuses", () => {
      it("a refusal (422) is an error toast with the reason, nothing moves and the picks are not cleared (no signal)", async () => {
        const reason = 'Yard already has an asset named "Rack 1".';
        const { calls, spy } = setup({ "POST /api/assets/move-preview": { status: 422, body: { detail: reason, refusals: [{ id: 4, name: "Rack 1", reason, code: "name_clash" }] } } });
        await settled(calls);
        await userEvent.click(screen.getByRole("button", { name: "drop" }));
        await waitFor(() => expect(spy.calls).toEqual([{ kind: "error", text: reason }]));
        expect(movedSignal()).toBe("none");
        expect(posts(calls, "/api/assets/move")).toEqual([]);
        expect(busy()).toBe("false");
      });

      it("a refusal of the move itself reads the same", async () => {
        const { calls, spy } = setup({
          "POST /api/assets/move-preview": { body: preview() },
          "POST /api/assets/move": { status: 422, body: { detail: "Yard is inside Rack 1.", refusals: [{ id: 4, name: "Rack 1", reason: "Yard is inside Rack 1.", code: "cycle" }] } },
        });
        await settled(calls);
        await userEvent.click(screen.getByRole("button", { name: "drop" }));
        await waitFor(() => expect(spy.calls).toEqual([{ kind: "error", text: "Yard is inside Rack 1." }]));
        expect(movedSignal()).toBe("none");
      });

      it("a stale answer to the move says the tree changed; try again", async () => {
        const { calls, spy } = setup({
          "POST /api/assets/move-preview": { body: preview() },
          "POST /api/assets/move": { status: 409, body: { detail: "More assets would move than you were shown.", stale: true } },
        });
        await settled(calls);
        await userEvent.click(screen.getByRole("button", { name: "drop" }));
        await waitFor(() => expect(spy.calls).toEqual([{ kind: "error", text: "The tree changed; try again" }]));
        expect(movedSignal()).toBe("none");
      });

      it("a stale answer to the preview says the same and refreshes the asset list", async () => {
        const { calls, spy } = setup({ "POST /api/assets/move-preview": { status: 409, body: { detail: "Yard is gone.", stale: true } } });
        await settled(calls);
        const before = calls.filter((c) => c.path === "/api/assets").length;
        await userEvent.click(screen.getByRole("button", { name: "drop" }));
        await waitFor(() => expect(spy.calls).toEqual([{ kind: "error", text: "The tree changed; try again" }]));
        await waitFor(() => expect(calls.filter((c) => c.path === "/api/assets").length).toBeGreaterThan(before));
      });

      it("a network failure shows the client's own message", async () => {
        const { calls, spy } = setup({ "POST /api/assets/move-preview": () => { throw new TypeError("Failed to fetch"); } });
        await settled(calls);
        await userEvent.click(screen.getByRole("button", { name: "drop" }));
        await waitFor(() => expect(spy.calls).toHaveLength(1));
        expect(spy.calls[0].kind).toBe("error");
        expect(spy.calls[0].text).toMatch(/\S/);
        expect(busy()).toBe("false");
      });

      it("'already there' (422, no refusals) is an info toast, never an error", async () => {
        const { calls, spy } = setup({ "POST /api/assets/move-preview": { status: 422, body: { detail: "Already there: nothing needs to move.", refusals: [], unchanged: [4] } } });
        await settled(calls);
        await userEvent.click(screen.getByRole("button", { name: "drop" }));
        await waitFor(() => expect(spy.calls).toEqual([{ kind: "info", text: "Already there" }]));
        expect(posts(calls, "/api/assets/move")).toEqual([]);
        expect(movedSignal()).toBe("none");
      });

      it("a preview whose every root is unchanged (200) is the same info toast and asks for no confirmation", async () => {
        const { calls, spy } = setup({ "POST /api/assets/move-preview": { body: preview({ unchanged: [4], roots: [], assets: 0, rate_changes: true }) } });
        await settled(calls);
        await userEvent.click(screen.getByRole("button", { name: "drop" }));
        await waitFor(() => expect(spy.calls).toEqual([{ kind: "info", text: "Already there" }]));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(posts(calls, "/api/assets/move")).toEqual([]);
      });

      it("after a failed drag the focus goes to the first root's link when it was on the body", async () => {
        const { calls, captured } = setup({ "POST /api/assets/move-preview": { status: 422, body: { detail: "No.", refusals: [{ id: 4, name: "Rack 1", reason: "No.", code: "cycle" }] } } });
        await settled(calls);
        (document.activeElement as HTMLElement | null)?.blur();
        await act(async () => { await lastMove(captured).onDrop([4], { parent_id: 7, before_id: null }); });
        await waitFor(() => expect(screen.getByRole("link", { name: "Rack 1 link" })).toHaveFocus());
      });
    });
  });

  describe("Undo", () => {
    const routes = (undo: Routes = {}): Routes => ({
      "POST /api/assets/move-preview": { body: preview() },
      "POST /api/assets/move": ({ body }) => ((body as { undo_of?: string }).undo_of ? { body: UNDONE } : { body: moved() }),
      ...undo,
    });

    it("sends the server's undo request with undo_of, says Undone without a second Undo, and tells the tree the first restored root", async () => {
      const { calls, spy } = setup(routes());
      await settled(calls);
      await userEvent.click(screen.getByRole("button", { name: "drop" }));
      await waitFor(() => expect(spy.calls).toHaveLength(1));
      await act(async () => { spy.calls[0].options!.action!.onAction(); });
      await waitFor(() => expect(spy.calls).toHaveLength(2));
      expect(posts(calls, "/api/assets/move")[1].body).toEqual({ moves: moved().undo.moves, expect: moved().undo.expect, undo_of: "r-1" });
      expect(spy.calls[1]).toEqual({ kind: "success", text: "Undone" }); // no options at all
      expect(movedSignal()).toBe("4");
      expect(busy()).toBe("false");
    });

    it("a 409 says something moved since, and puts the focus on the moved root", async () => {
      const { calls, spy } = setup(routes({
        "POST /api/assets/move": ({ body }) => ((body as { undo_of?: string }).undo_of ? { status: 409, body: { detail: "These assets were moved or changed since you looked.", stale: true } } : { body: moved() }),
      }));
      await settled(calls);
      await userEvent.click(screen.getByRole("button", { name: "drop" }));
      await waitFor(() => expect(spy.calls).toHaveLength(1));
      screen.getByRole("button", { name: "drop" }).focus(); // where the person's focus is when the toast's button is pressed
      await act(async () => { spy.calls[0].options!.action!.onAction(); });
      await waitFor(() => expect(spy.calls).toHaveLength(2));
      expect(spy.calls[1]).toEqual({ kind: "error", text: "Something moved since; the move could not be undone" });
      await waitFor(() => expect(screen.getByRole("link", { name: "Rack 1 link" })).toHaveFocus());
    });

    it("a 409 that is not marked stale reads the same", async () => {
      const { calls, spy } = setup(routes({
        "POST /api/assets/move": ({ body }) => ((body as { undo_of?: string }).undo_of ? { status: 409, body: { detail: "conflict" } } : { body: moved() }),
      }));
      await settled(calls);
      await userEvent.click(screen.getByRole("button", { name: "drop" }));
      await waitFor(() => expect(spy.calls).toHaveLength(1));
      await act(async () => { spy.calls[0].options!.action!.onAction(); });
      await waitFor(() => expect(spy.calls).toHaveLength(2));
      expect(spy.calls[1].text).toBe("Something moved since; the move could not be undone");
    });

    it("any other failure shows the server's own text", async () => {
      const { calls, spy } = setup(routes({
        "POST /api/assets/move": ({ body }) => ((body as { undo_of?: string }).undo_of ? { status: 422, body: { detail: 'Hall A already has an asset named "Rack 1".', refusals: [{ id: 4, name: "Rack 1", reason: 'Hall A already has an asset named "Rack 1".', code: "name_clash" }] } } : { body: moved() }),
      }));
      await settled(calls);
      await userEvent.click(screen.getByRole("button", { name: "drop" }));
      await waitFor(() => expect(spy.calls).toHaveLength(1));
      await act(async () => { spy.calls[0].options!.action!.onAction(); });
      await waitFor(() => expect(spy.calls).toHaveLength(2));
      expect(spy.calls[1]).toEqual({ kind: "error", text: 'Hall A already has an asset named "Rack 1".' });
    });

    it("an undo that is already done (422, no refusals) is an info toast, not an error", async () => {
      const { calls, spy } = setup(routes({
        "POST /api/assets/move": ({ body }) => ((body as { undo_of?: string }).undo_of ? { status: 422, body: { detail: "Already there: nothing needs to move.", refusals: [], unchanged: [4] } } : { body: moved() }),
      }));
      await settled(calls);
      await userEvent.click(screen.getByRole("button", { name: "drop" }));
      await waitFor(() => expect(spy.calls).toHaveLength(1));
      await act(async () => { spy.calls[0].options!.action!.onAction(); });
      await waitFor(() => expect(spy.calls).toHaveLength(2));
      expect(spy.calls[1]).toEqual({ kind: "info", text: "Already there" });
    });

    it("works after the page has gone: the toast outlives the hook's owner", async () => {
      const { calls, spy, view } = setup(routes());
      await settled(calls);
      await userEvent.click(screen.getByRole("button", { name: "drop" }));
      await waitFor(() => expect(spy.calls).toHaveLength(1));
      view.unmount();
      await act(async () => { spy.calls[0].options!.action!.onAction(); });
      await waitFor(() => expect(posts(calls, "/api/assets/move")).toHaveLength(2));
      await waitFor(() => expect(spy.calls[1]).toEqual({ kind: "success", text: "Undone" }));
    });
  });

  describe("Move to...", () => {
    const routes: Routes = { "POST /api/assets/move-preview": { body: preview() }, "POST /api/assets/move": { body: moved() } };

    it("opens the dialog for the ids and counts as busy; Cancel closes it and the focus goes back to the opener, which was locked while the dialog was open", async () => {
      const { calls } = setup(routes);
      await settled(calls);
      const open = screen.getByRole("button", { name: "open" });
      await userEvent.click(open);
      expect(await screen.findByRole("dialog", { name: 'Move "Rack 1" to...' })).toBeInTheDocument();
      expect(busy()).toBe("true");
      expect(open).toBeDisabled();
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(busy()).toBe("false");
      expect(open).toHaveFocus();
    });

    it("the focus goes back to the opener even when the browser dropped it while the opener was locked", async () => {
      const { calls } = setup(routes, { blurOpener: true }); // a button that turns disabled under the focus loses it: the dialog then finds nothing to give back to
      await settled(calls);
      const open = screen.getByRole("button", { name: "open" });
      await userEvent.click(open);
      await screen.findByRole("dialog");
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(open).toHaveFocus();
    });

    it("Escape does the same", async () => {
      const { calls } = setup(routes);
      await settled(calls);
      const open = screen.getByRole("button", { name: "open" });
      await userEvent.click(open);
      await screen.findByRole("dialog");
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(open).toHaveFocus();
    });

    it("a move from the dialog closes it, toasts with Undo and tells the tree; the focus lands on the moved root, not on the opener that is still there", async () => {
      const { calls, spy } = setup(routes);
      await settled(calls);
      await userEvent.click(screen.getByRole("button", { name: "open" }));
      await userEvent.click(await screen.findByRole("radio", { name: "Yard" }));
      await userEvent.click(screen.getByRole("button", { name: "Move" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]).toMatchObject({ kind: "success", text: "Moved Rack 1 to Yard", options: { durationMs: 8000, action: { label: "Undo" } } });
      expect(movedSignal()).toBe("4");
      expect(screen.getByRole("link", { name: "Rack 1 link" })).toHaveFocus();
      expect(posts(calls, "/api/assets/move")[0].body).toEqual({ moves: [GROUP], expect: preview().expect });
    });

    it("the warning appears inside the dialog, never as a second dialog", async () => {
      const { calls } = setup({ ...routes, "POST /api/assets/move-preview": { body: RATE_CHANGE } });
      await settled(calls);
      await userEvent.click(screen.getByRole("button", { name: "open" }));
      await userEvent.click(await screen.findByRole("radio", { name: "Yard" }));
      await userEvent.click(screen.getByRole("button", { name: "Move" }));
      await screen.findByRole("button", { name: "Move anyway" });
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(screen.queryByRole("dialog", { name: "This changes the rate" })).not.toBeInTheDocument();
    });

    it("does not open for ids that are not in the tree, nor beside another move", async () => {
      const { calls, captured } = setup(routes);
      await settled(calls);
      act(() => lastMove(captured).onMoveTo([999], null));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      act(() => lastMove(captured).onMoveTo([4], null));
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      act(() => lastMove(captured).onMoveTo([5], null)); // a second one beside it
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      await act(async () => { await lastMove(captured).onDrop([4], { parent_id: 7, before_id: null }); }); // and no drop beside it
      expect(posts(calls, "/api/assets/move-preview")).toEqual([]);
    });
  });
});
