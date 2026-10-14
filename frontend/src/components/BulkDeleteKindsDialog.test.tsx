import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAssetKinds, keys, type BulkDeleteResult } from "../api/queries";
import type { AssetKind } from "../api/types";
import { holdFetch } from "../test/holdFetch";
import { mockFetch } from "../test/fetchMock";
import { BulkDeleteKindsDialog } from "./BulkDeleteKindsDialog";

const kind = (id: number, name: string, asset_count = 0): AssetKind => ({ id, name, icon: "generic", asset_count, starter: false });

type Reply = { status: number; body?: unknown };

/**
 * The fake server: the registry it holds, which the deletions change (a move adds the assets to the target), and one url per DELETE in the
 * order sent. `replies[id]` replaces the answer for a kind (the registry is then left alone).
 */
function serve(initial: AssetKind[], replies: Record<number, Reply | (() => Reply)> = {}) {
  const registry = initial.map((row) => ({ ...row }));
  const urls: string[] = [];
  const routes: Record<string, (req: { url: string }) => Reply | { body: unknown }> = { "GET /api/asset-kinds": () => ({ body: registry }) };
  for (const { id } of initial) {
    routes[`DELETE /api/asset-kinds/${id}`] = ({ url }) => {
      urls.push(url);
      const custom = replies[id];
      if (custom) return typeof custom === "function" ? custom() : custom;
      const row = registry.find((r) => r.id === id)!;
      const move = new URL(url, "http://x").searchParams.get("move_to");
      if (move) registry.find((r) => r.id === Number(move))!.asset_count += row.asset_count;
      registry.splice(registry.indexOf(row), 1);
      return { status: 204 };
    };
  }
  mockFetch(routes as Parameters<typeof mockFetch>[0]);
  return { registry, urls };
}

/** What the page does: the kinds being deleted are looked up by id in the live list, which the dialog's own refetch changes. */
function Host({ ids, onDone, onCancel }: { ids: number[]; onDone: (r: BulkDeleteResult) => void; onCancel: () => void }) {
  const { data } = useAssetKinds();
  if (!data) return null;
  const rows = ids.map((id) => data.find((k) => k.id === id)).filter((k): k is AssetKind => k !== undefined);
  return <BulkDeleteKindsDialog rows={rows} all={data} onDone={onDone} onCancel={onCancel} />;
}

async function open(initial: AssetKind[], ids: number[], replies: Record<number, Reply | (() => Reply)> = {}) {
  const fake = serve(initial, replies);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(<QueryClientProvider client={client}><Host ids={ids} onDone={onDone} onCancel={onCancel} /></QueryClientProvider>);
  await screen.findByRole("dialog");
  return { ...fake, client, onDone, onCancel };
}

const dialog = () => screen.getByRole("dialog");
const deleteButton = () => screen.getByRole("button", { name: "Delete" });
const picker = () => screen.getByLabelText("Move the assets to") as HTMLSelectElement;

