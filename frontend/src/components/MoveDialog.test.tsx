import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../api/client";
import type { Asset, MoveBody, MovePreview, MoveResult } from "../api/types";
import { buildTree } from "../lib/tree";
import { indexTree } from "../lib/treeMove";
import { holdFetch } from "../test/holdFetch";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { userFor } from "../test/users";
import { MoveDialog, moveFailure, nothingChanges } from "./MoveDialog";

// user-event's arrow keys on a radio read window.CSS.escape, which jsdom 26 does not have: stub it here only.
beforeEach(() => {
  vi.stubGlobal("CSS", { escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) });
});
afterEach(() => { vi.unstubAllGlobals(); });

// Site
//   Hall A: Rack 1, Rack 2
//   Hall B: Rack 1
// Yard
const asset = (id: number, parent_id: number | null, name: string): Asset => ({ id, parent_id, name, kind: "room", sort_order: 0 });
const ASSETS: Asset[] = [
  asset(1, null, "Site"), asset(2, 1, "Hall A"), asset(3, 1, "Hall B"),
  asset(4, 2, "Rack 1"), asset(5, 2, "Rack 2"), asset(6, 3, "Rack 1"), asset(7, null, "Yard"),
];

const previewFor = (over: Partial<MovePreview> = {}): MovePreview => ({
  assets: 1, unchanged: [], currency: "USD", rate_changes: false,
  roots: [{
    id: 4, name: "Rack 1", subtree_assets: 1, from_parent_id: 2, from_parent_name: "Hall A", to_parent_id: 7, to_parent_name: "Yard",
    change: "parent", rate_before: 0.18, rate_after: 0.12, rate_changes_today: false, rate_changes_other_days: false,
  }],
  expect: { assets: 1, parents: { "4": 2 }, rate_changes: false },
  ...over,
});
const RATE_CHANGE = previewFor({
  rate_changes: true,
  roots: [{ ...previewFor().roots[0], rate_changes_today: true, rate_changes_other_days: true }],
  expect: { assets: 1, parents: { "4": 2 }, rate_changes: true },
});
const MOVED: MoveResult = {
  request_id: "r-1", assets: 1, unchanged: [],
  moved: [{ id: 4, name: "Rack 1", from_parent_id: 2, to_parent_id: 7, from_parent_name: "Hall A", to_parent_name: "Yard", change: "parent" }],
  undo: { moves: [{ ids: [4], parent_id: 2, before_id: 5 }], expect: { assets: 1, parents: { "4": 7 } } },
};

const base: Routes = { "GET /api/me": { body: userFor("admin") }, "GET /api/setup": { body: { needed: false } } };

