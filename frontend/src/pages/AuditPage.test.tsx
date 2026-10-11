import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../api/client";
import { downloadCsv } from "../lib/download";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithDataRouter } from "../test/render";
import { AuditPage } from "./AuditPage";

vi.mock("../lib/download", () => ({ downloadCsv: vi.fn() }));

const entry = (id: number, action: string, detail: Record<string, unknown> = { scan_id: id }, username: string | null = "admin") => ({
  id, user_id: username ? 1 : null, actor_id: username ? 1 : null, username, action, detail, ts: "2026-10-07T10:00:00Z",
});
const list = (total: number, items: ReturnType<typeof entry>[], offset = 0) => ({ body: { total, offset, limit: 50, items } });

const admin: Routes = {
  "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "u", role: "admin" } },
  "GET /api/site": { body: { timezone: "Asia/Qatar", currency: null } },
  "GET /api/audit/options": {
    body: { actions: ["asset.created", "scan.finished"], users: [{ id: 1, name: "admin" }], unattributed: true },
  },
};

const twoRows = list(51, [entry(51, "scan.finished", { scan_id: 51, status: "done" }), entry(50, "scan.started", { scan_id: 50 })]);

/** Every /api/audit request's URL is recorded; `routes` may override or add routes. */
function setup(route: string, auditReply: Routes[string] = twoRows, routes: Routes = {}) {
  const urls: string[] = [];
  const calls = mockFetch({
    ...admin,
    "GET /api/audit": (req) => {
      urls.push(req.url);
      return typeof auditReply === "function" ? auditReply(req) : auditReply;
    },
    ...routes,
  });
  const view = renderWithDataRouter(<AuditPage />, { route, path: "/audit" });
  return { ...view, urls, calls, search: () => view.router.state.location.search };
}

/** Holds back every request whose URL matches until `release()`; the rest go through. Install it after mockFetch. */
function hold(match: (url: string) => boolean) {
  const through = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (match(url)) await gate;
    return through(input, init);
  }));
  return release;
}

beforeEach(() => { vi.mocked(downloadCsv).mockReset().mockResolvedValue(undefined); });

