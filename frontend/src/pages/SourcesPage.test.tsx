import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCollectorStatus } from "../api/queries";
import { mockFetch } from "../test/fetchMock";
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
  "POST /api/sources/test-all": { status: 202, body: { job_ids: [9] } },
  "GET /api/jobs/9": { body: { id: 9, kind: "test_source", status: "done", result: { ok: false, status: "timeout", latency_ms: null, message: "no reply" }, created_at: "t", finished_at: "t" } },
});

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
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("admin role required");
  });

  it("lists status and last error, and tests one source", async () => {
    const calls = mockFetch(routes("operator"));
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    expect(await screen.findByText("offline")).toBeInTheDocument();
    expect(screen.getByText("timeout")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add source" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText(/no reply/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/sources/2/test")).toBe(true);
  });

  it("tests all sources and shows add/browse for admins", async () => {
    const calls = mockFetch(routes("admin"));
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    await userEvent.click(await screen.findByRole("button", { name: "Test all" }));
    expect(calls.some((c) => c.path === "/api/sources/test-all")).toBe(true);
    expect(screen.getByRole("button", { name: "Add source" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Points" })).toHaveAttribute("href", "/sources/2/points");
  });

  describe("deleting", () => {
    const impact = { detail: "needs confirmation", points: 3, mappings: 3 };
    /** DELETE answers 409 with the counts until the request carries confirm=true. `needsConfirm` false = nothing mapped. */
    function setup(needsConfirm: boolean, confirmed: { status: number; body?: object } = { status: 204 }, probes = false) {
      const urls: string[] = [];
      let removed = false;
      const calls = mockFetch({
        ...routes("admin"),
        ...(probes ? probeRoutes : {}),
        "GET /api/sources": () => ({ body: removed ? [] : [source] }),
        "DELETE /api/sources/2": ({ url }) => {
          urls.push(url);
          if (needsConfirm && !url.includes("confirm=true")) return { status: 409, body: impact };
          if (confirmed.status === 204) removed = true;
          return confirmed;
        },
      });
      renderWithProviders(<><SourcesPage />{probes && <CacheProbes />}</>, { route: "/sources", path: "/sources" });
      return { calls, urls };
    }
    const deletes = (calls: { method: string }[]) => calls.filter((c) => c.method === "DELETE").length;
    const click = async (name: string) => userEvent.click(await screen.findByRole("button", { name }));

    beforeEach(() => { vi.spyOn(window, "confirm").mockReturnValue(true); });

    it("deletes a source with nothing mapped as before: one request, no dialog", async () => {
      const { calls, urls } = setup(false);
      await click("Delete");
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
      const dialog = await screen.findByRole("dialog", { name: 'Delete source "sim"?' });
      expect(dialog).toHaveTextContent(
        "3 mapped points and 3 mappings will be deleted; the past energy and cost figures that depend on them disappear from Billing and dashboards.",
      );
      expect(within(dialog).getByRole("button", { name: "Delete anyway" })).toBeInTheDocument();
    });

    it("Cancel closes the dialog and deletes nothing", async () => {
      const { calls } = setup(true);
      await click("Delete");
      await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(deletes(calls)).toBe(1); // only the first, refused request
      expect(screen.getByText("sim")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("Delete anyway repeats the request with confirm=true, then closes and refreshes the list", async () => {
      const { urls } = setup(true);
      await click("Delete");
      await userEvent.click(await screen.findByRole("button", { name: "Delete anyway" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(urls).toEqual(["/api/sources/2", "/api/sources/2?confirm=true"]);
      await waitFor(() => expect(screen.queryByText("sim")).not.toBeInTheDocument());
    });

    it("keeps the dialog open and says why when the confirmed request fails", async () => {
      setup(true, { status: 500, body: { detail: "database is down" } });
      await click("Delete");
      await userEvent.click(await screen.findByRole("button", { name: "Delete anyway" }));
      const dialog = await screen.findByRole("dialog");
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("database is down");
    });

    it("shows any other 409 as a plain alert, not as a confirmation", async () => {
      mockFetch({ ...routes("admin"), "DELETE /api/sources/2": { status: 409, body: { detail: "something else" } } });
      renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
      await click("Delete");
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
