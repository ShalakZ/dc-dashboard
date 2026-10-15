import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { userFor } from "../test/users";
import { ScanDrawer } from "./ScanDrawer";

const done = {
  id: 7, scope_id: 3, scope_name: "lab", targets: ["simulator"], ports: [9000, 4840, 5020], status: "done", stage: "browse",
  created_at: "t", finished_at: "t", error: null,
  progress: { hosts: 1, pairs: 3, checked: 3, open: 3, claimed: 2, points: 120, unidentified: 0, needs_credentials: 1 },
  scope_snapshot: {},
  findings: [
    { host: "simulator", port: 4840, source_id: 5, connector_type: "opcua", outcome: "claimed", detail: "60 points" },
    { host: "simulator", port: 9000, source_id: 6, connector_type: "simulator", outcome: "needs_credentials", detail: "credentials rejected" },
  ],
};
const base = {
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor("operator") },
};
const open = (props: Partial<Parameters<typeof ScanDrawer>[0]> = {}) =>
  renderWithProviders(<ScanDrawer scanId={7} onClose={() => {}} {...props} />, { route: "/scans", path: "/scans" });
const dialog = () => screen.getByRole("dialog", { name: /^Scan #7/ });
/** The text of the stats row, one entry per figure. */
const figures = () => [...dialog().querySelectorAll(".scan-stats > span")].map((span) => span.textContent);
/** The one polite line: role-less, aria-live. */
const liveLine = () => dialog().querySelector<HTMLElement>("[aria-live]")!;

describe("ScanDrawer", () => {
  it("is a dialog named Scan #7 and its status, with what was scanned, in words", async () => {
    mockFetch({ ...base, "GET /api/scans/7": { body: done } });
    open();
    expect(await screen.findByRole("dialog", { name: "Scan #7 — done" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Scan #7 — done" })).toBeInTheDocument();
    expect(dialog()).toHaveTextContent("lab: simulator, ports 9000, 4840, 5020");
  });

  it("counts the checks, the open ports, the sources recognised and the rest in plain words", async () => {
    mockFetch({ ...base, "GET /api/scans/7": { body: done } });
    open();
    await screen.findByRole("dialog", { name: "Scan #7 — done" });
    expect(figures()).toEqual(["3 checks (1 host × 3 ports)", "3 open", "1 source recognised", "120 points", "1 needs credentials", "0 unidentified"]);
    expect(dialog().textContent).not.toMatch(/ports checked|\d claimed/);
  });

  it("still shows the ports of a scan whose scope was deleted (they come from the scan's own snapshot)", async () => {
    mockFetch({ ...base, "GET /api/scans/7": { body: { ...done, scope_id: null } } });
    open();
    await screen.findByRole("dialog", { name: "Scan #7 — done" });
    expect(dialog()).toHaveTextContent("lab: simulator, ports 9000, 4840, 5020");
  });

  it("shows every target and port of a long scope, never cut to 'and N more'", async () => {
    const targets = Array.from({ length: 50 }, (_, i) => `10.9.0.${i + 1}`);
    const ports = [502, 4840, 5020, 9000, 20000, 20001, 20002, 20003, 20004, 20005];
    mockFetch({ ...base, "GET /api/scans/7": { body: { ...done, targets, ports } } });
    open();
    await screen.findByRole("dialog", { name: "Scan #7 — done" });
    const line = dialog().querySelector(".scan-scope")!.textContent!;
    expect(line).toBe(`lab: ${targets.join(", ")}, ports ${ports.join(", ")}`);
    expect(line).not.toMatch(/more/);
  });

  it("shows just the name for an old scan that kept neither targets nor ports", async () => {
    const { targets: _targets, ports: _ports, ...old } = done;
    mockFetch({ ...base, "GET /api/scans/7": { body: old } });
    open();
    await screen.findByRole("dialog", { name: "Scan #7 — done" });
    expect(dialog().querySelector(".scan-scope")).toHaveTextContent(/^lab$/);
  });

  it("lists the findings with their outcomes as words, and links to the graph from the footer (the footer is the same in every state)", async () => {
    mockFetch({ ...base, "GET /api/scans/7": { body: done } });
    open();
    const locked = await screen.findByRole("row", { name: /^simulator 9000 / });
    expect(within(locked).getByText("needs credentials")).toHaveClass("chip", "chip-warn");
    expect(within(await screen.findByRole("row", { name: /^simulator 4840 / })).getByText("claimed")).toHaveClass("chip", "chip-ok");
    const link = screen.getByRole("link", { name: "Open the discovery graph" });
    expect(link).toHaveAttribute("href", "/discovery");
    expect(link.closest(".drawer-foot")).not.toBeNull();
  });

  it("says so when a finished scan found no open ports", async () => {
    mockFetch({ ...base, "GET /api/scans/7": { body: { ...done, findings: [], progress: { hosts: 1, pairs: 3, checked: 3 } } } });
    open();
    expect(await screen.findByText("No open ports were found.")).toBeInTheDocument();
    expect(figures()[0]).toBe("3 checks (1 host × 3 ports)");
  });

  it("shows a failed scan's reason as an alert, with how far it got and no table", async () => {
    mockFetch({ ...base, "GET /api/scans/7": { body: { ...done, status: "failed", error: "worker lost", findings: [], progress: { hosts: 2, pairs: 6, checked: 4 } } } });
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("worker lost");
    expect(screen.getByRole("dialog", { name: "Scan #7 — failed" })).toBeInTheDocument();
    expect(figures()[0]).toBe("4 of 6 checks");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  describe("while the scan is read", () => {
    it("is called Scan #7 with a skeleton in the shape of the body, and nothing in it to find by text", async () => {
      mockFetch({ ...base, "GET /api/scans/7": { body: done } });
      open();
      const region = screen.getByText("Loading the scan").parentElement!;
      expect(region).toHaveAttribute("role", "status");
      expect(screen.getByRole("dialog", { name: "Scan #7" })).toBeInTheDocument();
      expect(region.querySelectorAll(".scan-stats > span")).toHaveLength(6);
      expect(region.querySelectorAll(".sk-table thead th")).toHaveLength(5);
      expect(region.textContent).toBe("Loading the scan");
      await screen.findByRole("dialog", { name: "Scan #7 — done" });
      expect(document.querySelector(".sk-region")).toBeNull();
    });

    it("puts the alert in the skeleton's place when the scan cannot be read at all", async () => {
      mockFetch({ ...base, "GET /api/scans/7": { status: 404, body: { detail: "scan not found" } } });
      open();
      expect(await screen.findByRole("alert")).toHaveTextContent("scan not found");
      expect(screen.getByRole("dialog", { name: "Scan #7" })).toBeInTheDocument();
      expect(document.querySelector(".sk-region")).toBeNull();
    });
  });

  describe("a scan that is running", () => {
    const running = { ...done, status: "running", stage: "sweep", findings: [], progress: { hosts: 1, pairs: 3, checked: 1, open: 1 } };

    it("updates its title, figures and stage as the poll answers, and says the new state in the one polite line, never the figures", async () => {
      let polls = 0;
      mockFetch({ ...base, "GET /api/scans/7": () => ({ body: ++polls < 2 ? running : done }) });
      open();
      expect(await screen.findByRole("dialog", { name: "Scan #7 — running" })).toBeInTheDocument();
      expect(figures()[0]).toBe("1 of 3 checks");
      expect(dialog()).toHaveTextContent("stage: sweep");
      expect(liveLine()).toHaveTextContent(/^$/); // the first state is read out as the dialog is
      expect(await screen.findByRole("dialog", { name: "Scan #7 — done" }, { timeout: 5000 })).toBeInTheDocument();
      expect(figures()[0]).toBe("3 checks (1 host × 3 ports)");
      expect(liveLine()).toHaveTextContent(/^done$/);
      expect(dialog()).not.toHaveTextContent("stage:");
      expect(await screen.findByRole("row", { name: /^simulator 9000 / })).toBeInTheDocument();
    });

    it("draws the findings area as a skeleton table until it is done, so the table arrives under figures that do not move", async () => {
      mockFetch({ ...base, "GET /api/scans/7": { body: running } });
      open();
      await screen.findByRole("dialog", { name: "Scan #7 — running" });
      expect(dialog().querySelectorAll(".sk-table thead th")).toHaveLength(5);
      expect(screen.queryByRole("table")).not.toBeInTheDocument(); // the skeleton table is hidden from the accessibility tree
    });

    it("says 'starting' while a queued scan has no stage yet", async () => {
      mockFetch({ ...base, "GET /api/scans/7": { body: { ...running, status: "queued", stage: null, progress: {} } } });
      open();
      expect(await screen.findByRole("dialog", { name: "Scan #7 — queued" })).toHaveTextContent("stage: starting");
      expect(figures()[0]).toBe("0 checks");
    });
  });

  describe("a poll that fails", () => {
    it("keeps what it shows and says what went wrong in the footer; the line goes when a poll answers again", async () => {
      let polls = 0;
      const running = { ...done, status: "running", stage: "probe", findings: [], progress: { hosts: 1, pairs: 3, checked: 2, open: 2 } };
      mockFetch({
        ...base,
        "GET /api/scans/7": () => {
          polls += 1;
          return polls === 2 ? { status: 409, body: { detail: "the scan is being moved" } } : { body: running };
        },
      });
      open();
      await screen.findByRole("dialog", { name: "Scan #7 — running" });
      const note = await screen.findByRole("alert", {}, { timeout: 5000 });
      expect(note).toHaveTextContent("the scan is being moved");
      expect(note.closest(".drawer-foot")).not.toBeNull();
      expect(figures()[0]).toBe("2 of 3 checks"); // the content stays
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument(), { timeout: 5000 });
    });
  });

  describe("closing and focus", () => {
    it("closes with Escape, with the x and with a click outside, and never stops the scan", async () => {
      const calls = mockFetch({ ...base, "GET /api/scans/7": { body: done } });
      const onClose = vi.fn();
      open({ onClose });
      await screen.findByRole("dialog", { name: "Scan #7 — done" });
      await userEvent.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(1);
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).toHaveBeenCalledTimes(2);
      await userEvent.click(document.querySelector(".drawer-backdrop")!);
      expect(onClose).toHaveBeenCalledTimes(3);
      expect(calls.some((c) => c.method !== "GET")).toBe(false);
    });

    it("hands focus to what returnFocus gives when it goes away", async () => {
      mockFetch({ ...base, "GET /api/scans/7": { body: done } });
      const target = document.createElement("button");
      document.body.append(target);
      const { unmount } = open({ returnFocus: () => target });
      await screen.findByRole("dialog", { name: "Scan #7 — done" });
      unmount();
      expect(target).toHaveFocus();
      target.remove();
    });
  });
});
