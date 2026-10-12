import { useQueryClient } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Outlet, Route, Routes } from "react-router";
import { keys } from "../api/queries";
import type { Asset, AttentionItem, FleetSummary } from "../api/types";
import { authed } from "../test/dashboardFixtures";
import { holdFetch } from "../test/holdFetch";
import { mockFetch } from "../test/fetchMock";
import { iconHtml } from "../test/iconHtml";
import { renderWithProviders } from "../test/render";
import { type AssetsContext } from "./AssetsPage";
import { AssetsSummary } from "./AssetsSummary";

// Seven assets: three "panel"s in two spellings, a "Rack" in two, a Room and a Site.
const asset = (id: number, name: string, kind: string): Asset => ({ id, parent_id: id === 1 ? null : 1, name, kind, sort_order: id });
const assets = [
  asset(1, "Site", "Site"), asset(2, "MV2", "panel"), asset(3, "LV Panel 1", "panel"), asset(4, "LV Panel 2", " Panel "),
  asset(5, "Rack 1", "Rack"), asset(6, "Rack 2", "rack"), asset(7, "Hall", "Room"),
];

const EMPTY_SITE: FleetSummary = {
  power: { kw: null, counted: 0, of: 0 }, energy_today: null, cost_today: null, currency: "QAR", attention: { total: 0, items: [] },
};
const fleetOf = (over: Partial<FleetSummary> = {}): FleetSummary => ({ ...EMPTY_SITE, ...over });
const problem = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  asset_id: 3, name: "LV Panel 1", path: "Site / MV2 / LV Panel 1", problem: "bad", points: 1, last_ts: "2026-10-11T08:05:09+00:00", ...over,
});

const openAdd = vi.fn();
/** What the workspace layout provides; the page under test is its index child. */
function Workspace({ admin }: { admin: boolean }) {
  const context: AssetsContext = { admin, locked: false, openAdd, openEdit: vi.fn(), remove: vi.fn() };
  return <Outlet context={context} />;
}

type Role = "viewer" | "operator" | "admin";
function stub({ role = "viewer", list = assets, fleet = fleetOf(), fleetReply }: {
  role?: Role; list?: Asset[]; fleet?: FleetSummary; fleetReply?: { status: number; body: unknown };
} = {}) {
  return mockFetch({
    ...authed(role),
    "GET /api/assets": { body: list },
    "GET /api/fleet/summary": fleetReply ?? { body: fleet },
  });
}
/** Renders nothing; gives the tests a way to make the fleet query fetch again, as its 15 s poll does. */
let refetchFleet: () => void = () => {};
function FleetRefetcher() {
  const client = useQueryClient();
  refetchFleet = () => void client.invalidateQueries({ queryKey: keys.fleet });
  return null;
}
function mount(role: Role) {
  renderWithProviders(
    <>
      <Routes>
        <Route path="/assets" element={<Workspace admin={role === "admin"} />}>
          <Route index element={<AssetsSummary />} />
        </Route>
      </Routes>
      <FleetRefetcher />
    </>,
    { route: "/assets", path: "*" },
  );
}
function show(options: Parameters<typeof stub>[0] = {}) {
  const calls = stub(options);
  mount(options.role ?? "viewer");
  return calls;
}
const ready = () => screen.findByRole("heading", { name: "By kind", level: 2 });
const tile = (label: string) => screen.getByText(label, { selector: ".tile > .muted" }).closest(".tile") as HTMLElement;
const big = (label: string) => tile(label).querySelector(".big") as HTMLElement;

beforeEach(() => openAdd.mockClear());