describe("BulkDeleteKindsDialog", () => {
  describe("none of the kinds is in use", () => {
    const kinds = [kind(1, "Pump"), kind(2, "Fan"), kind(3, "Valve"), kind(4, "UPS")];

    it("names them, offers no move, and deletes them one at a time with no query", async () => {
      const { urls, onDone, onCancel } = await open(kinds, [1, 2, 3]);
      expect(dialog()).toHaveAccessibleName("Delete 3 kinds?");
      expect(dialog()).toHaveTextContent("Pump, Fan, Valve. Assets that carry these names later get an automatic icon.");
      expect(screen.queryByLabelText("Move the assets to")).not.toBeInTheDocument();
      expect(deleteButton()).toBeEnabled();
      await userEvent.click(deleteButton());
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(urls).toEqual(["/api/asset-kinds/1", "/api/asset-kinds/2", "/api/asset-kinds/3"]);
      expect(onDone.mock.calls[0][0]).toEqual({ deleted: [1, 2, 3], gone: [], failed: [], notTried: [], moved: null });
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("lists the first eight names and counts the rest", async () => {
      const many = Array.from({ length: 12 }, (_, i) => kind(i + 1, `Kind ${i + 1}`));
      await open(many, many.map((k) => k.id));
      expect(dialog()).toHaveAccessibleName("Delete 12 kinds?");
      expect(dialog()).toHaveTextContent("Kind 1, Kind 2, Kind 3, Kind 4, Kind 5, Kind 6, Kind 7, Kind 8 and 4 more.");
      expect(dialog()).not.toHaveTextContent("Kind 9");
    });

    it("is the same dialog for one kind", async () => {
      await open(kinds, [4]);
      expect(dialog()).toHaveAccessibleName("Delete 1 kind?");
      expect(dialog()).toHaveTextContent("UPS. Assets that carry this name later get an automatic icon.");
    });

    it("can delete every kind there is when none is in use", async () => {
      const only = [kind(1, "Pump"), kind(2, "Fan")];
      const { onDone } = await open(only, [1, 2]);
      expect(deleteButton()).toBeEnabled();
      await userEvent.click(deleteButton());
      await waitFor(() => expect(onDone).toHaveBeenCalled());
    });
  });

  describe("some of the kinds are in use", () => {
    // Not in key order on purpose: the select sorts by key (case-insensitive, code point), whatever order the list arrives in.
    const kinds = [kind(1, "Pump", 4), kind(2, "Fan"), kind(3, "ups"), kind(4, "Battery"), kind(5, "Zebra"), kind(6, "Valve", 3)];

    it("asks where the assets go: a select of the kinds NOT picked, sorted, with Delete off until one is chosen", async () => {
      await open(kinds, [1, 2, 6]);
      expect(dialog()).toHaveAccessibleName("Delete 3 kinds?");
      expect(dialog()).toHaveTextContent("2 of these kinds are used by 7 assets. Move those assets to another kind, then delete the 3.");
      expect(within(picker()).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a kind…", "Battery", "ups", "Zebra"]);
      expect(picker()).toHaveValue("");
      expect(deleteButton()).toBeDisabled();
      await userEvent.selectOptions(picker(), "Battery");
      expect(deleteButton()).toBeEnabled();
      await userEvent.selectOptions(picker(), "Choose a kind…");
      expect(deleteButton()).toBeDisabled();
    });

    it("keeps the select outside the live region the dialog is described by", async () => {
      await open(kinds, [1, 2]);
      const body = document.getElementById(dialog().getAttribute("aria-describedby")!)!;
      expect(body).not.toContainElement(picker());
    });

    it("moves the assets of the kinds in use with the count it showed, and deletes the unused ones plainly", async () => {
      const { urls, registry, onDone } = await open(kinds, [1, 2, 6]);
      await userEvent.selectOptions(picker(), "Battery");
      await userEvent.click(deleteButton());
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(urls).toEqual(["/api/asset-kinds/1?move_to=4&expect_assets=4", "/api/asset-kinds/2", "/api/asset-kinds/6?move_to=4&expect_assets=3"]);
      expect(onDone.mock.calls[0][0]).toMatchObject({ deleted: [1, 2, 6], failed: [], moved: { assets: 7, to: "Battery" } });
      expect(registry.find((k) => k.name === "Battery")!.asset_count).toBe(7);
    });

    it("names the kind when only one is picked, and the message follows", async () => {
      await open(kinds, [6]);
      expect(dialog()).toHaveAccessibleName("Delete 1 kind?");
      expect(dialog()).toHaveTextContent('3 assets use "Valve". Move them to another kind, then delete "Valve".');
    });

    it("drops the choice when the kind chosen leaves the list, so Delete is off again", async () => {
      const { client } = await open(kinds, [1]);
      await userEvent.selectOptions(picker(), "Battery");
      expect(deleteButton()).toBeEnabled();
      act(() => { client.setQueryData(keys.assetKinds, kinds.filter((k) => k.name !== "Battery")); });
      await waitFor(() => expect(deleteButton()).toBeDisabled());
      expect(within(picker()).queryByRole("option", { name: "Battery" })).not.toBeInTheDocument();
    });
  });

  describe("blocked: some are in use and there is no kind to move them to", () => {
    it("says why, offers no Delete, and Close closes", async () => {
      const kinds = [kind(1, "Pump", 5), kind(2, "Fan")];
      const { onCancel } = await open(kinds, [1, 2]);
      expect(dialog()).toHaveTextContent("Every kind is selected, and 5 assets use some of them. Keep at least one kind to move them to.");
      expect(screen.queryByLabelText("Move the assets to")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("is the single-kind wording for the only kind there is", async () => {
      await open([kind(1, "Pump", 5)], [1]);
      expect(dialog()).toHaveTextContent('5 assets use "Pump". Create another kind to move them to first.');
      expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    });
  });

  describe("when things go wrong", () => {
    const kinds = [kind(1, "Pump"), kind(2, "Fan"), kind(3, "Valve")];

    it("stays open and shows the reason when nothing could be deleted", async () => {
      const refused = { status: 500, body: { detail: "database is locked" } };
      const { onDone, onCancel, urls } = await open(kinds, [1, 2], { 1: refused, 2: refused });
      await userEvent.click(deleteButton());
      expect(await screen.findByRole("alert")).toHaveTextContent("Database is locked");
      expect(urls).toHaveLength(2);
      expect(onDone).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
      expect(dialog()).toHaveAccessibleName("Delete 2 kinds?");
      expect(deleteButton()).toBeEnabled();
    });

    it("stays open when the first request meets a problem that stops the loop, and says why", async () => {
      const { onDone, urls } = await open(kinds, [1, 2, 3], { 1: { status: 403, body: { detail: "insufficient permission" } } });
      await userEvent.click(deleteButton());
      expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow this.");
      expect(urls).toHaveLength(1);
      expect(onDone).not.toHaveBeenCalled();
    });

    it("hands the result to the page when only some were refused, and does not close itself", async () => {
      const { onDone, onCancel } = await open(kinds, [1, 2, 3], { 2: { status: 500, body: { detail: "boom" } } });
      await userEvent.click(deleteButton());
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(onDone.mock.calls[0][0]).toMatchObject({ deleted: [1, 3], failed: [{ id: 2, name: "Fan", reason: "Boom" }] });
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("hands the result over when the loop stopped after some were deleted", async () => {
      const { onDone } = await open(kinds, [1, 2, 3], { 2: { status: 503, body: "x" } });
      await userEvent.click(deleteButton());
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(onDone.mock.calls[0][0]).toMatchObject({ deleted: [1], notTried: [2, 3] });
      expect(onDone.mock.calls[0][0].stoppedBy).toMatch(/not answering/);
    });

    it("counts a kind another tab deleted as done", async () => {
      const { onDone } = await open(kinds, [1, 2], { 1: { status: 404, body: { detail: "asset kind not found" } }, 2: { status: 404, body: { detail: "asset kind not found" } } });
      await userEvent.click(deleteButton());
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(onDone.mock.calls[0][0]).toMatchObject({ deleted: [], gone: [1, 2], failed: [] });
    });

    it("turns a 409 into the new count: the message follows, the dialog stays, the choice stays, and the next press sends the new count", async () => {
      const list = [kind(1, "Pump", 2), kind(2, "UPS")];
      let refused = true;
      const fake = serve(list, {
        1: () => {
          if (!refused) return { status: 204 };
          refused = false;
          fake.registry[0].asset_count = 5; // three assets joined the kind while the dialog was open
          return { status: 409, body: { detail: "5 assets use this kind now. Check the new count and try again.", assets: 5 } };
        },
      });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      const onDone = vi.fn();
      const onCancel = vi.fn();
      render(<QueryClientProvider client={client}><Host ids={[1]} onDone={onDone} onCancel={onCancel} /></QueryClientProvider>);
      await screen.findByRole("dialog");
      expect(dialog()).toHaveTextContent('2 assets use "Pump".');
      await userEvent.selectOptions(picker(), "UPS");
      await userEvent.click(deleteButton());
      expect(await screen.findByRole("alert")).toHaveTextContent("5 assets use it now.");
      expect(dialog()).toHaveTextContent('5 assets use "Pump".');
      expect(picker()).toHaveValue("2");
      expect(onDone).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
      await userEvent.click(deleteButton());
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(fake.urls).toEqual(["/api/asset-kinds/1?move_to=2&expect_assets=2", "/api/asset-kinds/1?move_to=2&expect_assets=5"]);
    });
  });

  describe("while the request runs", () => {
    it("keeps the title and the message it was opened with, though the refetched list no longer has the kinds, and does not close itself", async () => {
      const kinds = [kind(1, "Pump"), kind(2, "Fan")];
      const { client, onDone, onCancel } = await open(kinds, [1, 2]);
      const held = holdFetch((method) => method === "DELETE");
      await userEvent.click(deleteButton());
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled(); // it is running
      act(() => { client.setQueryData(keys.assetKinds, []); }); // the refetch lands (here: before the deletions have)
      expect(dialog()).toHaveAccessibleName("Delete 2 kinds?");
      expect(dialog()).toHaveTextContent("Pump, Fan.");
      expect(onCancel).not.toHaveBeenCalled();
      await act(async () => { held.release(); });
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(dialog()).toHaveAccessibleName("Delete 2 kinds?");
      expect(onCancel).not.toHaveBeenCalled(); // the page closes it on onDone; the dialog does not call both
    });

    it("shows the live list again once a failed request is over (the counts follow)", async () => {
      const kinds = [kind(1, "Pump"), kind(2, "Fan")];
      const { client, onCancel } = await open(kinds, [1, 2], { 1: { status: 500, body: { detail: "boom" } }, 2: { status: 500, body: { detail: "boom" } } });
      await userEvent.click(deleteButton());
      await screen.findByRole("alert");
      act(() => { client.setQueryData(keys.assetKinds, [kind(1, "Pump")]); }); // Fan is gone elsewhere
      await waitFor(() => expect(dialog()).toHaveAccessibleName("Delete 1 kind?"));
      expect(onCancel).not.toHaveBeenCalled();
    });
  });

  describe("closing", () => {
    it("closes itself when no kind of the selection is left (they were all deleted elsewhere) and it is not running", async () => {
      const { client, onCancel } = await open([kind(1, "Pump"), kind(2, "Fan")], [1, 2]);
      expect(onCancel).not.toHaveBeenCalled();
      act(() => { client.setQueryData(keys.assetKinds, []); });
      await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    });

    it("closes at once when it is opened with nothing to delete", () => {
      const onCancel = vi.fn();
      mockFetch({});
      render(<QueryClientProvider client={new QueryClient()}><BulkDeleteKindsDialog rows={[]} all={[]} onDone={vi.fn()} onCancel={onCancel} /></QueryClientProvider>);
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe("focus, Escape and Tab (it is a ConfirmDeleteDialog)", () => {
    const kinds = [kind(1, "Pump", 2), kind(2, "Fan"), kind(3, "UPS")];

    it("starts on Cancel, and Escape and Cancel cancel without deleting anything", async () => {
      const { onCancel, urls } = await open(kinds, [1, 2]);
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onCancel).toHaveBeenCalledTimes(2);
      expect(urls).toEqual([]);
    });

    it("Tab wraps inside (the select comes first, then Cancel, then Delete once it is on) and Shift+Tab goes the other way", async () => {
      await open(kinds, [1, 2]);
      const cancel = screen.getByRole("button", { name: "Cancel" });
      await userEvent.tab(); // Delete is off, so Cancel was the last control: round to the select
      expect(picker()).toHaveFocus();
      await userEvent.tab();
      expect(cancel).toHaveFocus();
      await userEvent.tab({ shift: true });
      expect(picker()).toHaveFocus();
      await userEvent.tab({ shift: true }); // the first control: round to the last, which is Cancel while Delete is off
      expect(cancel).toHaveFocus();
      await userEvent.selectOptions(picker(), "UPS");
      await userEvent.tab();
      expect(cancel).toHaveFocus();
      await userEvent.tab();
      expect(deleteButton()).toHaveFocus();
      await userEvent.tab(); // the last control: round to the select
      expect(picker()).toHaveFocus();
      await userEvent.tab({ shift: true });
      expect(deleteButton()).toHaveFocus();
    });

    it("gives the focus back to the opener when it goes away", async () => {
      const opener = document.createElement("button");
      document.body.append(opener);
      opener.focus();
      try {
        serve(kinds);
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const { unmount } = render(<QueryClientProvider client={client}><Host ids={[2]} onDone={vi.fn()} onCancel={vi.fn()} /></QueryClientProvider>);
        await screen.findByRole("dialog");
        expect(opener).not.toHaveFocus();
        unmount();
        expect(opener).toHaveFocus();
      } finally {
        opener.remove();
      }
    });
  });
});
