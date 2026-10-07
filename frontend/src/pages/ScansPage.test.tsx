import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { ScansPage } from "./ScansPage";

const scope = { id: 3, name: "lab", targets: ["simulator"], ports: [9000, 4840, 5020], created_at: "2026-10-07T10:00:00Z" };
const done = {
  id: 7, scope_id: 3, scope_name: "lab", status: "done", stage: "browse", created_at: "t", finished_at: "t", error: null,
  progress: { hosts: 1, pairs: 3, checked: 3, open: 3, claimed: 2, points: 120, unidentified: 0, needs_credentials: 1 },
  scope_snapshot: {},
  findings: [
    { host: "simulator", port: 4840, source_id: 5, connector_type: "opcua", outcome: "claimed", detail: "60 points" },
    { host: "simulator", port: 9000, source_id: 6, connector_type: "simulator", outcome: "needs_credentials", detail: "credentials rejected" },
  ],
};
const base = (role: string) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role } },
  "GET /api/scopes": { body: [scope] },
  "GET /api/scans": { body: [{ ...done, findings: undefined }] },
  "GET /api/scopes/suggestions": { body: { targets: ["172.18.0.0/24"], ports: [502, 4840, 9000] } },
});
const open = () => renderWithProviders(<ScansPage />, { route: "/scans", path: "/scans" });

describe("ScansPage", () => {
  it("lets an operator read scopes and history but not change anything", async () => {
    mockFetch(base("operator"));
    open();
    expect(await screen.findAllByText("lab")).toHaveLength(2); // the scope row and its scan in the history
    expect(screen.queryByRole("button", { name: "New scope" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scan" })).not.toBeInTheDocument();
  });

  it("creates a scope from a prefilled form and sends parsed targets and ports", async () => {
    const calls = mockFetch({ ...base("admin"), "POST /api/scopes": { status: 201, body: scope } });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "New scope" }));
    expect(await screen.findByLabelText("Targets")).toHaveValue("172.18.0.0/24");
    expect(screen.getByLabelText("Ports")).toHaveValue("502, 4840, 9000");
    await userEvent.type(screen.getByLabelText("Name"), "lab");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/scopes");
    expect(post?.body).toEqual({ name: "lab", targets: ["172.18.0.0/24"], ports: [502, 4840, 9000] });
  });

  it("shows a port error without calling the API", async () => {
    const calls = mockFetch(base("admin"));
    open();
    await userEvent.click(await screen.findByRole("button", { name: "New scope" }));
    await userEvent.type(await screen.findByLabelText("Name"), "x");
    await userEvent.clear(screen.getByLabelText("Ports"));
    await userEvent.type(screen.getByLabelText("Ports"), "99999");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid port/i);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("asks for confirmation with the host and port counts, then starts the scan with that count", async () => {
    let polls = 0;
    const calls = mockFetch({
      ...base("admin"),
      "GET /api/scopes/3/preview": { body: { hosts: 2, ports: 3, pairs: 6 } },
      "POST /api/scopes/3/scan": { status: 202, body: { scan_id: 7, job_id: 1 } },
      "GET /api/scans/7": () => ({ body: ++polls < 2 ? { ...done, status: "running", stage: "probe", findings: [] } : done }),
    });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Scan" }));
    expect(await screen.findByText("2 hosts × 3 ports (6 probes)")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/scopes/3/scan")).toBe(false); // nothing runs before confirming
    await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/scopes/3/scan")?.body).toEqual({ confirm_host_count: 2 });
    expect(await screen.findByText(/running/i)).toBeInTheDocument();
    const row = await screen.findByRole("row", { name: /^simulator 9000 / }, { timeout: 5000 });
    expect(within(row).getByText("needs_credentials")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the discovery graph" })).toHaveAttribute("href", "/discovery");
  });

  it("cancelling the confirmation runs nothing", async () => {
    const calls = mockFetch({ ...base("admin"), "GET /api/scopes/3/preview": { body: { hosts: 2, ports: 3, pairs: 6 } } });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Scan" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/scan"))).toBe(false);
  });

  it("shows the server's reason when the count is stale or a scan is running", async () => {
    mockFetch({
      ...base("admin"),
      "GET /api/scopes/3/preview": { body: { hosts: 2, ports: 3, pairs: 6 } },
      "POST /api/scopes/3/scan": { status: 409, body: { detail: "a scan is already in progress" } },
    });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Scan" }));
    await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("a scan is already in progress");
  });

  it("edits a scope with a PATCH and deletes it after confirmation", async () => {
    const calls = mockFetch({
      ...base("admin"),
      "PATCH /api/scopes/3": { body: scope },
      "DELETE /api/scopes/3": { status: 204 },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Name")).toHaveValue("lab");
    expect(screen.getByLabelText("Targets")).toHaveValue("simulator");
    expect(screen.getByLabelText("Ports")).toHaveValue("9000, 4840, 5020");
    await userEvent.clear(screen.getByLabelText("Ports"));
    await userEvent.type(screen.getByLabelText("Ports"), "4840");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument());
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "lab", targets: ["simulator"], ports: [4840] });
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/scopes/3")).toBe(true));
  });

  it("opens the details of a past scan from the history", async () => {
    mockFetch({ ...base("operator"), "GET /api/scans/7": { body: done } });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Details" }));
    expect(await screen.findByRole("heading", { name: "Scan #7 — done" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the discovery graph" })).toBeInTheDocument();
  });
});