function setup({ ids = [4], routes = {} }: { ids?: number[]; routes?: Routes } = {}, assets: Asset[] = ASSETS) {
  const calls = mockFetch({ ...base, ...routes });
  const onCancel = vi.fn();
  const onMoved = vi.fn();
  const view = renderWithProviders(
    <MoveDialog
      assets={assets}
      index={indexTree(buildTree(assets))}
      ids={ids}
      move={(body: MoveBody) => api.post<MoveResult>("/api/assets/move", body)}
      onCancel={onCancel}
      onMoved={onMoved}
    />,
  );
  return { calls, onCancel, onMoved, ...view };
}
const posts = (calls: { method: string; path: string; body: unknown }[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

const dialog = () => screen.getByRole("dialog");
const search = () => screen.getByRole("searchbox", { name: "Search places" });
const places = () => screen.getByRole("radiogroup", { name: "Places" });
const radio = (name: string) => within(places()).getByRole("radio", { name });
const labels = () => within(places()).getAllByRole("radio").map((r) => r.closest("label")!.textContent);
const primary = () => within(dialog()).getByRole("button", { name: /^(Move|Move anyway|Checking\.\.\.)$/ });
const slot = () => dialog().querySelector(".place-message") as HTMLElement;

describe("MoveDialog", () => {
  it("names the asset in the title, puts the focus in the search box and lists Top level, then every asset in tree order, tellable apart", () => {
    setup();
    expect(screen.getByRole("dialog", { name: 'Move "Rack 1" to...' })).toBeInTheDocument();
    expect(search()).toHaveFocus();
    expect(labels()).toEqual(["Top level", "Site", "Hall A", "Rack 1 (Site / Hall A)", "Rack 2", "Hall B", "Rack 1 (Site / Hall B)", "Yard"]);
    expect(radio("Hall A").closest(".place-row")).toHaveStyle({ "--depth": "1" });
    expect(radio("Rack 2").closest(".place-row")).toHaveStyle({ "--depth": "2" });
  });

  it("says how many assets when several are moved", () => {
    setup({ ids: [4, 5, 7] });
    expect(screen.getByRole("dialog", { name: "Move 3 assets to..." })).toBeInTheDocument();
  });

  it("an id below another id travels inside it: the title counts the roots", () => {
    setup({ ids: [2, 4, 5] });
    expect(screen.getByRole("dialog", { name: 'Move "Hall A" to...' })).toBeInTheDocument();
  });

  it("marks the places it cannot go to aria-disabled with the reason as the radio's description, and keeps the reason out of its name", () => {
    setup(); // Rack 1 of Hall A
    const itself = radio("Rack 1 (Site / Hall A)");
    expect(itself).toHaveAttribute("aria-disabled", "true");
    expect(itself).toHaveAccessibleDescription('"Rack 1" cannot be moved into itself.');
    const clash = radio("Hall B");
    expect(clash).toHaveAttribute("aria-disabled", "true");
    expect(clash).toHaveAccessibleDescription('"Hall B" would have two assets named "Rack 1".');
    expect(radio("Yard")).not.toHaveAttribute("aria-disabled");
    expect(radio("Yard")).not.toHaveAccessibleDescription();
    expect(radio("Top level")).not.toHaveAttribute("aria-disabled");
  });

  it("calls the place the asset already is in (nothing would change) unavailable", () => {
    setup({ ids: [5] }); // Rack 2 is the last child of Hall A
    expect(radio("Hall A")).toHaveAttribute("aria-disabled", "true");
    expect(radio("Hall A")).toHaveAccessibleDescription('"Rack 2" is already there.');
  });

  it("offers the current parent when moving to its end is a reorder", () => {
    setup({ ids: [4] }); // Rack 1 is the first child of Hall A: last child is a different order
    expect(radio("Hall A")).not.toHaveAttribute("aria-disabled");
  });

  it("does not choose a place that is unavailable: a click leaves Move off", async () => {
    setup();
    await userEvent.click(radio("Hall B"));
    expect(radio("Hall B")).not.toBeChecked();
    expect(primary()).toHaveAttribute("aria-disabled", "true");
  });

  it("Move is off until a place is chosen, and a press then asks nothing", async () => {
    const { calls } = setup();
    expect(primary()).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(primary());
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("narrows the list as you type, ignores case, always keeps Top level, and says when nothing matches", async () => {
    setup();
    await userEvent.type(search(), "RACK");
    expect(labels()).toEqual(["Top level", "Rack 1 (Site / Hall A)", "Rack 2", "Rack 1 (Site / Hall B)"]);
    await userEvent.clear(search());
    await userEvent.type(search(), "zzz");
    expect(labels()).toEqual(["Top level"]);
    expect(screen.getByText("No place matches")).toBeInTheDocument();
  });

  it("a place chosen and then filtered away is not chosen any more: Move goes off, and it is chosen again when the search lets it back", async () => {
    setup();
    await userEvent.click(radio("Yard"));
    expect(primary()).not.toHaveAttribute("aria-disabled");
    await userEvent.type(search(), "hall");
    expect(primary()).toHaveAttribute("aria-disabled", "true");
    await userEvent.clear(search());
    expect(radio("Yard")).toBeChecked();
    expect(primary()).not.toHaveAttribute("aria-disabled");
  });

  it("draws at most 300 places in a long tree and tells the person to keep typing; a search reaches the rest", async () => {
    const many: Asset[] = Array.from({ length: 1200 }, (_, i) => asset(i + 1, null, `Asset ${String(i + 1).padStart(4, "0")}`));
    setup({ ids: [1] }, many);
    expect(within(places()).getAllByRole("radio")).toHaveLength(301); // Top level and 300
    expect(screen.getByText("Keep typing to narrow the list")).toBeInTheDocument();
    fireEvent.change(search(), { target: { value: "1199" } });
    expect(labels()).toEqual(["Top level", "Asset 1199"]);
    expect(screen.queryByText("Keep typing to narrow the list")).not.toBeInTheDocument();
  });

  it("moves with the keyboard alone: type to filter, Tab to the list, arrow to a place, Tab to Move, Enter", async () => {
    const { calls, onMoved } = setup({ routes: { "POST /api/assets/move-preview": { body: previewFor() }, "POST /api/assets/move": { body: MOVED } } });
    await userEvent.keyboard("yar");
    expect(labels()).toEqual(["Top level", "Yard"]);
    await userEvent.tab(); // into the radio group: its first radio, Top level
    expect(radio("Top level")).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(radio("Yard")).toBeChecked();
    expect(radio("Yard")).toHaveFocus();
    await userEvent.tab(); // Cancel
    await userEvent.tab(); // Move
    expect(primary()).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onMoved).toHaveBeenCalledWith(MOVED));
    expect(posts(calls, "/api/assets/move-preview")[0].body).toEqual({ moves: [{ ids: [4], parent_id: 7, before_id: null }] });
    expect(posts(calls, "/api/assets/move")[0].body).toEqual({ moves: [{ ids: [4], parent_id: 7, before_id: null }], expect: previewFor().expect });
  });

  it("Enter on a focused place submits the form", async () => {
    const { onMoved } = setup({ routes: { "POST /api/assets/move-preview": { body: previewFor() }, "POST /api/assets/move": { body: MOVED } } });
    await userEvent.click(radio("Yard"));
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
  });

  it("an arrow onto an unavailable place does not choose it", async () => {
    setup(); // Rack 1 of Hall A: itself is the 3rd place
    await userEvent.click(radio("Hall A"));
    expect(radio("Hall A")).toBeChecked();
    await userEvent.keyboard("{ArrowDown}"); // Rack 1 (itself), unavailable
    expect(radio("Rack 1 (Site / Hall A)")).not.toBeChecked();
    expect(radio("Hall A")).toBeChecked();
  });

  it("moves to the top level with parent_id null", async () => {
    const { calls, onMoved } = setup({ routes: { "POST /api/assets/move-preview": { body: previewFor() }, "POST /api/assets/move": { body: MOVED } } });
    await userEvent.click(radio("Top level"));
    await userEvent.click(primary());
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
    expect(posts(calls, "/api/assets/move-preview")[0].body).toEqual({ moves: [{ ids: [4], parent_id: null, before_id: null }] });
  });

  it("shows Checking... while the server is asked, and nothing else can be started meanwhile", async () => {
    const { calls } = setup({ routes: { "POST /api/assets/move-preview": { body: previewFor() }, "POST /api/assets/move": { body: MOVED } } });
    const held = holdFetch((method, path) => method === "POST" && path === "/api/assets/move-preview");
    await userEvent.click(radio("Yard"));
    await userEvent.click(primary());
    expect(screen.getByRole("button", { name: "Checking..." })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(screen.getByRole("button", { name: "Checking..." })); // a second press asks nothing more
    await userEvent.click(radio("Top level")); // the list does not change under the question
    expect(radio("Yard")).toBeChecked();
    held.release();
    await waitFor(() => expect(screen.getByRole("button", { name: "Move" })).toBeInTheDocument());
    expect(posts(calls, "/api/assets/move-preview")).toHaveLength(1);
  });

  it("when no rate changes it moves at once with the preview's expect, and tells the page", async () => {
    const { calls, onMoved } = setup({ routes: { "POST /api/assets/move-preview": { body: previewFor() }, "POST /api/assets/move": { body: MOVED } } });
    await userEvent.click(radio("Yard"));
    await userEvent.click(primary());
    await waitFor(() => expect(onMoved).toHaveBeenCalledWith(MOVED));
    expect(posts(calls, "/api/assets/move")).toHaveLength(1);
    expect(slot()).toHaveTextContent("");
  });

  describe("when the move changes a rate", () => {
    const routes: Routes = { "POST /api/assets/move-preview": { body: RATE_CHANGE }, "POST /api/assets/move": { body: MOVED } };

    it("shows the warning in the reserved slot, turns Move into Move anyway and moves only on the second press", async () => {
      const { calls, onMoved } = setup({ routes });
      await userEvent.click(radio("Yard"));
      await userEvent.click(primary());
      await waitFor(() => expect(screen.getByRole("button", { name: "Move anyway" })).toBeInTheDocument());
      expect(slot()).toHaveTextContent('Moving "Rack 1" changes its rate from 0.18 USD to 0.12 USD per kWh. Past periods are recalculated at the new place, and the totals of both branches change.');
      expect(slot()).toHaveAttribute("aria-live", "polite");
      expect(slot()).not.toHaveAttribute("role");
      expect(dialog().querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(0); // one announcer, and it has no role
      expect(onMoved).not.toHaveBeenCalled();
      expect(posts(calls, "/api/assets/move")).toEqual([]);
      expect(dialog()).toBeInTheDocument(); // still this dialog: no second one on top
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      await userEvent.click(screen.getByRole("button", { name: "Move anyway" }));
      await waitFor(() => expect(onMoved).toHaveBeenCalledWith(MOVED));
      expect(posts(calls, "/api/assets/move-preview")).toHaveLength(1); // the second press did not ask again
      expect(posts(calls, "/api/assets/move")[0].body).toEqual({ moves: [{ ids: [4], parent_id: 7, before_id: null }], expect: RATE_CHANGE.expect });
    });

    it("drops the warning when another place is chosen: the button is Move again", async () => {
      setup({ routes });
      await userEvent.click(radio("Yard"));
      await userEvent.click(primary());
      await screen.findByRole("button", { name: "Move anyway" });
      await userEvent.click(radio("Top level"));
      expect(screen.getByRole("button", { name: "Move" })).toBeInTheDocument();
      expect(slot()).toHaveTextContent("");
    });

    it("keeps the focus where it was (on the button) through the warning", async () => {
      setup({ routes });
      await userEvent.click(radio("Yard"));
      primary().focus();
      await userEvent.keyboard("{Enter}");
      await screen.findByRole("button", { name: "Move anyway" });
      expect(screen.getByRole("button", { name: "Move anyway" })).toHaveFocus();
    });
  });

  describe("when the server says no", () => {
    it("a refusal (422) is told in the slot with its reason, nothing closes, and the choice stays", async () => {
      const { onMoved, onCancel } = setup({ routes: { "POST /api/assets/move-preview": { status: 422, body: { detail: 'Yard already has an asset named "Rack 1".', refusals: [{ id: 4, name: "Rack 1", reason: 'Yard already has an asset named "Rack 1".', code: "name_clash" }] } } } });
      await userEvent.click(radio("Yard"));
      await userEvent.click(primary());
      await waitFor(() => expect(slot()).toHaveTextContent('Yard already has an asset named "Rack 1".'));
      expect(onMoved).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
      expect(radio("Yard")).toBeChecked();
      expect(screen.getByRole("button", { name: "Move" })).toBeInTheDocument();
    });

    it("a 409 stale says the tree changed and asks to choose again", async () => {
      setup({ routes: { "POST /api/assets/move-preview": { status: 409, body: { detail: "Yard is gone.", stale: true } } } });
      await userEvent.click(radio("Yard"));
      await userEvent.click(primary());
      await waitFor(() => expect(slot()).toHaveTextContent("The tree changed; choose again"));
    });

    it("a stale answer to the move itself says the same, and the dialog stays", async () => {
      const { onMoved } = setup({ routes: { "POST /api/assets/move-preview": { body: previewFor() }, "POST /api/assets/move": { status: 409, body: { detail: "A rate changed since you looked.", stale: true } } } });
      await userEvent.click(radio("Yard"));
      await userEvent.click(primary());
      await waitFor(() => expect(slot()).toHaveTextContent("The tree changed; choose again"));
      expect(onMoved).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Move" })).toBeInTheDocument(); // not "Move anyway": the question is asked afresh
    });

    it("'already there' (422 with no refusals) is a note in the slot, not an error", async () => {
      setup({ routes: { "POST /api/assets/move-preview": { status: 422, body: { detail: "Already there: nothing needs to move.", refusals: [], unchanged: [4] } } } });
      await userEvent.click(radio("Yard"));
      await userEvent.click(primary());
      await waitFor(() => expect(slot()).toHaveTextContent("Already there. Choose another place."));
    });

    it("a preview that finds nothing to move (200 with every root unchanged) reads the same", async () => {
      setup({ routes: { "POST /api/assets/move-preview": { body: previewFor({ unchanged: [4], roots: [], assets: 0 }) } } });
      await userEvent.click(radio("Yard"));
      await userEvent.click(primary());
      await waitFor(() => expect(slot()).toHaveTextContent("Already there. Choose another place."));
    });

    it("a network failure is told in the client's words, and the dialog stays", async () => {
      const { onMoved } = setup({ routes: { "POST /api/assets/move-preview": () => { throw new TypeError("Failed to fetch"); } } });
      await userEvent.click(radio("Yard"));
      await userEvent.click(primary());
      await waitFor(() => expect(slot().textContent).not.toBe(""));
      expect(slot().textContent).toMatch(/\S/);
      expect(onMoved).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Move" })).toBeInTheDocument();
    });
  });

  it.each([
    ["with a warning to show", RATE_CHANGE],
    ["with nothing to warn about", previewFor()],
  ])("an answer that comes after the person chose elsewhere is not acted on (%s)", async (_name, answer) => {
    const { onMoved, calls } = setup({ routes: { "POST /api/assets/move-preview": { body: answer }, "POST /api/assets/move": { body: MOVED } } });
    const held = holdFetch((method, path) => method === "POST" && path === "/api/assets/move-preview");
    await userEvent.click(radio("Yard"));
    await userEvent.click(primary());
    // The search takes Yard away while the question is out.
    fireEvent.change(search(), { target: { value: "hall" } });
    await act(async () => { held.release(); });
    expect(screen.getByRole("button", { name: "Move" })).toBeInTheDocument();
    expect(slot()).toHaveTextContent("");
    expect(onMoved).not.toHaveBeenCalled();
    expect(posts(calls, "/api/assets/move")).toEqual([]);
  });

  describe("Cancel and Escape", () => {
    it("Cancel and Escape each call onCancel once", async () => {
      const { onCancel } = setup();
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onCancel).toHaveBeenCalledTimes(1);
      await userEvent.keyboard("{Escape}");
      expect(onCancel).toHaveBeenCalledTimes(2);
    });

    it("Escape may leave a question that is still out (a preview writes nothing)", async () => {
      const { onCancel } = setup({ routes: { "POST /api/assets/move-preview": { body: previewFor() } } });
      holdFetch((method, path) => method === "POST" && path === "/api/assets/move-preview");
      await userEvent.click(radio("Yard"));
      await userEvent.click(primary());
      await userEvent.keyboard("{Escape}");
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("neither works while the move itself is being written", async () => {
      const { onCancel, onMoved } = setup({ routes: { "POST /api/assets/move-preview": { body: previewFor() }, "POST /api/assets/move": { body: MOVED } } });
      const held = holdFetch((method, path) => method === "POST" && path === "/api/assets/move");
      await userEvent.click(radio("Yard"));
      await userEvent.click(primary());
      await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute("aria-disabled", "true"));
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await userEvent.keyboard("{Escape}");
      expect(onCancel).not.toHaveBeenCalled();
      held.release();
      await waitFor(() => expect(onMoved).toHaveBeenCalled());
    });
  });

  it("every button is a plain button except the one that submits", () => {
    setup();
    const buttons = within(dialog()).getAllByRole("button");
    expect(buttons.map((b) => [b.textContent, b.getAttribute("type")])).toEqual([["Cancel", "button"], ["Move", "submit"]]);
  });

  it("keeps Tab inside the dialog", async () => {
    setup();
    await userEvent.click(radio("Yard"));
    await userEvent.tab(); // Cancel
    await userEvent.tab(); // Move
    await userEvent.tab(); // wraps to the search box
    expect(search()).toHaveFocus();
    await userEvent.tab({ shift: true }); // wraps back to Move
    expect(primary()).toHaveFocus();
  });
});

describe("moveFailure and nothingChanges", () => {
  it("tells apart already-there, stale, refused and everything else", async () => {
    mockFetch({
      "POST /a": { status: 422, body: { detail: "Already there: nothing needs to move.", refusals: [], unchanged: [1] } },
      "POST /b": { status: 422, body: { detail: "Row A already has Pump.", refusals: [{ id: 1, name: "P", reason: "Row A already has Pump.", code: "name_clash" }] } },
      "POST /c": { status: 409, body: { detail: "gone", stale: true } },
      "POST /d": { status: 409, body: { detail: "conflict" } },
      "POST /e": { status: 403, body: { detail: "insufficient permission" } },
      "POST /f": { status: 422, body: { detail: [{ loc: ["body", "moves"], msg: "too many" }] } },
    });
    const fail = async (path: string) => moveFailure(await api.post(path, {}).catch((e: unknown) => e));
    expect(await fail("/a")).toEqual({ kind: "already" });
    expect(await fail("/b")).toEqual({ kind: "refused", text: "Row A already has Pump." });
    expect(await fail("/c")).toEqual({ kind: "stale" });
    expect(await fail("/d")).toEqual({ kind: "other", text: "conflict" });
    expect(await fail("/e")).toEqual({ kind: "other", text: "Your role does not allow this." });
    expect(await fail("/f")).toEqual({ kind: "refused", text: "moves: too many" });
    expect(moveFailure(new Error("Failed to fetch"))).toEqual({ kind: "other", text: "Failed to fetch" });
  });

  it("nothingChanges: every root unchanged, or no root moves at all", () => {
    expect(nothingChanges(previewFor({ unchanged: [4], roots: [] }), [4])).toBe(true);
    expect(nothingChanges(previewFor({ unchanged: [4, 5], roots: [] }), [4, 5])).toBe(true);
    expect(nothingChanges(previewFor({ unchanged: [4] }), [4])).toBe(true);
    expect(nothingChanges(previewFor({ unchanged: [4] }), [4, 5])).toBe(false);
    expect(nothingChanges(previewFor(), [4])).toBe(false);
  });
});
