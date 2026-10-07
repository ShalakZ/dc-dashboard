import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { SourcesPage } from "./SourcesPage";

const source = { id: 2, name: "sim", connector_type: "simulator", config: { url: "http://simulator:9000" }, enabled: true, status: "online", last_seen: "2026-10-07T10:00:00+00:00", last_error: null, has_secret: true };
const routes = (role: string) => ({
  "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "u", role } },
  "GET /api/sources": { body: [{ ...source, status: "offline", last_error: "timeout" }] },
  "POST /api/sources/2/test": { status: 202, body: { job_id: 9 } },
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
});
