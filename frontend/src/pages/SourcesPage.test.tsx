import { useQuery, useQueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../api/client";
import { keys, useCollectorStatus } from "../api/queries";
import { mockFetch } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { CacheProbes, probeFetches, probeRoutes } from "../test/cacheProbes";
import { renderWithProviders } from "../test/render";
import { SourcesPage } from "./SourcesPage";

const source = { id: 2, name: "sim", connector_type: "simulator", config: { url: "http://simulator:9000" }, enabled: true, status: "online", last_seen: "2026-10-07T10:00:00+00:00", last_error: null, has_secret: true, last_reading_age_seconds: 5 };
const routes = (role: string) => ({
  "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "u", role } },
  "GET /api/site": { body: { timezone: "Asia/Qatar", currency: "QAR" } },
  "GET /api/sources": { body: [{ ...source, status: "offline", last_error: "timeout" }] },
  "POST /api/sources/2/test": { status: 202, body: { job_id: 9 } },
  "GET /api/collector/status": { body: { alive: true, age_seconds: 3 } },
  "GET /api/secret-key/status": { body: { ok: true, key_changed: false, unreadable: [] } },
  "POST /api/sources/test-all": { status: 202, body: { job_ids: [9] } },
  "GET /api/jobs/9": { body: { id: 9, kind: "test_source", status: "done", result: { ok: false, status: "timeout", latency_ms: null, message: "no reply" }, created_at: "t", finished_at: "t" } },
});

const connectors = [
  { type: "simulator", config_schema: { type: "object", title: "SimulatorConfig", properties: {
    url: { type: "string", format: "uri", title: "Url", default: "http://simulator:9000" },
    timeout_seconds: { type: "number", title: "Timeout Seconds", default: 5.0 } } } },
  { type: "other", config_schema: { type: "object", required: ["host"], properties: {
    host: { type: "string", title: "Host" }, port: { type: "integer", title: "Port", default: 502 }, tls: { type: "boolean", title: "Tls", default: false } } } },
];

/** The row menu's trigger (named `Actions for <source>`). Menu items are in the DOM only while the menu is open. */
const trigger = async () => screen.findByRole("button", { name: /^Actions for / });
/** Opens the menu of the only row and returns the item with this name. */
async function menuItem(name: string) {
  await userEvent.click(await trigger());
  return screen.findByRole("menuitem", { name });
}
/** Opens the menu of the only row and chooses an item. */
async function pick(name: string) {
  await userEvent.click(await menuItem(name));
}

/** Fetches the sources again, as the page's own 10 s poll does. */
function RefetchSources() {
  const client = useQueryClient();
  return <button onClick={() => void client.invalidateQueries({ queryKey: keys.sources })}>refetch sources</button>;
}

/** Queries on the assets and graph keys: each is fetched again only when something invalidates its key. */
function AssetGraphProbes() {
  useQuery({ queryKey: keys.assets, queryFn: () => api.get("/api/probe/assets"), staleTime: Infinity });
  useQuery({ queryKey: keys.graph, queryFn: () => api.get("/api/probe/graph"), staleTime: Infinity });
  return null;
}
const assetGraphRoutes = { "GET /api/probe/assets": { body: {} }, "GET /api/probe/graph": { body: {} } };
const assetGraphFetches = (calls: { path: string }[]) =>
  [calls.filter((c) => c.path === "/api/probe/assets").length, calls.filter((c) => c.path === "/api/probe/graph").length];

describe("SourcesPage", () => {
  it("attributes test-all job ids to sources by id order, not name order", async () => {
    const zed = { ...source, id: 1, name: "zed" };
    const alpha = { ...source, id: 3, name: "alpha" };
    const disabled = { ...source, id: 2, name: "mid", enabled: false };
    const result = (status: string) => ({ ok: true, status, latency_ms: 5, message: "" });
    mockFetch({
      ...routes("operator"),
      "GET /api/sources": { body: [alpha, disabled, zed] },
      "POST /api/sources/test-all": { status: 202, body: { job_ids: [10, 30] } },
      "GET /api/jobs/10": { body: { id: 10, kind: "test_source", status: "done", result: result("ok-for-zed"), created_at: "t", finished_at: "t" } },
      "GET /api/jobs/30": { body: { id: 30, kind: "test_source", status: "done", result: result("ok-for-alpha"), created_at: "t", finished_at: "t" } },
    });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    await userEvent.click(await screen.findByRole("button", { name: "Test all" }));
    const zedRow = (await screen.findByText("ok-for-zed 5 ms")).closest("tr")!;
    expect(within(zedRow).getByText("zed")).toBeInTheDocument();
    expect(within(screen.getByText("ok-for-alpha 5 ms").closest("tr")!).getByText("alpha")).toBeInTheDocument();
    expect(within(screen.getByText("mid").closest("tr")!).queryByText(/ms/)).not.toBeInTheDocument();
  });

  it("prints Last seen on the wall clock of the site zone, and a dash for a source never seen", async () => {
    mockFetch({
      ...routes("operator"),
      "GET /api/sources": { body: [{ ...source, last_seen: "2026-10-09T11:05:00Z" }, { ...source, id: 3, name: "idle", last_seen: null }] },
    });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    const row = (await screen.findByText("sim")).closest("tr")!;
    expect(await within(row).findByText("2026-10-09 14:05:00")).toBeInTheDocument();
    expect(within(screen.getByText("idle").closest("tr")!).getByText("—")).toBeInTheDocument();
  });

  it("shows a dash, not a time in the browser's zone, while the site zone is unavailable", async () => {
    const calls = mockFetch({
      ...routes("operator"),
      "GET /api/site": { status: 500, body: { detail: "site unavailable" } },
      "GET /api/sources": { body: [{ ...source, last_seen: "2026-10-09T11:05:00Z" }] },
    });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    const row = (await screen.findByText("sim")).closest("tr")!;
    await waitFor(() => expect(calls.some((c) => c.path === "/api/site")).toBe(true));
    expect(within(row).getByText("—")).toBeInTheDocument();
    expect(row).not.toHaveTextContent(/2026|2:05|14:05/);
  });

  it("shows an alert when deleting a source is rejected", async () => {
    mockFetch({ ...routes("admin"), "DELETE /api/sources/2": { status: 403, body: { detail: "admin role required" } } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    await userEvent.click(await screen.findByRole("button", { name: "Delete sim" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("admin role required");
  });

  it("lists status and last error, and tests one source", async () => {
    const calls = mockFetch(routes("operator"));
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    expect(await screen.findByText("offline")).toBeInTheDocument();
    expect(screen.getByText("timeout")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add source" })).not.toBeInTheDocument();
    await pick("Test");
    expect(await screen.findByText(/no reply/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/sources/2/test")).toBe(true);
  });

  it("tests all sources and shows add/browse for admins", async () => {
    const calls = mockFetch(routes("admin"));
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    await userEvent.click(await screen.findByRole("button", { name: "Test all" }));
    expect(calls.some((c) => c.path === "/api/sources/test-all")).toBe(true);
    expect(screen.getByRole("button", { name: "Add source" })).toBeInTheDocument();
    expect(await menuItem("Points")).toHaveAttribute("href", "/sources/2/points");
  });

  describe("adding and editing", () => {
    const withConnectors = { "GET /api/connectors": { body: connectors } };

    it("gives admins Edit, Points and a trash button in the menu of every row, and operators and viewers only Test and Check connection", async () => {
      mockFetch({ ...routes("admin"), "GET /api/sources": { body: [source, { ...source, id: 3, name: "second" }] } });
      const admin = renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      const triggers = await screen.findAllByRole("button", { name: /^Actions for / });
      expect(triggers).toHaveLength(2);
      expect(screen.getAllByRole("button", { name: /^Delete / })).toHaveLength(2);
      await userEvent.click(triggers[1]);
      expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Test", "Check connection", "Edit", "Points"]);
      admin.unmount();
      for (const role of ["operator", "viewer"]) {
        mockFetch(routes(role));
        const view = renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
        await userEvent.click(await trigger());
        // opened first: a closed menu has no items, so their absence would prove nothing
        expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Test", "Check connection"]);
        expect(screen.queryByRole("button", { name: /^Delete / })).not.toBeInTheDocument();
        view.unmount();
      }
    });

    it("Edit opens a dialog named after the source with its stored values; Cancel and Escape close it and focus returns to the row's menu button", async () => {
      mockFetch({ ...routes("admin"), ...withConnectors });
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      const edit = await trigger();
      await pick("Edit");
      const dialog = await screen.findByRole("dialog", { name: "Edit source sim" });
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(within(dialog).getByLabelText("Name")).toHaveValue("sim");
      expect(await within(dialog).findByLabelText("Url")).toHaveValue("http://simulator:9000");
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(edit).toHaveFocus();
      await pick("Edit");
      await screen.findByRole("dialog", { name: "Edit source sim" });
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("saves an edit with PATCH, closes the dialog and fetches the list again", async () => {
      let listed = 0;
      const calls = mockFetch({
        ...routes("admin"), ...withConnectors,
        "GET /api/sources": () => ({ body: [{ ...source, name: ++listed > 1 ? "renamed" : "sim" }] }),
        "PATCH /api/sources/2": { body: { id: 2 } },
      });
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      await pick("Edit");
      const name = await screen.findByLabelText("Name");
      await userEvent.clear(name);
      await userEvent.type(name, "renamed");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        name: "renamed", config: { url: "http://simulator:9000", timeout_seconds: 5 }, enabled: true, // the stored config lacks timeout_seconds: the field's default fills it
      });
      expect(await screen.findByText("renamed")).toBeInTheDocument();
    });

    it("keeps what is typed in an open Edit dialog when the list is fetched again with new values", async () => {
      let listed = 0;
      mockFetch({
        ...routes("admin"), ...withConnectors,
        "GET /api/sources": () => ({ body: [{ ...source, last_reading_age_seconds: ++listed > 1 ? 125 : 5 }] }),
      });
      renderWithProviders(<><SourcesPage /><RefetchSources /></>, { route: "/sources", path: "/sources" });
      expect(await screen.findByText("5 s ago")).toBeInTheDocument();
      await pick("Edit");
      const name = await screen.findByLabelText("Name");
      const url = await screen.findByLabelText("Url");
      await userEvent.clear(name);
      await userEvent.type(name, "renamed");
      await userEvent.clear(url);
      await userEvent.type(url, "http://other:1");
      await userEvent.click(screen.getByRole("button", { name: "refetch sources" }));
      expect(await screen.findByText("2 min ago")).toBeInTheDocument();
      expect(screen.getByLabelText("Name")).toHaveValue("renamed");
      expect(screen.getByLabelText("Url")).toHaveValue("http://other:1");
    });

    it("keeps the Edit dialog and what is typed when a later fetch of the list fails, and shows the error above the table", async () => {
      let listed = 0;
      mockFetch({
        ...routes("admin"), ...withConnectors,
        "GET /api/sources": () => (++listed > 1 ? { status: 500, body: { detail: "database is down" } } : { body: [source] }),
      });
      renderWithProviders(<><SourcesPage /><RefetchSources /></>, { route: "/sources", path: "/sources" });
      await pick("Edit");
      const name = await screen.findByLabelText("Name");
      await userEvent.clear(name);
      await userEvent.type(name, "renamed");
      await userEvent.click(screen.getByRole("button", { name: "refetch sources" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("database is down");
      expect(screen.getByRole("dialog", { name: "Edit source sim" })).toBeInTheDocument();
      expect(screen.getByLabelText("Name")).toHaveValue("renamed");
      expect(screen.getByRole("heading", { name: "Sources" })).toBeInTheDocument();
      expect(screen.getByRole("table")).toBeInTheDocument();
    });

    it("still shows the error alone when the very first fetch of the list fails", async () => {
      mockFetch({ ...routes("admin"), "GET /api/sources": { status: 500, body: { detail: "database is down" } } });
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      expect(await screen.findByRole("alert")).toHaveTextContent("database is down");
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });

    it("edits a source whose connector is the last in the list with that connector's fields, and sends them", async () => {
      const plc = { ...source, id: 4, name: "plc", connector_type: "other", config: { host: "10.0.0.1", port: 503, tls: true }, has_secret: false };
      const calls = mockFetch({
        ...routes("admin"), ...withConnectors, "GET /api/sources": { body: [plc] }, "PATCH /api/sources/4": { body: { id: 4 } },
      });
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      await pick("Edit");
      const dialog = await screen.findByRole("dialog", { name: "Edit source plc" });
      expect(await within(dialog).findByLabelText("Host")).toHaveValue("10.0.0.1");
      expect(within(dialog).queryByLabelText("Url")).not.toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        name: "plc", config: { host: "10.0.0.1", port: 503, tls: true }, enabled: true,
      });
    });

    it("ignores Escape and Cancel while an edit is being saved, then closes the dialog when the save is done", async () => {
      const calls = mockFetch({
        ...routes("admin"), ...withConnectors,
        "PATCH /api/sources/2": { body: { ...source, name: "renamed" } },
      });
      const hold = holdFetch((method, path) => method === "PATCH" && path === "/api/sources/2");
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      await pick("Edit");
      const name = await screen.findByLabelText("Name");
      await userEvent.clear(name);
      await userEvent.type(name, "renamed");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
      await userEvent.keyboard("{Escape}");
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      hold.release();
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    });

    it("shows the saved name and config in the list, and in the next Edit, even when the fetch after the save fails", async () => {
      const saved = { ...source, name: "renamed", config: { url: "http://changed:9000", timeout_seconds: 5 } };
      let listed = 0;
      mockFetch({
        ...routes("admin"), ...withConnectors,
        "GET /api/sources": () => (++listed > 1 ? { status: 500, body: { detail: "database is down" } } : { body: [source] }),
        "PATCH /api/sources/2": { body: saved },
      });
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      await pick("Edit");
      const name = await screen.findByLabelText("Name");
      await userEvent.clear(name);
      await userEvent.type(name, "renamed");
      const url = screen.getByLabelText("Url");
      await userEvent.clear(url);
      await userEvent.type(url, "http://changed:9000");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(await screen.findByText("renamed")).toBeInTheDocument();
      expect(screen.getByText("5 s ago")).toBeInTheDocument(); // what the PATCH reply does not carry keeps its old value
      await pick("Edit");
      const dialog = await screen.findByRole("dialog", { name: "Edit source renamed" });
      expect(within(dialog).getByLabelText("Name")).toHaveValue("renamed");
      expect(await within(dialog).findByLabelText("Url")).toHaveValue("http://changed:9000");
    });

    describe("while a delete runs or its confirmation is open", () => {
      const impact = { detail: "needs confirmation", points: 3, mappings: 3 };
      /** DELETE of source 2 is held, then answers 409 with the counts. */
      function startDelete() {
        mockFetch({ ...routes("admin"), ...withConnectors, "DELETE /api/sources/2": { status: 409, body: impact } });
        const hold = holdFetch((method, path) => method === "DELETE" && path === "/api/sources/2");
        renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
        return hold;
      }
      beforeEach(() => { vi.spyOn(window, "confirm").mockReturnValue(true); });

      it("keeps Add source and Edit from opening a second dialog, and the confirm dialog ends up alone", async () => {
        const hold = startDelete();
        await userEvent.click(await screen.findByRole("button", { name: "Delete sim" }));
        const add = screen.getByRole("button", { name: "Add source" });
        const edit = await menuItem("Edit");
        expect(add).toBeDisabled();
        expect(edit).toBeDisabled();
        expect(screen.getByRole("button", { name: "Delete sim" })).toBeDisabled();
        expect(screen.getByRole("menuitem", { name: "Test" })).toBeDisabled();
        await userEvent.click(add);
        await userEvent.click(edit);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        hold.release();
        expect(await screen.findByRole("dialog", { name: 'Delete source "sim"?' })).toBeInTheDocument();
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
      });

      it("keeps them from opening a dialog next to the confirm dialog, and frees them when it is cancelled", async () => {
        const hold = startDelete();
        await userEvent.click(await screen.findByRole("button", { name: "Delete sim" }));
        hold.release();
        await screen.findByRole("dialog", { name: 'Delete source "sim"?' });
        expect(screen.getByRole("button", { name: "Add source" })).toBeDisabled();
        await userEvent.click(screen.getByRole("button", { name: "Add source" }));
        // the dialog's backdrop covers the page, so the menu behind it is reached without moving the focus
        fireEvent.click(screen.getByRole("button", { name: /^Actions for /, hidden: true }));
        const edit = screen.getByRole("menuitem", { name: "Edit", hidden: true });
        expect(edit).toBeDisabled();
        await userEvent.click(edit);
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Add source" })).toBeEnabled();
        expect(await menuItem("Edit")).toBeEnabled();
      });
    });

    it("Add source opens a dialog with the same fields as before; pressing the button again does not close it; Escape does", async () => {
      const calls = mockFetch({ ...routes("admin"), ...withConnectors, "POST /api/sources": { status: 201, body: { id: 3 } } });
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      const add = await screen.findByRole("button", { name: "Add source" });
      await userEvent.click(add);
      const dialog = await screen.findByRole("dialog", { name: "Add source" });
      expect(await within(dialog).findByLabelText("Connector")).toBeInTheDocument();
      expect(within(dialog).getByLabelText("Name")).toBeInTheDocument();
      expect(within(dialog).getByLabelText("Secret")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
      await userEvent.click(add);
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      await userEvent.type(within(dialog).getByLabelText("Name"), "new one");
      await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(calls.find((c) => c.method === "POST" && c.path === "/api/sources")?.body).toMatchObject({ name: "new one", connector_type: "simulator" });
      await userEvent.click(add);
      await screen.findByRole("dialog", { name: "Add source" });
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  describe("the status column", () => {
    it("says why a source is not polled, keeps the last check visible, and shows the stored status of a polled one", async () => {
      mockFetch({
        ...routes("operator"),
        "GET /api/sources": { body: [
          { ...source, id: 1, name: "empty", mapped_points: 0, status: "unknown" },
          { ...source, id: 3, name: "checked", mapped_points: 0, status: "offline" },
          { ...source, id: 4, name: "off", enabled: false, mapped_points: 2, status: "unknown" },
          { ...source, id: 5, name: "live", mapped_points: 3, status: "online" },
        ] },
      });
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      const row = async (name: string) => within((await screen.findByText(name)).closest("tr")!);
      const empty = await row("empty");
      expect(empty.getByText("not polled (no mapped points)")).toHaveClass("muted");
      expect((await row("checked")).getByText("not polled (no mapped points); last check: offline")).toBeInTheDocument();
      expect((await row("off")).getByText("not polled (disabled)")).toBeInTheDocument();
      const live = await row("live");
      expect(live.getByText("online")).not.toHaveClass("muted");
      expect(live.queryByText(/not polled/)).not.toBeInTheDocument();
    });
  });

  describe("deleting", () => {
    const impact = { detail: "needs confirmation", points: 3, mappings: 3 };
    /** DELETE answers 409 with the counts until the request carries confirm=true. `needsConfirm` false = nothing mapped. */
    function setup(needsConfirm: boolean, confirmed: { status: number; body?: object } = { status: 204 }, probes = false) {
      const urls: string[] = [];
      let removed = false;
      const calls = mockFetch({
        ...routes("admin"),
        ...(probes ? { ...probeRoutes, ...assetGraphRoutes } : {}),
        "GET /api/sources": () => ({ body: removed ? [] : [source] }),
        "DELETE /api/sources/2": ({ url }) => {
          urls.push(url);
          if (needsConfirm && !url.includes("confirm=true")) return { status: 409, body: impact };
          if (confirmed.status === 204) removed = true;
          return confirmed;
        },
      });
      renderWithProviders(<><SourcesPage />{probes && <><CacheProbes /><AssetGraphProbes /></>}</>, { route: "/sources", path: "/sources" });
      return { calls, urls };
    }
    const deletes = (calls: { method: string }[]) => calls.filter((c) => c.method === "DELETE").length;
    const click = async (name: string) => userEvent.click(await screen.findByRole("button", { name }));

    beforeEach(() => { vi.spyOn(window, "confirm").mockReturnValue(true); });

    it("deletes a source with nothing mapped as before: one request, no dialog", async () => {
      const { calls, urls } = setup(false);
      await click("Delete sim");
      await waitFor(() => expect(screen.queryByText("sim")).not.toBeInTheDocument());
      expect(urls).toEqual(["/api/sources/2"]);
      expect(deletes(calls)).toBe(1);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it.each([["a source with nothing mapped", false], ["a source with mapped points, after Delete anyway", true]])(
      "refreshes billing, the dashboards' widget data and the tariff list too, because they depend on its points: %s",
      async (_case, needsConfirm) => {
        const { calls } = setup(needsConfirm, undefined, true);
        await waitFor(() => expect(probeFetches(calls)).toEqual({ billing: 1, widgetData: 1, tariffs: 1 }));
        await click("Delete sim");
        if (needsConfirm) await userEvent.click(await screen.findByRole("button", { name: "Delete anyway" }));
        await waitFor(() => expect(probeFetches(calls)).toEqual({ billing: 2, widgetData: 2, tariffs: 2 }));
      },
    );

    it.each([["a source with nothing mapped", false], ["a source with mapped points, after Delete anyway", true]])(
      "refreshes the assets and the graph too, because its points and mappings go with it: %s",
      async (_case, needsConfirm) => {
        const { calls } = setup(needsConfirm, undefined, true);
        await waitFor(() => expect(assetGraphFetches(calls)).toEqual([1, 1]));
        await click("Delete sim");
        if (needsConfirm) await userEvent.click(await screen.findByRole("button", { name: "Delete anyway" }));
        await waitFor(() => expect(assetGraphFetches(calls)).toEqual([2, 2]));
      },
    );

    it("sends nothing when the first confirmation is declined", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(false);
      const { calls } = setup(true);
      await click("Delete sim");
      expect(deletes(calls)).toBe(0);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows what will be lost when the API asks for confirmation", async () => {
      setup(true);
      await click("Delete sim");
      const dialog = await screen.findByRole("dialog", { name: 'Delete source "sim"?' });
      expect(dialog).toHaveTextContent(
        "3 mapped points and 3 mappings will be deleted; the past energy and cost figures that depend on them disappear from Billing and dashboards.",
      );
      expect(within(dialog).getByRole("button", { name: "Delete anyway" })).toBeInTheDocument();
    });

    it("Cancel closes the dialog and deletes nothing", async () => {
      const { calls } = setup(true);
      await click("Delete sim");
      await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(deletes(calls)).toBe(1); // only the first, refused request
      expect(screen.getByText("sim")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("Delete anyway repeats the request with confirm=true, then closes and refreshes the list", async () => {
      const { urls } = setup(true);
      await click("Delete sim");
      await userEvent.click(await screen.findByRole("button", { name: "Delete anyway" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(urls).toEqual(["/api/sources/2", "/api/sources/2?confirm=true"]);
      await waitFor(() => expect(screen.queryByText("sim")).not.toBeInTheDocument());
    });

    it("keeps the dialog open and says why when the confirmed request fails", async () => {
      setup(true, { status: 500, body: { detail: "database is down" } });
      await click("Delete sim");
      await userEvent.click(await screen.findByRole("button", { name: "Delete anyway" }));
      const dialog = await screen.findByRole("dialog");
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("database is down");
    });

    it("shows any other 409 as a plain alert, not as a confirmation", async () => {
      mockFetch({ ...routes("admin"), "DELETE /api/sources/2": { status: 409, body: { detail: "something else" } } });
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      await click("Delete sim");
      expect(await screen.findByRole("alert")).toHaveTextContent("something else");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("shows how old each source's newest reading is, and a dash for a source with no stored reading", async () => {
    mockFetch({
      ...routes("operator"),
      "GET /api/sources": { body: [{ ...source, last_reading_age_seconds: 125 }, { ...source, id: 3, name: "idle", last_reading_age_seconds: null }] },
    });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    expect(await screen.findByRole("columnheader", { name: "Last reading" })).toBeInTheDocument();
    expect(within((await screen.findByText("sim")).closest("tr")!).getByText("2 min ago")).toBeInTheDocument();
    expect(within(screen.getByText("idle").closest("tr")!).queryByText(/ago/)).not.toBeInTheDocument();
  });

  it("warns when the collector has been silent, and says so when it never reported", async () => {
    mockFetch({ ...routes("operator"), "GET /api/collector/status": { body: { alive: false, age_seconds: 95 } } });
    const first = renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    expect(await screen.findByRole("alert")).toHaveTextContent("The collector has not reported for 1 min. No readings are collected while it is silent.");
    first.unmount();
    mockFetch({ ...routes("operator"), "GET /api/collector/status": { body: { alive: false, age_seconds: null } } });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    expect(await screen.findByRole("alert")).toHaveTextContent("The collector has not reported yet.");
  });

  it("warns when stored secrets cannot be read with the key in .env, and names the sources", async () => {
    mockFetch({
      ...routes("operator"),
      "GET /api/secret-key/status": { body: { ok: false, key_changed: true, unreadable: [{ id: 2, name: "Boiler" }] } },
    });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    const warning = await screen.findByText(/DCDASH_SECRET_KEY/);
    expect(warning).toHaveTextContent(/different from the one this database was set up with/i);
    expect(warning).toHaveTextContent(/Boiler/);
  });

  it("shows no key warning when every secret can be read, or when the status cannot be fetched", async () => {
    mockFetch({ ...routes("operator"), "GET /api/secret-key/status": { status: 500, body: { detail: "boom" } } });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    await screen.findByText("offline");
    expect(screen.queryByText(/DCDASH_SECRET_KEY/)).not.toBeInTheDocument();
  });

  describe("the collector notice", () => {
    /** Sits next to the page on the same query and shows how that query stands, so a test can wait for the status request to be answered. */
    function StatusProbe() {
      const { status } = useCollectorStatus();
      return <p data-testid="status-probe">{status}</p>;
    }
    /** Opens the page and returns once /api/collector/status has been requested and its query has settled as `settledAs`. */
    async function openAndSettle(statusReply: { status?: number; body: object }, settledAs: "success" | "error") {
      const calls = mockFetch({ ...routes("operator"), "GET /api/collector/status": statusReply });
      const view = renderWithProviders(<><SourcesPage /><StatusProbe /></>, { route: "/sources", path: "/sources" });
      await screen.findByText("sim");
      await waitFor(() => expect(calls.some((c) => c.path === "/api/collector/status")).toBe(true));
      await waitFor(() => expect(screen.getByTestId("status-probe")).toHaveTextContent(settledAs));
      return view;
    }

    it("shows no notice while the collector is alive, nor when its status cannot be read, but does when it is silent", async () => {
      const alive = await openAndSettle({ body: { alive: true, age_seconds: 3 } }, "success");
      expect(screen.queryByText(/The collector has not reported/)).not.toBeInTheDocument();
      alive.unmount();
      const unreadable = await openAndSettle({ status: 500, body: { detail: "boom" } }, "error");
      expect(screen.queryByText(/The collector has not reported/)).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      unreadable.unmount();
      // positive control: the same flow, the same wait, with a silent collector: the notice is there as soon as the wait ends
      await openAndSettle({ body: { alive: false, age_seconds: 95 } }, "success");
      expect(screen.getByText(/The collector has not reported for 1 min/)).toBeInTheDocument();
    });
  });

  describe("when /api/sources and /api/collector/status stop answering", () => {
    /** Each path in `paths` is answered the first time and never again (its request stays pending, as against a database that freezes). */
    function stopAnsweringAfterTheFirst(paths: string[]) {
      const answering = globalThis.fetch;
      const answered = new Set<string>();
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
        if (paths.includes(path) && answered.has(path)) return new Promise<Response>(() => {});
        answered.add(path);
        return answering(input, init);
      }));
    }
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
    afterEach(() => vi.useRealTimers());

    it("keeps counting the age of each reading from the last answer, then says the collector status cannot be read", async () => {
      vi.useFakeTimers();
      mockFetch(routes("operator")); // sim: last reading 5 s old, collector alive
      stopAnsweringAfterTheFirst(["/api/sources", "/api/collector/status"]);
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      await advance(1_000); // the first answers arrive
      const row = () => screen.getByText("sim").closest("tr")!;
      expect(within(row()).getByText("5 s ago")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      await advance(25_000); // 25 s with no new answer: the age has grown, the status is still within its 30 s
      expect(within(row()).getByText("30 s ago")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      await advance(20_000); // 45 s: no answer for longer than 30 s
      expect(within(row()).getByText("50 s ago")).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Collector status cannot be read (no answer for 45 s). Last-reading ages are counted from the last answer.",
      );
      expect(screen.queryByText(/The collector has not reported/)).not.toBeInTheDocument();
    });
  });
});

describe("SourcesPage look (W6)", () => {
  it("shows each polled status as a chip with its own shape class, and a note (not a chip) for a source that is not polled", async () => {
    mockFetch({
      ...routes("operator"),
      "GET /api/sources": { body: [
        { ...source, id: 1, name: "up", mapped_points: 2, status: "online" },
        { ...source, id: 3, name: "down", mapped_points: 2, status: "offline" },
        { ...source, id: 4, name: "fresh", mapped_points: 2, status: "unknown" },
        { ...source, id: 5, name: "empty", mapped_points: 0, status: "unknown" },
      ] },
    });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    const row = async (name: string) => within((await screen.findByText(name)).closest("tr")!);
    expect((await row("up")).getByText("online")).toHaveClass("chip", "chip-ok");
    expect((await row("down")).getByText("offline")).toHaveClass("chip", "chip-bad");
    expect((await row("fresh")).getByText("unknown")).toHaveClass("chip", "chip-stale");
    const note = (await row("empty")).getByText("not polled (no mapped points)");
    expect(note).toHaveClass("muted", "st", "st-off");
    expect(note).not.toHaveClass("chip");
  });

  it("gives a test result a shape class: ok and failed", async () => {
    mockFetch(routes("operator"));
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    await pick("Test");
    expect(await screen.findByText(/no reply/)).toHaveClass("job", "st", "st-bad", "error");
  });

  it("puts Test all and Add source in the page header, Add source being the one primary button", async () => {
    mockFetch(routes("admin"));
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    const header = (await screen.findByRole("heading", { level: 1, name: "Sources" })).closest("header")!; // (the header is there while the list loads: wait for its buttons)
    expect(await within(header).findByRole("button", { name: "Test all" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Add source" })).toHaveClass("primary");
    expect(document.querySelectorAll("button.primary")).toHaveLength(1);
  });

  it("row actions are the three-dot menu and the trash button, side by side in a cell that stays a table cell", async () => {
    mockFetch(routes("admin"));
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    const row = (await screen.findByText("sim")).closest("tr")!;
    const menu = within(row).getByRole("button", { name: "Actions for sim" });
    expect(menu).toHaveClass("row-menu-btn");
    expect(within(row).getByRole("button", { name: "Delete sim" })).toHaveClass("trash-btn");
    expect(menu.closest("td")).toHaveClass("row-actions");
    expect(within(row).getByRole("button", { name: "Delete sim" }).closest("td")).toBe(menu.closest("td"));
    expect(within(row).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    await userEvent.click(menu);
    expect(row.querySelector('[role="menu"]')).toBeNull(); // the panel is a portal on document.body, outside the table
    expect(screen.getByRole("menu", { name: "Actions for sim" })).toBeInTheDocument();
  });

  it("writes the collector and secret-key problems as banners that keep role alert", async () => {
    mockFetch({
      ...routes("operator"),
      "GET /api/collector/status": { body: { alive: false, age_seconds: null } },
      "GET /api/secret-key/status": { body: { ok: false, key_changed: false, unreadable: [{ id: 2, name: "sim" }] } },
    });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    const collector = (await screen.findByText(/The collector has not reported yet/)).closest("[role=alert]")!;
    expect(collector).toHaveClass("banner", "banner-warn");
    const secrets = screen.getByText(/does not open the stored secrets/).closest("[role=alert]")!;
    expect(secrets).toHaveClass("banner", "banner-bad");
  });

  it("says so, in the empty look, when there are no sources", async () => {
    mockFetch({ ...routes("admin"), "GET /api/sources": { body: [] } });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    expect(await screen.findByText("No sources yet.")).toBeInTheDocument();
    expect(screen.getByText("No sources yet.").closest(".empty")).not.toBeNull();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("keeps a long source name to one line and puts the full name in its title", async () => {
    const long = "Chiller plant BMS with a very long source name";
    mockFetch({ ...routes("operator"), "GET /api/sources": { body: [{ ...source, name: long }] } });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    expect(await screen.findByText(long)).toHaveAttribute("title", long);
  });

  describe("Check connection", () => {
    const check = (steps: unknown[], done: boolean) => ({
      source_id: 2, connector_type: "simulator", started_at: "2026-10-07T10:00:00+00:00", finished: done, ok: done ? true : null, first_failed: null, steps,
      clock: { server_time: null, local_time: "2026-10-07T10:00:00+00:00", skew_seconds: null }, names: { hosts: [], uris: [] },
    });
    const testStep = { id: "test", name: "Connection test", ok: true, ms: 7, summary: "connected in 7 ms", error: null, hint: null, detail: {} };
    const checkRoutes = (role: string) => ({
      ...routes(role),
      "POST /api/sources/2/check": { status: 202, body: { job_id: 31 } },
      "GET /api/jobs/31": { body: { id: 31, kind: "check_connection", status: "done", result: check([testStep], true), created_at: "t", finished_at: "2026-10-07T10:00:03+00:00" } },
    });

    it.each(["operator", "admin"])("lets an %s check one source in a dialog that starts the check and shows its steps", async (role) => {
      const calls = mockFetch(checkRoutes(role));
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      await pick("Check connection");
      const dialog = await screen.findByRole("dialog", { name: "Check connection: sim" });
      expect(await within(dialog).findByText("Connection test")).toBeInTheDocument();
      expect(within(dialog).getByText("connected in 7 ms")).toBeInTheDocument();
      expect(within(dialog).getByText("Every step passed.")).toBeInTheDocument();
      expect(calls.filter((c) => c.method === "POST" && c.path === "/api/sources/2/check")).toHaveLength(1);
      await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("puts the focus on a control that still works: Close, not the Run button the auto-start has just disabled", async () => {
      mockFetch(checkRoutes("operator"));
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      await pick("Check connection");
      const dialog = await screen.findByRole("dialog", { name: "Check connection: sim" });
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
    });

    it("offers Check connection as a menu item named in full, next to Test, and not as a button of the row", async () => {
      mockFetch(checkRoutes("operator"));
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      const check = await menuItem("Check connection");
      expect(check.textContent).toBe("Check connection");
      expect(screen.queryByRole("button", { name: /check/i })).not.toBeInTheDocument();
      expect(screen.getAllByRole("menuitem", { name: /test/i }).map((el) => el.textContent)).toEqual(["Test"]);
      expect(screen.getAllByRole("button", { name: /test/i }).map((b) => b.textContent)).toEqual(["Test all"]);
    });

    it("blocks the other row actions while its dialog is open", async () => {
      mockFetch(checkRoutes("admin"));
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      await pick("Check connection");
      await screen.findByRole("dialog", { name: "Check connection: sim" });
      fireEvent.click(screen.getByRole("button", { name: /^Actions for /, hidden: true })); // the backdrop covers the page: no focus move
      expect(screen.getByRole("menuitem", { name: "Edit", hidden: true })).toBeDisabled();
      expect(screen.getByRole("menuitem", { name: "Test", hidden: true })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Delete sim", hidden: true })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Add source", hidden: true })).toBeDisabled();
    });
  });
});

describe("SourcesPage while the list loads (W7f)", () => {
  const LABEL = "Loading sources";
  const heldList = () => holdFetch((_method, path) => path === "/api/sources");

  it("shows the real heading and a table skeleton in the region while the list is held, then the table and no region", async () => {
    mockFetch(routes("admin"));
    const held = heldList();
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    expect(screen.getByRole("heading", { level: 1, name: "Sources" })).toBeInTheDocument();
    const region = screen.getByText(LABEL).parentElement!;
    expect(region).toHaveAttribute("role", "status");
    expect(region.querySelectorAll(".sk-table thead th")).toHaveLength(7); // seven of the table's nine columns: more would run wider than the page
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    expect(screen.queryByText("No sources yet.")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument(); // the placeholder is not a table to assistive technology
    expect(screen.queryByRole("button")).not.toBeInTheDocument(); // the header's buttons wait for the data: nothing focusable while loading
    held.release();
    expect(await screen.findByText("sim")).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
    expect(screen.getByRole("button", { name: "Test all" })).toBeInTheDocument();
  });

  it("keeps the header as tall as it will be: an aria-hidden 34px gap stands in the actions slot, outside the region", async () => {
    mockFetch(routes("admin"));
    const held = heldList();
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    const gap = document.querySelector<HTMLElement>(".page-head > .actions > [aria-hidden]")!;
    expect(gap.style.height).toBe("34px");
    expect(gap.closest(".sk-region")).toBeNull();
    held.release();
    await screen.findByText("sim");
  });

  it("ends with the empty state when there are no sources, and no region", async () => {
    mockFetch({ ...routes("admin"), "GET /api/sources": { body: [] } });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    expect(await screen.findByText("No sources yet.")).toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
  });

  it("ends with the error alone when the very first fetch fails, and no region", async () => {
    mockFetch({ ...routes("admin"), "GET /api/sources": { status: 500, body: { detail: "database is down" } } });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    expect(await screen.findByRole("alert")).toHaveTextContent("database is down");
    expect(document.querySelector(".sk-region")).toBeNull();
  });

  it("a list that failed once never brings the skeleton back when its poll asks again: today's muted line shows, not the skeleton or 'No sources yet.', then the error", async () => {
    mockFetch({ ...routes("admin"), "GET /api/sources": { status: 500, body: { detail: "database is down" } } });
    renderWithProviders(<><SourcesPage /><RefetchSources /></>, { route: "/sources", path: "/sources" });
    await screen.findByRole("alert");
    const held = heldList();
    await userEvent.click(screen.getByRole("button", { name: "refetch sources" }));
    expect(await screen.findByText("loading…")).toHaveClass("muted");
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText("No sources yet.")).not.toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
    held.release();
    expect(await screen.findByRole("alert")).toHaveTextContent("database is down");
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
  });

  it("never shows the skeleton on a refetch of a list that is on screen", async () => {
    mockFetch(routes("admin"));
    renderWithProviders(<><SourcesPage /><RefetchSources /></>, { route: "/sources", path: "/sources" });
    await screen.findByText("sim");
    const held = heldList();
    await userEvent.click(screen.getByRole("button", { name: "refetch sources" }));
    expect(screen.getByText("sim")).toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
    held.release();
  });
});
