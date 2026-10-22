import { useQuery, useQueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MockInstance } from "vitest";
import { api } from "../api/client";
import { keys, useCollectorStatus } from "../api/queries";
import { mockFetch } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { CacheProbes, probeFetches, probeRoutes } from "../test/cacheProbes";
import { renderWithProviders } from "../test/render";
import { spyToasts } from "../test/toasts";
import { accountKnown, SignedIn } from "../test/signedIn";
import { userFor } from "../test/users";
import { movePreview, moveDone, URI_MATCH } from "../test/moveFixtures";
import { SOURCE_KEEP_NOTE } from "../lib/impact";
import type { PermissionId } from "../lib/permissions";
import { SourcesPage } from "./SourcesPage";

const source = { id: 2, name: "sim", connector_type: "simulator", config: { url: "http://simulator:9000" }, enabled: true, status: "online", last_seen: "2026-10-07T10:00:00+00:00", last_error: null, has_secret: true, last_reading_age_seconds: 5 };
const routes = (role: string) => ({
  "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: userFor(role) },
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

    it("gives admins Edit, Points and a trash button in the menu of every row, and operators only Test and Check connection", async () => {
      mockFetch({ ...routes("admin"), "GET /api/sources": { body: [source, { ...source, id: 3, name: "second" }] } });
      const admin = renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      const triggers = await screen.findAllByRole("button", { name: /^Actions for / });
      expect(triggers).toHaveLength(2);
      expect(screen.getAllByRole("button", { name: /^Delete / })).toHaveLength(2);
      await userEvent.click(triggers[1]);
      // (w31: the Import and Map tag list items come after the old four; the fixture has no history, so no Fill older range; w32: Events, which an Admin may open, comes last)
      expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Test", "Check connection", "Edit", "Points", "Import file...", "Map tag list...", "Events"]);
      admin.unmount();
      // (a viewer is not in this loop any more: it holds no permission of this page, so it cannot open it at all, see builtinAccess.test.tsx)
      for (const role of ["operator"]) {
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

    describe("while a delete confirmation is open", () => {
      const impact = { points: 3, mappings: 3 };
      /** The preview of source 2 (what its delete takes with it) is held until released; the dialog opens at once, before it. */
      function startDelete() {
        mockFetch({ ...routes("admin"), ...withConnectors, "GET /api/sources/2/impact": { body: impact } });
        const hold = holdFetch((method, path) => method === "GET" && path === "/api/sources/2/impact");
        renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
        return hold;
      }

      it("keeps Add source and Edit from opening a second dialog from the moment the trash is pressed, and the confirm dialog stays alone", async () => {
        const hold = startDelete();
        await userEvent.click(await screen.findByRole("button", { name: "Delete sim" }));
        expect(screen.getByRole("dialog", { name: 'Delete source "sim"?' })).toHaveTextContent("Checking what this deletes…"); // already there, before the preview
        const add = screen.getByRole("button", { name: "Add source" });
        // the dialog's backdrop covers the page, so the menu behind it is reached without moving the focus
        fireEvent.click(screen.getByRole("button", { name: /^Actions for /, hidden: true }));
        const edit = screen.getByRole("menuitem", { name: "Edit", hidden: true });
        expect(add).toBeDisabled();
        expect(edit).toBeDisabled();
        expect(screen.getByRole("button", { name: "Delete sim" })).toBeDisabled();
        expect(screen.getByRole("menuitem", { name: "Test", hidden: true })).toBeDisabled();
        await userEvent.click(add);
        await userEvent.click(edit);
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        await act(async () => hold.release());
        expect(await screen.findByText(/3 mapped points and 3 mappings will be deleted/)).toBeInTheDocument();
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
      });

      it("keeps them from opening a dialog next to the loaded confirm dialog, and frees them when it is cancelled", async () => {
        const hold = startDelete();
        await userEvent.click(await screen.findByRole("button", { name: "Delete sim" }));
        await act(async () => hold.release());
        await screen.findByText(/3 mapped points and 3 mappings will be deleted/);
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
      const toasts = spyToasts();
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources", toasts: toasts.api });
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
      expect(toasts.calls).toEqual([{ kind: "success", text: "Source added" }]);
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
    const mapped = { points: 3, mappings: 3 };
    const none = { points: 0, mappings: 0 };
    const MAPPED_TEXT = "3 mapped points and 3 mappings will be deleted; the past energy and cost figures that depend on them disappear from Billing and dashboards, except in closed months, which keep their billed figures.";
    const PLAIN_TEXT = "Its points go with it. This can't be undone.";
    const SEEN_MAPPED = "/api/sources/2?confirm=true&expect_points=3&expect_mappings=3";
    const SEEN_NONE = "/api/sources/2?confirm=true&expect_points=0&expect_mappings=0";
    /**
     * The preview answers `impact` (or `preview`, a failure); the confirmed DELETE answers `confirmed` (a 204 takes the source out of the
     * list). `hold` keeps the preview request in flight until `held.release()`.
     */
    function setup(
      impact: object,
      confirmed: { status: number; body?: object } = { status: 204 },
      { probes = false, hold = false, preview }: { probes?: boolean; hold?: boolean; preview?: { status: number; body: object } } = {},
    ) {
      const urls: string[] = [];
      let removed = false;
      const toasts = spyToasts();
      const calls = mockFetch({
        ...routes("admin"),
        ...(probes ? { ...probeRoutes, ...assetGraphRoutes } : {}),
        "GET /api/sources": () => ({ body: removed ? [] : [source] }),
        "GET /api/sources/2/impact": preview ?? { body: impact },
        "DELETE /api/sources/2": ({ url }) => {
          urls.push(url);
          if (confirmed.status === 204) removed = true;
          return confirmed;
        },
      });
      const held = hold ? holdFetch((method, path) => method === "GET" && path === "/api/sources/2/impact") : null;
      renderWithProviders(<><SourcesPage />{probes && <><CacheProbes /><AssetGraphProbes /></>}</>, { route: "/sources", path: "/sources", toasts: toasts.api });
      return { calls, urls, toasts: toasts.calls, held };
    }
    const deletes = (calls: { method: string }[]) => calls.filter((c) => c.method === "DELETE").length;
    const click = async (name: string) => userEvent.click(await screen.findByRole("button", { name }));
    const dialogOf = () => screen.findByRole("dialog", { name: 'Delete source "sim"?' });

    // The browser's own box is gone: it must never be asked, whatever the test does.
    let browserBox: MockInstance<Window["confirm"]>;
    beforeEach(() => { browserBox = vi.spyOn(window, "confirm").mockReturnValue(true); });
    afterEach(() => { expect(browserBox).not.toHaveBeenCalled(); });

    it("the trash opens ONE styled dialog, even for a source with nothing mapped: it says its points go too, and has a plain Delete button", async () => {
      const { calls } = setup(none);
      await click("Delete sim");
      const dialog = await dialogOf();
      expect(await within(dialog).findByText(PLAIN_TEXT)).toBeInTheDocument();
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(within(dialog).getByRole("button", { name: "Delete" })).toBeEnabled();
      expect(deletes(calls)).toBe(0); // nothing is sent until the button is pressed
    });

    it("a source with nothing mapped: Delete sends the counts it showed, the row goes, and one toast says so", async () => {
      const { calls, urls, toasts } = setup(none);
      await click("Delete sim");
      await userEvent.click(await within(await dialogOf()).findByRole("button", { name: "Delete" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(screen.queryByText("sim")).not.toBeInTheDocument());
      expect(urls).toEqual([SEEN_NONE]);
      expect(deletes(calls)).toBe(1);
      expect(toasts).toEqual([{ kind: "success", text: 'Source "sim" deleted' }]);
    });

    it.each([["a source with nothing mapped", none], ["a source with mapped points, after Delete anyway", mapped]])(
      "refreshes billing, the dashboards' widget data and the tariff list too, because they depend on its points: %s",
      async (_case, impact) => {
        const { calls } = setup(impact, undefined, { probes: true });
        await waitFor(() => expect(probeFetches(calls)).toEqual({ billing: 1, widgetData: 1, tariffs: 1 }));
        await click("Delete sim");
        await userEvent.click(await within(await dialogOf()).findByRole("button", { name: /^Delete( anyway)?$/ }));
        await waitFor(() => expect(probeFetches(calls)).toEqual({ billing: 2, widgetData: 2, tariffs: 2 }));
      },
    );

    it.each([["a source with nothing mapped", none], ["a source with mapped points, after Delete anyway", mapped]])(
      "refreshes the assets and the graph too, because its points and mappings go with it: %s",
      async (_case, impact) => {
        const { calls } = setup(impact, undefined, { probes: true });
        await waitFor(() => expect(assetGraphFetches(calls)).toEqual([1, 1]));
        await click("Delete sim");
        await userEvent.click(await within(await dialogOf()).findByRole("button", { name: /^Delete( anyway)?$/ }));
        await waitFor(() => expect(assetGraphFetches(calls)).toEqual([2, 2]));
      },
    );

    it("opens at once with 'Checking what this deletes…' and a confirm button that cannot be pressed; nothing is deleted before the preview arrived", async () => {
      const { calls, held } = setup(mapped, undefined, { hold: true });
      await click("Delete sim");
      const dialog = await dialogOf();
      expect(dialog).toHaveTextContent("Checking what this deletes…");
      const confirm = within(dialog).getByRole("button", { name: "Delete" }); // plain "Delete" until the answer says it takes more than the row
      expect(confirm).toBeDisabled();
      await userEvent.click(confirm);
      expect(deletes(calls)).toBe(0);
      await act(async () => held!.release());
      expect(await within(dialog).findByText(MAPPED_TEXT)).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Delete anyway" })).toBeEnabled();
    });

    it("shows what will be lost when points of it are mapped", async () => {
      setup(mapped);
      await click("Delete sim");
      const dialog = await dialogOf();
      expect(await within(dialog).findByText(MAPPED_TEXT)).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Delete anyway" })).toBeInTheDocument();
    });

    // W18 R4: the words about months that are not closed and the stored readings, as a paragraph of their own, only when points are mapped.
    it("says, in a paragraph of its own, what happens to months that are not closed and to the readings, when points of it are mapped", async () => {
      setup(mapped);
      await click("Delete sim");
      const dialog = await dialogOf();
      const loss = await within(dialog).findByText(MAPPED_TEXT);
      const note = within(dialog).getByText(SOURCE_KEEP_NOTE);
      expect(note.tagName).toBe("P");
      expect(loss.nextElementSibling).toBe(note);
    });

    it("has no such paragraph for a source with nothing mapped", async () => {
      setup(none);
      await click("Delete sim");
      const dialog = await dialogOf();
      expect(await within(dialog).findByText(PLAIN_TEXT)).toBeInTheDocument();
      expect(within(dialog).queryByText(SOURCE_KEEP_NOTE)).not.toBeInTheDocument();
      expect(dialog.querySelector(".confirm-note")).toBeNull();
    });

    it.each([["Cancel", async () => userEvent.click(screen.getByRole("button", { name: "Cancel" }))], ["Escape", async () => userEvent.keyboard("{Escape}")]])(
      "%s closes the dialog and sends no DELETE at all, with no toast",
      async (_how, leave) => {
        const { calls, toasts } = setup(mapped);
        await click("Delete sim");
        await within(await dialogOf()).findByText(MAPPED_TEXT);
        await leave();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(deletes(calls)).toBe(0);
        expect(toasts).toEqual([]);
        expect(screen.getByText("sim")).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      },
    );

    it("Delete anyway sends the counts it showed, then closes, refreshes the list and raises the toast", async () => {
      const { urls, toasts } = setup(mapped);
      await click("Delete sim");
      await userEvent.click(await within(await dialogOf()).findByRole("button", { name: "Delete anyway" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(urls).toEqual([SEEN_MAPPED]);
      await waitFor(() => expect(screen.queryByText("sim")).not.toBeInTheDocument());
      expect(toasts).toEqual([{ kind: "success", text: 'Source "sim" deleted' }]);
    });

    it("keeps the dialog open and says why when the confirmed request fails, with no toast", async () => {
      const { toasts } = setup(mapped, { status: 500, body: { detail: "database is down" } });
      await click("Delete sim");
      await userEvent.click(await within(await dialogOf()).findByRole("button", { name: "Delete anyway" }));
      const dialog = await dialogOf();
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("database is down");
      expect(toasts).toEqual([]);
    });

    it("shows a rejected delete (403) inside the dialog, not above the page", async () => {
      setup(none, { status: 403, body: { detail: "admin role required" } });
      await click("Delete sim");
      await userEvent.click(await within(await dialogOf()).findByRole("button", { name: "Delete" }));
      expect(await within(await dialogOf()).findByRole("alert")).toHaveTextContent("admin role required");
      expect(screen.getAllByRole("alert")).toHaveLength(1);
    });

    it("shows any other 409 inside the dialog, as it is, and the dialog keeps the numbers it showed", async () => {
      setup(mapped, { status: 409, body: { detail: "something else" } });
      await click("Delete sim");
      await userEvent.click(await within(await dialogOf()).findByRole("button", { name: "Delete anyway" }));
      const dialog = await dialogOf();
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("something else");
      expect(dialog).toHaveTextContent(MAPPED_TEXT);
    });

    it("a preview that cannot be read is shown in the dialog, and there is nothing to confirm", async () => {
      const { calls } = setup(mapped, undefined, { preview: { status: 404, body: { detail: "Source 2 not found" } } });
      await click("Delete sim");
      const dialog = await dialogOf();
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Could not check what this deletes: Source 2 not found");
      expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(deletes(calls)).toBe(0);
    });

    it("a point mapped while the dialog was open: the server refuses, the dialog shows the new numbers, and only the second confirm deletes", async () => {
      const urls: string[] = [];
      const toasts = spyToasts();
      let removed = false;
      mockFetch({
        ...routes("admin"),
        "GET /api/sources": () => ({ body: removed ? [] : [source] }),
        "GET /api/sources/2/impact": { body: none },
        "DELETE /api/sources/2": ({ url }) => {
          urls.push(url);
          if (urls.length === 1) return { status: 409, body: { detail: "More than you were shown would be deleted now", ...mapped } };
          removed = true;
          return { status: 204 };
        },
      });
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources", toasts: toasts.api });
      await click("Delete sim");
      await userEvent.click(await within(await dialogOf()).findByRole("button", { name: "Delete" }));
      const dialog = await dialogOf();
      expect(await within(dialog).findByText(MAPPED_TEXT)).toBeInTheDocument();
      expect(within(dialog).getByRole("alert")).toHaveTextContent("More was added while this was open. The numbers above are updated; delete again to confirm.");
      expect(urls).toEqual([SEEN_NONE]); // nothing is deleted yet
      expect(toasts.calls).toEqual([]);
      await userEvent.click(within(dialog).getByRole("button", { name: "Delete anyway" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(urls).toEqual([SEEN_NONE, SEEN_MAPPED]);
      expect(toasts.calls).toEqual([{ kind: "success", text: 'Source "sim" deleted' }]);
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
    // The loaded Name cell has the history line under the name: the placeholder draws both lines, or the page grows by about 24px a row when the list lands.
    const rows = region.querySelectorAll(".sk-table tbody tr");
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.querySelectorAll("td:first-child .sk-line")).toHaveLength(2);
      expect(row.querySelectorAll("td:first-child > .cell-history .sk-line")).toHaveLength(1);
      expect(row.querySelectorAll("td:not(:first-child) .cell-history")).toHaveLength(0);
    }
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

describe("SourcesPage controls follow the permissions of the role (a custom role)", () => {
  /** A role called "custom" that holds sources.view and `permissions`; the page is up and the account is known when this returns. */
  const show = async (permissions: PermissionId[], over: Record<string, unknown> = {}) => {
    const calls = mockFetch({ ...routes("custom"), "GET /api/me": { body: userFor("custom", { permissions: ["sources.view", ...permissions] }) }, ...over });
    renderWithProviders(<><SourcesPage /><SignedIn /></>, { route: "/sources", path: "/sources" });
    await screen.findByText("sim");
    await accountKnown();
    return calls;
  };
  const menuTexts = async () => {
    await userEvent.click(await screen.findByRole("button", { name: /^Actions for / }));
    return screen.getAllByRole("menuitem").map((el) => el.textContent);
  };

  it("sources.view alone: the list and its status, and no button, no menu, no trash", async () => {
    await show([]);
    expect(screen.getByText("timeout")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Test all" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add source" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete / })).not.toBeInTheDocument();
  });

  it("sources.test: Test all in the header and Test in the menu, and nothing else", async () => {
    const calls = await show(["sources.test"]);
    expect(screen.queryByRole("button", { name: "Add source" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete / })).not.toBeInTheDocument();
    expect(await menuTexts()).toEqual(["Test"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Test" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/sources/2/test")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Test all" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/sources/test-all")).toBe(true));
  });

  it("diagnostics.run: Check connection in the menu, no Test, no Test all", async () => {
    await show(["diagnostics.run"]);
    expect(screen.queryByRole("button", { name: "Test all" })).not.toBeInTheDocument();
    expect(await menuTexts()).toEqual(["Check connection"]);
  });

  it("sources.edit: Add source, Edit, Points and the trash, but not Test, Check connection or Test all", async () => {
    await show(["sources.edit"]);
    expect(screen.getByRole("button", { name: "Add source" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete sim" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Test all" })).not.toBeInTheDocument();
    expect(await menuTexts()).toEqual(["Edit", "Points"]);
  });

  it("sources.test and diagnostics.run and sources.edit: the menu an administrator has, in the same order", async () => {
    await show(["sources.test", "diagnostics.run", "sources.edit"]);
    expect(await menuTexts()).toEqual(["Test", "Check connection", "Edit", "Points"]);
    expect(screen.getByRole("button", { name: "Test all" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add source" })).toBeInTheDocument();
  });

  it("Add source opens the form for sources.edit (a role with no other source permission)", async () => {
    await show(["sources.edit"], { "GET /api/connectors": { body: connectors } });
    await userEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(await screen.findByRole("dialog", { name: "Add source" })).toBeInTheDocument();
  });
});

// w31: the three new row-menu items, the second line under a name, the source that is filled by files.
describe("SourcesPage, importing, mapping a tag list and filling (w31)", () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
  const history = (over: Record<string, unknown> = {}) => ({
    supports_history: true, state: "idle", answered_through: minutesAgo(3), last_success_at: minutesAgo(3), next_try_at: null, last_error: null, ...over,
  });
  const fileSource = { ...source, id: 5, name: "from-files", connector_type: "file", config: {}, has_secret: false, status: "unknown", polls: false, mapped_points: 0 };
  const w31Routes = (over: Record<string, unknown> = {}) => ({
    "GET /api/import-profiles": { body: { profiles: [] } },
    ...over,
  });
  /** The only row's menu, opened: the texts of its items. */
  const menuTexts = async () => {
    await userEvent.click(await screen.findByRole("button", { name: /^Actions for / }));
    return screen.getAllByRole("menuitem").map((el) => el.textContent);
  };
  /** A role called "custom" that holds sources.view and `permissions`; `row` is the only row. */
  const show = async (permissions: PermissionId[], row: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => {
    const calls = mockFetch({
      ...routes("custom"), ...w31Routes(),
      "GET /api/me": { body: userFor("custom", { permissions: ["sources.view", ...permissions] }) },
      "GET /api/sources": { body: [{ ...source, ...row }] },
      ...over,
    });
    renderWithProviders(<><SourcesPage /><SignedIn /></>, { route: "/sources", path: "/sources" });
    await screen.findByText(String(row.name ?? "sim"));
    await accountKnown();
    return calls;
  };

  describe("the menu follows the permissions", () => {
    it("readings.import alone: Import file...", async () => {
      await show(["readings.import"], { history: history() });
      expect(await menuTexts()).toEqual(["Import file..."]);
    });

    it("discovery.accept alone: Map tag list...", async () => {
      await show(["discovery.accept"], { history: history() });
      expect(await menuTexts()).toEqual(["Map tag list..."]);
    });

    it("sources.edit with a source that keeps history: Fill older range... after Edit and Points", async () => {
      await show(["sources.edit"], { history: history() });
      expect(await menuTexts()).toEqual(["Edit", "Points", "Fill older range..."]);
    });

    it("no Fill older range... without sources.edit, for a source without history, or when its row says the connector keeps none", async () => {
      await show(["readings.import", "discovery.accept"], { history: history() });
      expect(await menuTexts()).toEqual(["Import file...", "Map tag list..."]);
    });

    it.each([
      ["no history field (an older API)", {}],
      ["a null history", { history: null }],
      ["a connector that keeps none", { history: history({ supports_history: false, state: "not_supported" }) }],
    ])("sources.edit with %s: no Fill older range...", async (_name, row) => {
      await show(["sources.edit"], row);
      expect(await menuTexts()).toEqual(["Edit", "Points"]);
    });

    it("every permission: the old four in their order, then Import file..., Map tag list..., Fill older range...", async () => {
      await show(["sources.test", "diagnostics.run", "sources.edit", "readings.import", "discovery.accept"], { history: history() });
      expect(await menuTexts()).toEqual(["Test", "Check connection", "Edit", "Points", "Import file...", "Map tag list...", "Fill older range..."]);
    });
  });

  describe("a source that is filled by importing files (polls: false)", () => {
    const all: PermissionId[] = ["sources.test", "diagnostics.run", "sources.edit", "readings.import", "discovery.accept"];

    it("has no Test and no Check connection, whatever the role may do; the other items stay", async () => {
      await show(all, fileSource);
      expect(await menuTexts()).toEqual(["Edit", "Points", "Import file...", "Map tag list..."]);
    });

    it("keeps Test and Check connection for a source whose polls is true or missing", async () => {
      await show(all, { polls: true });
      expect(await menuTexts()).toEqual(["Test", "Check connection", "Edit", "Points", "Import file...", "Map tag list..."]);
    });

    it("says it is filled by file import, in the note style, not 'not polled' and not a chip", async () => {
      await show(["sources.view"], fileSource);
      const text = screen.getByText("filled by file import");
      expect(text).toHaveClass("muted", "st", "st-off", "note");
      expect(text).not.toHaveClass("chip");
      expect(screen.queryByText(/not polled/)).not.toBeInTheDocument();
    });

    it("is left out of Test all: the job ids go to the sources that were tested, by id order, and the file source shows no result", async () => {
      const result = (status: string) => ({ ok: true, status, latency_ms: 5, message: "" });
      mockFetch({
        ...routes("operator"),
        "GET /api/sources": { body: [
          { ...source, id: 3, name: "alpha" }, { ...fileSource, id: 2, name: "bravo-files" }, { ...source, id: 1, name: "zed" },
        ] },
        "POST /api/sources/test-all": { status: 202, body: { job_ids: [10, 30] } },
        "GET /api/jobs/10": { body: { id: 10, kind: "test_source", status: "done", result: result("ok-for-zed"), created_at: "t", finished_at: "t" } },
        "GET /api/jobs/30": { body: { id: 30, kind: "test_source", status: "done", result: result("ok-for-alpha"), created_at: "t", finished_at: "t" } },
      });
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      await userEvent.click(await screen.findByRole("button", { name: "Test all" }));
      expect(await screen.findByText("ok-for-zed 5 ms")).toBeInTheDocument();
      expect(within(screen.getByText("ok-for-zed 5 ms").closest("tr")!).getByText("zed")).toBeInTheDocument();
      expect(within(screen.getByText("ok-for-alpha 5 ms").closest("tr")!).getByText("alpha")).toBeInTheDocument();
      expect(within(screen.getByText("bravo-files").closest("tr")!).queryByText(/ms/)).not.toBeInTheDocument();
    });

    it("leaves Test all waiting when every source is filled by files (the server would test none)", async () => {
      mockFetch({ ...routes("operator"), "GET /api/sources": { body: [fileSource] } });
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      await screen.findByText("from-files");
      expect(screen.getByRole("button", { name: "Test all" })).toBeDisabled();
    });
  });

  describe("the second line under the name", () => {
    const lineOf = (name: string) => within((screen.getByText(name).closest("tr"))!);

    it("shows the history line of a source that keeps history, inside the Name cell, in a muted small line with the full text as its title", async () => {
      await show(["sources.view"], { history: history() });
      const line = screen.getByText(/^History: up to date, last fill 3 min ago$/);
      expect(line).toHaveClass("cell-history", "muted");
      expect(line).toHaveAttribute("title", "History: up to date, last fill 3 min ago");
      expect(line.closest("td")).toBe(screen.getByText("sim").closest("td")); // the same cell as the name: the table keeps its nine columns
      expect(document.querySelectorAll("thead th")).toHaveLength(9);
      expect(document.querySelectorAll("tbody tr:first-child td")).toHaveLength(9);
    });

    it("says what the connector reports in each state", async () => {
      mockFetch({
        ...routes("operator"),
        "GET /api/sources": { body: [
          { ...source, id: 1, name: "fresh", history: history({ state: "never_run", last_success_at: null, answered_through: null }) },
          { ...source, id: 2, name: "catching", history: history({ state: "filling", answered_through: minutesAgo(300) }) },
          { ...source, id: 3, name: "refused", history: history({ state: "backing_off", last_error: "the Historian refused: 429" }) },
        ] },
      });
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      await screen.findByText("fresh");
      expect(lineOf("fresh").getByText("History: not started yet")).toBeInTheDocument();
      expect(lineOf("catching").getByText("History: filling, 5 hours behind")).toBeInTheDocument();
      expect(lineOf("refused").getByText("History: waiting, the Historian refused: 429")).toBeInTheDocument();
    });

    it("says a switched-off source that never ran is not filled, rather than 'not started yet' for ever (the automatic fill skips it)", async () => {
      mockFetch({
        ...routes("operator"),
        "GET /api/sources": { body: [
          { ...source, id: 1, name: "off", enabled: false, history: history({ state: "never_run", last_success_at: null, answered_through: null }) },
          { ...source, id: 2, name: "on", history: history({ state: "never_run", last_success_at: null, answered_through: null }) },
        ] },
      });
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      await screen.findByText("off");
      expect(lineOf("off").getByText("History: not filled (the source is switched off)")).toHaveClass("cell-history");
      expect(lineOf("on").getByText("History: not started yet")).toBeInTheDocument();
    });

    it("says a switched-off source that was backing off has stopped, since nothing retries it", async () => {
      mockFetch({
        ...routes("operator"),
        "GET /api/sources": { body: [
          { ...source, id: 1, name: "off", enabled: false, history: history({ state: "backing_off", last_error: "the Historian refused: 429" }) },
          { ...source, id: 2, name: "on", history: history({ state: "backing_off", last_error: "the Historian refused: 429" }) },
        ] },
      });
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      await screen.findByText("off");
      expect(lineOf("off").getByText("History: stopped (the source is switched off), the Historian refused: 429")).toHaveClass("cell-history");
      expect(lineOf("on").getByText("History: waiting, the Historian refused: 429")).toBeInTheDocument();
    });

    it("shows nothing for a source whose connector keeps no history, or whose row has none", async () => {
      mockFetch({
        ...routes("operator"),
        "GET /api/sources": { body: [
          { ...source, id: 1, name: "plain" },
          { ...source, id: 2, name: "nulled", history: null },
          { ...source, id: 3, name: "none", history: history({ supports_history: false, state: "not_supported" }) },
        ] },
      });
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      await screen.findByText("plain");
      expect(document.querySelectorAll(".cell-history")).toHaveLength(0);
      for (const name of ["plain", "nulled", "none"]) expect(screen.getByText(name).closest("td")!.textContent).toBe(name);
    });

    it("says a source that is filled by files is filled by importing files", async () => {
      await show(["sources.view"], fileSource);
      expect(screen.getByText("Filled by importing files")).toHaveClass("cell-history");
    });
  });

  describe("the three dialogs", () => {
    /** The sources list as a variable, so a test can empty it under an open dialog. */
    let listed: unknown[];
    beforeEach(() => { listed = [{ ...source, history: history() }]; });
    const open = async (item: string, title: string) => {
      mockFetch({ ...routes("admin"), ...w31Routes(), "GET /api/sources": () => ({ body: listed }) });
      renderWithProviders(<><SourcesPage /><RefetchSources /></>, { route: "/sources", path: "/sources" });
      const opener = await trigger();
      await pick(item);
      const dialog = await screen.findByRole("dialog", { name: title });
      return { opener, dialog };
    };

    it.each([
      ["Import file...", "Import readings: sim", "Close"],
      ["Map tag list...", "Map tag list: sim", "Cancel"],
      ["Fill older range...", "Fill an older range: sim", "Close"],
    ])("%s opens %s, the other row actions wait while it is open, and closing it puts the focus on the row's menu button", async (item, title, closer) => {
      const { opener, dialog } = await open(item, title);
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: /^Actions for /, hidden: true })); // the backdrop covers the page: no focus move
      expect(screen.getByRole("menuitem", { name: "Edit", hidden: true })).toBeDisabled();
      expect(screen.getByRole("menuitem", { name: "Import file...", hidden: true })).toBeDisabled();
      expect(screen.getByRole("menuitem", { name: "Map tag list...", hidden: true })).toBeDisabled();
      expect(screen.getByRole("menuitem", { name: "Fill older range...", hidden: true })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Add source", hidden: true })).toBeDisabled();
      await userEvent.click(within(dialog).getByRole("button", { name: closer }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
      expect(screen.getByRole("button", { name: "Add source" })).toBeEnabled();
    });

    it.each([
      ["Import file...", "Import readings: sim"],
      ["Map tag list...", "Map tag list: sim"],
      ["Fill older range...", "Fill an older range: sim"],
    ])("%s: Escape closes it and the focus goes back to the row's menu button", async (item, title) => {
      const { opener } = await open(item, title);
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
    });

    it.each([
      ["Import file...", "Import readings: sim", "Close"],
      ["Map tag list...", "Map tag list: sim", "Cancel"],
      ["Fill older range...", "Fill an older range: sim", "Close"],
    ])("%s: when the row is gone by the time it closes (the list moved on), the focus goes to the page's heading, not to the body", async (item, title, closer) => {
      const { dialog } = await open(item, title);
      listed = [];
      fireEvent.click(screen.getByRole("button", { name: "refetch sources", hidden: true }));
      await waitFor(() => expect(screen.getByText("No sources yet.")).toBeInTheDocument());
      await userEvent.click(within(dialog).getByRole("button", { name: closer }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1, name: "Sources" })).toHaveFocus();
    });

    it("the Import dialog is for the source of the row it was opened from, even when the list is replaced under it", async () => {
      const { dialog } = await open("Import file...", "Import readings: sim");
      listed = [{ ...source, name: "renamed", history: history() }];
      fireEvent.click(screen.getByRole("button", { name: "refetch sources", hidden: true }));
      await waitFor(() => expect(screen.getByText("renamed", { selector: ".cell-name" })).toBeInTheDocument());
      expect(dialog).toHaveAccessibleName("Import readings: sim");
    });

    it("Fill older range... posts to the fill route of the row's source", async () => {
      const calls = mockFetch({
        ...routes("admin"), ...w31Routes(),
        "GET /api/sources": { body: [{ ...source, history: history() }] },
        "POST /api/sources/2/history/fill": { body: { plan: "p", windows: [], expected_rows: 0 } },
      });
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      await pick("Fill older range...");
      await userEvent.type(await screen.findByLabelText("Start date"), "2020-03-01");
      await userEvent.type(screen.getByLabelText("End date"), "2020-03-02");
      await userEvent.click(screen.getByRole("button", { name: "Check range" }));
      await screen.findByText("p");
      expect(calls.filter((c) => c.method === "POST" && c.path === "/api/sources/2/history/fill")).toHaveLength(1);
    });
  });
});

describe("SourcesPage, the long-offline banner, the offline-since tooltip and the Events item (w32)", () => {
  // 2026-10-22 07:00 UTC. A source that went offline at 2026-10-18 04:52:51 UTC (07:52 in Qatar, UTC+3) has been out of reach for 4 d 2 h 7 min.
  // Only the clock is faked (fake timers would hang React Query), and it stands still: the page's own ticking clock reads this time.
  const NOW = new Date("2026-10-22T07:00:00Z");
  const SINCE = "2026-10-18T04:52:51Z";
  const secondsAgo = (n: number) => new Date(NOW.getTime() - n * 1000).toISOString();
  const down = {
    ...source, id: 2, name: "OPC UA server at 172.20.0.3:4840", status: "offline", mapped_points: 3, polls: true,
    last_error: "[Errno 111] Connect call failed ('172.20.0.3', 4840)", offline_since: SINCE, failed_reads: 1204,
  };
  const SENTENCE = "1 source is offline: OPC UA server at 172.20.0.3:4840, for 4 d 2 h (since 18 Oct 07:52): [Errno 111] Connect call failed ('172.20.0.3', 4840).";
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }); });
  afterEach(() => vi.useRealTimers());

  /** The page for `role` (a built-in role, or "custom" with `permissions`), with these rows; waits for the account, so an absent control is really absent. */
  const show = async (rows: Record<string, unknown>[], role = "admin", permissions: PermissionId[] = [], over: Record<string, unknown> = {}) => {
    const calls = mockFetch({
      ...routes(role), "GET /api/import-profiles": { body: { profiles: [] } },
      ...(role === "custom" ? { "GET /api/me": { body: userFor("custom", { permissions: ["sources.view", ...permissions] }) } } : {}),
      "GET /api/sources": { body: rows },
      ...over,
    });
    renderWithProviders(<><SourcesPage /><SignedIn /><RefetchSources /></>, { route: "/sources", path: "/sources" });
    await screen.findByText(String(rows[0].name));
    await accountKnown();
    return calls;
  };
  const banner = () => screen.getByText(/ (is|are) offline: /);

  describe("the banner", () => {
    it("names the source, how long it has been out of reach, since when on the site's wall clock, and its last error, in one sentence", async () => {
      await show([down]);
      expect(banner()).toHaveTextContent(SENTENCE);
    });

    it("is a plain block: no alert role, no live region, so nothing is read out at each 10 s refresh", async () => {
      await show([down]);
      const box = banner().closest(".banner")!;
      expect(box).not.toHaveAttribute("role");
      expect(box.querySelector("[aria-live], [role]")).toBeNull();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("leaves the alerts as they were: a silent collector is still the one alert on the page", async () => {
      await show([down], "admin", [], { "GET /api/collector/status": { body: { alive: false, age_seconds: 95 } } });
      expect(await screen.findByText(/The collector has not reported for 1 min/)).toBeInTheDocument();
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(banner()).toBeInTheDocument();
    });

    it.each([
      ["a disabled source", { enabled: false }],
      ["a source filled by importing files", { polls: false, mapped_points: 0 }],
      ["a source with no mapped points", { mapped_points: 0 }],
      ["a source that is online", { status: "online" }],
      ["a source that has been offline for 90 seconds", { offline_since: secondsAgo(90) }],
      ["a source with no offline_since", { offline_since: null }],
      ["a list from an older API (no offline_since at all)", { offline_since: undefined }],
    ])("shows nothing for %s", async (_name, over) => {
      await show([{ ...down, ...over }]);
      expect(screen.queryByText(/ (is|are) offline: /)).not.toBeInTheDocument();
      expect(document.querySelector(".offline-banner")).toBeNull();
    });

    it("says a source that never answered has not answered since it was added", async () => {
      await show([{ ...down, last_seen: null, offline_since: secondsAgo(600) }]);
      expect(banner()).toHaveTextContent("1 source is offline: OPC UA server at 172.20.0.3:4840, which has not answered since it was added: [Errno 111] Connect call failed ('172.20.0.3', 4840).");
    });

    it("names at most three sources, the longest outage first, then says how many more", async () => {
      const rows = [
        { ...down, id: 1, name: "e", offline_since: secondsAgo(200) }, { ...down, id: 2, name: "a", offline_since: secondsAgo(2 * 86400) },
        { ...down, id: 3, name: "b", offline_since: secondsAgo(7200) }, { ...down, id: 4, name: "c", offline_since: secondsAgo(300) },
        { ...down, id: 5, name: "d", offline_since: secondsAgo(250) }, { ...down, id: 6, name: "fine", status: "online", offline_since: null },
      ];
      await show(rows);
      expect(banner()).toHaveTextContent("5 sources are offline: a (for 2 d), b (for 2 h), c (for 5 min) and 2 more.");
    });

    it("offers See its events (with diagnostics.view) to that source's events for one source, and to all events for several", async () => {
      await show([down]);
      expect(screen.getByRole("link", { name: "See its events" })).toHaveAttribute("href", "/events?source=2");
    });

    it("offers See its events to all events when several sources are offline", async () => {
      await show([down, { ...down, id: 3, name: "second" }]);
      expect(screen.getByRole("link", { name: "See its events" })).toHaveAttribute("href", "/events");
    });

    it("has no See its events without diagnostics.view (an Operator still sees the banner), and has it for a role that holds it", async () => {
      await show([down], "operator");
      expect(banner()).toHaveTextContent(SENTENCE);
      expect(screen.queryByRole("link", { name: "See its events" })).not.toBeInTheDocument();
      cleanup(); // a second page in the same test
      await show([down], "custom", ["diagnostics.view"]);
      expect(screen.getByRole("link", { name: "See its events" })).toHaveAttribute("href", "/events?source=2");
    });

    it("leaves the time out, not the browser's, while the site zone is unavailable", async () => {
      await show([down], "admin", [], { "GET /api/site": { status: 500, body: { detail: "site unavailable" } } });
      expect(banner()).toHaveTextContent("1 source is offline: OPC UA server at 172.20.0.3:4840, for 4 d 2 h: [Errno 111] Connect call failed ('172.20.0.3', 4840).");
    });

    it("is the same element after each refetch, and stays when a refetch fails (no flash, no re-announcement)", async () => {
      let failing = false;
      const calls = await show([down], "admin", [], { "GET /api/sources": () => (failing ? { status: 500, body: { detail: "database is down" } } : { body: [{ ...down }] }) });
      const before = banner();
      const sourceCalls = () => calls.filter((c) => c.path === "/api/sources").length;
      const start = sourceCalls();
      fireEvent.click(screen.getByRole("button", { name: "refetch sources" }));
      await waitFor(() => expect(sourceCalls()).toBe(start + 1));
      await act(async () => {});
      expect(banner()).toBe(before);
      failing = true;
      fireEvent.click(screen.getByRole("button", { name: "refetch sources" }));
      expect(await screen.findByText("database is down")).toBeInTheDocument();
      expect(banner()).toBe(before);
    });
  });

  describe("the Status chip", () => {
    it("says when an offline source went offline, on the wall clock of the site zone", async () => {
      await show([down]);
      expect(screen.getByText("offline", { selector: ".chip" })).toHaveAttribute("title", "offline since 18 Oct 07:52");
    });

    it("has no such tooltip for an online source, one with no offline_since, or while the site zone is unavailable", async () => {
      await show([{ ...down, status: "online", offline_since: null }, { ...down, id: 3, name: "undated", offline_since: null }]);
      for (const chip of document.querySelectorAll(".chip")) expect(chip).not.toHaveAttribute("title");
      cleanup(); // a second page in the same test
      await show([down], "admin", [], { "GET /api/site": { status: 500, body: { detail: "site unavailable" } } });
      expect(screen.getByText("offline", { selector: ".chip" })).not.toHaveAttribute("title");
    });

    it("tells a source that has been offline for under two minutes too (the tooltip is a fact; only the banner waits)", async () => {
      await show([{ ...down, offline_since: secondsAgo(30) }]);
      expect(screen.getByText("offline", { selector: ".chip" })).toHaveAttribute("title", "offline since 22 Oct 09:59"); // 06:59:30 UTC
      expect(document.querySelector(".offline-banner")).toBeNull();
    });
  });

  describe("the row menu", () => {
    const menuTexts = async () => {
      await userEvent.click(await screen.findByRole("button", { name: /^Actions for / }));
      return screen.getAllByRole("menuitem").map((el) => el.textContent);
    };
    const all: PermissionId[] = ["sources.test", "diagnostics.run", "sources.edit", "readings.import", "discovery.accept", "diagnostics.view"];

    it("gains Events after every other item, with diagnostics.view, and it opens that source's events", async () => {
      await show([{ ...down, history: { supports_history: true, state: "idle", answered_through: null, last_success_at: null, next_try_at: null, last_error: null } }], "custom", all);
      expect(await menuTexts()).toEqual(["Test", "Check connection", "Edit", "Points", "Import file...", "Map tag list...", "Fill older range...", "Events"]);
      expect(screen.getByRole("menuitem", { name: "Events" })).toHaveAttribute("href", "/events?source=2");
    });

    it("is the only item for a role that holds diagnostics.view alone, and is absent without it", async () => {
      await show([down], "custom", ["diagnostics.view"]);
      expect(await menuTexts()).toEqual(["Events"]);
      cleanup(); // a second page in the same test
      await show([down], "custom", ["sources.test"]);
      expect(await menuTexts()).toEqual(["Test"]);
    });

    it("is there for a source that is filled by importing files too (it has events of its own)", async () => {
      await show([{ ...down, polls: false, mapped_points: 0, status: "unknown", offline_since: null }], "custom", all);
      expect(await menuTexts()).toEqual(["Edit", "Points", "Import file...", "Map tag list...", "Events"]);
    });
  });
});

describe("SourcesPage, moving a source to the address where its device turned up (w33)", () => {
  // The clock stands still at 2026-10-22 07:00 UTC; the source went offline at 04:52:51 on the 18th (4 d 2 h before).
  const NOW = new Date("2026-10-22T07:00:00Z");
  const SINCE = "2026-10-18T04:52:51Z";
  const OLD = "OPC UA server at 172.20.0.3:4840";
  const NEW = "OPC UA server at 172.20.0.5:4840";
  const offer = { kind: "offer" as const, to_source_id: 7, to_name: NEW, to_endpoint: "opc.tcp://172.20.0.5:4840/dcdash/", match: URI_MATCH };
  const down = {
    ...source, id: 2, name: OLD, connector_type: "opcua", config: { endpoint: "opc.tcp://172.20.0.3:4840/dcdash/" }, status: "offline", mapped_points: 12, polls: true,
    last_error: "Connect call failed", offline_since: SINCE, move_candidate: offer,
  };
  const SENTENCE = `1 source is offline: ${OLD}, for 4 d 2 h (since 18 Oct 07:52): Connect call failed.`;
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }); });
  afterEach(() => vi.useRealTimers());

  const dryRuns: { url: string; body: unknown }[] = [];
  const realRuns: { url: string; body: unknown }[] = [];
  beforeEach(() => { dryRuns.length = 0; realRuns.length = 0; });

  /** The page for `role` (a built-in role, or "custom" with `permissions`), with these rows and the move routes; waits for the account. */
  const show = async (rows: Record<string, unknown>[], role = "admin", permissions: PermissionId[] = []) => {
    const toasts = spyToasts();
    const calls = mockFetch({
      ...routes(role), "GET /api/import-profiles": { body: { profiles: [] } },
      ...(role === "custom" ? { "GET /api/me": { body: userFor("custom", { permissions: ["sources.view", ...permissions] }) } } : {}),
      "GET /api/sources": { body: rows },
      "POST /api/sources/2/move": ({ url, body }) => {
        if (url.includes("dry_run=1")) { dryRuns.push({ url, body }); return { body: movePreview() }; }
        realRuns.push({ url, body });
        return { body: moveDone() };
      },
    });
    renderWithProviders(<><SourcesPage /><SignedIn /></>, { route: "/sources", path: "/sources", toasts: toasts.api });
    await screen.findByText(String(rows[0].name));
    await accountKnown();
    return { calls, toasts };
  };
  const menuTexts = async () => {
    await userEvent.click(await screen.findByRole("button", { name: /^Actions for / }));
    return screen.getAllByRole("menuitem").map((el) => el.textContent);
  };
  const banner = () => screen.getByText(/ (is|are) offline: /).closest(".banner") as HTMLElement;
  const dialog = () => screen.getByRole("dialog", { name: `Move to new address: ${OLD}` });

  describe("the row menu", () => {
    it("starts with Move to new address... for an offline source a scan found again, for a person who can edit sources", async () => {
      await show([down]);
      expect(await menuTexts()).toEqual(["Move to new address...", "Test", "Check connection", "Edit", "Points", "Import file...", "Map tag list...", "Events"]);
    });

    it("is the first item even when the person holds sources.edit alone", async () => {
      await show([down], "custom", ["sources.edit"]);
      expect(await menuTexts()).toEqual(["Move to new address...", "Edit", "Points"]);
    });

    it("is not offered without sources.edit, whatever else the person may do", async () => {
      await show([down], "operator");
      const texts = await menuTexts();
      expect(texts).not.toContain("Move to new address...");
      expect(texts[0]).toBe("Test");
    });

    it.each([
      ["no candidate", {}],
      ["a null candidate", { move_candidate: null }],
      ["two candidates", { move_candidate: { kind: "two", count: 2 } }],
    ])("is not offered for a source with %s", async (_name, over) => {
      await show([{ ...down, move_candidate: undefined, ...over }]);
      expect(await menuTexts()).not.toContain("Move to new address...");
    });

    it("opens the dialog with a dry run for this source and the new one, and puts the focus back on the row's menu button on Cancel", async () => {
      await show([down]);
      await userEvent.click(await screen.findByRole("button", { name: /^Actions for / }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Move to new address..." }));
      expect(await screen.findByText(/^From opc\.tcp:\/\/172\.20\.0\.3/)).toBeInTheDocument();
      expect(dialog()).toBeInTheDocument();
      expect(dryRuns).toEqual([{ url: "/api/sources/2/move?dry_run=1", body: { to: 7, address: "as_found" } }]);
      await userEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: /^Actions for / })).toHaveFocus();
    });

    it("keeps the rest of the page from opening a second dialog while this one is open", async () => {
      await show([down]);
      await userEvent.click(await screen.findByRole("button", { name: /^Actions for / }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Move to new address..." }));
      await screen.findByText(/^From opc\.tcp:\/\/172\.20\.0\.3/);
      expect(screen.getByRole("button", { name: `Delete ${OLD}` })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Add source" })).toBeDisabled();
    });
  });

  describe("moving", () => {
    it("sends the real run, closes the dialog, says so in a toast and reads the list again", async () => {
      const { calls, toasts } = await show([down]);
      await userEvent.click(await screen.findByRole("button", { name: /^Actions for / }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Move to new address..." }));
      await screen.findByText(/^From opc\.tcp:\/\/172\.20\.0\.3/);
      const before = calls.filter((c) => c.method === "GET" && c.path === "/api/sources").length;
      await userEvent.click(within(dialog()).getByRole("button", { name: "Move 12 mappings" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(realRuns).toHaveLength(1);
      expect(toasts.calls).toEqual([{ kind: "success", text: `Moved "${NEW}" to 172.20.0.5:4840` }]);
      expect(calls.filter((c) => c.method === "GET" && c.path === "/api/sources").length).toBeGreaterThan(before);
      expect(screen.getByRole("button", { name: /^Actions for / })).toHaveFocus();
    });
  });

  describe("the Status chip and the banner", () => {
    it("ends the banner sentence of a source with an offer with where it was found and a button that opens the dialog", async () => {
      await show([down]);
      expect(banner()).toHaveTextContent(`${SENTENCE} A scan found it at 172.20.0.5:4840:`);
      const button = within(banner()).getByRole("button", { name: "Move to new address..." });
      expect(button).toHaveAttribute("type", "button");
      expect(banner()).toHaveTextContent(`${SENTENCE} A scan found it at 172.20.0.5:4840:Move to new address...`);
      await userEvent.click(button);
      expect(await screen.findByText(/^From opc\.tcp:\/\/172\.20\.0\.3/)).toBeInTheDocument();
      expect(dryRuns).toHaveLength(1);
      await userEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("still says where it was found, but has no button, for a person who cannot edit sources", async () => {
      await show([down], "operator");
      expect(banner()).toHaveTextContent(`${SENTENCE} A scan found it at 172.20.0.5:4840.`);
      expect(within(banner()).queryByRole("button")).not.toBeInTheDocument();
    });

    it("keeps the old sentence, and no button, for a source without a candidate", async () => {
      await show([{ ...down, move_candidate: null }]);
      expect(banner()).toHaveTextContent(SENTENCE);
      expect(banner()).not.toHaveTextContent("A scan found");
      expect(within(banner()).queryByRole("button")).not.toBeInTheDocument();
    });

    it("says two servers could be this one, in the banner and in the Status chip's tooltip, and offers no move", async () => {
      await show([{ ...down, move_candidate: { kind: "two", count: 2 } }]);
      expect(banner()).toHaveTextContent(`${SENTENCE} Two servers could be this one; edit the address by hand.`);
      expect(within(banner()).queryByRole("button")).not.toBeInTheDocument();
      expect(screen.getByText("offline", { selector: ".chip" })).toHaveAttribute("title", "offline since 18 Oct 07:52. Two servers could be this one; edit the address by hand.");
    });

    it("leaves the chip's tooltip as it was for a source with an offer", async () => {
      await show([down]);
      expect(screen.getByText("offline", { selector: ".chip" })).toHaveAttribute("title", "offline since 18 Oct 07:52");
    });

    it("with several sources offline sends the person to the row menus", async () => {
      await show([down, { ...down, id: 3, name: "second", move_candidate: null }]);
      expect(banner()).toHaveTextContent("A scan found a new address for 1 of them: use Move to new address... in its row menu.");
      expect(within(banner()).queryByRole("button", { name: "Move to new address..." })).not.toBeInTheDocument();
    });
  });
});
