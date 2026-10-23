import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../api/client";
import type { EventDetail, EventPage, EventSummary, Incident, SystemEvent } from "../api/types";
import { PAGE_NEED } from "../components/navItems";
import { RequirePermission } from "../auth/RequireAuth";
import { downloadCsv } from "../lib/download";
import type { PermissionId } from "../lib/permissions";
import { mockFetch, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithDataRouter } from "../test/render";
import { spyToasts } from "../test/toasts";
import { userFor } from "../test/users";
import { EventsPage } from "./EventsPage";

vi.mock("../lib/download", () => ({ downloadCsv: vi.fn() }));

const incident = (extra: Partial<Incident> = {}): Incident => ({
  state: "open", count: 1204, first_at: "2026-10-18T04:52:00Z", last_at: "2026-10-22T09:59:00Z", closed_at: null, duration_seconds: 4 * 86400 + 2 * 3600, closed_by: null, ...extra,
});
const ev = (id: number, extra: Partial<SystemEvent> = {}): SystemEvent => ({
  id, ts: "2026-10-22T08:00:00Z", level: "info", component: "collector", source_id: 4, source_name: "Plant OPC", source_deleted: false,
  kind: "check.finished", code: null, message: `connection check passed (${id} steps)`, detail: { ok: true, steps: id }, incident: null, ...extra,
});
const OFFLINE = ev(7, {
  level: "warning", kind: "source.offline", code: "unreachable", source_name: "OPC UA server at 172.20.0.3:4840",
  message: "[Errno 111] Connect call failed ('172.20.0.3', 4840)", detail: { interval: 10 }, incident: incident(),
});
const ONLINE = ev(6, { kind: "source.online", message: "back online after 3 min", detail: { incident_id: 3, offline_seconds: 180, failed_reads: 12 } });
const CHECK = ev(5, { ts: "2026-10-22T07:00:00Z" });

const page = (items: SystemEvent[], extra: Partial<EventPage> = {}): EventPage => ({ items, next: null, total: null, total_capped: false, ...extra });
const SUMMARY: EventSummary = { open_incidents: 1, warnings_24h: 5, errors_24h: 0, kept: 3412, oldest: "2026-07-24T08:00:00Z", retention_days: 90, max_rows: 100_000 };

const admin: Routes = {
  "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: userFor("admin") },
  "GET /api/site": { body: { timezone: "Asia/Qatar", currency: null } },
};

/** The server of a test: what the journal holds (newest first) and how it answers each kind of request the page makes. */
function server(initial: SystemEvent[] = [OFFLINE, ONLINE, CHECK]) {
  const state = {
    items: initial, open: initial.filter((item) => item.incident?.state === "open"), summary: SUMMARY, nextPage: null as EventPage | null, latestStatus: 200,
    total: null as number | null, capped: false, nextFails: null as string | null,
  };
  const urls: string[] = [];
  const params = (url: string) => new URL(url, "http://x").searchParams;
  const kind = (url: string): "pinned" | "next" | "first" | "latest" => {
    const q = params(url);
    if (q.get("before")) return "next";
    if (q.get("include_total") === "1") return "first";
    if (q.get("open") === "1" && ![...q.keys()].some((key) => ["level", "kind", "from", "to"].includes(key))) return "pinned";
    return "latest";
  };
  const routes: Routes = {
    "GET /api/events": ({ url }) => {
      urls.push(url);
      switch (kind(url)) {
        case "pinned": return { body: page(state.open) };
        case "next": return state.nextFails ? { status: 500, body: { detail: state.nextFails } } : { body: state.nextPage ?? page([]) };
        case "first": return { body: page(state.items, { total: state.total ?? state.items.length, total_capped: state.capped, next: state.nextPage ? "1760000000000000_5" : null }) };
        default: return state.latestStatus === 200 ? { body: page(state.items, { next: state.nextPage ? "1760000000000000_5" : null }) } : { status: state.latestStatus, body: { detail: "boom" } };
      }
    },
    "GET /api/events/options": { body: { kinds: ["source.offline", "source.online", "check.finished"], sources: [{ id: 4, name: "Plant OPC" }] } },
    "GET /api/events/summary": () => ({ body: state.summary }),
  };
  return {
    state, urls, routes, kind, params,
    listCalls: () => urls.filter((url) => kind(url) === "first"),
    latestCalls: () => urls.filter((url) => kind(url) === "latest"),
    pinnedCalls: () => urls.filter((url) => kind(url) === "pinned"),
  };
}

