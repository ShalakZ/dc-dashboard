import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { Route, Routes, useLocation } from "react-router";
import { useFleetSummary } from "../api/queries";
import { mockFetch } from "../test/fetchMock";
import { CacheProbes, probeFetches, probeRoutes } from "../test/cacheProbes";
import { FakeEventSource } from "../test/fakeEventSource";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { userFor } from "../test/users";
import { AssetPage } from "./AssetPage";
import { AssetsPage } from "./AssetsPage";
import { AssetsSummary } from "./AssetsSummary";

const assets = [
  { id: 1, parent_id: null, name: "Site", kind: "site", sort_order: 0 },
  { id: 2, parent_id: 1, name: "Room A", kind: "room", sort_order: 0 },
];
type Fixture = typeof assets;

/** The asset page's summary. No mapped metric by default, so no stream opens and no live chip joins the header's actions. */
const summaryOf = (asset: Fixture[number], metrics: unknown[] = []) => ({ asset, metrics, energy_today: null, cost_today: null, currency: "QAR" });
/** What every asset page asks for besides the list: its summary, the trend's series and the site zone. */
const pageRoutes = (list: Fixture) => ({
  "GET /api/site": { body: { timezone: "Asia/Qatar", currency: "QAR" } },
  ...Object.fromEntries(list.flatMap((a) => [
    [`GET /api/assets/${a.id}/summary`, { body: summaryOf(a) }],
    [`GET /api/assets/${a.id}/series`, { body: { metric: "active_power_kw", unit: "kW", points: [] } }],
  ])),
});
/** The fleet summary of a site with nothing to report. The index page asks for it, and an unmocked request is a 500 (a second role="alert"). */
const emptyFleet = { power: { kw: null, counted: 0, of: 0 }, energy_today: null, cost_today: null, currency: null, attention: { total: 0, items: [] } };
const authed = (role: string, list: Fixture = assets) => ({
  "GET /api/fleet/summary": { body: emptyFleet },
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor(role) },
  "GET /api/assets": { body: list },
  ...pageRoutes(list),
});

/** The location, as text, so that a test can say where a click or a delete landed. */
function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}
const where = () => screen.getByTestId("where").textContent;

/** Next to the page: keeps the fleet summary query mounted, so a test can count how often it is fetched (it is fetched again only when something invalidates it). */
function FleetProbe() {
  useFleetSummary();
  return null;
}
const cacheCounts = (calls: { path: string }[]) => ({ ...probeFetches(calls), fleet: calls.filter((c) => c.path === "/api/fleet/summary").length });

/** The Assets workspace as App mounts it: the layout with the real index page and the real asset page. `extra` renders outside the routes. */
function renderWorkspace(route: string, { extra }: { extra?: ReactElement } = {}) {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/assets" element={<AssetsPage />}>
          <Route index element={<AssetsSummary />} />
          <Route path=":id" element={<AssetPage />} />
        </Route>
      </Routes>
      <Where />
      {extra}
    </>,
    { route, path: "*" },
  );
}

