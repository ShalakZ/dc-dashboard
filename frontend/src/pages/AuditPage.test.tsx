import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../api/client";
import type { AuditRefs } from "../api/types";
import { downloadCsv } from "../lib/download";
import { mockFetch, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import type { PermissionId } from "../lib/permissions";
import { renderWithDataRouter } from "../test/render";
import { accountKnown, SignedIn } from "../test/signedIn";
import { spyToasts } from "../test/toasts";
import { userFor } from "../test/users";
import type { ToastApi } from "../components/Toasts";
import { AuditPage } from "./AuditPage";

vi.mock("../lib/download", () => ({ downloadCsv: vi.fn() }));

const entry = (id: number, action: string, detail: Record<string, unknown> = { scan_id: id }, username: string | null = "admin") => ({
  id, user_id: username ? 1 : null, actor_id: username ? 1 : null, username, action, detail, ts: "2026-10-07T10:00:00Z",
});
const list = (total: number, items: (ReturnType<typeof entry> & { refs?: AuditRefs })[], offset = 0) => ({
  body: { total, offset, limit: 50, items },
});

const admin: Routes = {
  "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: userFor("admin") },
  "GET /api/site": { body: { timezone: "Asia/Qatar", currency: null } },
  "GET /api/audit/options": {
    body: { actions: ["asset.created", "scan.finished"], users: [{ id: 1, name: "admin" }], unattributed: true },
  },
};

const twoRows = list(51, [entry(51, "scan.finished", { scan_id: 51, status: "done" }), entry(50, "scan.started", { scan_id: 50 })]);

/** Every /api/audit request's URL is recorded; `routes` may override or add routes. */
function setup(route: string, auditReply: Routes[string] = twoRows, routes: Routes = {}, toasts?: ToastApi) {
  const urls: string[] = [];
  const calls = mockFetch({
    ...admin,
    "GET /api/audit": (req) => {
      urls.push(req.url);
      return typeof auditReply === "function" ? auditReply(req) : auditReply;
    },
    ...routes,
  });
  // <main id="main"> is the Layout's: the drawer sends focus there when the entry it was opened for has no row to go back to
  const view = renderWithDataRouter(<main id="main" tabIndex={-1}><AuditPage /></main>, { route, path: "/audit/:id?", toasts });
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

  it("names the asset of a tariff entry from the entry's refs, and says 'a deleted asset' when the server did not find it", async () => {
    const tariff = { tariff_id: 3, asset_id: 7, rate_per_kwh: 0.16, effective_from: "2026-10-13" };
    setup("/audit", list(2, [
      { ...entry(9, "tariff.created", tariff), refs: { asset: { "7": "MV2-R1-LV-Panel-02" } } },
      { ...entry(8, "tariff.created", tariff), refs: {} },
    ]));
    expect(await screen.findByText("Created tariff 0.16 per kWh from 2026-10-13 for asset MV2-R1-LV-Panel-02")).toBeInTheDocument();
    expect(screen.getByText("Created tariff 0.16 per kWh from 2026-10-13 for a deleted asset")).toBeInTheDocument();
    expect(screen.queryByText(/#\d/)).not.toBeInTheDocument(); // no id in any visible text
  });

  it("links an entry to the thing it is about, and its Details button opens a drawer (no row opens under it any more)", async () => {
    setup("/audit", list(1, [entry(9, "asset.created", { asset_id: 7, name: "Panel A" })]));
    expect(await screen.findByText("Created asset Panel A")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open asset Panel A" })).toHaveAttribute("href", "/assets/7");
    const details = screen.getByRole("button", { name: "Details of entry #9" });
    expect(details).toHaveAttribute("aria-haspopup", "dialog");
    expect(details).not.toHaveAttribute("aria-expanded");
    expect(details).not.toHaveAttribute("aria-controls");
    await userEvent.click(details);
    expect(await screen.findByRole("dialog", { name: "Audit entry" })).toBeInTheDocument();
    expect(document.querySelector(".detail-row")).toBeNull();
    expect(document.querySelectorAll(".audit-table tbody tr")).toHaveLength(1);
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
    expect(link).toHaveAttribute("href", "/audit/51?view=raw"); // the list's query rides along, so the drawer opens over the same list
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
    it("downloads the filtered log and says so with one toast, after the file came back", async () => {
      const toasts = spyToasts();
      setup("/audit?action=asset.created&q=panel+a", twoRows, {}, toasts.api);
      await userEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
      expect(downloadCsv).toHaveBeenCalledWith("/api/audit.csv?action=asset.created&q=panel+a");
      await waitFor(() => expect(toasts.calls).toEqual([{ kind: "info", text: "CSV downloaded" }]));
    });

    it("downloads the whole log when nothing is filtered", async () => {
      setup("/audit");
      await userEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
      expect(downloadCsv).toHaveBeenCalledWith("/api/audit.csv?");
    });

    it("shows the API's message when the export is refused", async () => {
      vi.mocked(downloadCsv).mockRejectedValueOnce(new ApiError(422, "more than 20000 entries; narrow the date range"));
      const toasts = spyToasts();
      setup("/audit", twoRows, {}, toasts.api);
      await userEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("narrow the date range");
      await waitFor(() => expect(screen.getByRole("button", { name: "Export CSV" })).toBeEnabled());
      expect(toasts.calls).toEqual([]); // a failed export keeps its inline line and raises no toast
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

describe("AuditPage Export CSV follows the permission of the role (a custom role)", () => {
  /** A role called "custom" that holds `permissions`; the log is up and the account is known when this returns. */
  const show = async (permissions: PermissionId[]) => {
    mockFetch({ ...admin, "GET /api/me": { body: userFor("custom", { permissions }) }, "GET /api/audit": twoRows });
    renderWithDataRouter(<><AuditPage /><SignedIn /></>, { route: "/audit", path: "/audit" });
    await screen.findByText("Scan #51 finished (done)");
    await accountKnown();
  };

  it("audit.view alone: the log, the filters and Go to date, and no Export CSV", async () => {
    await show(["audit.view"]);
    expect(screen.getByRole("button", { name: "Go" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Today" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
  });

  it("audit.view and audit.export: Export CSV downloads the log", async () => {
    await show(["audit.view", "audit.export"]);
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(downloadCsv).toHaveBeenCalledWith("/api/audit.csv?");
  });

  it("the Administrator role is unchanged: Export CSV is there", async () => {
    setup("/audit");
    expect(await screen.findByRole("button", { name: "Export CSV" })).toBeInTheDocument();
  });
});

describe("AuditPage: an entry opens in the drawer (W7l)", () => {
  const tariff = { tariff_id: 3, asset_id: 7, rate_per_kwh: 0.16, effective_from: "2026-10-13" };
  const SENTENCE = "Created tariff 0.16 per kWh from 2026-10-13 for asset Panel A";
  const page = list(51, [
    { ...entry(51, "tariff.created", tariff), refs: { asset: { "7": "Panel A" } } },
    entry(50, "scan.started", { scan_id: 50 }),
    entry(49, "asset.created", { asset_id: 7, name: "Panel A" }),
  ]);
  const found = (id: number) => ({ ...entry(id, "scan.finished", { scan_id: id, status: "done" }), refs: {} });
  const dialog = () => screen.findByRole("dialog", { name: "Audit entry" });
  const noDialog = () => expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  const rowOf = (id: number) => document.querySelector<HTMLElement>(`tr[data-entry-id="${id}"]`)!;
  const chevron = (id: number) => screen.getByRole("button", { name: `Details of entry #${id}` });
  const where = (view: { router: { state: { location: { pathname: string; search: string } } } }) => {
    const { pathname, search } = view.router.state.location;
    return pathname + search;
  };
  /** A page of the log; the entry route answers `entries` (an id missing from it is a 404). */
  const mount = (route: string, entries: Record<number, ReturnType<typeof found>> = {}, toasts?: ToastApi) =>
    setup(route, page, {
      ...Object.fromEntries(Object.entries(entries).map(([id, e]) => [`GET /api/audit/${id}`, { body: e }])),
    }, toasts);

  describe("opening", () => {
    it("opens from the Details button, from the time link and from a click on the row, each as one new history entry that keeps the list's query", async () => {
      const view = mount("/audit?q=Panel");
      await screen.findByText(SENTENCE);
      expect(view.router.state.historyAction).toBe("POP");

      await userEvent.click(chevron(51));
      const first = await dialog();
      expect(within(first).getByText(SENTENCE)).toBeInTheDocument();
      expect(where(view)).toBe("/audit/51?q=Panel");
      expect(view.router.state.historyAction).toBe("PUSH");
      expect(view.router.state.location.state).toEqual({ fromList: true, search: "?q=Panel" });

      await userEvent.click(within(first).getByRole("button", { name: "Close" }));
      await waitFor(noDialog);
      expect(where(view)).toBe("/audit?q=Panel");

      const time = screen.getByRole("link", { name: /^Entry #50,/ });
      expect(time).toHaveAttribute("href", "/audit/50?q=Panel"); // a real link: a middle click opens the deep link
      await userEvent.click(time);
      expect(await dialog()).toBeInTheDocument();
      expect(where(view)).toBe("/audit/50?q=Panel");
      expect(view.router.state.historyAction).toBe("PUSH");
      expect(view.router.state.location.state).toEqual({ fromList: true, search: "?q=Panel" });
      await userEvent.keyboard("{Escape}");
      await waitFor(noDialog);

      await userEvent.click(rowOf(49).querySelector(".cell-user")!);
      expect(await dialog()).toBeInTheDocument();
      expect(where(view)).toBe("/audit/49?q=Panel");
      expect(view.router.state.historyAction).toBe("PUSH");
    });

    it("opens from a click on a raw row and from its time link, and shows the same drawer", async () => {
      const view = mount("/audit?view=raw");
      await screen.findByText("tariff.created");
      await userEvent.click(rowOf(50).querySelector(".cell-action")!);
      const open = await dialog();
      expect(where(view)).toBe("/audit/50?view=raw");
      expect(within(open).getByText("Started scan #50")).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      await waitFor(noDialog);
      await userEvent.click(screen.getByRole("link", { name: /^Entry #49,/ }));
      expect(await within(await dialog()).findByText("Created asset Panel A")).toBeInTheDocument();
      expect(where(view)).toBe("/audit/49?view=raw");
    });

    it("pushes once for the Details button (its click is not also the row's)", async () => {
      const view = mount("/audit");
      await screen.findByText(SENTENCE);
      const navigate = vi.spyOn(view.router, "navigate");
      await userEvent.click(chevron(50));
      await dialog();
      expect(navigate).toHaveBeenCalledTimes(1);
    });

    it("does not open for a click on a link in the row (it does its own thing)", async () => {
      const view = mount("/audit");
      const link = await screen.findByRole("link", { name: "Open asset Panel A" });
      link.addEventListener("click", (e) => e.preventDefault()); // the link would leave for /assets/7; this test is about the row
      await userEvent.click(link);
      noDialog();
      expect(where(view)).toBe("/audit");
    });

    it("does not open for a click that ends a text selection, and opens again once nothing is selected", async () => {
      const view = mount("/audit");
      await screen.findByText(SENTENCE);
      const cell = rowOf(50).querySelector<HTMLElement>(".cell-what")!;
      window.getSelection()!.selectAllChildren(cell.querySelector(".what")!);
      expect(window.getSelection()!.toString()).toBe("Started scan #50");
      fireEvent.click(cell);
      noDialog();
      expect(where(view)).toBe("/audit");
      window.getSelection()!.removeAllRanges();
      fireEvent.click(cell);
      expect(await dialog()).toBeInTheDocument();
    });

    it("marks the open row (and only that one) and drops the mark on close", async () => {
      mount("/audit");
      await screen.findByText(SENTENCE);
      expect(document.querySelector("tr[data-open]")).toBeNull();
      await userEvent.click(chevron(50));
      await dialog();
      expect([...document.querySelectorAll("tr[data-open]")].map((r) => r.getAttribute("data-entry-id"))).toEqual(["50"]);
      await userEvent.keyboard("{Escape}");
      await waitFor(noDialog);
      expect(document.querySelector("tr[data-open]")).toBeNull();
    });
  });

  describe("the address", () => {
    it("a deep link to an entry of the loaded page opens the drawer over the list and asks for no second copy of it", async () => {
      const view = mount("/audit/50?q=Panel");
      const open = await dialog();
      expect(await within(open).findByText("Started scan #50")).toBeInTheDocument();
      expect(rowOf(51)).toBeInTheDocument(); // the list is behind it
      expect(rowOf(50)).toHaveAttribute("data-open");
      expect(where(view)).toBe("/audit/50?q=Panel");
      expect(view.calls.some((c) => c.path === "/api/audit/50")).toBe(false);
    });

    it("a deep link to an entry that is not on the page fetches it once the list has answered, and shows it", async () => {
      const view = mount("/audit/7", { 7: found(7) });
      const open = await dialog();
      expect(await within(open).findByText("Scan #7 finished (done)")).toBeInTheDocument();
      expect(view.calls.filter((c) => c.path === "/api/audit/7")).toHaveLength(1);
      const order = view.calls.map((c) => c.path);
      expect(order.indexOf("/api/audit")).toBeLessThan(order.indexOf("/api/audit/7"));
      expect(document.querySelector("tr[data-open]")).toBeNull(); // it is not a row of this page
    });

    it("shows a skeleton in the drawer while that entry loads", async () => {
      mockFetch({ ...admin, "GET /api/audit": page, "GET /api/audit/7": { body: found(7) } });
      const held = holdFetch((_method, path) => path === "/api/audit/7");
      renderWithDataRouter(<AuditPage />, { route: "/audit/7", path: "/audit/:id?" });
      const open = await dialog();
      expect(await within(open).findByText("Loading the entry")).toBeInTheDocument();
      expect(within(open).queryByText("What happened")).not.toBeInTheDocument();
      held.release();
      expect(await within(open).findByText("Scan #7 finished (done)")).toBeInTheDocument();
      expect(within(open).queryByText("Loading the entry")).not.toBeInTheDocument();
    });

    it.each(["abc", "99999999999", "0", "1.5"])("says not found for the id %s inside the drawer, without asking the API", async (id) => {
      const view = mount(`/audit/${id}`);
      const open = await dialog();
      expect(await within(open).findByRole("alert")).toHaveTextContent("Audit entry not found.");
      expect(view.calls.some((c) => c.path.startsWith("/api/audit/") && c.path !== "/api/audit/options")).toBe(false);
    });

    it("says not found for an entry the API does not hold, and shows its message for any other failure", async () => {
      mockFetch({
        ...admin, "GET /api/audit": page,
        "GET /api/audit/404": { status: 404, body: { detail: "audit entry not found" } },
        "GET /api/audit/500": { status: 500, body: { detail: "database is down" } },
      });
      const gone = renderWithDataRouter(<AuditPage />, { route: "/audit/404", path: "/audit/:id?" });
      expect(await within(await dialog()).findByRole("alert")).toHaveTextContent("Audit entry not found.");
      gone.unmount();
      renderWithDataRouter(<AuditPage />, { route: "/audit/500", path: "/audit/:id?" });
      expect(await within(await dialog()).findByRole("alert")).toHaveTextContent("database is down");
    });
  });

  describe("closing", () => {
    it.each([
      ["Escape", async () => { await userEvent.keyboard("{Escape}"); }],
      ["the Close button", async () => { await userEvent.click(screen.getByRole("button", { name: "Close" })); }],
      ["a click on the backdrop", async () => { await userEvent.click(document.querySelector(".drawer-backdrop")!); }],
    ])("%s goes back to the list it was opened from: same query, the page not reloaded", async (_name, close) => {
      const view = mount("/audit?q=Panel&view=raw");
      await screen.findByText("tariff.created");
      const lists = () => view.calls.filter((c) => c.path === "/api/audit").length;
      const before = lists();
      await userEvent.click(rowOf(50).querySelector(".cell-action")!);
      await dialog();
      await close();
      await waitFor(noDialog);
      expect(where(view)).toBe("/audit?q=Panel&view=raw");
      expect(view.router.state.historyAction).toBe("POP"); // one step back, not a new entry
      expect(lists()).toBe(before);
      expect(screen.getByRole("button", { name: "Raw" })).toHaveAttribute("aria-pressed", "true");
    });

    it("from a deep link it goes to the list with the same query (replacing the entry, there is nothing to go back to)", async () => {
      const view = mount("/audit/50?q=Panel");
      await dialog();
      await userEvent.keyboard("{Escape}");
      await waitFor(noDialog);
      expect(where(view)).toBe("/audit?q=Panel");
      expect(view.router.state.historyAction).toBe("REPLACE");
    });

    it("the browser's Back button closes it", async () => {
      const view = mount("/audit?q=Panel");
      await screen.findByText(SENTENCE);
      await userEvent.click(chevron(51));
      await dialog();
      await act(async () => { await view.router.navigate(-1); });
      await waitFor(noDialog);
      expect(where(view)).toBe("/audit?q=Panel");
    });

    it("a key held down (a second Escape before the first close lands) goes back once", async () => {
      const view = mount("/audit");
      await screen.findByText(SENTENCE);
      await userEvent.click(chevron(51));
      await dialog();
      const navigate = vi.spyOn(view.router, "navigate");
      const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await act(async () => { escape(); escape(); }); // both land before React has taken the drawer away
      await waitFor(noDialog);
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith(-1);
    });

    it("can be opened and closed again", async () => {
      const view = mount("/audit");
      await screen.findByText(SENTENCE);
      for (const id of [51, 50, 51]) {
        await userEvent.click(chevron(id));
        await dialog();
        await userEvent.keyboard("{Escape}");
        await waitFor(noDialog);
        expect(where(view)).toBe("/audit");
      }
    });
  });

  describe("focus on close", () => {
    it("goes to the Details button of the row that was open", async () => {
      mount("/audit");
      await screen.findByText(SENTENCE);
      await userEvent.click(rowOf(50).querySelector(".cell-user")!); // a click on the row: nothing in it had focus
      await dialog();
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(chevron(50)).toHaveFocus());
    });

    it("goes to the time link of the open row in the raw view, which has no Details button", async () => {
      mount("/audit?view=raw");
      await screen.findByText("tariff.created");
      await userEvent.click(rowOf(50).querySelector(".cell-action")!);
      await dialog();
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(within(rowOf(50)).getByRole("link")).toHaveFocus());
    });

    it("goes to the page when the entry has no row on it (a deep link to another page)", async () => {
      mount("/audit/7", { 7: found(7) });
      await within(await dialog()).findByText("Scan #7 finished (done)");
      await userEvent.keyboard("{Escape}");
      await waitFor(noDialog);
      await waitFor(() => expect(document.getElementById("main")).toHaveFocus());
    });
  });
});