function setup(route = "/events", routes: Routes = {}, srv = server(), toasts = spyToasts()) {
  const calls = mockFetch({ ...admin, ...srv.routes, ...routes });
  const view = renderWithDataRouter(<main id="main" tabIndex={-1}><EventsPage /></main>, { route, path: "/events/:id?", toasts: toasts.api });
  return { ...view, srv, calls, toasts, search: () => view.router.state.location.search, path: () => view.router.state.location.pathname };
}
const rowFor = (id: number) => document.querySelector<HTMLElement>(`tr[data-event-id="${id}"]`)!;

beforeEach(() => { vi.mocked(downloadCsv).mockReset().mockResolvedValue(undefined); });

describe("EventsPage: the page (w32)", () => {
  it("is the System events page: one h1, the sub line with a link to the Audit log, and the page class", async () => {
    setup();
    expect(await screen.findByRole("heading", { level: 1, name: "System events" })).toBeInTheDocument();
    expect(document.querySelector(".events-page")).not.toBeNull();
    expect(screen.getByText(/What the system did by itself/)).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Audit log" })).toHaveAttribute("href", "/audit");
  });

  it("names the Audit log without a link for an account that may not read it", async () => {
    mockFetchAs(["diagnostics.view", "sources.view"]);
    expect(await screen.findByRole("row", { name: /OPC UA server/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Audit log" })).toBeNull();
    expect(screen.getByText(/Who did what is in the Audit log\./)).toBeInTheDocument();
  });

  it("shows the four tiles on top, the first red above zero", async () => {
    setup();
    expect(await screen.findByText("3,412")).toBeInTheDocument();
    const tiles = [...document.querySelectorAll(".event-tiles > .tile")];
    expect(tiles.map((tile) => tile.querySelector(".tile-label")!.textContent)).toEqual(["Open problems", "Warnings, last 24 h", "Errors, last 24 h", "Kept"]);
    expect(tiles.map((tile) => tile.querySelector(".big")!.textContent)).toEqual(["1", "5", "0", "3,412 events"]);
    expect(tiles[0]).toHaveAttribute("data-alert", "true");
    expect(tiles[1]).not.toHaveAttribute("data-alert");
    expect(tiles[2]).not.toHaveAttribute("data-alert");
    expect(tiles[3]).toHaveTextContent("90 days");
    expect(tiles[3]).toHaveTextContent("the oldest from 24 Jul");
    // review M7: the day and the month of the oldest event are one no-wrap unit, so the note never breaks between "2" and "Sep" at 1024 px
    expect(tiles[3].querySelector(".tile-date")).toHaveTextContent(/^24 Jul$/);
    expect(tiles[3].querySelector("small.muted")).toHaveTextContent("90 days, the oldest from 24 Jul");
  });

  it("gives each tile's ? tip its own name, About plus the tile's title (review M8)", async () => {
    setup();
    expect(await screen.findByText("3,412")).toBeInTheDocument();
    const tiles = [...document.querySelectorAll(".event-tiles > .tile")];
    expect(tiles.map((tile) => tile.querySelector(".tip-btn")!.getAttribute("aria-label"))).toEqual(
      ["About Open problems", "About Warnings, last 24 h", "About Errors, last 24 h", "About Kept"],
    );
  });

  it("shows no red on the first tile when nothing is open", async () => {
    const srv = server([ONLINE]);
    srv.state.summary = { ...SUMMARY, open_incidents: 0 };
    setup("/events", {}, srv);
    await screen.findByText("3,412");
    expect(document.querySelector(".event-tiles > .tile")).not.toHaveAttribute("data-alert");
  });

  it("pins the open problems above the list, one line each, in plain words, linked to their event", async () => {
    setup();
    const line = await screen.findByText("OPC UA server at 172.20.0.3:4840 is offline since 18 Oct 07:52 (4 d 2 h), 1,204 failed reads. Could not connect to the server.");
    expect(line.closest(".open-now")).not.toBeNull();
    expect(within(line.closest("li") as HTMLElement).getByRole("link", { name: "Open problem details, event #7" })).toHaveAttribute("href", "/events/7");
    expect(screen.getByRole("heading", { level: 2, name: "Happening now" })).toBeInTheDocument();
  });

  it("pins a stale-meters incident without 'offline' or a count of failed reads, and shows its row with the same words (w35)", async () => {
    const stale = ev(9, {
      level: "error", component: "figures", kind: "data.stale", message: "3 of 12 meters have had no good reading for up to 2 h 10 min",
      detail: { state: "open", count: 7, meters: 12, stale: 3, not_advancing: 0, frozen: false },
      incident: incident({ count: 7, duration_seconds: 2 * 3600 }),
    });
    setup("/events", {}, server([stale, OFFLINE, ONLINE]));
    const line = await screen.findByText("Plant OPC has stale meters since 18 Oct 07:52 (2 h). 3 of 12 meters have no good reading.");
    expect(line.closest(".open-now")).not.toBeNull();
    expect(line).not.toHaveTextContent(/offline|failed/);
    const row = rowFor(9);
    expect(within(row).getByText("3 of 12 meters have no good reading")).toBeInTheDocument();
    expect(row).not.toHaveTextContent(/failed \d+ times?/);
    expect(row).toHaveTextContent("ongoing, 2 h");
  });

  it("says so, in the place the lines would be, when nothing is open", async () => {
    const srv = server([ONLINE]);
    srv.state.open = [];
    setup("/events", {}, srv);
    expect(await screen.findByText("No problems are open right now.")).toBeInTheDocument();
  });

  it("does not pin the open problems again while the list is filtered to Open only", async () => {
    const srv = server();
    setup("/events?open=1", {}, srv);
    expect(await screen.findByRole("row", { name: /OPC UA server/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Happening now" })).toBeNull();
    expect(srv.params(srv.listCalls()[0]).get("open")).toBe("1");
  });

  it("asks the pinned lines only for the source the list is filtered to", async () => {
    const srv = server();
    setup("/events?source=4&level=warning&from=2026-10-01", {}, srv);
    await screen.findByText(/is offline since/);
    const q = srv.params(srv.pinnedCalls()[0]);
    expect(q.get("source")).toBe("4");
    expect(q.get("open")).toBe("1");
    expect(q.get("include_total")).toBe("0");
    expect(q.getAll("level")).toEqual([]);
    expect(q.get("from")).toBeNull();
  });

  it("offers every open problem past the tenth as one button that turns Open only on", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ev(100 + i, { kind: "source.offline", level: "warning", code: "timeout", source_name: `Source ${i}`, incident: incident({ count: i + 1 }) }));
    const srv = server(many);
    const { search } = setup("/events", {}, srv);
    await screen.findByText(/Source 0 is offline/);
    expect(document.querySelectorAll(".open-now li")).toHaveLength(10);
    await userEvent.click(screen.getByRole("button", { name: "Show all open problems" }));
    expect(search()).toBe("?open=1");
  });
});

describe("EventsPage: the list (w32)", () => {
  it("lists the events newest first, with a severity tag, the source, the sentence and the count, and the time in the site's zone", async () => {
    setup();
    await screen.findByRole("row", { name: /OPC UA server/ });
    const first = rowFor(7);
    expect(within(first).getByRole("link", { name: "Event #7, 2026-10-22 11:00:00" })).toHaveAttribute("href", "/events/7");
    expect(first.querySelector(".ev-tag")).toHaveClass("ev-tag-warning");
    expect(first.querySelector(".ev-tag")).toHaveTextContent("Warning");
    expect(within(first).getByRole("link", { name: "OPC UA server at 172.20.0.3:4840" })).toHaveAttribute("href", "/sources");
    expect(first).toHaveTextContent("Went offline: could not reach the server");
    expect(first).toHaveTextContent("failed 1,204 times");
    expect(first).toHaveTextContent("ongoing, 4 d 2 h");
    expect(rowFor(6)).toHaveTextContent("Back online after 3 min");
    expect(rowFor(5)).toHaveTextContent("The connection check passed (5 steps)");
    expect([...document.querySelectorAll(".events-table tbody tr")].map((tr) => tr.getAttribute("data-event-id"))).toEqual(["7", "6", "5"]);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Details", "Time (Asia/Qatar)", "Source", "What happened", "Count"]);
  });

  it("shows an old row (no incident) with no count", async () => {
    setup("/events", {}, server([ev(3, { kind: "source.offline", level: "warning", code: "timeout", message: "timed out", incident: null })]));
    await screen.findByText("Went offline: the server did not answer in time");
    expect(rowFor(3).querySelector(".cell-count")).toBeEmptyDOMElement();
  });

  it("shows a deleted source and an event of no source without a link", async () => {
    setup("/events", {}, server([
      ev(3, { source_id: 9, source_name: null, source_deleted: true }),
      ev(2, { source_id: null, source_name: null, kind: "collector.started", message: "collector started, build x" }),
    ]));
    await screen.findByText("The collector started");
    expect(within(rowFor(3)).getByText("deleted source #9")).toBeInTheDocument();
    expect(within(rowFor(3)).queryByRole("link", { name: /deleted/ })).toBeNull();
    expect(rowFor(2).querySelector(".cell-source")).toHaveTextContent("—");
  });

  it("counts them, and says '10,000+' when the server capped the total", async () => {
    const { unmount } = setup();
    expect(await screen.findByText("3 events")).toBeInTheDocument();
    unmount();
    const srv = server();
    srv.state.total = 10_000;
    srv.state.capped = true;
    setup("/events", {}, srv);
    expect(await screen.findByText("10,000+ events")).toBeInTheDocument();
    expect(screen.getByText("Showing 3 of 10,000+")).toBeInTheDocument();
    cleanup();
    const one = server([ONLINE]);
    one.state.open = [];
    setup("/events", {}, one);
    expect(await screen.findByText("1 event")).toBeInTheDocument();
  });

  it("shows the raw rows in the Raw view: the stored message and detail, and keeps the view in the address", async () => {
    const { search } = setup();
    await screen.findByRole("row", { name: /OPC UA server/ });
    await userEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(search()).toBe("?view=raw");
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Time (Asia/Qatar)", "Level", "Source", "Kind", "Message"]);
    expect(rowFor(7)).toHaveTextContent("source.offline / unreachable");
    expect(rowFor(7)).toHaveTextContent("[Errno 111] Connect call failed ('172.20.0.3', 4840)");
    expect(rowFor(7).querySelector(".cell-detail code")).toHaveTextContent('"interval":10');
    await userEvent.click(screen.getByRole("button", { name: "Friendly" }));
    expect(search()).toBe("");
  });

  it("draws a skeleton of the same table while the first page is read, one status region, and then the rows", async () => {
    mockFetch({ ...admin, ...server().routes });
    const { release } = holdFetch((_method, path) => path === "/api/events");
    renderWithDataRouter(<main id="main" tabIndex={-1}><EventsPage /></main>, { route: "/events", path: "/events/:id?" });
    await waitFor(() => expect(document.querySelectorAll(".sk-table tbody tr")).toHaveLength(8));
    expect(document.querySelectorAll(".sk-table thead th")).toHaveLength(5);
    expect(document.querySelectorAll(".sk-table col")).toHaveLength(5);
    expect(screen.getByText("Loading the system events")).toBeInTheDocument();
    expect(document.querySelectorAll(".events-page [role=status]")).toHaveLength(1);
    release();
    await screen.findByRole("row", { name: /OPC UA server/ });
    expect(document.querySelector(".sk-table")).toBeNull();
    expect(document.querySelectorAll(".events-table col")).toHaveLength(5);
  });

  it("draws as many placeholder lines for the open problems as the tiles say are open, so the list does not drop when they arrive", async () => {
    const srv = server();
    srv.state.summary = { ...SUMMARY, open_incidents: 3 };
    mockFetch({ ...admin, ...srv.routes });
    const { release } = holdFetch((_method, path) => path === "/api/events");
    renderWithDataRouter(<main id="main" tabIndex={-1}><EventsPage /></main>, { route: "/events", path: "/events/:id?" });
    await screen.findByText("3,412");
    expect(document.querySelectorAll(".open-now li")).toHaveLength(3);
    expect(document.querySelector(".open-now ul")).toHaveAttribute("aria-hidden", "true");
    release();
    await screen.findByText(/is offline since/);
    expect(document.querySelectorAll(".open-now li")).toHaveLength(1);
  });

  it("says there are no events yet, or that none match the filters", async () => {
    const empty = server([]);
    empty.state.open = [];
    const { unmount } = setup("/events", {}, empty);
    expect(await screen.findByText("No system events yet.")).toBeInTheDocument();
    unmount();
    const none = server([]);
    none.state.open = [];
    setup("/events?level=error", {}, none);
    expect(await screen.findByText("No events match these filters.")).toBeInTheDocument();
  });

  it("shows the server's sentence as an alert when the list cannot be read, and no table", async () => {
    setup("/events", { "GET /api/events": { status: 500, body: { detail: "the journal is not available" } } });
    expect(await screen.findByRole("alert")).toHaveTextContent("the journal is not available");
    expect(document.querySelector(".events-table")).toBeNull();
  });
});

describe("EventsPage: filters and paging (w32)", () => {
  it("sends each filter to the list and keeps it in the address", async () => {
    const srv = server();
    const { search } = setup("/events", {}, srv);
    await screen.findByRole("row", { name: /OPC UA server/ });
    const bar = screen.getByRole("search", { name: "Filter the system events" });
    await userEvent.selectOptions(within(bar).getByLabelText("Source"), "4");
    await userEvent.click(within(bar).getByRole("button", { name: "Warning" }));
    await userEvent.click(within(bar).getByRole("button", { name: "Error" }));
    await userEvent.selectOptions(within(bar).getByLabelText("Kind"), "source.offline");
    fireEvent.change(within(bar).getByLabelText("From"), { target: { value: "2026-10-01" } });
    fireEvent.change(within(bar).getByLabelText("To"), { target: { value: "2026-10-22" } });
    await userEvent.click(within(bar).getByRole("button", { name: "Open only" }));
    expect(search()).toBe("?source=4&level=warning&level=error&kind=source.offline&from=2026-10-01&to=2026-10-22&open=1");
    await waitFor(() => {
      const q = srv.params(srv.listCalls().at(-1)!);
      expect(q.get("source")).toBe("4");
      expect(q.getAll("level")).toEqual(["warning", "error"]);
      expect(q.getAll("kind")).toEqual(["source.offline"]);
      expect(q.get("from")).toBe("2026-10-01");
      expect(q.get("to")).toBe("2026-10-22");
      expect(q.get("open")).toBe("1");
      expect(q.get("include_total")).toBe("1");
    });
  });

  it("reads the filters from the address, so a link from the Sources page opens the list for that source", async () => {
    const srv = server();
    setup("/events?source=4&level=error", {}, srv);
    await screen.findByRole("row", { name: /OPC UA server/ });
    const bar = screen.getByRole("search", { name: "Filter the system events" });
    expect(within(bar).getByLabelText("Source")).toHaveValue("4");
    expect(within(bar).getByRole("button", { name: "Error" })).toHaveAttribute("aria-pressed", "true");
    expect(srv.params(srv.listCalls()[0]).getAll("level")).toEqual(["error"]);
  });

  it("loads more with the cursor of the last page and no total, keeps what is shown, hides the button on the last page and puts focus on the first new row", async () => {
    const srv = server();
    srv.state.nextPage = page([ev(4), ev(3)], { next: null });
    setup("/events", {}, srv);
    await screen.findByRole("row", { name: /OPC UA server/ });
    expect(screen.getByText("Showing 3 of 3")).toBeInTheDocument();
    const more = screen.getByRole("button", { name: "Load more" });
    await userEvent.click(more);
    await waitFor(() => expect(rowFor(4)).not.toBeNull());
    const request = srv.urls.find((url) => srv.params(url).get("before"))!;
    expect(srv.params(request).get("before")).toBe("1760000000000000_5");
    expect(srv.params(request).get("include_total")).toBe("0");
    expect([...document.querySelectorAll(".events-table tbody tr")].map((tr) => tr.getAttribute("data-event-id"))).toEqual(["7", "6", "5", "4", "3"]);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    await waitFor(() => expect(within(rowFor(4)).getByRole("button", { name: "Details of event #4" })).toHaveFocus());
  });

  it("shows the error of a page that could not be read, next to the button, and keeps the rows", async () => {
    const srv = server();
    srv.state.nextPage = page([ev(4)]);
    srv.state.nextFails = "no more today";
    setup("/events", {}, srv);
    await screen.findByRole("row", { name: /OPC UA server/ });
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no more today");
    expect(rowFor(7)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
  });

  it("exports the CSV of the current filters, raises one toast, and shows the server's refusal as the bar's alert", async () => {
    const { toasts } = setup("/events?level=error&open=1");
    await screen.findByRole("search", { name: "Filter the system events" });
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(downloadCsv).toHaveBeenCalledWith("/api/events.csv?level=error&open=1");
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "info", text: "CSV downloaded" }]));
    vi.mocked(downloadCsv).mockRejectedValueOnce(new ApiError(422, "30,000 events match; the export holds at most 20,000. Narrow the date range and try again."));
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Narrow the date range and try again.");
  });
});

describe("EventsPage: the calm refresh (w32)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); }); // before the render, so the queries' intervals are the fake ones
  afterEach(() => { vi.useRealTimers(); });
  // the intervals are the fake ones (setInterval only); the answers come on the real clock, so the act waits a moment for them
  const beat = async (ms = 10_000) => { await act(async () => { vi.advanceTimersByTime(ms); await new Promise((resolve) => setTimeout(resolve, 30)); }); };

  it("reads page one again every 10 seconds, with no total and no cursor, and the list stays as it is", async () => {
    const srv = server();
    setup("/events", {}, srv);
    await screen.findByRole("row", { name: /OPC UA server/ });
    const before = srv.latestCalls().length;
    await beat();
    await waitFor(() => expect(srv.latestCalls().length).toBe(before + 1));
    const q = srv.params(srv.latestCalls().at(-1)!);
    expect(q.get("include_total")).toBe("0");
    expect(q.get("before")).toBeNull();
    expect(q.get("limit")).toBe("50");
    expect(screen.queryByRole("button", { name: /new event/ })).toBeNull();
    expect(document.querySelectorAll(".events-table tbody tr")).toHaveLength(3);
  });

  it("shows '3 new events' as a button and does not push the rows; the button reads the list again, goes, and puts focus on the first row", async () => {
    const srv = server();
    setup("/events", {}, srv);
    await screen.findByRole("row", { name: /OPC UA server/ });
    srv.state.items = [ev(10), ev(9), ev(8), ...srv.state.items];
    await beat();
    const button = await screen.findByRole("button", { name: "3 new events" });
    expect(button).toHaveAttribute("type", "button");
    expect(document.querySelectorAll(".events-table tbody tr")).toHaveLength(3); // nothing moved
    expect(rowFor(10)).toBeNull();
    await userEvent.click(button);
    await waitFor(() => expect(rowFor(10)).not.toBeNull());
    expect(screen.queryByRole("button", { name: /new event/ })).toBeNull();
    expect([...document.querySelectorAll(".events-table tbody tr")].map((tr) => tr.getAttribute("data-event-id")).slice(0, 4)).toEqual(["10", "9", "8", "7"]);
    await waitFor(() => expect(within(rowFor(10)).getByRole("button", { name: "Details of event #10" })).toHaveFocus());
  });

  it("says '1 new event' for one", async () => {
    const srv = server();
    setup("/events", {}, srv);
    await screen.findByRole("row", { name: /OPC UA server/ });
    srv.state.items = [ev(10), ...srv.state.items];
    await beat();
    expect(await screen.findByRole("button", { name: "1 new event" })).toBeInTheDocument();
  });

  it("updates the count of an open problem in place, with no button and no row moving", async () => {
    const srv = server();
    setup("/events", {}, srv);
    await screen.findByRole("row", { name: /OPC UA server/ });
    expect(rowFor(7)).toHaveTextContent("failed 1,204 times");
    const grown = { ...OFFLINE, incident: incident({ count: 1300 }) };
    srv.state.items = [grown, ONLINE, CHECK];
    srv.state.open = [grown];
    await beat();
    await waitFor(() => expect(rowFor(7)).toHaveTextContent("failed 1,300 times"));
    expect(screen.queryByRole("button", { name: /new event/ })).toBeNull();
    expect(screen.getByText(/1,300 failed reads/)).toBeInTheDocument(); // the pinned line too
    expect([...document.querySelectorAll(".events-table tbody tr")].map((tr) => tr.getAttribute("data-event-id"))).toEqual(["7", "6", "5"]);
  });

  it("shows an incident that closed in the page as closed, in place", async () => {
    const srv = server();
    setup("/events", {}, srv);
    await screen.findByRole("row", { name: /OPC UA server/ });
    const closed = { ...OFFLINE, incident: incident({ state: "closed", closed_by: "recovered", closed_at: "2026-10-22T10:00:00Z", duration_seconds: 9000 }) };
    srv.state.items = [closed, ONLINE, CHECK];
    srv.state.open = [];
    await beat();
    await waitFor(() => expect(rowFor(7)).toHaveTextContent("lasted 2 h 30 min"));
    expect(await screen.findByText("No problems are open right now.")).toBeInTheDocument();
  });

  it("keeps the rows and shows no alert when a refresh fails, then recovers at the next beat", async () => {
    const srv = server();
    setup("/events", {}, srv);
    await screen.findByRole("row", { name: /OPC UA server/ });
    srv.state.latestStatus = 500;
    await beat();
    await waitFor(() => expect(srv.latestCalls().length).toBeGreaterThan(1));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelectorAll(".events-table tbody tr")).toHaveLength(3);
    expect(screen.queryByText("Loading the system events")).toBeNull();
    srv.state.latestStatus = 200;
    srv.state.items = [ev(10), ...srv.state.items];
    await beat();
    expect(await screen.findByRole("button", { name: "1 new event" })).toBeInTheDocument();
  });

  it("does not read page one again while a To date is set (the list is a past period)", async () => {
    const srv = server();
    setup("/events?to=2026-10-20", {}, srv);
    await screen.findByRole("row", { name: /OPC UA server/ });
    await beat(30_000);
    expect(srv.latestCalls()).toHaveLength(0);
  });

  it("does not read page one again while a drawer is open, and reads it again when the drawer closes", async () => {
    const srv = server();
    setup("/events", { "GET /api/events/7": () => ({ body: { ...OFFLINE, started_by: null } }) }, srv);
    await screen.findByRole("row", { name: /OPC UA server/ });
    await userEvent.click(within(rowFor(7)).getByRole("button", { name: "Details of event #7" }));
    await screen.findByRole("dialog", { name: "System event" });
    const during = srv.latestCalls().length;
    await beat(30_000);
    expect(srv.latestCalls().length).toBe(during);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(srv.latestCalls().length).toBeGreaterThan(during)); // enabled again: it reads at once, the list may be old
  });
});

