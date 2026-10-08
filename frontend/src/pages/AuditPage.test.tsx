import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { AuditPage } from "./AuditPage";

const entry = (id: number, action: string, username: string | null = "admin") => ({
  id, user_id: username ? 1 : null, username, action, detail: { scan_id: id }, ts: "2026-10-07T10:00:00Z",
});
const admin = {
  "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "u", role: "admin" } },
  "GET /api/site": { body: { timezone: "Asia/Qatar", currency: null } },
};

describe("AuditPage", () => {
  it("lists entries newest first with who, what and details, and pages", async () => {
    const calls = mockFetch({
      ...admin,
      "GET /api/audit": ({ url }) =>
        url.includes("offset=50")
          ? { body: { total: 51, items: [entry(1, "scope.created", null)] } }
          : { body: { total: 51, items: [entry(51, "scan.finished"), entry(50, "scan.started")] } },
    });
    renderWithProviders(<AuditPage />, { route: "/audit", path: "/audit" });
    expect(await screen.findByText("scan.finished")).toBeInTheDocument();
    expect(screen.getByText('{"scan_id":51}')).toBeInTheDocument();
    expect(screen.getByText("Showing 1–2 of 51")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("scope.created")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(calls.some((c) => c.path === "/api/audit")).toBe(true);
  });

  it("shows times in the site timezone, not the browser's", async () => {
    mockFetch({ ...admin, "GET /api/audit": { body: { total: 1, items: [entry(1, "scan.finished")] } } });
    renderWithProviders(<AuditPage />, { route: "/audit", path: "/audit" });
    expect(await screen.findByText("2026-10-07 13:00:00")).toBeInTheDocument(); // 10:00Z in Asia/Qatar (UTC+3)
    expect(screen.getByRole("columnheader", { name: "Time (Asia/Qatar)" })).toBeInTheDocument();
  });

  it("says so when there is nothing yet", async () => {
    mockFetch({ ...admin, "GET /api/audit": { body: { total: 0, items: [] } } });
    renderWithProviders(<AuditPage />, { route: "/audit", path: "/audit" });
    expect(await screen.findByText("No audit entries yet.")).toBeInTheDocument();
  });

  it("shows an error when the request fails", async () => {
    mockFetch({ ...admin, "GET /api/audit": { status: 403, body: { detail: "insufficient role" } } });
    renderWithProviders(<AuditPage />, { route: "/audit", path: "/audit" });
    expect(await screen.findByRole("alert")).toHaveTextContent("insufficient role");
  });
});
