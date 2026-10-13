import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../api/client";
import { downloadCsv } from "../lib/download";
import { mockFetch, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
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
    // 10:00Z in Asia/Qatar (UTC+3); the link's name says which entry it opens, the visible text stays the time
    const first = await screen.findByRole("link", { name: "Entry #51, 2026-10-07 13:00:00" });
    expect(first).toHaveAttribute("href", "/audit/51");
    expect(first).toHaveTextContent("2026-10-07 13:00:00");
    expect(screen.getByRole("link", { name: "Entry #50, 2026-10-07 13:00:00" })).toHaveAttribute("href", "/audit/50");
    expect(screen.getByRole("columnheader", { name: "Time (Asia/Qatar)" })).toBeInTheDocument();
    // the disclosure chevron is the FIRST column (so the empty end of a short sentence is not between it and its entry); its header is read out, not drawn
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Details", "Time (Asia/Qatar)", "User", "What happened"]);
    const cells = [...document.querySelectorAll(".audit-table tbody tr:first-child > td")];
    expect(cells.map((c) => c.className)).toEqual(["cell-more", "cell-time", "cell-user", "cell-what"]);
    expect(cells[0].querySelector("button")).toHaveAttribute("aria-label", "Details of entry #51");
    expect([...document.querySelectorAll(".audit-table col")].map((c) => (c as HTMLElement).style.width)).toEqual(["36px", "200px", "160px", ""]);
  });

  it("keeps the raw table at four columns, time first", async () => {
    setup("/audit?view=raw");
    await screen.findByRole("cell", { name: "scan.finished" });
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Time (Asia/Qatar)", "User", "Action", "Detail"]);
    expect(document.querySelector(".audit-table tbody tr:first-child > td:first-child")).toHaveClass("cell-time");
  });

  it("puts a space between the sentence and its link in the text, so a copy or a screen reader's line does not join the words", async () => {
    setup("/audit", list(1, [entry(9, "asset.created", { asset_id: 7, name: "Panel A" })]));
    await screen.findByText("Created asset Panel A");
    expect(document.querySelector(".what-text")!.textContent).toBe("Created asset Panel A Open asset Panel A");
  });

  it("links an entry to the thing it is about and opens its details in a row under it from a Details button", async () => {
    setup("/audit", list(1, [entry(9, "asset.created", { asset_id: 7, name: "Panel A" })]));
    expect(await screen.findByText("Created asset Panel A")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open asset Panel A" })).toHaveAttribute("href", "/assets/7");
    const details = screen.getByRole("button", { name: "Details of entry #9" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(details).not.toHaveAttribute("aria-controls"); // nothing to control while the row is not drawn
    expect(screen.queryByText("Asset id")).not.toBeInTheDocument(); // closed: nothing drawn yet
    const body = document.querySelector(".audit-table tbody")!;
    expect(body.querySelectorAll("tr")).toHaveLength(1);
    await userEvent.click(details);
    expect(await screen.findByText("Asset id")).toBeInTheDocument();
    expect(details).toHaveAttribute("aria-expanded", "true");
    const opened = body.querySelectorAll("tr");
    expect(opened).toHaveLength(2);
    expect(opened[1]).toHaveAttribute("id", details.getAttribute("aria-controls")); // the row under the entry
    expect(opened[1].querySelector("td")).toHaveAttribute("colspan", "4");
    expect(opened[1]).toContainElement(screen.getByText("Asset id"));
    await userEvent.click(details);
    expect(screen.queryByText("Asset id")).not.toBeInTheDocument();
    expect(body.querySelectorAll("tr")).toHaveLength(1);
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(details).not.toHaveAttribute("aria-controls");
  });

  it("gives every entry its own Details button, named by the entry", async () => {
    setup("/audit");
    await screen.findByText("Scan #51 finished (done)");
    expect(screen.getAllByRole("button", { name: /^Details of entry #/ }).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Details of entry #51", "Details of entry #50",
    ]);
  });

  it("shows the number of entries the filters match, singular for one, and nothing while the next query loads", async () => {
    setup("/audit", (req) => (req.url.includes("offset=50") ? list(1234, [entry(1, "scope.created", { scope_id: 1, name: "Lab" })], 50) : list(1234, [entry(51, "scan.finished")])));
    expect(await screen.findByText("1,234 entries")).toBeInTheDocument();
    const release = hold((url) => url.includes("offset=50"));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Updating…")).toBeInTheDocument();
    expect(screen.queryByText(/ entries?$/)).not.toBeInTheDocument(); // the old query's total says nothing about the next page's query
    await act(async () => { release(); });
    expect(await screen.findByText("1,234 entries")).toBeInTheDocument();
  });

  it("says '1 entry' for a log of one", async () => {
    setup("/audit", list(1, [entry(9, "asset.created", { asset_id: 7, name: "Panel A" })]));
    expect(await screen.findByText("1 entry")).toBeInTheDocument();
  });

  it("puts the count on the result line beside the View switch, which keeps its name", async () => {
    setup("/audit");
    const view = await screen.findByRole("group", { name: "View" });
    expect(within(view).getAllByRole("button").map((b) => b.textContent)).toEqual(["Friendly", "Raw"]);
    const line = view.parentElement!;
    expect(line).toHaveClass("row", "seg");
    expect(within(line).getByText("51 entries")).toBeInTheDocument();
  });

  it("marks each friendly row with the kind of event as an icon, and the sentence is still there", async () => {
    setup("/audit", list(3, [
      entry(7, "asset.deleted", { asset_id: 3, name: "Old pump" }),
      entry(6, "login.failed", { username: "ops" }, null),
      entry(5, "scan.started", { scan_id: 5 }),
    ]));
    const row = (await screen.findByText("Deleted asset Old pump")).closest("tr")!;
    const icon = row.querySelector("[data-kind]")!;
    expect(icon).toHaveAttribute("data-kind", "delete");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon.querySelector("svg")).not.toBeNull();
    const kinds = Array.from(document.querySelectorAll(".audit-table tbody [data-kind]")).map((el) => el.getAttribute("data-kind"));
    expect(kinds).toEqual(["delete", "problem", "other"]);
  });

  it("draws the user as an initial disc (hidden from screen readers) and the name; no user is a bare dash", async () => {
    setup("/audit", list(2, [entry(2, "scan.finished", { scan_id: 2, status: "done" }), entry(1, "scope.created", { scope_id: 1, name: "Lab" }, null)]));
    const cells = (await screen.findAllByRole("cell", { name: "admin" })).filter((c) => c.classList.contains("cell-user"));
    expect(cells).toHaveLength(1); // the disc's letter is not part of the cell's name
    const disc = cells[0].querySelector(".user-disc")!;
    expect(disc).toHaveAttribute("aria-hidden", "true");
    expect(disc).toHaveTextContent("A");
    expect(cells[0]).toHaveAttribute("title", "admin");
    const dash = screen.getByText("—");
    expect(dash.tagName).toBe("TD");
    expect(dash.querySelector(".user-disc")).toBeNull();
  });

  describe("how long ago (the site clock, taken once per render)", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("says how long ago under the exact time, outside the entry link", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-07T12:30:00Z")); // 2 h 30 min after the entries, the same site day (Asia/Qatar is UTC+3)
      setup("/audit");
      const link = await screen.findByRole("link", { name: "Entry #51, 2026-10-07 13:00:00" });
      expect(link).toHaveTextContent(/^2026-10-07 13:00:00$/); // the link's text stays exactly the time
      const ago = within(link.closest("td")!).getByText("2 h ago");
      expect(link).not.toContainElement(ago);
    });

    it("shows no line for an entry older than two weeks", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-12-01T12:00:00Z"));
      setup("/audit");
      const link = await screen.findByRole("link", { name: "Entry #51, 2026-10-07 13:00:00" });
      expect(link.closest("td")).toHaveTextContent(/^2026-10-07 13:00:00$/);
    });

    it("has the same time and user cells in the raw view", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-07T12:30:00Z"));
      setup("/audit?view=raw");
      const link = await screen.findByRole("link", { name: "Entry #51, 2026-10-07 13:00:00" });
      expect(within(link.closest("td")!).getByText("2 h ago")).toBeInTheDocument();
      expect(link.closest("tr")!.querySelector(".cell-user .user-disc")).not.toBeNull();
    });
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

  it("names the time link of a raw row by its entry too", async () => {
    setup("/audit?view=raw");
    const link = await screen.findByRole("link", { name: "Entry #51, 2026-10-07 13:00:00" });
    expect(link).toHaveAttribute("href", "/audit/51");
    expect(link).toHaveTextContent("2026-10-07 13:00:00");
  });

  it("says so when there is nothing yet", async () => {
    setup("/audit", list(0, []));
    const note = await screen.findByText("No audit entries yet.");
    expect(note.closest(".empty-note")).not.toBeNull(); // the compact note, not the big dashed box
    expect(document.querySelector(".audit-page .empty")).toBeNull();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    expect(screen.queryByText(/ entries?$/)).not.toBeInTheDocument(); // no count line for an empty log
  });

  it("says nothing matches when filters leave no entry, and Clear filters brings the log back", async () => {
    const { urls, search } = setup("/audit?action=asset.created", (req) =>
      req.url.includes("action=") ? list(0, []) : twoRows);
    expect((await screen.findByText("No entries match these filters.")).closest(".empty-note")).not.toBeNull();
    expect(screen.queryByText("No audit entries yet.")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
    expect(search()).toBe("");
    expect(urls.at(-1)).not.toContain("action=");
  });

  it("does not use the old query's total for the empty-state messages while the next query loads", async () => {
    const { search } = setup("/audit?action=a.b", (req) => (req.url.includes("action=") ? list(0, []) : twoRows));
    expect(await screen.findByText("No entries match these filters.")).toBeInTheDocument();
    const release = hold((url) => url.startsWith("/api/audit?") && !url.includes("action="));
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(search()).toBe(""));
    // the unfiltered answer is still on its way: the old "0 matches" must not turn into "the log is empty"
    expect(screen.queryByText("No audit entries yet.")).not.toBeInTheDocument();
    expect(screen.queryByText("No entries match these filters.")).not.toBeInTheDocument();
    // not blank either: there are no old rows to carry the "Updating…" line, so the page says it on its own
    expect(screen.getByText("Updating…")).toBeInTheDocument();
    await act(async () => { release(); });
    expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
    expect(screen.queryByText("No audit entries yet.")).not.toBeInTheDocument();
    expect(screen.queryByText("Updating…")).not.toBeInTheDocument();
  });

  it("does not flash the past-the-end message for an old page while the next one loads", async () => {
    setup("/audit?offset=100", (req) => (req.url.includes("offset=100") ? list(51, [], 100) : twoRows));
    expect(await screen.findByText("This page is past the end of the log.")).toBeInTheDocument();
    const release = hold((url) => url.startsWith("/api/audit?") && url.includes("offset=0"));
    await userEvent.click(screen.getAllByRole("button", { name: "First" })[0]);
    expect(screen.queryByText("This page is past the end of the log.")).not.toBeInTheDocument();
    await act(async () => { release(); });
    expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
  });

  it("an offset past the end says so, goes back with the pager's First, and never claims the log is empty", async () => {
    const { urls, search } = setup("/audit?offset=100", (req) => (req.url.includes("offset=100") ? list(51, [], 100) : twoRows));
    expect(await screen.findByText("This page is past the end of the log.")).toBeInTheDocument();
    expect(screen.queryByText("No audit entries yet.")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Showing /)).not.toBeInTheDocument();
    expect(screen.getByText("Page – of 2")).toBeInTheDocument(); // never "Page 3 of 2"
    expect(screen.getAllByRole("button", { name: "First" })).toHaveLength(1); // the pager's own; the message has none
    await userEvent.click(screen.getByRole("button", { name: "First" }));
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
      expect(await screen.findByText("No entries on 2026-10-05; showing the nearest ones.")).toBeInTheDocument();
      expect(search()).toBe("?offset=73");
      await userEvent.click(screen.getByRole("button", { name: "Previous" }));
      await waitFor(() => expect(search()).toBe("?offset=23"));
      expect(screen.queryByText(/^No entries on /)).not.toBeInTheDocument();
    });

    it("does not show the nothing-on-that-day hint when the log has no entries at all", async () => {
      setup("/audit", list(0, []), position({ body: { offset: 0, total: 0, on_day: false } }));
      expect(await screen.findByText("No audit entries yet.")).toBeInTheDocument();
      await jump();
      await waitFor(() => expect(screen.getByRole("button", { name: "Go" })).toBeEnabled());
      expect(screen.queryByText(/^No entries on /)).not.toBeInTheDocument();
    });

    it("does not rewrite the address of the page the user has moved to before the answer came", async () => {
      const { router } = setup("/audit", twoRows, position({ body: { offset: 73, total: 120, on_day: false } }));
      expect(await screen.findByText("Scan #51 finished (done)")).toBeInTheDocument();
      const release = hold((url) => url.startsWith("/api/audit/position"));
      await jump();
      await act(async () => { await router.navigate("/assets"); });
      expect(await screen.findByText("assets page")).toBeInTheDocument();
      await act(async () => {
        release();
        await new Promise((resolve) => setTimeout(resolve, 50)); // let the late answer land
      });
      expect(router.state.location.pathname + router.state.location.search).toBe("/assets");
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

describe("AuditPage while the log loads (W7f)", () => {
  const LABEL = "Loading the audit log";
  const mount = (route: string, held: string, reply: Routes[string] = twoRows) => {
    mockFetch({ ...admin, "GET /api/audit": reply });
    const hold = holdFetch((_method, path) => path === held);
    renderWithDataRouter(<AuditPage />, { route, path: "/audit" });
    return hold;
  };

  it("keeps the real header and filter bar and shows a table skeleton in one region while the log is held, then the rows and no region", async () => {
    const hold = mount("/audit", "/api/audit");
    expect(screen.getByRole("heading", { level: 1, name: "Audit log" })).toBeInTheDocument();
    expect(screen.getByLabelText("Action")).toBeInTheDocument(); // the filter bar does not wait
    const region = screen.getByText(LABEL).parentElement!;
    expect(region).toHaveAttribute("role", "status");
    expect(region.querySelectorAll(".sk-table thead th")).toHaveLength(4); // Details, Time, User, What happened
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("No audit entries yet.")).not.toBeInTheDocument();
    hold.release();
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
  });

  it("keeps the place of the Friendly/Raw switch above the skeleton (an aria-hidden .row.seg with a 34px gap, so the table does not jump), and the real switch replaces it", async () => {
    const hold = mount("/audit", "/api/audit");
    const place = document.querySelector(".audit-page > .row.seg")!;
    expect(place).toHaveAttribute("aria-hidden", "true");
    expect(place.textContent).toBe("");
    expect(place.querySelector("button")).toBeNull();
    expect((place.firstElementChild as HTMLElement).style.height).toBe("34px");
    const region = screen.getByText(LABEL).parentElement!;
    expect(place.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING, "the gap comes before the skeleton").toBeTruthy();
    expect(screen.queryByRole("group", { name: "View" })).not.toBeInTheDocument();
    hold.release();
    expect(await screen.findByRole("group", { name: "View" })).toBeInTheDocument();
    expect(document.querySelectorAll(".audit-page .row.seg")).toHaveLength(1); // the real one only
    expect(document.querySelector(".audit-page .row.seg[aria-hidden]")).toBeNull();
  });

  it("has four columns in the raw view", async () => {
    const hold = mount("/audit?view=raw", "/api/audit");
    expect(screen.getByText(LABEL).parentElement!.querySelectorAll(".sk-table thead th")).toHaveLength(4);
    hold.release();
    await screen.findByRole("table");
  });

  it("keeps the skeleton until the site zone is in as well, as the rows wait for it", async () => {
    const hold = mount("/audit", "/api/site");
    await screen.findByLabelText("Action");
    await new Promise((r) => setTimeout(r, 30)); // the log has answered by now
    expect(screen.getByText(LABEL)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    hold.release();
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
  });

  it("ends with the empty state for an empty log, and with the error when the log fails, never a region", async () => {
    mockFetch({ ...admin, "GET /api/audit": list(0, []) });
    const first = renderWithDataRouter(<AuditPage />, { route: "/audit", path: "/audit" });
    expect(await screen.findByText("No audit entries yet.")).toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
    first.unmount();
    mockFetch({ ...admin, "GET /api/audit": { status: 500, body: { detail: "the log is down" } } });
    renderWithDataRouter(<AuditPage />, { route: "/audit", path: "/audit" });
    expect(await screen.findByRole("alert")).toHaveTextContent("the log is down");
    expect(document.querySelector(".sk-region")).toBeNull();
  });
});