// The real asset page opens a stream when its asset has points; jsdom has no EventSource.
beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("AssetsPage", () => {
  it("renders the hierarchy as a nested tree", async () => {
    mockFetch(authed("viewer"));
    renderWorkspace("/assets");
    const site = await screen.findByRole("link", { name: "Site" });
    expect(within(site.closest("li")!).getByRole("link", { name: "Room A" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add asset" })).not.toBeInTheDocument();
  });

  describe("while the asset list loads", () => {
    const holdAssets = () => holdFetch((method, path) => method === "GET" && path === "/api/assets");
    const tree = () => screen.getByRole("region", { name: "Asset tree" });
    const regionOf = (label: string) => screen.getByText(label).parentElement!;

    it("shows the layout at once: the tree column with its status region, and the index page in the pane with its own", async () => {
      mockFetch(authed("admin"));
      const held = holdAssets();
      renderWorkspace("/assets");
      expect(tree().closest(".assets-layout")).not.toBeNull();
      expect(within(tree()).getByText("Loading the asset tree").parentElement).toHaveAttribute("role", "status");
      const pane = document.querySelector(".assets-detail") as HTMLElement;
      expect(within(pane).getByRole("heading", { name: "Assets Tree", level: 1 })).toBeInTheDocument(); // the Outlet's page is mounted
      expect(within(pane).getByText("Loading the fleet summary").parentElement).toHaveAttribute("role", "status");
      expect(screen.queryByText("loading…")).not.toBeInTheDocument();
      held.release();
      expect(await screen.findByRole("link", { name: "Site" })).toBeInTheDocument();
    });

    it("keeps every way to add an asset disabled until the list is there: the tree's +, the page's Add asset and a node's +", async () => {
      mockFetch(authed("admin"));
      const held = holdAssets();
      renderWorkspace("/assets");
      await screen.findByRole("button", { name: "Add a top-level asset" }); // an admin's: the account is known a moment after the layout
      expect(screen.getByRole("button", { name: "Add a top-level asset" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Add asset" })).toBeDisabled();
      await userEvent.click(screen.getByRole("button", { name: "Add asset" })); // a disabled button does nothing: no form opens without the parent list
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      held.release();
      await screen.findByRole("link", { name: "Site" });
      expect(screen.getByRole("button", { name: "Add a top-level asset" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Add asset" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Add child of Site" })).toBeEnabled();
    });

    it("after the release the tree has its rows and its column holds no region (the pane's own may still be waiting)", async () => {
      mockFetch(authed("viewer"));
      const held = holdAssets();
      renderWorkspace("/assets");
      const before = tree();
      held.release();
      const site = await screen.findByRole("link", { name: "Site" });
      expect(within(site.closest("li")!).getByRole("link", { name: "Room A" })).toBeInTheDocument();
      expect(tree()).toBe(before); // the same column, filled
      expect(within(tree()).queryByRole("status")).not.toBeInTheDocument();
      expect(screen.getByRole("searchbox", { name: "Filter assets" })).toBeInTheDocument();
    });

    it("puts a stored tree width on the skeleton column", async () => {
      localStorage.setItem("dcdash.assetTreeWidth", "340");
      mockFetch(authed("viewer"));
      const held = holdAssets();
      renderWorkspace("/assets");
      expect(tree().style.getPropertyValue("--tree-user-w")).toBe("340px");
      held.release();
      await screen.findByRole("link", { name: "Site" });
      expect(tree().style.getPropertyValue("--tree-user-w")).toBe("340px");
    });

    it("on an asset's URL the pane holds the asset's skeleton (the crumbs need the list), then the asset", async () => {
      mockFetch(authed("viewer"));
      const held = holdAssets();
      renderWorkspace("/assets/2");
      expect(regionOf("Loading the asset")).toHaveClass("asset-page");
      expect(screen.queryByRole("heading", { name: "Room A" })).not.toBeInTheDocument();
      held.release();
      expect(await screen.findByRole("heading", { name: "Room A", level: 1 })).toBeInTheDocument();
      expect(screen.queryByText("Loading the asset")).not.toBeInTheDocument();
    });

    it("an assets error still replaces the whole layout with the error", async () => {
      mockFetch({ ...authed("viewer"), "GET /api/assets": { status: 500, body: { detail: "assets are down" } } });
      renderWorkspace("/assets");
      expect(await screen.findByRole("alert")).toHaveTextContent("assets are down");
      expect(screen.queryByRole("region", { name: "Asset tree" })).not.toBeInTheDocument();
      expect(document.querySelector(".assets-layout")).toBeNull();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });

  it("lets an admin add a child asset", async () => {
    const calls = mockFetch({
      ...authed("admin"),
      "POST /api/assets": { status: 201, body: { id: 3, parent_id: 1, name: "Room B", kind: "generic", sort_order: 0 } },
    });
    renderWorkspace("/assets");
    await userEvent.click(await screen.findByRole("button", { name: "Add asset" }));
    await userEvent.type(screen.getByLabelText("Name"), "Room B");
    await userEvent.selectOptions(screen.getByLabelText("Parent"), "1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Room B", parent_id: 1, kind: "generic", sort_order: 0 });
  });

  describe("dialogs and the + on each branch", () => {
    const created = { status: 201, body: { id: 3, parent_id: 1, name: "Room B", kind: "generic", sort_order: 0 } };
    const posts = (calls: { method: string; body?: unknown }[]) => calls.filter((c) => c.method === "POST");

    it("shows a + on every node for an admin, named after the node", async () => {
      mockFetch(authed("admin"));
      renderWorkspace("/assets");
      const plus = await screen.findByRole("button", { name: "Add child of Site" });
      expect(plus).toHaveAttribute("type", "button");
      expect(plus.textContent).toBe(""); // an icon button: the name comes from aria-label, the svg is decoration
      expect(plus.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(screen.getByRole("button", { name: "Add child of Room A" })).toHaveAttribute("type", "button");
    });

    it.each(["viewer", "operator"])("shows no + to a %s", async (role) => {
      mockFetch(authed(role));
      renderWorkspace("/assets");
      await screen.findByRole("link", { name: "Site" });
      expect(screen.queryByRole("button", { name: /Add child of/ })).not.toBeInTheDocument();
    });

    it("the + opens one dialog titled Add asset with that node as the parent, and Save posts it and closes", async () => {
      const calls = mockFetch({ ...authed("admin"), "POST /api/assets": created });
      renderWorkspace("/assets");
      await userEvent.click(await screen.findByRole("button", { name: "Add child of Site" }));
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      const dialog = screen.getByRole("dialog", { name: "Add asset" });
      expect(within(dialog).getByLabelText("Parent")).toHaveValue("1");
      await userEvent.type(within(dialog).getByLabelText("Name"), "Room B");
      await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(posts(calls).map((c) => c.body)).toEqual([{ name: "Room B", parent_id: 1, kind: "generic", sort_order: 0 }]);
    });

    it.each([
      ["Cancel", async () => userEvent.click(screen.getByRole("button", { name: "Cancel" }))],
      ["Escape", async () => userEvent.keyboard("{Escape}")],
    ])("%s closes the dialog without a request", async (_how, close) => {
      const calls = mockFetch({ ...authed("admin"), "POST /api/assets": created });
      renderWorkspace("/assets");
      await userEvent.click(await screen.findByRole("button", { name: "Add child of Room A" }));
      expect(screen.getByRole("dialog", { name: "Add asset" })).toBeInTheDocument();
      await close();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(posts(calls)).toHaveLength(0);
    });

    it("the Add asset button opens the dialog with no parent when nothing is selected", async () => {
      mockFetch(authed("admin"));
      renderWorkspace("/assets");
      await userEvent.click(await screen.findByRole("button", { name: "Add asset" }));
      const dialog = screen.getByRole("dialog", { name: "Add asset" });
      expect(within(dialog).getByLabelText("Parent")).toHaveValue("");
    });

    it("the Add asset button opens the dialog with the selected asset as the parent", async () => {
      mockFetch(authed("admin"));
      renderWorkspace("/assets/2");
      await userEvent.click(await screen.findByRole("button", { name: "Add asset" }));
      expect(within(screen.getByRole("dialog", { name: "Add asset" })).getByLabelText("Parent")).toHaveValue("2");
    });

    it("Edit opens the same form, titled Edit asset, with the asset's values", async () => {
      mockFetch(authed("admin"));
      renderWorkspace("/assets/2");
      await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      const dialog = screen.getByRole("dialog", { name: "Edit asset" });
      expect(within(dialog).getByLabelText("Name")).toHaveValue("Room A");
      expect(within(dialog).getByLabelText("Parent")).toHaveValue("1");
      expect(within(dialog).getByLabelText("Kind")).toHaveValue("room");
    });

    it("Escape on a dialog opened by Add asset puts focus back on the Add asset button", async () => {
      mockFetch(authed("admin"));
      renderWorkspace("/assets");
      const add = await screen.findByRole("button", { name: "Add asset" });
      await userEvent.click(add);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(add).toHaveFocus();
    });

    it("Cancel on a dialog opened by Edit puts focus back on the Edit button", async () => {
      mockFetch(authed("admin"));
      renderWorkspace("/assets/2");
      const edit = await screen.findByRole("button", { name: "Edit" });
      await userEvent.click(edit);
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(edit).toHaveFocus();
    });
  });

  describe("the asset tree column", () => {
    // A local fixture (the shared one is counted by other tests): a second root that never matches "panel", and a leaf two levels down.
    const deep = [
      { id: 1, parent_id: null, name: "Site", kind: "site", sort_order: 0 },
      { id: 2, parent_id: 1, name: "Room A", kind: "room", sort_order: 0 },
      { id: 3, parent_id: 2, name: "Panel 1", kind: "panel", sort_order: 0 },
      { id: 4, parent_id: 1, name: "Room B", kind: "room", sort_order: 1 },
      { id: 5, parent_id: null, name: "Yard", kind: "outdoor", sort_order: 1 },
    ];
    const show = async (role = "viewer", route = "/assets") => {
      mockFetch(authed(role, deep));
      renderWorkspace(route);
      // in the tree: on an asset's URL the page's crumbs hold a "Site" link too, and they arrive in the same commit
      await within(await screen.findByRole("region", { name: "Asset tree" })).findByRole("link", { name: "Site" });
    };
    const column = () => screen.getByRole("region", { name: "Asset tree" });
    const link = (name: string) => screen.queryByRole("link", { name });
    const typeFilter = (text: string) => userEvent.type(screen.getByLabelText("Filter assets"), text);

    it("has a pane that Skip the tree can land on: #asset-detail takes focus, and a click on the link puts it there", async () => {
      await show("viewer", "/assets/3");
      const pane = document.getElementById("asset-detail")!;
      expect(pane).toHaveClass("assets-detail");
      expect(pane).toHaveAttribute("tabindex", "-1");
      await userEvent.click(within(column()).getByRole("link", { name: "Skip the tree" }));
      expect(pane).toHaveFocus();
    });

    it("is a region named Asset tree; the title is plain text, so the h1 is the only heading named Assets Tree, and there is no legend", async () => {
      await show();
      expect(within(column()).getByText("Assets Tree")).toBeInTheDocument();
      expect(screen.getAllByRole("heading", { name: "Assets Tree" })).toHaveLength(1);
      expect(screen.getByRole("heading", { name: "Assets Tree", level: 1 })).toBeInTheDocument();
      expect(screen.queryByRole("group")).not.toBeInTheDocument();
      expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    });

    it("keeps the nested lists of the old tree: the only lists on the page, children inside the parent's li", async () => {
      await show();
      const lists = screen.getAllByRole("list");
      expect(lists.length).toBeGreaterThan(0);
      for (const list of lists) expect(column()).toContainElement(list);
      expect(within(link("Room A")!.closest("li")!).getByRole("link", { name: "Panel 1" })).toBeInTheDocument();
    });

    it("a twisty collapses and expands its branch; a leaf has none", async () => {
      await show();
      const twisty = screen.getByRole("button", { name: "Children of Site" });
      expect(twisty).toHaveAttribute("aria-expanded", "true");
      expect(screen.queryByRole("button", { name: "Children of Room B" })).not.toBeInTheDocument();
      await userEvent.click(twisty);
      expect(twisty).toHaveAttribute("aria-expanded", "false");
      expect(link("Room A")).not.toBeInTheDocument(); // hidden, so not in the accessibility tree
      expect(link("Panel 1")).not.toBeInTheDocument();
      expect(link("Yard")).toBeInTheDocument();
      expect(document.getElementById(twisty.getAttribute("aria-controls")!)).toBeInTheDocument(); // collapsed is hidden, not removed
      await userEvent.click(twisty);
      expect(twisty).toHaveAttribute("aria-expanded", "true");
      expect(link("Room A")).toBeInTheDocument();
      expect(link("Panel 1")).toBeInTheDocument();
    });

    it("the tree toggle flips its name and aria-expanded, hides the body, keeps focus and is remembered", async () => {
      await show();
      const toggle = screen.getByRole("button", { name: "Minimize asset tree" });
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(toggle).toHaveAttribute("aria-controls", "asset-tree-body");
      await userEvent.click(toggle);
      expect(toggle).toHaveAccessibleName("Expand asset tree");
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).toHaveFocus();
      expect(document.getElementById("asset-tree-body")).not.toBeVisible();
      expect(link("Site")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Filter assets")).not.toBeVisible(); // kept mounted, so the typed filter and the folds survive
      expect(localStorage.getItem("dcdash.assetTree")).toBe("minimized");
      await userEvent.click(toggle);
      expect(toggle).toHaveAccessibleName("Minimize asset tree");
      expect(document.getElementById("asset-tree-body")).toBeVisible();
      expect(link("Site")).toBeInTheDocument();
      expect(localStorage.getItem("dcdash.assetTree")).toBe("expanded");
    });

    it("minimized, only the toggle is left of the header (no title, no top-level +)", async () => {
      await show("admin");
      expect(screen.getByRole("button", { name: "Add a top-level asset" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Minimize asset tree" }));
      expect(screen.queryByRole("button", { name: "Add a top-level asset" })).not.toBeInTheDocument();
      expect(within(column()).queryByText("Assets Tree")).not.toBeInTheDocument();
      expect(within(column()).getAllByRole("button")).toHaveLength(1);
    });

    it("starts minimized when minimized was remembered", async () => {
      localStorage.setItem("dcdash.assetTree", "minimized");
      mockFetch(authed("viewer", deep));
      renderWorkspace("/assets");
      expect(await screen.findByRole("button", { name: "Expand asset tree" })).toHaveAttribute("aria-expanded", "false");
      expect(link("Site")).not.toBeInTheDocument();
    });

    it("renders expanded and does not throw when storage is blocked", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
      await show();
      await userEvent.click(screen.getByRole("button", { name: "Minimize asset tree" }));
      expect(screen.getByRole("button", { name: "Expand asset tree" })).toBeInTheDocument(); // works for this visit, just not remembered
    });

    it("a filter keeps what matches by name or kind, with its ancestors, whatever the case", async () => {
      await show();
      await typeFilter("PANEL");
      expect(link("Panel 1")).toBeInTheDocument();
      expect(link("Room A")).toBeInTheDocument(); // ancestors stay
      expect(link("Site")).toBeInTheDocument();
      expect(link("Room B")).not.toBeInTheDocument();
      expect(link("Yard")).not.toBeInTheDocument();
      await userEvent.clear(screen.getByLabelText("Filter assets"));
      await typeFilter("outdoor"); // by kind
      expect(link("Yard")).toBeInTheDocument();
      expect(link("Site")).not.toBeInTheDocument();
      await userEvent.clear(screen.getByLabelText("Filter assets"));
      expect(link("Room B")).toBeInTheDocument(); // cleared: everything is back
      expect(link("Panel 1")).toBeInTheDocument();
    });

    it("a match under a collapsed branch is shown anyway, the twisties wait while filtering, and clearing restores the collapse", async () => {
      await show();
      await userEvent.click(screen.getByRole("button", { name: "Children of Room A" }));
      expect(link("Panel 1")).not.toBeInTheDocument();
      await typeFilter("panel");
      expect(link("Panel 1")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Children of Room A" })).toBeDisabled();
      await userEvent.clear(screen.getByLabelText("Filter assets"));
      expect(link("Panel 1")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Children of Room A" })).toBeEnabled();
    });

    it("says so when nothing matches", async () => {
      await show();
      await typeFilter("zzz");
      expect(screen.getByText("No assets match the filter.")).toBeInTheDocument();
      expect(screen.queryAllByRole("link").map((l) => l.textContent)).toEqual(["Skip the tree"]); // no row is left, only the skip link
    });

    it("gives each name a title with the full name; the selected one (the asset in the URL) carries aria-current", async () => {
      await show("viewer", "/assets/3");
      expect(within(column()).getByRole("link", { name: "Panel 1" })).toHaveAttribute("title", "Panel 1");
      expect(within(column()).getByRole("link", { name: "Panel 1" })).toHaveAttribute("aria-current", "true");
      expect(within(column()).getByRole("link", { name: "Room A" })).not.toHaveAttribute("aria-current");
    });

    it("a + on a collapsed branch opens it again", async () => {
      await show("admin");
      await userEvent.click(screen.getByRole("button", { name: "Children of Site" }));
      expect(link("Room A")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Add child of Site" }));
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(link("Room A")).toBeInTheDocument();
    });

    it("the top-level + (admin only) opens Add asset with no parent, even with an asset selected", async () => {
      await show("admin", "/assets/2");
      await userEvent.click(screen.getByRole("button", { name: "Add a top-level asset" }));
      expect(within(screen.getByRole("dialog", { name: "Add asset" })).getByLabelText("Parent")).toHaveValue("");
    });

    it.each(["viewer", "operator"])("shows no top-level + to a %s", async (role) => {
      await show(role);
      expect(screen.queryByRole("button", { name: "Add a top-level asset" })).not.toBeInTheDocument();
    });

    it("nothing selected: the h1 and no details, no Selected line", async () => {
      await show();
      expect(screen.queryByText("Kind", { selector: "dt" })).not.toBeInTheDocument();
      expect(screen.queryByText(/Selected:/)).not.toBeInTheDocument();
    });

    describe("the tree and the pane are one workspace", () => {
      it("clicking a node navigates and the asset's tiles, Trend and Metrics appear in the pane, with no second click", async () => {
        await show();
        expect(where()).toBe("/assets");
        expect(await screen.findByRole("heading", { name: "By kind", level: 2 })).toBeInTheDocument(); // the index page is the fleet summary
        await userEvent.click(within(column()).getByRole("link", { name: "Room B" }));
        expect(await screen.findByRole("heading", { name: "Room B", level: 1 })).toBeInTheDocument();
        expect(where()).toBe("/assets/4");
        expect(screen.getByText("Live power")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Trend", level: 2 })).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Metrics", level: 2 })).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "By kind" })).not.toBeInTheDocument();
      });

      it("selecting highlights the node: aria-current follows the URL from one asset to the next", async () => {
        await show();
        expect(within(column()).getByRole("link", { name: "Room A" })).not.toHaveAttribute("aria-current");
        await userEvent.click(within(column()).getByRole("link", { name: "Room A" }));
        await screen.findByRole("heading", { name: "Room A", level: 1 });
        expect(within(column()).getByRole("link", { name: "Room A" })).toHaveAttribute("aria-current", "true");
        await userEvent.click(within(column()).getByRole("link", { name: "Room B" }));
        await screen.findByRole("heading", { name: "Room B", level: 1 });
        expect(within(column()).getByRole("link", { name: "Room B" })).toHaveAttribute("aria-current", "true");
        expect(within(column()).getByRole("link", { name: "Room A" })).not.toHaveAttribute("aria-current");
        expect(within(column()).getAllByRole("link").filter((a) => a.hasAttribute("aria-current"))).toHaveLength(1);
      });

      it("the column stays mounted and keeps its folds when you move between two assets", async () => {
        await show();
        const before = column();
        await userEvent.click(screen.getByRole("button", { name: "Children of Room A" })); // folds Panel 1 away
        await userEvent.click(within(column()).getByRole("link", { name: "Site" }));
        await screen.findByRole("heading", { name: "Site", level: 1 });
        await userEvent.click(within(column()).getByRole("link", { name: "Room B" }));
        await screen.findByRole("heading", { name: "Room B", level: 1 });
        expect(column()).toBe(before);
        expect(before.isConnected).toBe(true);
        expect(screen.getByRole("button", { name: "Children of Room A" })).toHaveAttribute("aria-expanded", "false");
        expect(link("Panel 1")).not.toBeInTheDocument();
      });

      it("the column keeps the filter text (and the input itself) when you move between two assets", async () => {
        await show();
        await typeFilter("room");
        const filter = screen.getByLabelText("Filter assets");
        await userEvent.click(within(column()).getByRole("link", { name: "Room A" }));
        await screen.findByRole("heading", { name: "Room A", level: 1 });
        await userEvent.click(within(column()).getByRole("link", { name: "Room B" }));
        await screen.findByRole("heading", { name: "Room B", level: 1 });
        expect(screen.getByLabelText("Filter assets")).toBe(filter);
        expect(filter).toHaveValue("room");
        expect(link("Yard")).not.toBeInTheDocument(); // still filtered
      });

      it("a viewer sees no Edit, Delete or Add asset on an asset's page, and no + in the tree", async () => {
        await show("viewer", "/assets/2");
        await screen.findByRole("heading", { name: "Room A", level: 1 });
        for (const name of ["Edit", "Delete Room A", "Add asset", "Add a top-level asset"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Add child of/ })).not.toBeInTheDocument();
      });

      it("the asset page has no Kind/Parent/Children block and no Selected line: the tree link is the only link to the asset in the list", async () => {
        await show("viewer", "/assets/2");
        await screen.findByRole("heading", { name: "Room A", level: 1 });
        for (const label of ["Kind", "Parent", "Children"]) expect(screen.queryByText(label, { selector: "dt" })).not.toBeInTheDocument();
        expect(screen.queryByText(/Selected:/)).not.toBeInTheDocument();
        expect(screen.queryByText(/open page/)).not.toBeInTheDocument();
        expect(screen.getAllByRole("link", { name: "Room A" })).toHaveLength(1);
      });

      it("an asset with points puts the live chip first in the header's actions, then the admin's Edit, the Delete trash button and Add asset", async () => {
        const point = { mapping_id: 1, point_id: 7, metric: "active_power_kw", unit: "kW", value: 10.5, ts: "2026-10-07T10:00:00+00:00", quality: 0 };
        mockFetch({ ...authed("admin", deep), "GET /api/assets/2/summary": { body: summaryOf(deep[1], [point]) } });
        renderWorkspace("/assets/2");
        const head = (await screen.findByRole("heading", { name: "Room A", level: 1 })).closest("header")!;
        const actions = head.querySelector(".actions")!;
        // the trash button is an icon: its name is the aria-label, not text
        expect([...actions.children].map((c) => c.textContent || c.getAttribute("aria-label"))).toEqual(["reconnecting…", "Edit", "Delete Room A", "Add asset"]);
        expect(actions.children[0]).toHaveClass("chip");
      });
    });
  });

  it("tells two assets with one name apart in the Add asset form's Parent list", async () => {
    mockFetch({
      ...authed("admin"),
      "GET /api/assets": { body: [
        { id: 1, parent_id: null, name: "Room 1", kind: "room", sort_order: 0 },
        { id: 2, parent_id: null, name: "Room 2", kind: "room", sort_order: 1 },
        { id: 3, parent_id: 1, name: "LV Panel", kind: "panel", sort_order: 0 },
        { id: 4, parent_id: 2, name: "LV Panel", kind: "panel", sort_order: 0 },
      ] },
    });
    renderWorkspace("/assets");
    await userEvent.click(await screen.findByRole("button", { name: "Add asset" }));
    const texts = within(screen.getByLabelText("Parent")).getAllByRole("option").map((o) => o.textContent!.replace(/ /g, "").trim());
    expect(texts).toEqual(["(none)", "Room 1", "LV Panel (Room 1)", "Room 2", "LV Panel (Room 2)"]);
  });

  it("shows the API error when a move is rejected", async () => {
    mockFetch({
      ...authed("admin"),
      "PATCH /api/assets/1": { status: 422, body: { detail: "an asset cannot be moved under itself or its own descendants" } },
    });
    renderWorkspace("/assets/1");
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot be moved under itself");
  });

  it("shows the API's refusal when the name already exists under that parent", async () => {
    mockFetch({
      ...authed("admin"),
      "POST /api/assets": { status: 409, body: { detail: 'an asset named "Room A" already exists under "Site"; choose another name' } },
    });
    renderWorkspace("/assets");
    await userEvent.click(await screen.findByRole("button", { name: "Add asset" }));
    await userEvent.type(screen.getByLabelText("Name"), "Room A");
    await userEvent.selectOptions(screen.getByLabelText("Parent"), "1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent('an asset named "Room A" already exists under "Site"');
    expect(screen.getByLabelText("Name")).toHaveValue("Room A"); // the form stays open with what was typed
  });

  describe("saving refreshes the fleet figures too", () => {
    it("a new asset and an edited one each fetch the fleet summary again", async () => {
      const calls = mockFetch({
        ...authed("admin"),
        "POST /api/assets": { status: 201, body: { id: 3, parent_id: 1, name: "Room B", kind: "generic", sort_order: 0 } },
        "PATCH /api/assets/2": { body: { ...assets[1], name: "Room A2" } },
      });
      renderWorkspace("/assets/2", { extra: <FleetProbe /> });
      const fleet = () => cacheCounts(calls).fleet;
      await waitFor(() => expect(fleet()).toBe(1));
      await userEvent.click(await screen.findByRole("button", { name: "Add asset" }));
      await userEvent.type(screen.getByLabelText("Name"), "Room B");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fleet()).toBe(2));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await userEvent.click(screen.getByRole("button", { name: "Edit" }));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fleet()).toBe(3));
    });
  });

  describe("deleting", () => {
    const impact = { detail: "needs confirmation", assets: 2, mappings: 3, tariffs: 1 };
    /** DELETE answers 409 with the counts until the request carries confirm=true. `needsConfirm` false = a plain asset. */
    function setup(needsConfirm: boolean, confirmed: { status: number; body?: object } = { status: 204 }, probes = false) {
      const urls: string[] = [];
      let removed = false;
      const calls = mockFetch({
        ...authed("admin"),
        ...(probes ? probeRoutes : {}),
        "GET /api/assets": () => ({ body: removed ? [assets[0]] : assets }),
        "DELETE /api/assets/2": ({ url }) => {
          urls.push(url);
          if (needsConfirm && !url.includes("confirm=true")) return { status: 409, body: impact };
          if (confirmed.status === 204) removed = true;
          return confirmed;
        },
      });
      renderWorkspace("/assets/2", { extra: probes ? <><CacheProbes /><FleetProbe /></> : undefined });
      return { calls, urls };
    }
    const deletes = (calls: { method: string }[]) => calls.filter((c) => c.method === "DELETE").length;
    const click = async (name: string) => userEvent.click(await screen.findByRole("button", { name }));

    beforeEach(() => { vi.spyOn(window, "confirm").mockReturnValue(true); });

    it("deletes a plain asset as before: one request, no dialog, and the page lands on /assets", async () => {
      const { calls, urls } = setup(false);
      await click("Delete Room A");
      await waitFor(() => expect(screen.queryByRole("button", { name: "Delete Room A" })).not.toBeInTheDocument());
      expect(urls).toEqual(["/api/assets/2"]);
      expect(deletes(calls)).toBe(1);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(where()).toBe("/assets"); // not a dead /assets/2
      expect(await screen.findByRole("heading", { name: "By kind", level: 2 })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Assets Tree", level: 1 })).toBeInTheDocument();
    });

    it.each([["a plain asset", false], ["an asset with mappings, after Delete anyway", true]])(
      "refreshes billing, the dashboards' widget data, the tariff list and the fleet summary too, because they depend on the asset: %s",
      async (_case, needsConfirm) => {
        const { calls } = setup(needsConfirm, undefined, true);
        await waitFor(() => expect(cacheCounts(calls)).toEqual({ billing: 1, widgetData: 1, tariffs: 1, fleet: 1 }));
        await click("Delete Room A");
        if (needsConfirm) await userEvent.click(await screen.findByRole("button", { name: "Delete anyway" }));
        // The fleet summary is fetched three times: at the start, again when the summary page mounts after the redirect to /assets (its entry is stale), and once more by the invalidation.
        await waitFor(() => expect(cacheCounts(calls)).toEqual({ billing: 2, widgetData: 2, tariffs: 2, fleet: 3 }));
      },
    );

    it("sends nothing when the first confirmation is declined", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(false);
      const { calls } = setup(true);
      await click("Delete Room A");
      expect(deletes(calls)).toBe(0);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows what will be lost when the API asks for confirmation", async () => {
      setup(true);
      await click("Delete Room A");
      const dialog = await screen.findByRole("dialog", { name: 'Delete "Room A"?' });
      expect(dialog).toHaveTextContent(
        "2 assets, 3 mappings and 1 tariff will be deleted; their past energy and cost figures disappear from Billing and dashboards.",
      );
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Delete anyway" })).toBeInTheDocument();
    });

    it("Cancel closes the dialog and deletes nothing", async () => {
      const { calls, urls } = setup(true);
      await click("Delete Room A");
      await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(urls).toEqual(["/api/assets/2"]); // only the first, refused request
      expect(deletes(calls)).toBe(1);
      expect(where()).toBe("/assets/2"); // still on the asset, still in the tree
      expect(screen.getByRole("heading", { name: "Room A", level: 1 })).toBeInTheDocument();
      expect(within(screen.getByRole("region", { name: "Asset tree" })).getByRole("link", { name: "Room A" })).toHaveAttribute("aria-current", "true");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("Delete anyway repeats the request with confirm=true, then closes, refreshes the tree and lands on /assets", async () => {
      const { urls } = setup(true);
      await click("Delete Room A");
      await userEvent.click(await screen.findByRole("button", { name: "Delete anyway" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(urls).toEqual(["/api/assets/2", "/api/assets/2?confirm=true"]);
      await waitFor(() => expect(screen.queryByRole("link", { name: "Room A" })).not.toBeInTheDocument());
      await waitFor(() => expect(where()).toBe("/assets")); // navigate() renders in a transition, which may land after the list refetch
      expect(await screen.findByRole("heading", { name: "By kind", level: 2 })).toBeInTheDocument();
    });

    it("keeps the dialog open and says why when the confirmed request fails", async () => {
      setup(true, { status: 403, body: { detail: "admin role required" } });
      await click("Delete Room A");
      await userEvent.click(await screen.findByRole("button", { name: "Delete anyway" }));
      const dialog = await screen.findByRole("dialog");
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("admin role required");
      expect(where()).toBe("/assets/2"); // a failed delete does not leave the asset
    });

    it("shows any other 409 as a plain alert above the page, not as a confirmation", async () => {
      mockFetch({ ...authed("admin"), "DELETE /api/assets/2": { status: 409, body: { detail: "something else" } } });
      renderWorkspace("/assets/2");
      await click("Delete Room A");
      expect(await screen.findByRole("alert")).toHaveTextContent("something else");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(where()).toBe("/assets/2");
    });
  });

  describe("while a request is in flight", () => {
    it("ignores Escape and Cancel during a save, then closes the dialog when the save is done", async () => {
      const calls = mockFetch({
        ...authed("admin"),
        "POST /api/assets": { status: 201, body: { id: 3, parent_id: 1, name: "Room B", kind: "generic", sort_order: 0 } },
      });
      const hold = holdFetch((method, path) => method === "POST" && path === "/api/assets");
      renderWorkspace("/assets");
      await userEvent.click(await screen.findByRole("button", { name: "Add asset" }));
      await userEvent.type(screen.getByLabelText("Name"), "Room B");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      const dialog = screen.getByRole("dialog", { name: "Add asset" });
      expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
      await userEvent.keyboard("{Escape}");
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.getByRole("dialog", { name: "Add asset" })).toBeInTheDocument();
      hold.release();
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    });

    it("can be saved only once: Enter in the Name box during a save sends nothing more", async () => {
      const calls = mockFetch({
        ...authed("admin"),
        "POST /api/assets": { status: 201, body: { id: 3, parent_id: 1, name: "Room B", kind: "generic", sort_order: 0 } },
      });
      const hold = holdFetch((method, path) => method === "POST" && path === "/api/assets");
      renderWorkspace("/assets");
      await userEvent.click(await screen.findByRole("button", { name: "Add asset" }));
      await userEvent.type(screen.getByLabelText("Name"), "Room B");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await userEvent.type(screen.getByLabelText("Name"), "{Enter}");
      hold.release();
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    });

    describe("a delete", () => {
      const impact = { detail: "needs confirmation", assets: 2, mappings: 3, tariffs: 1 };
      /** DELETE of asset 2 is held, then answers 409 with the counts. */
      function startDelete() {
        mockFetch({ ...authed("admin"), "DELETE /api/assets/2": { status: 409, body: impact } });
        const hold = holdFetch((method, path) => method === "DELETE" && path === "/api/assets/2");
        renderWorkspace("/assets/2");
        return hold;
      }
      beforeEach(() => { vi.spyOn(window, "confirm").mockReturnValue(true); });

      it("keeps Add asset, Edit, Delete and every + from opening a second dialog while it runs, and the confirm dialog ends up alone", async () => {
        const hold = startDelete();
        await userEvent.click(await screen.findByRole("button", { name: "Delete Room A" }));
        const add = screen.getByRole("button", { name: "Add asset" });
        expect(add).toBeDisabled();
        expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Delete Room A" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Add child of Site" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Add child of Room A" })).toBeDisabled();
        await userEvent.click(add);
        await userEvent.click(screen.getByRole("button", { name: "Edit" }));
        await userEvent.click(screen.getByRole("button", { name: "Add child of Site" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        hold.release();
        expect(await screen.findByRole("dialog", { name: 'Delete "Room A"?' })).toBeInTheDocument();
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
      });

      it("keeps them from opening a dialog next to the confirm dialog", async () => {
        const hold = startDelete();
        await userEvent.click(await screen.findByRole("button", { name: "Delete Room A" }));
        hold.release();
        await screen.findByRole("dialog", { name: 'Delete "Room A"?' });
        for (const name of ["Add asset", "Edit", "Add child of Site"]) {
          expect(screen.getByRole("button", { name })).toBeDisabled();
          await userEvent.click(screen.getByRole("button", { name }));
        }
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Add asset" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "Add child of Site" })).toBeEnabled();
      });
    });
  });
});

describe("AssetsPage header", () => {
  /** `title` is the h1 to wait for: "Assets Tree" on the index page, the asset's name on its own page. */
  const show = async (role: string, route: string, body: Fixture = assets, title = "Assets Tree") => {
    mockFetch(authed(role, body));
    renderWorkspace(route);
    await screen.findByRole("heading", { name: title, level: 1 });
  };
  const header = (title = "Assets Tree") => screen.getByRole("heading", { name: title, level: 1 }).closest("header")!;

  it("puts an admin's buttons in the asset page's header, with Add asset as the page's only primary and Delete a trash button named for the asset", async () => {
    await show("admin", "/assets/2", assets, "Room A");
    for (const name of ["Add asset", "Edit", "Delete Room A"]) expect(header("Room A")).toContainElement(screen.getByRole("button", { name }));
    expect(document.querySelectorAll("button.primary")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Add asset" })).toHaveClass("primary");
    expect(screen.getByRole("button", { name: "Delete Room A" })).toHaveClass("trash-btn");
    expect(screen.getByRole("button", { name: "Edit" })).not.toHaveClass("primary");
    for (const name of ["Add asset", "Edit", "Delete Room A"]) expect(screen.getByRole("button", { name })).toHaveAttribute("type", "button");
  });

  it("nothing selected: the admin has Add asset only in the header, as the page's only primary", async () => {
    await show("admin", "/assets");
    expect(within(header()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Add asset"]);
    expect(document.querySelectorAll("button.primary")).toHaveLength(1);
  });

  it.each(["viewer", "operator"])("a %s gets no actions in the index header", async (role) => {
    await show(role, "/assets");
    expect(header().querySelector(".actions")).toBeNull();
    expect(within(header()).queryAllByRole("button")).toHaveLength(0);
  });

  it.each(["viewer", "operator"])("a %s gets no buttons in an asset page's header", async (role) => {
    await show(role, "/assets/2", assets, "Room A");
    expect(within(header("Room A")).queryAllByRole("button")).toHaveLength(0);
  });

  it("nothing selected: the fleet summary follows the header, and the old 'select an asset' line is gone", async () => {
    await show("viewer", "/assets");
    expect(await screen.findByRole("heading", { name: "By kind", level: 2 })).toBeInTheDocument();
    expect(header().nextElementSibling).toHaveClass("tiles");
    expect(screen.queryByText("Select an asset in the tree.")).not.toBeInTheDocument();
  });

  it("a selected asset shows its own page, not the fleet summary", async () => {
    await show("viewer", "/assets/2", assets, "Room A");
    expect(screen.queryByRole("heading", { name: "By kind" })).not.toBeInTheDocument();
    expect(screen.queryByText("Select an asset in the tree.")).not.toBeInTheDocument();
  });

  it("an empty list says so in an .empty block and adds no heading (a heading with 'assets' in it would clash with the h1 in e2e)", async () => {
    await show("admin", "/assets", []);
    const note = screen.getByText("No assets yet.");
    expect(note.closest(".empty")).not.toBeNull();
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Add asset" })).toHaveLength(1);
  });
});

describe("the stream of an asset's page", () => {
  // One point mapped to both assets (a room's meter that the site shows too), so that a value left over from the first page would show on the second.
  const point = (value: number) => ({ mapping_id: 1, point_id: 7, metric: "active_power_kw", unit: "kW", value, ts: "2026-10-07T10:00:00+00:00", quality: 0 });
  const livePower = () => screen.getByText("Live power").closest(".tile")!.querySelector(".big")!;
  const tree = () => within(screen.getByRole("region", { name: "Asset tree" }));
  const push = (stream: FakeEventSource, value: number) => act(() => stream.emit([[7, Date.now() / 1000, value, 0]]));

  it("starts afresh for each asset: a live value never outlives its page, going to another asset and back", async () => {
    mockFetch({
      ...authed("viewer"),
      "GET /api/assets/1/summary": { body: summaryOf(assets[0], [point(3)]) },
      "GET /api/assets/2/summary": { body: summaryOf(assets[1], [point(10.5)]) },
    });
    renderWorkspace("/assets/2");
    await screen.findByRole("heading", { name: "Room A", level: 1 });
    expect(livePower()).toHaveTextContent(/^10\.50 kW$/);
    const first = FakeEventSource.open;
    expect(first).toHaveLength(1);
    push(first[0], 11.25);
    expect(livePower()).toHaveTextContent(/^11\.25 kW$/);

    await userEvent.click(tree().getByRole("link", { name: "Site" }));
    await screen.findByRole("heading", { name: "Site", level: 1 });
    expect(livePower()).toHaveTextContent(/^3\.00 kW$/); // its own summary, not Room A's 11.25
    expect(FakeEventSource.open).toHaveLength(1);
    expect(FakeEventSource.open[0]).not.toBe(first[0]);
    expect(first[0].closed).toBe(true);
    push(FakeEventSource.open[0], 4.5);
    expect(livePower()).toHaveTextContent(/^4\.50 kW$/);

    await userEvent.click(tree().getByRole("link", { name: "Room A" }));
    await screen.findByRole("heading", { name: "Room A", level: 1 });
    expect(livePower()).toHaveTextContent(/^10\.50 kW$/); // not Site's 4.50, and not the 11.25 it showed before
    expect(FakeEventSource.open).toHaveLength(1);
  });
});
