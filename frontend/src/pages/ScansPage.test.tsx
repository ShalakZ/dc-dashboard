import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { accountKnown, SignedIn } from "../test/signedIn";
import { spyToasts } from "../test/toasts";
import { userFor } from "../test/users";
import type { ToastApi } from "../components/Toasts";
import type { PermissionId } from "../lib/permissions";
import { ScansPage } from "./ScansPage";

const scope = { id: 3, name: "lab", targets: ["simulator"], ports: [9000, 4840, 5020], created_at: "2026-10-07T10:00:00Z" };
const done = {
  id: 7, scope_id: 3, scope_name: "lab", targets: ["simulator"], ports: [9000, 4840, 5020], status: "done", stage: "browse", created_at: "t", finished_at: "t", error: null,
  progress: { hosts: 1, pairs: 3, checked: 3, open: 3, claimed: 2, points: 120, unidentified: 0, needs_credentials: 1 },
  scope_snapshot: {},
  findings: [
    { host: "simulator", port: 4840, source_id: 5, connector_type: "opcua", outcome: "claimed", detail: "60 points" },
    { host: "simulator", port: 9000, source_id: 6, connector_type: "simulator", outcome: "needs_credentials", detail: "credentials rejected" },
  ],
};
const base = (role: string) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor(role) },
  "GET /api/site": { body: { timezone: "Asia/Qatar", currency: "QAR" } },
  "GET /api/scopes": { body: [scope] },
  "GET /api/scans": { body: [{ ...done, findings: undefined }] },
  "GET /api/scopes/suggestions": { body: { targets: ["172.18.0.0/24"], ports: [502, 4840, 9000] } },
});
const open = (toasts?: ToastApi) => renderWithProviders(<ScansPage />, { route: "/scans", path: "/scans", toasts });
/** The three-dot menu of the scope row (named `Actions for lab`); its items are in the DOM only while it is open. */
const menuButton = async () => screen.findByRole("button", { name: "Actions for lab" });
async function pick(item: string) {
  await userEvent.click(await menuButton());
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}