describe("EventsPage: the drawer (w32)", () => {
  const single = (extra: Partial<EventDetail> = {}): Routes => ({ "GET /api/events/7": () => ({ body: { ...OFFLINE, started_by: null, ...extra } }) });

  it("opens an event over the list from its row, as /events/7 with the same query, names the dialog and moves the focus into it", async () => {
    const { path, search } = setup("/events?level=warning", single());
    await screen.findByRole("row", { name: /OPC UA server/ });
    await userEvent.click(within(rowFor(7)).getByRole("button", { name: "Details of event #7" }));
    const dialog = await screen.findByRole("dialog", { name: "System event" });
    expect(path()).toBe("/events/7");
    expect(search()).toBe("?level=warning");
    expect(dialog).toHaveFocus();
    expect(within(dialog).getByText("Went offline: could not reach the server")).toBeInTheDocument();
    expect(document.querySelector(".shell, .skip-link")).toBeNull(); // (no shell in this test: the drawer's inert lock is the Drawer's own test)
  });

  it("opens from a click on the row, but not from a click that ends a text selection (selecting a sentence to copy it must not throw a drawer over the page)", async () => {
    const { path } = setup("/events", single());
    await screen.findByRole("row", { name: /OPC UA server/ });
    const selection = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "Went offline" } as unknown as Selection);
    await userEvent.click(within(rowFor(7)).getByText("Went offline: could not reach the server"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(path()).toBe("/events");
    selection.mockReturnValue({ toString: () => "" } as unknown as Selection);
    await userEvent.click(within(rowFor(7)).getByText("Went offline: could not reach the server"));
    expect(await screen.findByRole("dialog", { name: "System event" })).toBeInTheDocument();
    expect(path()).toBe("/events/7");
  });

  it("closes with Escape, goes back to the list as it was and returns the focus to the row's Details button", async () => {
    const { path, search } = setup("/events?level=warning", single());
    await screen.findByRole("row", { name: /OPC UA server/ });
    const opener = within(rowFor(7)).getByRole("button", { name: "Details of event #7" });
    await userEvent.click(opener);
    await screen.findByRole("dialog", { name: "System event" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(path()).toBe("/events");
    expect(search()).toBe("?level=warning");
    expect(opener).toHaveFocus();
  });

  it("closes with the Close button and with Back", async () => {
    const { path, router } = setup("/events", single());
    await screen.findByRole("row", { name: /OPC UA server/ });
    await userEvent.click(within(rowFor(7)).getByRole("button", { name: "Details of event #7" }));
    await userEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(within(rowFor(7)).getByRole("link", { name: /Event #7/ }));
    await screen.findByRole("dialog", { name: "System event" });
    await act(async () => { await router.navigate(-1); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(path()).toBe("/events");
  });

  it("opens a pinned problem's event too, and Escape returns the focus to the pinned link", async () => {
    setup("/events", single());
    const link = await screen.findByRole("link", { name: "Open problem details, event #7" });
    await userEvent.click(link);
    await screen.findByRole("dialog", { name: "System event" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(link).toHaveFocus();
  });

  it("opens an event that is not in the list from a link (a deep link), reads it by its id, and says who started a check", async () => {
    const check = { ...ev(42, { kind: "check.finished", message: "connection check passed (7 steps)", detail: { ok: true, steps: 7, job_id: 9 } }), started_by: { audit_id: 231, username: "admin", ts: "2026-10-22T07:59:00Z" } };
    setup("/events/42", { "GET /api/events/42": { body: check } });
    const dialog = await screen.findByRole("dialog", { name: "System event" });
    expect(await within(dialog).findByText("The connection check passed (7 steps)")).toBeInTheDocument();
    expect(await within(dialog).findByRole("link", { name: "Open the audit entry" })).toHaveAttribute("href", "/audit/231");
    expect(within(dialog).getByRole("button", { name: /^Previous event: open it from the list/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("says the event is not found for an id the journal no longer holds, and for an address that is no id (without asking)", async () => {
    const { unmount } = setup("/events/99", { "GET /api/events/99": { status: 404, body: { detail: "event not found" } } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Event not found.");
    unmount();
    const second = setup("/events/abc");
    expect(await screen.findByText("Event not found.")).toBeInTheDocument();
    expect(second.calls.some((call) => call.path.startsWith("/api/events/abc"))).toBe(false);
  });

  it("shows the list row at once and fills in 'Started by' when the single event arrives", async () => {
    const check = ev(5, { ts: "2026-10-22T07:00:00Z" });
    setup("/events", { "GET /api/events/5": { body: { ...check, started_by: { audit_id: 12, username: "ops", ts: "2026-10-22T06:59:00Z" } } } });
    await screen.findByRole("row", { name: /OPC UA server/ });
    await userEvent.click(within(rowFor(5)).getByRole("button", { name: "Details of event #5" }));
    const dialog = await screen.findByRole("dialog", { name: "System event" });
    expect(within(dialog).getByText("The connection check passed (5 steps)")).toBeInTheDocument();
    expect(await within(dialog).findByText(/ops, 22 Oct 09:59/)).toBeInTheDocument();
  });

  it("steps to the neighbouring event of the loaded list with Previous and Next, replacing the address", async () => {
    const { path } = setup("/events", {
      "GET /api/events/6": () => ({ body: { ...ONLINE, started_by: null } }),
      "GET /api/events/5": () => ({ body: { ...CHECK, started_by: null } }),
      ...single(),
    });
    await screen.findByRole("row", { name: /OPC UA server/ });
    await userEvent.click(within(rowFor(6)).getByRole("button", { name: "Details of event #6" }));
    const dialog = await screen.findByRole("dialog", { name: "System event" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Next event" }));
    await waitFor(() => expect(path()).toBe("/events/5"));
    expect(await within(dialog).findByText("The connection check passed (5 steps)")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^Next event: this is the oldest event/ })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(within(dialog).getByRole("button", { name: "Previous event" }));
    await waitFor(() => expect(path()).toBe("/events/6"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Previous event" }));
    await waitFor(() => expect(path()).toBe("/events/7"));
    expect(within(dialog).getByRole("button", { name: /^Previous event: this is the newest event/ })).toHaveAttribute("aria-disabled", "true");
    // one Escape closes it however many steps were taken (the steps replaced the address)
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(path()).toBe("/events");
  });

  it("reads the next page of the list when Next is pressed on the last loaded event", async () => {
    const srv = server();
    srv.state.nextPage = page([ev(4)]);
    const { path } = setup("/events", { ...single(), "GET /api/events/5": () => ({ body: { ...CHECK, started_by: null } }), "GET /api/events/4": () => ({ body: { ...ev(4), started_by: null } }) }, srv);
    await screen.findByRole("row", { name: /OPC UA server/ });
    await userEvent.click(within(rowFor(5)).getByRole("button", { name: "Details of event #5" }));
    const dialog = await screen.findByRole("dialog", { name: "System event" });
    const next = within(dialog).getByRole("button", { name: "Next event" });
    expect(next).not.toHaveAttribute("aria-disabled");
    await userEvent.click(next);
    await waitFor(() => expect(path()).toBe("/events/4"));
    expect(srv.urls.some((url) => srv.params(url).get("before") === "1760000000000000_5")).toBe(true);
  });

  it("has one live region in the drawer, and the page itself adds none", async () => {
    setup("/events", single());
    await screen.findByRole("row", { name: /OPC UA server/ });
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(0);
    await userEvent.click(within(rowFor(7)).getByRole("button", { name: "Details of event #7" }));
    await screen.findByRole("dialog", { name: "System event" });
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
  });
});

/** The page under the route gate, as App.tsx mounts it, for an account that holds exactly `permissions`. */
function mockFetchAs(permissions: PermissionId[]) {
  const srv = server();
  mockFetch({ ...admin, "GET /api/me": { body: userFor("custom", { permissions }) }, ...srv.routes });
  return renderWithDataRouter(
    <RequirePermission need={PAGE_NEED.events}><main id="main" tabIndex={-1}><EventsPage /></main></RequirePermission>,
    { route: "/events", path: "/events/:id?" },
  );
}

describe("EventsPage: who may open it (w32)", () => {
  it("opens for an account with diagnostics.view and sources.view", async () => {
    mockFetchAs(["diagnostics.view", "sources.view"]);
    expect(await screen.findByRole("heading", { level: 1, name: "System events" })).toBeInTheDocument();
  });

  it.each([[["diagnostics.view"]], [["sources.view"]], [[]]] as [PermissionId[]][])("says No access, and asks for no events, with %j", async (permissions) => {
    mockFetchAs(permissions);
    expect(await screen.findByRole("heading", { name: "No access" })).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith("/api/events"))).toBe(false);
  });
});
