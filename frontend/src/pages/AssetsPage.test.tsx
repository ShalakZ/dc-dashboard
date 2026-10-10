import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { CacheProbes, probeFetches, probeRoutes } from "../test/cacheProbes";
import { holdFetch } from "../test/holdFetch";
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

  describe("dialogs and the + on each branch", () => {
    const created = { status: 201, body: { id: 3, parent_id: 1, name: "Room B", kind: "generic", sort_order: 0 } };
    const posts = (calls: { method: string; body?: unknown }[]) => calls.filter((c) => c.method === "POST");

    it("shows a + on every node for an admin, named after the node", async () => {
      mockFetch(authed("admin"));
      renderWithProviders(<AssetsPage />, { route: "/assets", path: "/assets" });
      expect(await screen.findByRole("button", { name: "Add child of Site" })).toHaveTextContent("+");
      expect(screen.getByRole("button", { name: "Add child of Room A" })).toHaveAttribute("type", "button");
    });

    it.each(["viewer", "operator"])("shows no + to a %s", async (role) => {
      mockFetch(authed(role));
      renderWithProviders(<AssetsPage />, { route: "/assets", path: "/assets" });
      await screen.findByRole("link", { name: "Site" });
      expect(screen.queryByRole("button", { name: /Add child of/ })).not.toBeInTheDocument();
    });

    it("the + opens one dialog titled Add asset with that node as the parent, and Save posts it and closes", async () => {
      const calls = mockFetch({ ...authed("admin"), "POST /api/assets": created });
      renderWithProviders(<AssetsPage />, { route: "/assets", path: "/assets" });
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
      renderWithProviders(<AssetsPage />, { route: "/assets", path: "/assets" });
      await userEvent.click(await screen.findByRole("button", { name: "Add child of Room A" }));
      expect(screen.getByRole("dialog", { name: "Add asset" })).toBeInTheDocument();
      await close();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(posts(calls)).toHaveLength(0);
    });

    it("the Add asset button opens the dialog with no parent when nothing is selected", async () => {
      mockFetch(authed("admin"));
      renderWithProviders(<AssetsPage />, { route: "/assets", path: "/assets" });
      await userEvent.click(await screen.findByRole("button", { name: "Add asset" }));
      const dialog = screen.getByRole("dialog", { name: "Add asset" });
      expect(within(dialog).getByLabelText("Parent")).toHaveValue("");
    });

    it("the Add asset button opens the dialog with the selected asset as the parent", async () => {
      mockFetch(authed("admin"));
      renderWithProviders(<AssetsPage />, { route: "/assets?selected=2", path: "/assets" });
      await userEvent.click(await screen.findByRole("button", { name: "Add asset" }));
      expect(within(screen.getByRole("dialog", { name: "Add asset" })).getByLabelText("Parent")).toHaveValue("2");
    });

    it("Edit opens the same form, titled Edit asset, with the asset's values", async () => {
      mockFetch(authed("admin"));
      renderWithProviders(<AssetsPage />, { route: "/assets?selected=2", path: "/assets" });
      await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      const dialog = screen.getByRole("dialog", { name: "Edit asset" });
      expect(within(dialog).getByLabelText("Name")).toHaveValue("Room A");
      expect(within(dialog).getByLabelText("Parent")).toHaveValue("1");
      expect(within(dialog).getByLabelText("Kind")).toHaveValue("room");
    });

    it("Escape on a dialog opened by Add asset puts focus back on the Add asset button", async () => {
      mockFetch(authed("admin"));
      renderWithProviders(<AssetsPage />, { route: "/assets", path: "/assets" });
      const add = await screen.findByRole("button", { name: "Add asset" });
      await userEvent.click(add);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(add).toHaveFocus();
    });

    it("Cancel on a dialog opened by Edit puts focus back on the Edit button", async () => {
      mockFetch(authed("admin"));
      renderWithProviders(<AssetsPage />, { route: "/assets?selected=2", path: "/assets" });
      const edit = await screen.findByRole("button", { name: "Edit" });
      await userEvent.click(edit);
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(edit).toHaveFocus();
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
    renderWithProviders(<AssetsPage />, { route: "/assets", path: "/assets" });
    await userEvent.click(await screen.findByRole("button", { name: "Add asset" }));
    const texts = within(screen.getByLabelText("Parent")).getAllByRole("option").map((o) => o.textContent!.replace(/\u00a0/g, "").trim());
    expect(texts).toEqual(["(none)", "Room 1", "LV Panel (Room 1)", "Room 2", "LV Panel (Room 2)"]);
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

  it("shows the API's refusal when the name already exists under that parent", async () => {
    mockFetch({
      ...authed("admin"),
      "POST /api/assets": { status: 409, body: { detail: 'an asset named "Room A" already exists under "Site"; choose another name' } },
    });
    renderWithProviders(<AssetsPage />, { route: "/assets", path: "/assets" });
    await userEvent.click(await screen.findByRole("button", { name: "Add asset" }));
    await userEvent.type(screen.getByLabelText("Name"), "Room A");
    await userEvent.selectOptions(screen.getByLabelText("Parent"), "1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent('an asset named "Room A" already exists under "Site"');
    expect(screen.getByLabelText("Name")).toHaveValue("Room A"); // the form stays open with what was typed
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

  describe("while a request is in flight", () => {
    it("ignores Escape and Cancel during a save, then closes the dialog when the save is done", async () => {
      const calls = mockFetch({
        ...authed("admin"),
        "POST /api/assets": { status: 201, body: { id: 3, parent_id: 1, name: "Room B", kind: "generic", sort_order: 0 } },
      });
      const hold = holdFetch((method, path) => method === "POST" && path === "/api/assets");
      renderWithProviders(<AssetsPage />, { route: "/assets", path: "/assets" });
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
      renderWithProviders(<AssetsPage />, { route: "/assets", path: "/assets" });
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
        renderWithProviders(<AssetsPage />, { route: "/assets?selected=2", path: "/assets" });
        return hold;
      }
      beforeEach(() => { vi.spyOn(window, "confirm").mockReturnValue(true); });

      it("keeps Add asset, Edit, Delete and every + from opening a second dialog while it runs, and the confirm dialog ends up alone", async () => {
        const hold = startDelete();
        await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
        const add = screen.getByRole("button", { name: "Add asset" });
        expect(add).toBeDisabled();
        expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
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
        await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
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
