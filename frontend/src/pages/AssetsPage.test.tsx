import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { CacheProbes, probeFetches, probeRoutes } from "../test/cacheProbes";
import { renderWithProviders } from "../test/render";
import { AssetsPage } from "./AssetsPage";

const assets = [
  { id: 1, parent_id: null, name: "Site", kind: "site", sort_order: 0 },
  { id: 2, parent_id: 1, name: "Room A", kind: "room", sort_order: 0 },
];
const authed = (role: string) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role } },
  "GET /api/assets": { body: assets },
});

describe("AssetsPage", () => {
  it("renders the hierarchy as a nested tree", async () => {
    mockFetch(authed("viewer"));
    renderWithProviders(<AssetsPage />, { route: "/assets", path: "/assets" });
    const site = await screen.findByRole("link", { name: "Site" });
    expect(within(site.closest("li")!).getByRole("link", { name: "Room A" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add asset" })).not.toBeInTheDocument();
  });

  it("lets an admin add a child asset", async () => {
    const calls = mockFetch({
      ...authed("admin"),
      "POST /api/assets": { status: 201, body: { id: 3, parent_id: 1, name: "Room B", kind: "generic", sort_order: 0 } },
    });
    renderWithProviders(<AssetsPage />, { route: "/assets", path: "/assets" });
    await userEvent.click(await screen.findByRole("button", { name: "Add asset" }));
    await userEvent.type(screen.getByLabelText("Name"), "Room B");
    await userEvent.selectOptions(screen.getByLabelText("Parent"), "1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Room B", parent_id: 1, kind: "generic", sort_order: 0 });
  });

  it("shows the API error when a move is rejected", async () => {
    mockFetch({
      ...authed("admin"),
      "PATCH /api/assets/1": { status: 422, body: { detail: "an asset cannot be moved under itself or its own descendants" } },
    });
    renderWithProviders(<AssetsPage />, { route: "/assets?selected=1", path: "/assets" });
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot be moved under itself");
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
      renderWithProviders(<><AssetsPage />{probes && <CacheProbes />}</>, { route: "/assets?selected=2", path: "/assets" });
      return { calls, urls };
    }
    const deletes = (calls: { method: string }[]) => calls.filter((c) => c.method === "DELETE").length;
    const click = async (name: string) => userEvent.click(await screen.findByRole("button", { name }));

    beforeEach(() => { vi.spyOn(window, "confirm").mockReturnValue(true); });

    it("deletes a plain asset as before: one request, no dialog", async () => {
      const { calls, urls } = setup(false);
      await click("Delete");
      await waitFor(() => expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument());
      expect(urls).toEqual(["/api/assets/2"]);
      expect(deletes(calls)).toBe(1);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it.each([["a plain asset", false], ["an asset with mappings, after Delete anyway", true]])(
      "refreshes billing, the dashboards' widget data and the tariff list too, because they depend on the asset: %s",
      async (_case, needsConfirm) => {
        const { calls } = setup(needsConfirm, undefined, true);
        await waitFor(() => expect(probeFetches(calls)).toEqual({ billing: 1, widgetData: 1, tariffs: 1 }));
        await click("Delete");
        if (needsConfirm) await userEvent.click(await screen.findByRole("button", { name: "Delete anyway" }));
        await waitFor(() => expect(probeFetches(calls)).toEqual({ billing: 2, widgetData: 2, tariffs: 2 }));
      },
    );

    it("sends nothing when the first confirmation is declined", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(false);
      const { calls } = setup(true);
      await click("Delete");
      expect(deletes(calls)).toBe(0);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows what will be lost when the API asks for confirmation", async () => {
      setup(true);
      await click("Delete");
      const dialog = await screen.findByRole("dialog", { name: 'Delete "Room A"?' });
      expect(dialog).toHaveTextContent(
        "2 assets, 3 mappings and 1 tariff will be deleted; their past energy and cost figures disappear from Billing and dashboards.",
      );
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Delete anyway" })).toBeInTheDocument();
    });

    it("Cancel closes the dialog and deletes nothing", async () => {
      const { calls, urls } = setup(true);
      await click("Delete");
      await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(urls).toEqual(["/api/assets/2"]); // only the first, refused request
      expect(deletes(calls)).toBe(1);
      expect(screen.getByText(/Selected:/)).toBeInTheDocument(); // still selected, still in the tree
      expect(screen.getAllByRole("link", { name: "Room A" })).toHaveLength(2);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("Delete anyway repeats the request with confirm=true, then closes and refreshes the tree", async () => {
      const { urls } = setup(true);
      await click("Delete");
      await userEvent.click(await screen.findByRole("button", { name: "Delete anyway" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(urls).toEqual(["/api/assets/2", "/api/assets/2?confirm=true"]);
      await waitFor(() => expect(screen.queryByRole("link", { name: "Room A" })).not.toBeInTheDocument());
      expect(screen.queryByText(/Selected:/)).not.toBeInTheDocument();
    });

    it("keeps the dialog open and says why when the confirmed request fails", async () => {
      setup(true, { status: 403, body: { detail: "admin role required" } });
      await click("Delete");
      await userEvent.click(await screen.findByRole("button", { name: "Delete anyway" }));
      const dialog = await screen.findByRole("dialog");
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("admin role required");
    });

    it("shows any other 409 as a plain alert, not as a confirmation", async () => {
      mockFetch({ ...authed("admin"), "DELETE /api/assets/2": { status: 409, body: { detail: "something else" } } });
      renderWithProviders(<AssetsPage />, { route: "/assets?selected=2", path: "/assets" });
      await click("Delete");
      expect(await screen.findByRole("alert")).toHaveTextContent("something else");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