describe("AssetsSummary", () => {
  it("has one h1, and its other headings are By kind and Needs attention (no heading may contain Assets, Metrics or Trend)", async () => {
    show();
    await ready();
    expect(screen.getAllByRole("heading").map((h) => [h.tagName, h.textContent])).toEqual([
      ["H1", "Assets Tree"], ["H2", "By kind"], ["H2", "Needs attention"],
    ]);
    expect(document.querySelectorAll("h2.section-title")).toHaveLength(2);
  });

  it("asks for the fleet summary and the asset list once each", async () => {
    const calls = show();
    await ready();
    expect(calls.filter((c) => c.path === "/api/fleet/summary")).toHaveLength(1);
    expect(calls.filter((c) => c.path === "/api/assets")).toHaveLength(1);
  });

  describe("the tiles", () => {
    it("carry an icon in each caption (Assets, Live power, Energy today, Cost today) and keep the caption text", async () => {
      show();
      await ready();
      const captions = Array.from(document.querySelectorAll(".fleet-tiles > .tile > .muted:first-child"));
      expect(captions.map((c) => c.textContent)).toEqual(["Assets", "Live power", "Energy today", "Cost today"]);
      expect(captions.map((c) => c.className)).toEqual(Array(4).fill("muted tile-label"));
      expect(captions.map((c) => c.querySelector("svg")?.innerHTML)).toEqual([iconHtml("assets"), iconHtml("rate"), iconHtml("energy"), iconHtml("currency")]);
    });

    it("are four, in order: Assets, Live power, Energy today, Cost today", async () => {
      show();
      await ready();
      const tiles = [...document.querySelectorAll(".tiles > .tile")];
      expect(tiles).toHaveLength(4);
      expect(tiles.map((t) => t.querySelector(":scope > .muted")?.textContent)).toEqual(["Assets", "Live power", "Energy today", "Cost today"]);
    });

    it("count the assets, and the label Assets is not a heading", async () => {
      show();
      await ready();
      expect(big("Assets")).toHaveTextContent(/^7$/);
      expect(tile("Assets").querySelector("h1, h2, h3, h4, h5, h6")).toBeNull();
    });

    it("show the live power with two decimals and its note", async () => {
      show({ fleet: fleetOf({ power: { kw: 34.5, counted: 3, of: 3 } }) });
      await ready();
      expect(big("Live power")).toHaveTextContent(/^34\.50 kW$/);
      expect(within(tile("Live power")).getByText("Sum of 3 meters")).toBeInTheDocument();
    });

    it.each([
      ["every meter reports", { kw: 34.5, counted: 3, of: 3 }, "34.50 kW", "Sum of 3 meters"],
      ["one meter, and it reports", { kw: 8, counted: 1, of: 1 }, "8.00 kW", "Sum of 1 meter"],
      ["some report, one is silent", { kw: 20, counted: 2, of: 3 }, "20.00 kW", "Sum of 2 of 3 meters; the other is not reporting"],
      ["some report, several are silent", { kw: 5, counted: 1, of: 4 }, "5.00 kW", "Sum of 1 of 4 meters; the others are not reporting"],
      ["none reports", { kw: null, counted: 0, of: 3 }, "—", "None of the 3 meters is reporting"],
      ["the one meter is silent", { kw: null, counted: 0, of: 1 }, "—", "The meter is not reporting"],
      ["no power meter is mapped", { kw: null, counted: 0, of: 0 }, "—", "No power meters mapped"],
    ])("word the note when %s", async (_case, power, figure, note) => {
      show({ fleet: fleetOf({ power }) });
      await ready();
      expect(big("Live power")).toHaveTextContent(new RegExp(`^${figure}$`)); // a bare dash for null, never "— kW"
      expect(tile("Live power").querySelector("small")).toHaveTextContent(note);
    });

    it("show today's energy and cost with the tiles of the asset page", async () => {
      show({ fleet: fleetOf({ energy_today: { kwh: 12.5, estimated: true, no_data: false }, cost_today: { cost: 3.456, estimated: false, partial: false, no_data: false } }) });
      await ready();
      expect(tile("Energy today")).toHaveTextContent("12.50 kWh (estimated)");
      expect(big("Energy today")).not.toHaveClass("muted");
      expect(tile("Cost today")).toHaveTextContent("3.46 QAR");
    });

    it("mute a day that recorded nothing, as the asset page does", async () => {
      show({ fleet: fleetOf({ energy_today: { kwh: 0, estimated: false, no_data: true }, cost_today: { cost: 0, estimated: false, partial: false, no_data: true } }) });
      await ready();
      expect(big("Energy today")).toHaveClass("muted");
      expect(big("Energy today")).toHaveAttribute("title", "no data");
      expect(big("Cost today")).toHaveClass("muted");
    });

    it("say so in words when there is no energy or cost figure, or no rate", async () => {
      show({ fleet: fleetOf({ energy_today: null, cost_today: null }) });
      await ready();
      expect(within(tile("Energy today")).getByText("no energy data")).toBeInTheDocument();
      expect(within(tile("Cost today")).getByText("no cost data")).toBeInTheDocument();
    });

    it("show a dash and 'no rate set' for energy without a rate", async () => {
      show({ fleet: fleetOf({ energy_today: { kwh: 4, estimated: false, no_data: false }, cost_today: { cost: null, estimated: false, partial: false, no_data: false } }) });
      await ready();
      expect(big("Cost today")).toHaveTextContent(/^—$/);
      expect(within(tile("Cost today")).getByText("no rate set")).toBeInTheDocument();
    });
  });

  describe("By kind", () => {
    const listed = () => within(document.querySelector("ul.kind-list") as HTMLElement).getAllByRole("listitem").map((li) => [li.children[0].textContent, li.children[1].textContent]);

    it("groups the kinds ignoring case and blanks, shows the most used spelling, and counts, most first", async () => {
      show();
      await ready();
      // "panel" twice and " Panel " once; "Rack" and "rack" once each (a tie: code-point order, so "Rack"); one Room and one Site (a tie in count: by kind).
      expect(listed()).toEqual([["panel", "3"], ["Rack", "2"], ["Room", "1"], ["Site", "1"]]);
    });

    it("draws the icon of each kind inside .kind-name, so the name and the count stay the item's two children", async () => {
      show();
      await ready();
      const items = within(document.querySelector("ul.kind-list") as HTMLElement).getAllByRole("listitem");
      const icons = items.map((li) => [li.children[0].textContent, li.children[0].querySelector("svg")?.innerHTML, li.children.length]);
      expect(icons).toEqual([
        ["panel", iconHtml("kindPanel"), 2], ["Rack", iconHtml("kindRack"), 2], ["Room", iconHtml("kindRoom"), 2], ["Site", iconHtml("kindSite"), 2],
      ]);
      expect(items[0].children[0]).toHaveClass("kind-name");
      expect(items[0].querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    });

    it("is a plain list, not a list of links", async () => {
      show();
      await ready();
      const list = document.querySelector("ul.kind-list") as HTMLElement;
      expect(list.querySelector("a, button")).toBeNull();
      expect(list.previousElementSibling).toBe(screen.getByRole("heading", { name: "By kind" }));
    });

    it("leaves out an asset without a kind (the other assets still add up)", async () => {
      show({ list: [...assets, asset(8, "Spare", "   ")] });
      await ready();
      expect(listed().map(([name]) => name)).toEqual(["panel", "Rack", "Room", "Site"]);
      expect(big("Assets")).toHaveTextContent(/^8$/);
    });
  });

  describe("Needs attention", () => {
    const table = () => screen.getByRole("table");
    const rowOf = (name: string) => within(table()).getByRole("link", { name }).closest("tr") as HTMLElement;
    const cells = (row: HTMLElement) => within(row).getAllByRole("cell");

    it("lists an asset a row: a link to its page, where it is, what is wrong, and when it was last read in the site zone", async () => {
      show({ fleet: fleetOf({ attention: { total: 1, items: [problem()] } }) });
      await ready();
      expect(within(table()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Asset", "Where", "Problem", "Last reading"]);
      expect(table().closest("div")).toHaveClass("table-wrap");
      const row = rowOf("LV Panel 1");
      expect(within(row).getByRole("link", { name: "LV Panel 1" })).toHaveAttribute("href", "/assets/3");
      expect(cells(row).map((c) => c.textContent)).toEqual(["LV Panel 1", "Site / MV2", "Bad reading", "2026-10-11 11:05:09"]); // Asia/Qatar is UTC+3
      expect(within(row).getByText("Bad reading")).toHaveClass("chip", "chip-bad");
    });

    it("tells a stale reading from a bad one, in words and in chip", async () => {
      show({ fleet: fleetOf({ attention: { total: 2, items: [problem(), problem({ asset_id: 6, name: "Rack 2", path: "Site / Rack 2", problem: "stale" })] } }) });
      await ready();
      const chip = within(rowOf("Rack 2")).getByText("No recent reading");
      expect(chip).toHaveClass("chip", "chip-stale");
      expect(chip).not.toHaveClass("chip-bad");
    });

    it("says how many points when more than one has the problem, and says nothing for one", async () => {
      show({ fleet: fleetOf({ attention: { total: 2, items: [problem({ points: 3 }), problem({ asset_id: 6, name: "Rack 2", path: "Site / Rack 2", points: 1 })] } }) });
      await ready();
      expect(within(rowOf("LV Panel 1")).getByText("· 3 points")).toBeInTheDocument();
      expect(cells(rowOf("LV Panel 1"))[2]).toHaveTextContent("Bad reading · 3 points");
      expect(cells(rowOf("Rack 2"))[2]).toHaveTextContent(/^Bad reading$/);
    });

    it("shows a top-level asset's Where as a dash, and cuts only the asset's own name from the path (a name may hold ' / ')", async () => {
      show({
        fleet: fleetOf({ attention: { total: 2, items: [
          problem({ asset_id: 1, name: "Site", path: "Site" }),
          problem({ asset_id: 9, name: "A / B", path: "Site / A / B / A / B" }),
        ] } }),
      });
      await ready();
      expect(cells(rowOf("Site"))[1]).toHaveTextContent(/^—$/);
      expect(cells(rowOf("A / B"))[1]).toHaveTextContent(/^Site \/ A \/ B$/);
    });

    it("says how many more there are when the list is cut", async () => {
      const items = [problem(), problem({ asset_id: 6, name: "Rack 2", path: "Site / Rack 2" })];
      show({ fleet: fleetOf({ attention: { total: 7, items } }) });
      await ready();
      expect(screen.getByText("and 5 more")).toBeInTheDocument();
      expect(within(table()).getAllByRole("row")).toHaveLength(3); // the header and two
    });

    it("says nothing about more when every item is listed", async () => {
      show({ fleet: fleetOf({ attention: { total: 1, items: [problem()] } }) });
      await ready();
      expect(screen.queryByText(/and \d+ more/)).not.toBeInTheDocument();
    });

    it("shows a quiet 'Nothing needs attention' chip, and no table, when nothing is wrong", async () => {
      show();
      await ready();
      expect(screen.getByRole("heading", { name: "Needs attention", level: 2 })).toBeInTheDocument();
      expect(screen.getByText("Nothing needs attention")).toHaveClass("chip", "chip-ok");
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });
  });

  describe("a site with no assets", () => {
    it("says so in the .empty card and shows no tile and no section, and asks for no figures", async () => {
      const calls = show({ list: [] });
      expect(await screen.findByText("No assets yet.")).toBeInTheDocument();
      expect(screen.getByText("No assets yet.").closest(".empty")).not.toBeNull();
      expect(screen.getAllByRole("heading")).toHaveLength(1); // the h1 only
      expect(document.querySelector(".tiles")).toBeNull();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(calls.filter((c) => c.path === "/api/fleet/summary")).toHaveLength(0);
    });

    it("gives an admin the Add asset button in the header, once, and no viewer", async () => {
      show({ list: [], role: "admin" });
      const add = await screen.findByRole("button", { name: "Add asset" });
      expect(add.closest("header")).toContainElement(screen.getByRole("heading", { name: "Assets Tree", level: 1 }));
      expect(screen.getAllByRole("button", { name: "Add asset" })).toHaveLength(1);
    });

    it("gives a viewer no Add asset button", async () => {
      show({ list: [] });
      await screen.findByText("No assets yet.");
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });
  });

  describe("the header", () => {
    it("gives an admin Add asset, the page's one primary button, and it adds a top-level asset", async () => {
      show({ role: "admin" });
      await ready();
      const add = screen.getByRole("button", { name: "Add asset" });
      expect(add).toHaveClass("primary");
      expect(document.querySelectorAll("button")).toHaveLength(1);
      await userEvent.click(add);
      expect(openAdd).toHaveBeenCalledTimes(1);
      expect(openAdd).toHaveBeenCalledWith(null);
    });

    it.each(["viewer", "operator"] as const)("gives a %s no button", async (role) => {
      show({ role });
      await ready();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });
  });

  describe("while the figures load or fail", () => {
    const FLEET = "Loading the fleet summary";
    const fleetAsked = () => waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/api/fleet/summary"))).toBe(true));
    const statusOf = (label: string) => screen.getByText(label).parentElement!;

    it("shows the header and the fleet skeleton while the fleet request is in flight, then the page", async () => {
      stub({ fleet: fleetOf({ power: { kw: 3, counted: 1, of: 1 } }) });
      const held = holdFetch((_method, path) => path === "/api/fleet/summary");
      mount("viewer");
      await fleetAsked();
      expect(statusOf(FLEET)).toHaveAttribute("role", "status");
      expect(document.querySelectorAll(".tiles.fleet-tiles > .tile")).toHaveLength(4);
      expect(screen.queryByText("loading…")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Assets Tree", level: 1 })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "By kind" })).not.toBeInTheDocument();
      held.release();
      await ready();
      expect(screen.queryByText(FLEET)).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("shows the header at once and the same skeleton while the asset list is in flight, and asks for no figures until the list says there are assets", async () => {
      const calls = stub({ fleet: fleetOf({ power: { kw: 3, counted: 1, of: 1 } }) });
      const held = holdFetch((_method, path) => path === "/api/assets");
      mount("viewer");
      expect(screen.getByRole("heading", { name: "Assets Tree", level: 1 })).toBeInTheDocument();
      expect(statusOf(FLEET)).toHaveAttribute("role", "status");
      expect(document.querySelectorAll(".tiles.fleet-tiles > .tile")).toHaveLength(4);
      expect(screen.queryByText("No assets yet.")).not.toBeInTheDocument();
      expect(calls.filter((c) => c.path === "/api/fleet/summary")).toHaveLength(0);
      held.release();
      await ready();
      expect(calls.filter((c) => c.path === "/api/fleet/summary")).toHaveLength(1);
    });

    it("is ONE region from the asset list to the fleet figures: the very element stays, so the fade does not start again", async () => {
      stub({ fleet: fleetOf({ power: { kw: 3, counted: 1, of: 1 } }) });
      const assetsHeld = holdFetch((_method, path) => path === "/api/assets");
      const fleetHeld = holdFetch((_method, path) => path === "/api/fleet/summary");
      mount("viewer");
      const region = statusOf(FLEET);
      assetsHeld.release();
      await fleetAsked(); // the list is in, the figures are on their way
      expect(statusOf(FLEET)).toBe(region);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("No assets yet.")).not.toBeInTheDocument();
      fleetHeld.release();
      await ready();
      expect(region.isConnected).toBe(false);
    });

    it("ends the skeleton with the empty card for a site with no assets (no region left)", async () => {
      show({ list: [] });
      expect(await screen.findByText("No assets yet.")).toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("ends the skeleton with the failure as an alert, and no region", async () => {
      show({ fleetReply: { status: 500, body: { detail: "the fleet figures are not available" } } });
      expect(await screen.findByRole("alert")).toHaveTextContent("the fleet figures are not available");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("a fleet request that failed never brings the skeleton back when it is tried again: today's muted line shows, then the error", async () => {
      show({ fleetReply: { status: 500, body: { detail: "the fleet figures are not available" } } });
      await screen.findByRole("alert");
      const held = holdFetch((_method, path) => path === "/api/fleet/summary");
      act(refetchFleet);
      await fleetAsked();
      expect(await screen.findByText("loading…")).toHaveClass("muted");
      expect(screen.queryByText(FLEET)).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByText("No assets yet.")).not.toBeInTheDocument();
      held.release();
      expect(await screen.findByRole("alert")).toHaveTextContent("the fleet figures are not available");
      expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    });

    it("a fleet request that succeeded never shows the skeleton on a refetch (the figures stay)", async () => {
      show({ fleet: fleetOf({ power: { kw: 3, counted: 1, of: 1 } }) });
      await ready();
      const held = holdFetch((_method, path) => path === "/api/fleet/summary");
      act(refetchFleet);
      await fleetAsked();
      expect(screen.getByRole("heading", { name: "By kind" })).toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      held.release();
    });

    it("shows the failure as an alert under the header, and the admin's Add asset stays", async () => {
      show({ role: "admin", fleetReply: { status: 500, body: { detail: "the fleet figures are not available" } } });
      expect(await screen.findByRole("alert")).toHaveTextContent("the fleet figures are not available");
      expect(screen.getByRole("heading", { name: "Assets Tree", level: 1 })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Add asset" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "By kind" })).not.toBeInTheDocument();
    });
  });
});