describe("ScansPage", () => {
  it("lets an operator read scopes and history but not change anything", async () => {
    mockFetch(base("operator"));
    open();
    expect(await screen.findAllByText("lab")).toHaveLength(2); // the scope row and its scan in the history
    expect(screen.queryByRole("button", { name: "New scope" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument(); // no menu at all, so no Scan, Edit or Delete either
    expect(screen.queryByRole("button", { name: /^Delete / })).not.toBeInTheDocument();
  });

  it("prints the start of a scan on the wall clock of the site zone", async () => {
    mockFetch({ ...base("operator"), "GET /api/scans": { body: [{ ...done, created_at: "2026-10-09T11:05:00Z", findings: undefined }] } });
    open();
    const history = await screen.findByRole("row", { name: /^lab .*done/ });
    expect(await within(history).findByText("2026-10-09 14:05:00")).toBeInTheDocument();
  });

  it("shows a dash, not a time in the browser's zone, while the site zone is unavailable", async () => {
    const calls = mockFetch({
      ...base("operator"),
      "GET /api/site": { status: 500, body: { detail: "site unavailable" } },
      "GET /api/scans": { body: [{ ...done, created_at: "2026-10-09T11:05:00Z", findings: undefined }] },
    });
    open();
    const history = await screen.findByRole("row", { name: /^lab .*done/ });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/site")).toBe(true));
    expect(within(history).getByText("—")).toBeInTheDocument();
    expect(history).not.toHaveTextContent(/2026|2:05|14:05/);
  });

  it("creates a scope from a prefilled form and sends parsed targets and ports", async () => {
    const calls = mockFetch({ ...base("admin"), "POST /api/scopes": { status: 201, body: scope } });
    const toasts = spyToasts();
    open(toasts.api);
    await userEvent.click(await screen.findByRole("button", { name: "New scope" }));
    expect(await screen.findByLabelText("Targets")).toHaveValue("172.18.0.0/24");
    expect(screen.getByLabelText("Ports")).toHaveValue("502, 4840, 9000");
    await userEvent.type(screen.getByLabelText("Name"), "lab");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/scopes");
    expect(post?.body).toEqual({ name: "lab", targets: ["172.18.0.0/24"], ports: [502, 4840, 9000] });
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "success", text: "Scan scope created" }]));
  });

  it("raises no toast when the new scope is refused: the error line is the feedback", async () => {
    mockFetch({ ...base("admin"), "POST /api/scopes": { status: 409, body: { detail: "a scope with that name already exists" } } });
    const toasts = spyToasts();
    open(toasts.api);
    await userEvent.click(await screen.findByRole("button", { name: "New scope" }));
    await userEvent.type(await screen.findByLabelText("Name"), "lab");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(toasts.calls).toEqual([]);
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
      "GET /api/scopes/3/preview": { body: { hosts: 2, ports: 3, pairs: 6, digest: "d1g3st" } },
      "POST /api/scopes/3/scan": { status: 202, body: { scan_id: 7, job_id: 1 } },
      "GET /api/scans/7": () => ({ body: ++polls < 2 ? { ...done, status: "running", stage: "probe", findings: [] } : done }),
    });
    open();
    await pick("Scan");
    expect(await screen.findByText("2 hosts × 3 ports (6 checks)")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/scopes/3/scan")).toBe(false); // nothing runs before confirming
    await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/scopes/3/scan")?.body).toEqual({ confirm_host_count: 2, digest: "d1g3st" });
    expect(await screen.findByRole("heading", { name: /running/i })).toBeInTheDocument(); // the drawer's title (the status text on the row says it too)
    const row = await screen.findByRole("row", { name: /^simulator 9000 / }, { timeout: 5000 });
    expect(within(row).getByText("needs credentials")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the discovery graph" })).toHaveAttribute("href", "/discovery");
  });

  it("starts the scan with the digest of the latest preview, not an earlier one", async () => {
    let previews = 0;
    const calls = mockFetch({
      ...base("admin"),
      "GET /api/scopes/3/preview": () => ({ body: { hosts: 2, ports: 3, pairs: 6, digest: `digest-${++previews}` } }),
      "POST /api/scopes/3/scan": { status: 202, body: { scan_id: 7, job_id: 1 } },
      "GET /api/scans/7": { body: done },
    });
    open();
    await pick("Scan");
    await screen.findByRole("button", { name: "Start scan" });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await pick("Scan");
    await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/scopes/3/scan")?.body).toEqual({
      confirm_host_count: 2, digest: "digest-2",
    });
  });

  it("cancelling the confirmation runs nothing", async () => {
    const calls = mockFetch({ ...base("admin"), "GET /api/scopes/3/preview": { body: { hosts: 2, ports: 3, pairs: 6, digest: "d1g3st" } } });
    open();
    await pick("Scan");
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/scan"))).toBe(false);
  });

  it("shows the server's reason when the count is stale or a scan is running", async () => {
    mockFetch({
      ...base("admin"),
      "GET /api/scopes/3/preview": { body: { hosts: 2, ports: 3, pairs: 6, digest: "d1g3st" } },
      "POST /api/scopes/3/scan": { status: 409, body: { detail: "a scan is already in progress" } },
    });
    open();
    await pick("Scan");
    await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("a scan is already in progress");
  });

  it("edits a scope with a PATCH and deletes it after confirmation in the styled dialog", async () => {
    const calls = mockFetch({
      ...base("admin"),
      "PATCH /api/scopes/3": { body: scope },
      "DELETE /api/scopes/3": { status: 204 },
    });
    const browserBox = vi.spyOn(window, "confirm").mockReturnValue(true);
    const toasts = spyToasts();
    open(toasts.api);
    await pick("Edit");
    expect(screen.getByLabelText("Name")).toHaveValue("lab");
    expect(screen.getByLabelText("Targets")).toHaveValue("simulator");
    expect(screen.getByLabelText("Ports")).toHaveValue("9000, 4840, 5020");
    await userEvent.clear(screen.getByLabelText("Ports"));
    await userEvent.type(screen.getByLabelText("Ports"), "4840");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument());
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "lab", targets: ["simulator"], ports: [4840] });
    expect(toasts.calls).toEqual([]); // an edit closes its form: no toast
    await userEvent.click(screen.getByRole("button", { name: "Delete lab" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false); // asked first
    const dialog = await screen.findByRole("dialog", { name: 'Delete scope "lab"?' });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/scopes/3")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(toasts.calls).toEqual([{ kind: "success", text: 'Scan scope "lab" deleted' }]);
    expect(browserBox).not.toHaveBeenCalled();
  });

  it("gives an admin a menu with Scan and Edit and a trash button for Delete, which asks first in one styled dialog; Cancel and Escape delete nothing", async () => {
    const calls = mockFetch({ ...base("admin"), "DELETE /api/scopes/3": { status: 204 } });
    const browserBox = vi.spyOn(window, "confirm").mockReturnValue(true);
    const toasts = spyToasts();
    open(toasts.api);
    await userEvent.click(await menuButton());
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Scan", "Edit"]);
    await userEvent.keyboard("{Escape}");
    expect((await menuButton()).closest("td")).toHaveClass("row-actions");
    await userEvent.click(screen.getByRole("button", { name: "Delete lab" }));
    const dialog = await screen.findByRole("dialog", { name: 'Delete scope "lab"?' });
    expect(dialog).toHaveTextContent("This can't be undone.");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete lab" }));
    await screen.findByRole("dialog", { name: 'Delete scope "lab"?' });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(toasts.calls).toEqual([]);
    expect(browserBox).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Details" })).toBeInTheDocument(); // the history keeps its own link-like button
  });

  it("hands focus back to the trash button after Cancel and after Escape (the button is not disabled while the question is open)", async () => {
    mockFetch({ ...base("admin"), "DELETE /api/scopes/3": { status: 204 } });
    open();
    const trash = await screen.findByRole("button", { name: "Delete lab" });
    await userEvent.click(trash);
    expect(trash).toBeEnabled(); // the question is not an action in flight: a disabled opener cannot take the focus back
    await userEvent.click(within(await screen.findByRole("dialog", { name: 'Delete scope "lab"?' })).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete lab" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: 'Delete scope "lab"?' });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete lab" })).toHaveFocus();
  });

  it("a delete that the server refuses is shown above the table, and raises no toast", async () => {
    mockFetch({ ...base("admin"), "DELETE /api/scopes/3": { status: 403, body: { detail: "admin role required" } } });
    const toasts = spyToasts();
    open(toasts.api);
    await userEvent.click(await screen.findByRole("button", { name: "Delete lab" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: 'Delete scope "lab"?' })).getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("admin role required");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toasts.calls).toEqual([]);
  });

  it("opens the details of a past scan from the history", async () => {
    mockFetch({ ...base("operator"), "GET /api/scans/7": { body: done } });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Details" }));
    expect(await screen.findByRole("heading", { name: "Scan #7 — done" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the discovery graph" })).toBeInTheDocument();
  });

  it("counts only recognised sources that are not locked as sources, in the stats line and in the history, in words", async () => {
    mockFetch({ ...base("operator"), "GET /api/scans/7": { body: done } }); // claimed 2, of which 1 needs credentials
    open();
    const history = await screen.findByRole("row", { name: /^lab .*done/ });
    expect(within(history).getByText("1 source, 120 points")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Sources / points" })).toBeInTheDocument();
    await userEvent.click(within(history).getByRole("button", { name: "Details" }));
    expect(await screen.findByText("1 source recognised")).toBeInTheDocument();
    expect(screen.queryByText("2 sources recognised")).not.toBeInTheDocument();
    expect(screen.queryByText(/\d claimed/)).not.toBeInTheDocument();
  });

  it("writes the finding outcomes as words, never as needs_credentials", async () => {
    const findings = [
      ...done.findings,
      { host: "simulator", port: 8080, source_id: null, connector_type: null, outcome: "unclaimed", detail: "" },
    ];
    mockFetch({ ...base("operator"), "GET /api/scans/7": { body: { ...done, findings } } });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Details" }));
    const locked = await screen.findByRole("row", { name: /^simulator 9000 / });
    expect(within(locked).getByText("needs credentials")).toBeInTheDocument();
    expect(within(await screen.findByRole("row", { name: /^simulator 4840 / })).getByText("claimed")).toBeInTheDocument();
    expect(within(await screen.findByRole("row", { name: /^simulator 8080 / })).getByText("unidentified")).toBeInTheDocument();
    expect(screen.queryByText(/needs_credentials|unclaimed/)).not.toBeInTheDocument();
  });

  it("counts the sweep as checks (hosts times ports), not ports checked or probed", async () => {
    const sweeping = { ...done, status: "running", stage: "sweep", findings: [], progress: { hosts: 1, pairs: 3, checked: 2, open: 1 } };
    mockFetch({ ...base("operator"), "GET /api/scans/7": { body: sweeping } });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Details" }));
    expect(await screen.findByText("2 of 3 checks")).toBeInTheDocument();
    expect(screen.queryByText(/probed|ports checked/)).not.toBeInTheDocument();
  });

  it("says so when there are no scopes and no scans yet, instead of showing empty tables", async () => {
    mockFetch({ ...base("admin"), "GET /api/scopes": { body: [] }, "GET /api/scans": { body: [] } });
    open();
    expect(await screen.findByText(/No scopes yet/)).toHaveTextContent("New scope");
    expect(await screen.findByText("No scans yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("does not tell an operator with no scopes to use a button they do not have", async () => {
    mockFetch({ ...base("operator"), "GET /api/scopes": { body: [] }, "GET /api/scans": { body: [] } });
    open();
    expect(await screen.findByText("No scopes have been defined yet.")).toBeInTheDocument();
    expect(screen.queryByText(/New scope/)).not.toBeInTheDocument();
  });

  describe("confirmation panel never outlives the scope it was previewed for", () => {
    const confirmation = "2 hosts × 3 ports (6 checks)";

    it("closes when the scope is edited", async () => {
      const calls = mockFetch({ ...base("admin"), "GET /api/scopes/3/preview": { body: { hosts: 2, ports: 3, pairs: 6, digest: "d1g3st" } } });
      open();
      await pick("Scan");
      expect(await screen.findByText(confirmation)).toBeInTheDocument();
      await pick("Edit");
      expect(screen.queryByText(confirmation)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Start scan" })).not.toBeInTheDocument();
      expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/scan"))).toBe(false);
    });

    it("closes when the scope is deleted", async () => {
      const calls = mockFetch({
        ...base("admin"),
        "GET /api/scopes/3/preview": { body: { hosts: 2, ports: 3, pairs: 6, digest: "d1g3st" } },
        "DELETE /api/scopes/3": { status: 204 },
      });
      open();
      await pick("Scan");
      expect(await screen.findByText(confirmation)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Delete lab" }));
      await userEvent.click(within(await screen.findByRole("dialog", { name: 'Delete scope "lab"?' })).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/scopes/3")).toBe(true));
      expect(screen.queryByText(confirmation)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Start scan" })).not.toBeInTheDocument();
    });

    it("closes when an edit is saved, and the next Scan previews the new size", async () => {
      let ports = 3;
      const calls = mockFetch({
        ...base("admin"),
        "GET /api/scopes/3/preview": () => ({ body: { hosts: 2, ports, pairs: 2 * ports, digest: "d1g3st" } }),
        "PATCH /api/scopes/3": ({ body }) => { ports = (body as { ports: number[] }).ports.length; return { body: scope }; },
      });
      open();
      await pick("Edit");
      // The edit form stays open while the operator previews again; saving must still discard that preview.
      await pick("Scan");
      expect(await screen.findByText(confirmation)).toBeInTheDocument();
      await userEvent.clear(screen.getByLabelText("Ports"));
      await userEvent.type(screen.getByLabelText("Ports"), "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument());
      expect(screen.queryByText(confirmation)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Start scan" })).not.toBeInTheDocument();
      await pick("Scan");
      expect(await screen.findByText("2 hosts × 20 ports (40 checks)")).toBeInTheDocument();
      expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/scan"))).toBe(false);
    });
  });
});

describe("ScansPage look (W6)", () => {
  it("shows a scan's status as a chip: done ok, failed bad, running the hollow one", async () => {
    mockFetch({
      ...base("operator"),
      "GET /api/scans": { body: [
        { ...done, id: 7, scope_name: "a", status: "done", findings: undefined },
        { ...done, id: 8, scope_name: "b", status: "failed", findings: undefined },
        { ...done, id: 9, scope_name: "c", status: "running", findings: undefined },
      ] },
    });
    open();
    expect(within(await screen.findByRole("row", { name: /^a .*done/ })).getByText("done")).toHaveClass("chip", "chip-ok");
    expect(within(screen.getByRole("row", { name: /^b .*failed/ })).getByText("failed")).toHaveClass("chip", "chip-bad");
    expect(within(screen.getByRole("row", { name: /^c .*running/ })).getByText("running")).toHaveClass("chip", "chip-stale");
  });

  it("writes each finding outcome as a chip: claimed ok, needs credentials warning, unidentified hollow", async () => {
    const findings = [...done.findings, { host: "simulator", port: 8080, source_id: null, connector_type: null, outcome: "unclaimed", detail: "" }];
    mockFetch({ ...base("operator"), "GET /api/scans/7": { body: { ...done, findings } } });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Details" }));
    const outcome = async (prefix: RegExp, word: string) => within(await screen.findByRole("row", { name: prefix })).getByText(word);
    expect(await outcome(/^simulator 4840 /, "claimed")).toHaveClass("chip", "chip-ok");
    expect(await outcome(/^simulator 9000 /, "needs credentials")).toHaveClass("chip", "chip-warn");
    expect(await outcome(/^simulator 8080 /, "unidentified")).toHaveClass("chip", "chip-stale");
  });

  it("New scope is the one primary button; while a scan waits for its confirmation, Start scan is", async () => {
    mockFetch({ ...base("admin"), "GET /api/scopes/3/preview": { body: { hosts: 2, ports: 3, pairs: 6, digest: "d1g3st" } } });
    open();
    expect(await screen.findByRole("button", { name: "New scope" })).toHaveClass("primary");
    expect(document.querySelectorAll("button.primary")).toHaveLength(1);
    await pick("Scan");
    const start = await screen.findByRole("button", { name: "Start scan" });
    expect(start).toHaveClass("primary");
    expect(screen.getByRole("button", { name: "New scope" })).not.toHaveClass("primary");
    expect(document.querySelectorAll("button.primary")).toHaveLength(1);
    // Cancel sits before the primary in the DOM, so the focus order is what is seen
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("puts the scope form in a card and keeps New scope out of the header while it is open", async () => {
    mockFetch(base("admin"));
    open();
    await userEvent.click(await screen.findByRole("button", { name: "New scope" }));
    expect((await screen.findByLabelText("Targets")).closest(".scope-card")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "New scope" })).not.toBeInTheDocument();
  });

  it("shows the empty look when there are no scopes and no scans", async () => {
    mockFetch({ ...base("admin"), "GET /api/scopes": { body: [] }, "GET /api/scans": { body: [] } });
    open();
    expect((await screen.findByText(/No scopes yet/)).closest(".empty")).not.toBeNull();
    expect((await screen.findByText("No scans yet.")).closest(".empty")).not.toBeNull();
  });
});

describe("ScansPage while the lists load (W7f)", () => {
  const heldBy = (held: string) => holdFetch((_method, path) => path === held);

  it("shows the real heading and a table skeleton while the scopes are held, with nothing to press, then the scopes and no region", async () => {
    mockFetch(base("admin"));
    const held = heldBy("/api/scopes");
    open();
    expect(screen.getByRole("heading", { level: 1, name: "Scans" })).toBeInTheDocument();
    const region = screen.getByText("Loading scopes").parentElement!;
    expect(region).toHaveAttribute("role", "status");
    await waitFor(() => expect(region.querySelectorAll(".sk-table thead th")).toHaveLength(4)); // Name, Targets, Ports and the admin's row menu (the role arrives a moment after the first render)
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    expect(screen.queryByText(/No scopes/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    held.release();
    expect(await screen.findByRole("button", { name: "New scope" })).toBeInTheDocument();
    expect(screen.queryByText("Loading scopes")).not.toBeInTheDocument();
    expect(await screen.findAllByText("lab")).toHaveLength(2);
    expect(document.querySelector(".sk-region")).toBeNull();
  });

  it("stands a 34px gap in the admin's header actions slot, outside the region, so the header keeps its height", async () => {
    mockFetch(base("admin"));
    const held = heldBy("/api/scopes");
    open();
    await waitFor(() => expect(document.querySelector(".page-head > .actions > [aria-hidden]")).not.toBeNull()); // (the role arrives a moment after the first render)
    const gap = document.querySelector<HTMLElement>(".page-head > .actions > [aria-hidden]")!;
    expect(gap.style.height).toBe("34px");
    expect(gap.closest(".sk-region")).toBeNull();
    held.release();
    await screen.findByRole("button", { name: "New scope" });
  });

  it("has three columns and no actions slot for someone who cannot change anything (the real header has none either)", async () => {
    mockFetch(base("operator"));
    const held = heldBy("/api/scopes");
    open();
    await waitFor(() => expect(document.querySelectorAll(".sk-table thead th")).toHaveLength(3));
    expect(document.querySelector(".page-head > .actions")).toBeNull();
    held.release();
    await screen.findAllByText("lab");
  });

  it("shows 'Recent scans' and its own skeleton while only the history is held, then the history", async () => {
    mockFetch(base("operator"));
    const held = heldBy("/api/scans");
    open();
    expect(await screen.findByText("lab")).toBeInTheDocument(); // the scope row
    expect(screen.getByRole("heading", { name: "Recent scans" })).toBeInTheDocument();
    const region = screen.getByText("Loading recent scans").parentElement!;
    expect(region).toHaveAttribute("role", "status");
    expect(region.querySelectorAll(".sk-table thead th")).toHaveLength(5);
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    expect(screen.queryByText("No scans yet.")).not.toBeInTheDocument();
    held.release();
    await waitFor(() => expect(screen.getAllByText("lab")).toHaveLength(2)); // the scope row and its scan in the history
    expect(document.querySelector(".sk-region")).toBeNull();
  });

  it("ends with the empty looks when there is nothing, and with the errors when the lists fail, never a region", async () => {
    mockFetch({ ...base("operator"), "GET /api/scopes": { body: [] }, "GET /api/scans": { body: [] } });
    open();
    expect(await screen.findByText("No scopes have been defined yet.")).toBeInTheDocument();
    expect(await screen.findByText("No scans yet.")).toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
  });

  it("ends with the scopes error alone, and with the history's error under its heading, never a region", async () => {
    mockFetch({ ...base("operator"), "GET /api/scopes": { status: 500, body: { detail: "scopes are down" } } });
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("scopes are down");
    expect(document.querySelector(".sk-region")).toBeNull();
  });

  it("ends with the history's error under its heading when only the history fails", async () => {
    mockFetch({ ...base("operator"), "GET /api/scans": { status: 500, body: { detail: "history is down" } } });
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("history is down");
    expect(screen.getByRole("heading", { name: "Recent scans" })).toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
  });
});

describe("ScansPage controls follow the permissions of the role (a custom role)", () => {
  const preview = { "GET /api/scopes/3/preview": { body: { hosts: 2, ports: 3, pairs: 6, digest: "d1g3st" } } };
  /** A role called "custom" that holds discovery.view and `permissions`; the page is up and the account is known when this returns. */
  const show = async (permissions: PermissionId[], over: Record<string, unknown> = {}) => {
    const calls = mockFetch({ ...base("custom"), "GET /api/me": { body: userFor("custom", { permissions: ["discovery.view", ...permissions] }) }, ...over });
    renderWithProviders(<><ScansPage /><SignedIn /></>, { route: "/scans", path: "/scans" });
    await screen.findAllByText("lab");
    await accountKnown();
    return calls;
  };
  const menuTexts = async () => {
    await userEvent.click(await menuButton());
    return screen.getAllByRole("menuitem").map((el) => el.textContent);
  };

  it("discovery.view alone: scopes and history, and no New scope, no menu, no trash", async () => {
    const calls = await show([]);
    expect(screen.queryByRole("button", { name: "New scope" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete / })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Details" })).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/scopes/suggestions")).toBe(false);
  });

  it("discovery.edit: New scope (which asks for the suggestions), Edit in the menu and the trash, but not Scan", async () => {
    const calls = await show(["discovery.edit"]);
    expect(await menuTexts()).toEqual(["Edit"]);
    expect(screen.getByRole("button", { name: "Delete lab" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "New scope" }));
    expect(await screen.findByLabelText("Targets")).toHaveValue("172.18.0.0/24");
    expect(calls.some((c) => c.path === "/api/scopes/suggestions")).toBe(true);
  });

  it("discovery.scan alone: only Scan in the menu, no New scope, no Edit, no trash, and a scan runs from the confirmation", async () => {
    const calls = await show(["discovery.scan"], {
      ...preview, "POST /api/scopes/3/scan": { status: 202, body: { scan_id: 7, job_id: 1 } }, "GET /api/scans/7": { body: done },
    });
    expect(screen.queryByRole("button", { name: "New scope" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete / })).not.toBeInTheDocument();
    expect(await menuTexts()).toEqual(["Scan"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Scan" }));
    await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/scopes/3/scan")?.body).toEqual({ confirm_host_count: 2, digest: "d1g3st" });
    expect(calls.some((c) => c.path === "/api/scopes/suggestions")).toBe(false);
  });

  it("discovery.edit and discovery.scan: Scan and Edit, and a scan runs from the confirmation", async () => {
    const calls = await show(["discovery.edit", "discovery.scan"], {
      ...preview, "POST /api/scopes/3/scan": { status: 202, body: { scan_id: 7, job_id: 1 } }, "GET /api/scans/7": { body: done },
    });
    expect(await menuTexts()).toEqual(["Scan", "Edit"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Scan" }));
    await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/scopes/3/scan")?.body).toEqual({ confirm_host_count: 2, digest: "d1g3st" });
  });

  it("the empty state names New scope only for discovery.edit", async () => {
    mockFetch({ ...base("custom"), "GET /api/me": { body: userFor("custom", { permissions: ["discovery.view", "discovery.scan"] }) }, "GET /api/scopes": { body: [] }, "GET /api/scans": { body: [] } });
    renderWithProviders(<><ScansPage /><SignedIn /></>, { route: "/scans", path: "/scans" });
    expect(await screen.findByText("No scopes have been defined yet.")).toBeInTheDocument();
    await accountKnown();
    expect(screen.queryByText(/New scope/)).not.toBeInTheDocument();
  });

  it("the skeleton has the actions column and the header gap for discovery.edit", async () => {
    mockFetch({ ...base("custom"), "GET /api/me": { body: userFor("custom", { permissions: ["discovery.view", "discovery.edit"] }) } });
    const held = holdFetch((_method, path) => path === "/api/scopes");
    renderWithProviders(<ScansPage />, { route: "/scans", path: "/scans" });
    await waitFor(() => expect(document.querySelectorAll(".sk-table thead th")).toHaveLength(4));
    expect(document.querySelector(".page-head > .actions > [aria-hidden]")).not.toBeNull();
    held.release();
    await screen.findByRole("button", { name: "New scope" });
  });
});

describe("ScansPage scan drawer and readable numbers (W7r)", () => {
  const second = { ...done, id: 8, scope_name: "plant", targets: ["10.0.0.0/24"], ports: [502], findings: undefined };
  const history = [{ ...done, findings: undefined }, second];
  const detailsOf = (name: RegExp) => within(screen.getByRole("row", { name })).getByRole("button", { name: "Details" });

  it("opens Details in a drawer, closes it with Escape and puts the focus back on that row's Details button", async () => {
    mockFetch({ ...base("operator"), "GET /api/scans": { body: history }, "GET /api/scans/8": { body: { ...second, findings: [] } }, "GET /api/scans/7": { body: done } });
    open();
    await screen.findByRole("row", { name: /^plant / });
    const button = detailsOf(/^plant /);
    expect(button).toHaveAttribute("data-scan-details", "8");
    expect(button).toHaveAttribute("type", "button");
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Scan #8 — done" });
    expect(dialog).toHaveTextContent("plant: 10.0.0.0/24, port 502");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(detailsOf(/^plant /)).toHaveFocus(); // not the other scan's button
    await userEvent.click(detailsOf(/^lab .*done/));
    await screen.findByRole("dialog", { name: "Scan #7 — done" });
  });

  it("closes with the x and with a click outside, and sends nothing but reads", async () => {
    const calls = mockFetch({ ...base("operator"), "GET /api/scans/7": { body: done } });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Details" }));
    await screen.findByRole("dialog", { name: "Scan #7 — done" });
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Details" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    await screen.findByRole("dialog", { name: "Scan #7 — done" });
    await userEvent.click(document.querySelector(".drawer-backdrop")!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("opens the drawer of a scan that was just started, and closing it leaves the scan running with its row's Details button focused", async () => {
    const calls = mockFetch({
      ...base("admin"),
      "GET /api/scopes/3/preview": { body: { hosts: 2, ports: 3, pairs: 6, digest: "d1g3st" } },
      "POST /api/scopes/3/scan": { status: 202, body: { scan_id: 7, job_id: 1 } },
      "GET /api/scans/7": { body: { ...done, status: "running", stage: "sweep", findings: [], progress: { hosts: 2, pairs: 6, checked: 1 } } },
    });
    open();
    await pick("Scan");
    await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    expect(await screen.findByRole("dialog", { name: "Scan #7 — running" })).toHaveTextContent("1 of 6 checks");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Details" })).toHaveFocus();
    expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/scopes/3/scan"]); // nothing cancels it
  });

  it("falls back to the page when the scan's row is not in the list", async () => {
    mockFetch({
      ...base("admin"),
      "GET /api/scopes/3/preview": { body: { hosts: 2, ports: 3, pairs: 6, digest: "d1g3st" } },
      "POST /api/scopes/3/scan": { status: 202, body: { scan_id: 9, job_id: 1 } },
      "GET /api/scans/9": { body: { ...done, id: 9 } },
    });
    const main = document.createElement("main");
    main.id = "main";
    main.tabIndex = -1;
    document.body.append(main);
    open();
    await pick("Scan");
    await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    await screen.findByRole("dialog", { name: "Scan #9 — done" });
    await userEvent.keyboard("{Escape}");
    expect(main).toHaveFocus(); // the list does not show scan 9, so there is no button to give the focus to
    main.remove();
  });

  it("reads the scan's targets and ports under the scope's name in Recent scans, whole, with all of it in the title", async () => {
    const ports = [1, 2, 3, 4, 5, 6, 7, 8, 9, 4080];
    mockFetch({ ...base("operator"), "GET /api/scans": { body: [{ ...done, findings: undefined, targets: ["a", "b", "c", "d", "e"], ports }] } });
    open();
    const row = await screen.findByRole("row", { name: /^lab .*done/ });
    const sub = row.querySelector(".cell-sub")!;
    const all = "a, b, c, d, e, ports 1, 2, 3, 4, 5, 6, 7, 8, 9, 4080";
    expect(sub).toHaveTextContent(all); // nothing cut in the text itself: the ellipsis is CSS, and a mistyped port stays visible
    expect(sub).toHaveAttribute("title", all);
    expect(row.querySelector(".cell-name")).toHaveTextContent(/^lab$/);
  });

  it("has no second line for a scan that kept neither targets nor ports, and gives the figures their longer wording as a title", async () => {
    const { targets: _targets, ports: _ports, ...old } = done;
    mockFetch({ ...base("operator"), "GET /api/scans": { body: [{ ...old, findings: undefined }] } });
    open();
    const row = await screen.findByRole("row", { name: /^lab done/ });
    expect(row.querySelector(".cell-sub")).toBeNull();
    expect(within(row).getByText("1 source, 120 points")).toHaveAttribute("title", "1 source recognised, 120 points found");
  });
});

describe("ScansPage port names, the typo guard and Scan again (W7t)", () => {
  const preview = { "GET /api/scopes/3/preview": { body: { hosts: 2, ports: 3, pairs: 6, digest: "d1g3st" } } };
  const note = () => document.getElementById("scope-ports-note")!;
  const newScope = async (over: Record<string, unknown> = {}, role = "admin") => {
    const calls = mockFetch({ ...base(role), "POST /api/scopes": { status: 201, body: scope }, ...over });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "New scope" }));
    await screen.findByLabelText("Targets");
    return calls;
  };

  it("says '1 host', '1 port' and '1 check' in the confirmation, and keeps the plurals for more", async () => {
    mockFetch({ ...base("admin"), "GET /api/scopes/3/preview": { body: { hosts: 1, ports: 1, pairs: 1, digest: "d1g3st" } } });
    open();
    await pick("Scan");
    expect(await screen.findByText("1 host × 1 port (1 check)")).toBeInTheDocument();
    expect(screen.queryByText(/1 hosts|1 ports|1 checks/)).not.toBeInTheDocument();
  });

  it("names the known ports in the Scopes table and leaves a typo as the bare number", async () => {
    mockFetch({ ...base("operator"), "GET /api/scopes": { body: [{ ...scope, ports: [9000, 4840, 4080] }] } });
    open();
    const row = await screen.findByRole("row", { name: /^lab simulator / });
    expect(within(row).getByText("9000 (simulator), 4840 (OPC UA), 4080")).toBeInTheDocument();
  });

  it("reads the Ports field back with the names, in one reserved slot that the field points to", async () => {
    await newScope();
    expect(note()).toHaveClass("scope-ports-note");
    expect(note()).toHaveTextContent("502 (Modbus), 4840 (OPC UA), 9000 (simulator)");
    expect(screen.getByLabelText("Ports")).toHaveAttribute("aria-describedby", "scope-ports-hint scope-ports-note");
    expect(screen.getByLabelText("Ports")).toHaveAccessibleDescription(/502 \(Modbus\)/);
    expect(note().querySelector("[role]")).toBeNull(); // no live region: it would chatter on every key
    await userEvent.clear(screen.getByLabelText("Ports"));
    expect(note()).toBeEmptyDOMElement(); // the slot stays, empty
    await userEvent.type(screen.getByLabelText("Ports"), "4080");
    expect(note()).not.toHaveTextContent("Reads as"); // the warning has the slot
    await userEvent.clear(screen.getByLabelText("Ports"));
    await userEvent.type(screen.getByLabelText("Ports"), "80 8080");
    expect(note()).toBeEmptyDOMElement(); // nothing here has a name and nothing looks like a typo: nothing to say
    await userEvent.clear(screen.getByLabelText("Ports"));
    await userEvent.type(screen.getByLabelText("Ports"), "4840 80");
    expect(note()).toHaveTextContent("Reads as 4840 (OPC UA), 80"); // a named port: the readout is back
    expect(note().querySelector(".scope-ports-readout")).toHaveClass("muted");
  });

  it("warns about a port that looks like a typo, names the likely one, and never blocks the save", async () => {
    const calls = await newScope();
    await userEvent.type(screen.getByLabelText("Name"), "lab");
    await userEvent.clear(screen.getByLabelText("Ports"));
    await userEvent.type(screen.getByLabelText("Ports"), "4840 4080");
    expect(note()).toHaveTextContent("4080 is not a port any connector uses; did you mean 4840 (OPC UA)?");
    expect(note()).not.toHaveTextContent("Reads as"); // one slot: the warning has it, the readout would be a third line
    expect(note().querySelectorAll("p")).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // a note, not an error
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/scopes")?.body).toEqual({ name: "lab", targets: ["172.18.0.0/24"], ports: [4840, 4080] });
  });

  it("does not warn about 80, 8080, 443 or the ports it names, and keeps quiet while a port is half typed", async () => {
    await newScope();
    const ports = screen.getByLabelText("Ports");
    await userEvent.clear(ports);
    await userEvent.type(ports, "80 8080 443 502 4840 5020 9000");
    expect(note()).not.toHaveTextContent("did you mean");
    await userEvent.clear(ports);
    await userEvent.type(ports, "48");
    expect(note()).not.toHaveTextContent("did you mean");
  });

  it("lists at most three warnings and counts the rest", async () => {
    await newScope();
    await userEvent.clear(screen.getByLabelText("Ports"));
    await userEvent.type(screen.getByLabelText("Ports"), "4080 4048 4804 503 5022");
    expect(note().querySelectorAll("p")).toHaveLength(3 + 1); // three warnings and "and 2 more" (no port here has a name, so no readout)
    expect(note()).toHaveTextContent("and 2 more");
  });

  it("still guards from the static names when the suggestions cannot be read", async () => {
    await newScope({ "GET /api/scopes/suggestions": { status: 500, body: { detail: "suggestions are down" } } });
    expect(screen.getByText(/Could not load suggestions/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Name"), "x");
    await userEvent.type(screen.getByLabelText("Ports"), "4080");
    expect(note()).toHaveTextContent("did you mean 4840 (OPC UA)?");
  });

  it("also guards the edit form, reads the suggestions for it and compares with them", async () => {
    const calls = mockFetch({ ...base("admin"), "GET /api/scopes/suggestions": { body: { targets: ["172.18.0.0/24"], ports: [20000, 502] } } });
    open();
    await pick("Edit");
    expect(screen.getByLabelText("Ports")).toHaveValue("9000, 4840, 5020");
    expect(note()).toHaveTextContent("9000 (simulator), 4840 (OPC UA), 5020 (Modbus, simulator)");
    await userEvent.type(screen.getByLabelText("Ports"), ", 20001");
    await waitFor(() => expect(note()).toHaveTextContent("20001 is not a port any connector uses; did you mean 20000?"));
    expect(calls.some((c) => c.path === "/api/scopes/suggestions")).toBe(true);
  });

  it("shows the typo of a saved scope the moment its edit form opens", async () => {
    mockFetch({ ...base("admin"), "GET /api/scopes": { body: [{ ...scope, ports: [9000, 4080] }] } });
    open();
    await pick("Edit");
    expect(note()).toHaveTextContent("4080 is not a port any connector uses; did you mean 4840 (OPC UA)?");
  });

  describe("Scan again", () => {
    afterEach(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; }); // jsdom has none: a test that spies puts it there
    const again = (name = "Scan again") => screen.findByRole("button", { name });
    const startable = { ...preview, "POST /api/scopes/3/scan": { status: 202, body: { scan_id: 8, job_id: 1 } }, "GET /api/scans/8": { body: { ...done, id: 8 } } };

    it("previews the scope of that scan, and starts it only after the confirmation; the focus stays on the pressed button", async () => {
      const reveal = vi.fn();
      Element.prototype.scrollIntoView = reveal;
      const calls = mockFetch({ ...base("admin"), ...startable });
      open();
      const button = await again();
      expect(button).toHaveAttribute("data-scan-again", "7");
      expect(button).toHaveAttribute("type", "button");
      expect(button).not.toHaveAttribute("aria-disabled");
      button.focus();
      await userEvent.click(button);
      expect(await screen.findByText("2 hosts × 3 ports (6 checks)")).toBeInTheDocument();
      expect(calls.some((c) => c.method === "POST" && c.path === "/api/scopes/3/scan")).toBe(false); // the preview first, as the menu's Scan does
      expect(button).toHaveFocus();
      await waitFor(() => expect(reveal).toHaveBeenCalledWith({ block: "nearest", behavior: "auto" })); // the panel is above the table, often off screen
      expect(reveal.mock.contexts[0]).toBe(document.querySelector(".confirm-scan"));
      await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
      expect(calls.find((c) => c.method === "POST" && c.path === "/api/scopes/3/scan")?.body).toEqual({ confirm_host_count: 2, digest: "d1g3st" });
    });

    it("does not scroll for the menu's Scan, which has its own place in view", async () => {
      const reveal = vi.fn();
      Element.prototype.scrollIntoView = reveal;
      mockFetch({ ...base("admin"), ...preview });
      open();
      await pick("Scan");
      await screen.findByText("2 hosts × 3 ports (6 checks)");
      expect(reveal).not.toHaveBeenCalled();
    });

    it("sits beside Details in every row and keeps its name, so the Details button is still found by its own name", async () => {
      mockFetch({ ...base("admin"), "GET /api/scans": { body: [{ ...done, findings: undefined }, { ...done, id: 8, findings: undefined }] } });
      open();
      const rows = (await screen.findAllByRole("row", { name: /^lab .*done/ }));
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const cell = within(row).getByRole("button", { name: "Details" }).closest("td")!;
        expect([...cell.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Scan again", "Details"]);
      }
    });

    it("is drawn for a role that cannot scan, aria-disabled with the reason, and does nothing when pressed", async () => {
      const calls = mockFetch({ ...base("operator"), ...preview });
      open();
      const button = await again();
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).not.toBeDisabled(); // never native: a button that has the focus keeps it
      expect(button).toHaveAttribute("title", "Your role may not start scans.");
      expect(button).toHaveAccessibleDescription("Your role may not start scans.");
      await userEvent.click(button);
      expect(calls.some((c) => c.path.endsWith("/preview"))).toBe(false);
      expect(screen.queryByText(/hosts ×/)).not.toBeInTheDocument();
    });

    it("is aria-disabled with the reason when the scope was deleted (no scope id, or one that is no longer in the list)", async () => {
      const calls = mockFetch({
        ...base("admin"),
        "GET /api/scans": { body: [{ ...done, scope_id: null, findings: undefined }, { ...done, id: 8, scope_id: 99, findings: undefined }] },
      });
      open();
      await screen.findAllByRole("row", { name: /^lab .*done/ });
      const buttons = await screen.findAllByRole("button", { name: "Scan again" });
      expect(buttons).toHaveLength(2);
      for (const button of buttons) {
        expect(button).toHaveAttribute("aria-disabled", "true");
        expect(button).toHaveAttribute("title", "The scope was deleted.");
        await userEvent.click(button);
      }
      expect(calls.some((c) => c.path.endsWith("/preview"))).toBe(false);
    });

    it("waits while a request is in flight: a second press sends nothing, and the reason says why", async () => {
      const calls = mockFetch({ ...base("admin"), ...preview });
      const held = holdFetch((_method, path) => path === "/api/scopes/3/preview");
      open();
      const button = await again();
      await userEvent.click(button);
      await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"));
      expect(button).toHaveAttribute("title", "Another request is in progress.");
      await userEvent.click(button);
      held.release();
      await screen.findByText("2 hosts × 3 ports (6 checks)");
      expect(calls.filter((c) => c.path === "/api/scopes/3/preview")).toHaveLength(1);
      expect(button).not.toHaveAttribute("aria-disabled");
    });

    it("previews the scope as it is now, not as the scan saw it", async () => {
      let ports = 3;
      mockFetch({
        ...base("admin"),
        "GET /api/scopes/3/preview": () => ({ body: { hosts: 2, ports, pairs: 2 * ports, digest: `d${ports}` } }),
        "PATCH /api/scopes/3": ({ body }) => { ports = (body as { ports: number[] }).ports.length; return { body: scope }; },
      });
      open();
      await pick("Edit");
      await userEvent.clear(screen.getByLabelText("Ports"));
      await userEvent.type(screen.getByLabelText("Ports"), "1 2");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument());
      await userEvent.click(await again());
      expect(await screen.findByText("2 hosts × 2 ports (4 checks)")).toBeInTheDocument();
    });

    it("is there for a custom role that holds discovery.scan, and not enabled for one that holds only discovery.view", async () => {
      mockFetch({ ...base("custom"), "GET /api/me": { body: userFor("custom", { permissions: ["discovery.view", "discovery.scan"] }) }, ...preview });
      renderWithProviders(<><ScansPage /><SignedIn /></>, { route: "/scans", path: "/scans" });
      await screen.findAllByText("lab");
      await accountKnown();
      expect(await again()).not.toHaveAttribute("aria-disabled");
    });

    it("keeps the Details focus return working (its button carries data-scan-details and no other button does)", async () => {
      mockFetch({ ...base("operator"), "GET /api/scans/7": { body: done } });
      open();
      await userEvent.click(await screen.findByRole("button", { name: "Details" }));
      await screen.findByRole("dialog", { name: "Scan #7 — done" });
      await userEvent.keyboard("{Escape}");
      expect(screen.getByRole("button", { name: "Details" })).toHaveFocus();
      expect(document.querySelectorAll("[data-scan-details]")).toHaveLength(1);
    });
  });
});

describe("ScansPage Recent scans table hooks (W7t)", () => {
  it("is the container whose width decides when the two buttons stack, and its actions cell carries the class that may", async () => {
    mockFetch(base("admin"));
    open();
    const row = await screen.findByRole("row", { name: /^lab .*done/ });
    expect(row.closest(".table-wrap")).toHaveClass("scans-recent");
    expect(within(row).getByRole("button", { name: "Details" }).closest("td")).toHaveClass("row-actions", "scan-actions");
    expect(document.querySelectorAll(".scans-recent")).toHaveLength(1); // the Scopes table keeps its plain frame
  });
});
