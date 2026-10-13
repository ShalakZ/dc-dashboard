import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ApiError } from "../api/client";
import { loadAssetImpact } from "../api/queries";
import type { AssetImpact } from "../api/types";
import { assetImpact, assetLoss } from "../lib/impact";
import { mockFetch } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { ImpactDeleteDialog } from "./ImpactDeleteDialog";

const leaf: AssetImpact = { assets: 1, mappings: 0, tariffs: 0 };
const branch: AssetImpact = { assets: 3, mappings: 2, tariffs: 1 };
const BRANCH_TEXT = "3 assets, 2 mappings and 1 tariff will be deleted; their past energy and cost figures disappear from Billing and dashboards.";
const impactRoute = (body: unknown, status = 200) => ({ "GET /api/assets/5/impact": { status, body } });
const gets = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method === "GET" && c.path === "/api/assets/5/impact").length;

function dialogFor(onConfirm: (seen: AssetImpact) => Promise<unknown>, onCancel: () => void) {
  return (
    <ImpactDeleteDialog<AssetImpact>
      title='Delete "Room A"?'
      queryKey={["impact", "asset", 5]}
      load={() => loadAssetImpact(5)}
      loss={assetLoss}
      isPlain={(i) => i.assets === 1 && i.mappings === 0 && i.tariffs === 0}
      plainMessage="This can't be undone."
      grown={assetImpact}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
function open(onConfirm: (seen: AssetImpact) => Promise<unknown> = async () => undefined, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const onCancel = vi.fn();
  const view = render(<QueryClientProvider client={client}>{dialogFor(onConfirm, onCancel)}</QueryClientProvider>);
  return { onCancel, client, ...view };
}
const dialog = () => screen.getByRole("dialog", { name: 'Delete "Room A"?' });

describe("ImpactDeleteDialog", () => {
  it("opens at once with the checking line and a disabled confirm button, before the preview has arrived", async () => {
    mockFetch(impactRoute(leaf));
    const held = holdFetch((method, path) => method === "GET" && path === "/api/assets/5/impact");
    open();
    expect(dialog()).toHaveTextContent("Checking what this deletes…");
    expect(screen.getByRole("button", { name: "Delete anyway" })).toBeDisabled(); // the confirm button of a dialog that has nothing to say yet
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await act(async () => held.release());
    expect(await screen.findByText("This can't be undone.")).toBeInTheDocument();
  });

  it("a leaf reads the plain sentence with a plain Delete button", async () => {
    mockFetch(impactRoute(leaf));
    open();
    expect(await screen.findByText("This can't be undone.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("danger");
    expect(screen.queryByText("Checking what this deletes…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete anyway" })).not.toBeInTheDocument();
  });

  it("anything more than the row itself reads the impact sentence with Delete anyway", async () => {
    mockFetch(impactRoute(branch));
    open();
    expect(await within(dialog()).findByText(BRANCH_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete anyway" })).toBeEnabled();
    expect(screen.queryByText("This can't be undone.")).not.toBeInTheDocument();
  });

  it("each count on its own makes it a branch (one mapping, or one tariff, is not a leaf)", async () => {
    mockFetch(impactRoute({ assets: 1, mappings: 1, tariffs: 0 }));
    open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete anyway" })).toBeEnabled()); // (while it loads the same button is there, off)
    expect(screen.getByRole("dialog")).toHaveTextContent("1 asset, 1 mapping and 0 tariffs will be deleted");
    cleanup();
    mockFetch(impactRoute({ assets: 1, mappings: 0, tariffs: 1 }));
    open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete anyway" })).toBeEnabled());
    expect(screen.getByRole("dialog")).toHaveTextContent("1 asset, 0 mappings and 1 tariff will be deleted");
  });

  it("a preview that cannot be loaded shows the server's words, keeps the confirm button off, and Cancel closes", async () => {
    mockFetch(impactRoute({ detail: "Asset 5 not found" }, 404));
    const onConfirm = vi.fn(async () => undefined);
    const { onCancel } = open(onConfirm);
    expect(await screen.findByRole("alert")).toHaveTextContent("Asset 5 not found");
    expect(screen.getByRole("button", { name: "Delete anyway" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByText("Checking what this deletes…")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("the confirm request carries the counts the person saw", async () => {
    mockFetch(impactRoute(branch));
    const onConfirm = vi.fn(async () => undefined);
    open(onConfirm);
    await userEvent.click(await screen.findByRole("button", { name: "Delete anyway" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(branch);
  });

  describe("when more was added while it was open (the server answers 409 with the new counts)", () => {
    const refusal = () => new ApiError(409, "More than you were shown would be deleted now", { detail: "x", ...branch });

    it("shows the new numbers and the new label, says why in its error line, and the next confirm sends the new counts", async () => {
      mockFetch(impactRoute(leaf));
      const onConfirm = vi.fn<(seen: AssetImpact) => Promise<unknown>>()
        .mockRejectedValueOnce(refusal())
        .mockResolvedValue(undefined);
      open(onConfirm);
      expect(await screen.findByText("This can't be undone.")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Delete" }));
      expect(onConfirm).toHaveBeenLastCalledWith(leaf);
      expect(await within(dialog()).findByText(BRANCH_TEXT)).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("More was added while this was open. The numbers above are updated; delete again to confirm.");
      expect(screen.queryByText("This can't be undone.")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
      expect(onConfirm).toHaveBeenCalledTimes(2);
      expect(onConfirm).toHaveBeenLastCalledWith(branch);
    });

    it("a 409 that is not a count (any other refusal) is shown as it is and changes nothing else", async () => {
      mockFetch(impactRoute(branch));
      const onConfirm = vi.fn(async () => { throw new ApiError(409, "something else", { detail: "something else" }); });
      open(onConfirm);
      await userEvent.click(await screen.findByRole("button", { name: "Delete anyway" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("something else");
      expect(dialog()).toHaveTextContent(BRANCH_TEXT);
      await userEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
      expect(onConfirm).toHaveBeenLastCalledWith(branch); // still the counts that were shown
    });
  });

  it("Cancel and Escape confirm nothing", async () => {
    mockFetch(impactRoute(branch));
    const onConfirm = vi.fn(async () => undefined);
    const { onCancel } = open(onConfirm);
    await screen.findByRole("button", { name: "Delete anyway" });
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("asks again at every open (nothing is kept between two openings), and not again while it is open", async () => {
    const calls = mockFetch(impactRoute(branch));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = open(undefined, client);
    await first.findByText(BRANCH_TEXT);
    first.unmount();
    open(undefined, client);
    await screen.findByText(BRANCH_TEXT);
    expect(gets(calls)).toBe(2);
  });

  it("does not refresh by itself when the window regains focus: what was shown is what the delete is checked against", async () => {
    const calls = mockFetch(impactRoute(branch));
    open();
    await screen.findByText(BRANCH_TEXT);
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await act(async () => {});
    expect(gets(calls)).toBe(1);
    focusManager.setFocused(undefined);
  });

  it("starts on Cancel and gives the focus back to what opened it", async () => {
    mockFetch(impactRoute(leaf));
    function Page() {
      const [open, setOpen] = useState(false);
      return (
        <QueryClientProvider client={new QueryClient()}>
          <button type="button" onClick={() => setOpen(true)}>trash</button>
          {open && dialogFor(async () => undefined, () => setOpen(false))}
        </QueryClientProvider>
      );
    }
    render(<Page />);
    await userEvent.click(screen.getByRole("button", { name: "trash" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "trash" })).toHaveFocus();
  });

  it("keeps its buttons off while the confirmed request runs, and closes only when its opener says so", async () => {
    mockFetch(impactRoute(leaf));
    let finish!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    open(onConfirm);
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => finish());
    expect(screen.getByRole("dialog")).toBeInTheDocument(); // the opener unmounts it after its own bookkeeping
  });
});