describe("AuditPage", () => {
  it("lists entries newest first with who and what happened, and pages", async () => {
    const { urls, search } = setup("/audit", (req) =>
      req.url.includes("offset=50")
        ? list(51, [entry(1, "scope.created", { scope_id: 1, name: "Lab" }, null)], 50)
        : twoRows);
    expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
    expect(screen.getByText("Started scan #50")).toBeInTheDocument();
    expect(screen.getAllByText("admin").length).toBeGreaterThan(0);
    expect(screen.getByText("Showing 1–50 of 51")).toBeInTheDocument(); // the pager counts by page size; the mock sends two rows
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Created scan scope Lab")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(search()).toBe("?offset=50");
    expect(urls.at(-1)).toContain("offset=50");
    await userEvent.click(screen.getByRole("button", { name: "First" }));
    expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
    expect(search()).toBe("");
  });

  it("shows times in the site timezone, not the browser's, and links each time to its entry", async () => {
    setup("/audit");
    const time = await screen.findAllByRole("link", { name: "2026-10-07 13:00:00" }); // 10:00Z in Asia/Qatar (UTC+3)
    expect(time[0]).toHaveAttribute("href", "/audit/51");
    expect(time[1]).toHaveAttribute("href", "/audit/50");
    expect(screen.getByRole("columnheader", { name: "Time (Asia/Qatar)" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Time (Asia/Qatar)", "User", "What happened"]);
  });

  it("links an entry to the thing it is about and holds the details in a Details section", async () => {
    setup("/audit", list(1, [entry(9, "asset.created", { asset_id: 7, name: "Panel A" })]));
    expect(await screen.findByText("Created asset Panel A")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open asset Panel A" })).toHaveAttribute("href", "/assets/7");
    expect(screen.queryByText("Asset id")).not.toBeInTheDocument(); // closed: nothing drawn yet
    await userEvent.click(screen.getByText("Details"));
    expect(await screen.findByText("Asset id")).toBeInTheDocument();
  });

  it("shows the action code and the stored JSON in the raw view, which is part of the address", async () => {
    const { search } = setup("/audit", twoRows);
    expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Raw" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    const table = await screen.findByRole("table");
    expect(await within(table).findByText("scan.finished")).toBeInTheDocument(); // the Action select lists it too
    expect(within(table).getByText('{"scan_id":51,"status":"done"}')).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Time (Asia/Qatar)", "User", "Action", "Detail"]);
    expect(screen.getByRole("button", { name: "Raw" })).toHaveAttribute("aria-pressed", "true");
    expect(search()).toBe("?view=raw");
    await userEvent.click(screen.getByRole("button", { name: "Friendly" }));
    expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
    expect(search()).toBe("");
  });

  it("opens straight into the raw view from the address", async () => {
    setup("/audit?view=raw");
    expect(await within(await screen.findByRole("table")).findByText("scan.started")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Raw" })).toHaveAttribute("aria-pressed", "true");
  });

  it("says so when there is nothing yet", async () => {
    setup("/audit", list(0, []));
    expect(await screen.findByText("No audit entries yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  it("says nothing matches when filters leave no entry, and Clear filters brings the log back", async () => {
    const { urls, search } = setup("/audit?action=asset.created", (req) =>
      req.url.includes("action=") ? list(0, []) : twoRows);
    expect(await screen.findByText("No entries match these filters.")).toBeInTheDocument();
    expect(screen.queryByText("No audit entries yet.")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
    expect(search()).toBe("");
    expect(urls.at(-1)).not.toContain("action=");
  });

  it("an offset past the end says so, with a First button, and never claims the log is empty", async () => {
    const { urls, search } = setup("/audit?offset=100", (req) => (req.url.includes("offset=100") ? list(51, [], 100) : twoRows));
    expect(await screen.findByText("This page is past the end of the log.")).toBeInTheDocument();
    expect(screen.queryByText("No audit entries yet.")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Showing /)).not.toBeInTheDocument();
    const message = screen.getByText("This page is past the end of the log.").parentElement!;
    await userEvent.click(within(message).getByRole("button", { name: "First" }));
    expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
    expect(search()).toBe("");
    expect(urls.at(-1)).toContain("offset=0");
  });

  it("falls back to the first page when the address carries a bad offset or size", async () => {
    const { urls } = setup("/audit?offset=abc&size=7");
    expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
    expect(urls[0]).toContain("limit=50");
    expect(urls[0]).toContain("offset=0");
  });

  it("shows an error when the request fails", async () => {
    setup("/audit", { status: 403, body: { detail: "insufficient role" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("insufficient role");
  });

  it("reads the filters and the page from the address", async () => {
    const { urls } = setup("/audit?action=%2A.deleted&offset=50");
    expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
    expect(urls[0]).toContain("action=*.deleted");
    expect(urls[0]).toContain("offset=50");
    expect(screen.getByRole("button", { name: "Deletions" })).toHaveAttribute("aria-pressed", "true");
  });

  it("a filter change asks the API with the filter keys, goes back to the first page and writes the address", async () => {
    const { urls, search, router } = setup("/audit?offset=50");
    expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
    await screen.findByRole("option", { name: "asset.created" }); // the options have arrived
    await userEvent.selectOptions(screen.getByLabelText("Action"), "asset.created");
    await waitFor(() => expect(urls.at(-1)).toContain("action=asset.created"));
    expect(urls.at(-1)).toContain("offset=0");
    expect(search()).toBe("?action=asset.created");
    expect(router.state.historyAction).toBe("PUSH");
    await userEvent.selectOptions(screen.getByLabelText("User"), "1");
    await waitFor(() => expect(urls.at(-1)).toContain("user=1"));
    expect(search()).toBe("?user=1&action=asset.created");
  });

  it("a quick filter writes its filter, and pressing it again takes it off", async () => {
    const { urls, search } = setup("/audit?offset=50");
    expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Deletions" }));
    await waitFor(() => expect(urls.at(-1)).toContain("action=*.deleted"));
    expect(urls.at(-1)).toContain("offset=0");
    expect(search()).toBe("?action=*.deleted");
    await userEvent.click(screen.getByRole("button", { name: "Deletions" }));
    await waitFor(() => expect(search()).toBe(""));
  });

  it("the search text is written to the address without adding a history entry", async () => {
    const { urls, search, router } = setup("/audit");
    expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
    const box = screen.getByLabelText("Search");
    fireEvent.change(box, { target: { value: "panel a" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(urls.at(-1)).toContain("q=panel+a"));
    expect(search()).toBe("?q=panel+a");
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("changing the page size goes back to the first page", async () => {
    const { urls, search } = setup("/audit?offset=50");
    expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Rows per page"), "100");
    await waitFor(() => expect(urls.at(-1)).toContain("limit=100"));
    expect(urls.at(-1)).toContain("offset=0");
    expect(search()).toBe("?size=100");
  });

  describe("Go to date", () => {
    const jump = async (date = "2026-10-05") => {
      fireEvent.change(screen.getByLabelText("Go to date"), { target: { value: date } });
      await userEvent.click(screen.getByRole("button", { name: "Go" }));
    };
    const position = (reply: Routes[string]) => ({ "GET /api/audit/position": reply });

    it("asks the API for the position, then shows the page that holds it", async () => {
      const { urls, search, calls } = setup("/audit?action=asset.created", twoRows, position({ body: { offset: 73, total: 120, on_day: true } }));
      expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
      await jump();
      await waitFor(() => expect(search()).toBe("?action=asset.created&offset=73"));
      expect(calls.some((c) => c.path === "/api/audit/position")).toBe(true);
      await waitFor(() => expect(urls.at(-1)).toContain("offset=73"));
      expect(screen.queryByText(/^No entries on /)).not.toBeInTheDocument();
    });

    it("says when nothing is on that day, and the hint goes away when the page moves on", async () => {
      const { search } = setup("/audit", twoRows, position({ body: { offset: 73, total: 120, on_day: false } }));
      expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
      await jump();
      expect(await screen.findByText("No entries on 2026-10-05; showing the nearest older ones.")).toBeInTheDocument();
      expect(search()).toBe("?offset=73");
      await userEvent.click(screen.getByRole("button", { name: "Previous" }));
      await waitFor(() => expect(search()).toBe("?offset=23"));
      expect(screen.queryByText(/^No entries on /)).not.toBeInTheDocument();
    });

    it("drops an answer that arrives after the filters changed", async () => {
      const { search } = setup("/audit", twoRows, position({ body: { offset: 73, total: 120, on_day: false } }));
      expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
      await screen.findByRole("option", { name: "asset.created" });
      const release = hold((url) => url.startsWith("/api/audit/position"));
      await jump();
      await userEvent.selectOptions(screen.getByLabelText("Action"), "asset.created");
      await waitFor(() => expect(search()).toBe("?action=asset.created"));
      await act(async () => { release(); });
      await waitFor(() => expect(screen.getByRole("button", { name: "Go" })).toBeEnabled());
      expect(search()).toBe("?action=asset.created");
      expect(screen.queryByText(/^No entries on /)).not.toBeInTheDocument();
    });

    it("shows why the jump failed", async () => {
      setup("/audit", twoRows, position({ status: 422, body: { detail: "date out of range" } }));
      expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
      await jump("2026-10-05");
      expect(await screen.findByRole("alert")).toHaveTextContent("date out of range");
    });
  });

  describe("Export CSV", () => {
    it("downloads the filtered log", async () => {
      setup("/audit?action=asset.created&q=panel+a");
      await userEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
      expect(downloadCsv).toHaveBeenCalledWith("/api/audit.csv?action=asset.created&q=panel+a");
    });

    it("downloads the whole log when nothing is filtered", async () => {
      setup("/audit");
      await userEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
      expect(downloadCsv).toHaveBeenCalledWith("/api/audit.csv?");
    });

    it("shows the API's message when the export is refused", async () => {
      vi.mocked(downloadCsv).mockRejectedValueOnce(new ApiError(422, "more than 20000 entries; narrow the date range"));
      setup("/audit");
      await userEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("narrow the date range");
      await waitFor(() => expect(screen.getByRole("button", { name: "Export CSV" })).toBeEnabled());
    });
  });

  it("keeps the previous rows, marked busy, while the next page loads", async () => {
    setup("/audit", (req) => (req.url.includes("offset=50") ? list(51, [entry(1, "scope.created", { scope_id: 1, name: "Lab" })], 50) : twoRows));
    expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
    expect(screen.queryByText("Updating…")).not.toBeInTheDocument();
    expect(screen.getByRole("table")).not.toHaveAttribute("aria-busy", "true");
    const release = hold((url) => url.includes("offset=50"));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Updating…")).toBeInTheDocument();
    expect(screen.getByText("Scan #51 finished (done)")).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Previous" })).toBeInTheDocument(); // the pager stays
    await act(async () => { release(); });
    expect(await screen.findByText("Created scan scope Lab")).toBeInTheDocument();
    expect(screen.queryByText("Updating…")).not.toBeInTheDocument();
    expect(screen.getByRole("table")).not.toHaveAttribute("aria-busy", "true");
  });
});
