import { screen, within } from "@testing-library/react";
import { mockFetch, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { userFor } from "../test/users";
import { AuditEntryPage } from "./AuditEntryPage";

const detail = { tariff_id: 3, asset_id: 7, before: { rate_per_kwh: 0.1 }, after: { rate_per_kwh: 0.12 } };
const stored = { id: 9, user_id: 1, actor_id: 1, username: "admin", action: "tariff.updated", detail, ts: "2026-10-07T10:00:00Z" };
const admin: Routes = {
  "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: userFor("admin") },
  "GET /api/site": { body: { timezone: "Asia/Qatar", currency: null } },
};
const open = (id: string, routes: Routes = {}) => {
  const calls = mockFetch({ ...admin, ...routes });
  renderWithProviders(<AuditEntryPage />, { route: `/audit/${id}`, path: "/audit/:id" });
  return calls;
};

describe("AuditEntryPage", () => {
  it("shows one entry: who, when in the site zone, what happened, what changed, and the stored JSON", async () => {
    open("9", { "GET /api/audit/9": { body: stored } });
    expect(await screen.findByRole("heading", { name: "Audit entry #9" })).toBeInTheDocument();
    expect(screen.getByText("2026-10-07 13:00:00")).toBeInTheDocument(); // 10:00Z in Asia/Qatar (UTC+3)
    expect(screen.getByText("Asia/Qatar", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getByText("Changed tariff #3: rate per kwh")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(table).toHaveTextContent("Rate per kwh");
    expect(screen.getByRole("link", { name: "Open Tariffs" })).toHaveAttribute("href", "/tariffs");
    expect(screen.getByRole("heading", { name: "Raw" })).toBeInTheDocument();
    expect(document.querySelector("pre")?.textContent).toBe(JSON.stringify(detail, null, 2));
    expect(screen.getByText("tariff.updated")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the log" })).toHaveAttribute("href", "/audit");
  });

  it("puts the trail Audit log / Entry #9 above the title, and keeps one Back to the log link, in the header's actions", async () => {
    open("9", { "GET /api/audit/9": { body: stored } });
    const h1 = await screen.findByRole("heading", { name: "Audit entry #9", level: 1 });
    const head = h1.closest<HTMLElement>("header.page-head")!;
    const nav = within(head).getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).getByRole("link", { name: "Audit log" })).toHaveAttribute("href", "/audit");
    expect(within(nav).getByText("Entry #9")).toHaveAttribute("aria-current", "page");
    expect(within(nav).getAllByRole("link")).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "Back to the log" })).toHaveLength(1);
    expect(head.querySelector(".actions")).toContainElement(screen.getByRole("link", { name: "Back to the log" }));
  });

  it("shows a dash for an entry with no user", async () => {
    open("9", { "GET /api/audit/9": { body: { ...stored, user_id: null, actor_id: null, username: null } } });
    expect(await screen.findByRole("heading", { name: "Audit entry #9" })).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("says not found for an entry that does not exist, and offers the way back", async () => {
    open("404", { "GET /api/audit/404": { status: 404, body: { detail: "audit entry not found" } } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Audit entry not found.");
    expect(screen.getByRole("link", { name: "Back to the log" })).toHaveAttribute("href", "/audit");
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).not.toBeInTheDocument(); // no entry, no trail
  });

  it.each(["abc", "99999999999", "0", "1.5"])("says not found for the id %s without asking the API", async (id) => {
    const calls = open(id);
    expect(await screen.findByRole("alert")).toHaveTextContent("Audit entry not found.");
    expect(calls.some((c) => c.path.startsWith("/api/audit/"))).toBe(false);
  });

  it("shows the API's message for any other failure", async () => {
    open("9", { "GET /api/audit/9": { status: 500, body: { detail: "database is down" } } });
    expect(await screen.findByRole("alert")).toHaveTextContent("database is down");
  });
});

describe("AuditEntryPage while the entry loads (W7f)", () => {
  const LABEL = "Loading the entry";
  const mount = (held: string) => {
    mockFetch({ ...admin, "GET /api/audit/9": { body: stored } });
    const hold = holdFetch((_method, path) => path === held);
    renderWithProviders(<AuditEntryPage />, { route: "/audit/9", path: "/audit/:id" });
    return hold;
  };

  it.each(["/api/audit/9", "/api/site"])("shows one region with a header trail and a list of ten pairs while %s is held, nothing to read, then the entry and no region", async (held) => {
    const hold = mount(held);
    const region = screen.getByText(LABEL).parentElement!;
    expect(region).toHaveAttribute("role", "status");
    expect(region.closest(".admin-page.audit-entry-page")).not.toBeNull(); // the wrapper the page's width rules key on
    expect(region.querySelector("header.page-head .crumbs")).not.toBeNull();
    expect(region.querySelectorAll("dl.kv > div")).toHaveLength(10);
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    hold.release();
    expect(await screen.findByRole("heading", { name: "Audit entry #9" })).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
  });

  it("never shows a skeleton for an id that cannot be one (nothing is asked), nor over a 404", async () => {
    open("abc");
    expect(await screen.findByRole("alert")).toHaveTextContent("Audit entry not found.");
    expect(document.querySelector(".sk-region")).toBeNull();
  });
});
