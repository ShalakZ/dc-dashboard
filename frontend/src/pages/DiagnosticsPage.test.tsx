import { readFileSync } from "node:fs";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch, type Routes } from "../test/fetchMock";
import { parseRules, stripComments } from "../test/cssTools";
import { renderWithProviders } from "../test/render";
import { spyToasts } from "../test/toasts";
import { accountKnown, SignedIn } from "../test/signedIn";
import { userFor } from "../test/users";
import type { PermissionId } from "../lib/permissions";
import { DiagnosticsPage } from "./DiagnosticsPage";

const part = (index: number, of: number, text: string, chars: number, lines: number) => ({ index, of, text, chars, lines });
const reply = (over: Record<string, unknown> = {}) => ({
  format: "DCDASH-REPORT v1", build_id: "227bd6a", detail: "summary", mask: false, checksum: "0123456789ab",
  parts: [part(1, 1, "DCDASH-REPORT v1 | PART 1 OF 1 | build 227bd6a\n== ENVIRONMENT ==\nEND OF REPORT 0123456789ab", 12034, 210)],
  legend: [], ...over,
});

let reportUrls: string[];
const routes = (report: unknown = reply(), extra: Routes = {}): Routes => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor("admin", { username: "a" }) },
  "GET /api/site": { body: { timezone: "UTC", currency: null } },
  "GET /api/sources": { body: [{ id: 5, name: "Main SCADA", connector_type: "opcua", enabled: true }, { id: 6, name: "Backup", connector_type: "opcua", enabled: true }] },
  "GET /api/diagnostics/report": ({ url }) => { reportUrls.push(url); return { body: report }; },
  ...extra,
});
const build = () => screen.getByRole("button", { name: "Build report" });
const paramsOf = (url: string) => new URL(url, "http://x").searchParams;

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  reportUrls = [];
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  URL.createObjectURL = vi.fn(() => "blob:report");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

describe("DiagnosticsPage report", () => {
  it("asks for nothing until Build is pressed, then once, with the options chosen", async () => {
    const calls = mockFetch(routes());
    renderWithProviders(<DiagnosticsPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Diagnostics" })).toBeInTheDocument();
    expect(await screen.findAllByRole("option", { name: "Backup" })).toHaveLength(2); // the report's select and the check panel's
    expect(screen.getByText(/Nothing built yet/)).toBeInTheDocument();
    expect(reportUrls).toEqual([]);
    await userEvent.click(screen.getByRole("radio", { name: "Full" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Hide host names and addresses" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Limit to one source" }), "Backup");
    await userEvent.click(build());
    await screen.findByRole("textbox", { name: "Report part 1 of 1" });
    expect(reportUrls).toHaveLength(1);
    const query = paramsOf(reportUrls[0]);
    expect([query.get("detail"), query.get("mask"), query.get("source"), query.get("format")]).toEqual(["full", "1", "6", "json"]);
    expect(Date.parse(query.get("client_time") ?? "")).not.toBeNaN(); // the browser's clock, for the clock comparison
    expect(calls.filter((c) => c.path === "/api/diagnostics/report")).toHaveLength(1);
  });

  it("defaults to a summary of all sources, unmasked", async () => {
    mockFetch(routes());
    renderWithProviders(<DiagnosticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Build report" }));
    await screen.findByRole("textbox", { name: "Report part 1 of 1" });
    const query = paramsOf(reportUrls[0]);
    expect([query.get("detail"), query.get("mask"), query.has("source")]).toEqual(["summary", "0", false]);
  });

  it("shows every part in its own read-only text area with the server's size", async () => {
    const parts = [part(1, 2, "FIRST PART\nline", 12034, 210), part(2, 2, "SECOND PART\nEND OF REPORT x", 1, 1)];
    mockFetch(routes(reply({ detail: "full", parts })));
    renderWithProviders(<DiagnosticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Build report" }));
    const first = await screen.findByRole("textbox", { name: "Report part 1 of 2" });
    const second = screen.getByRole("textbox", { name: "Report part 2 of 2" });
    expect(first).toHaveValue("FIRST PART\nline");
    expect(first).toHaveAttribute("readonly");
    expect(second).toHaveValue("SECOND PART\nEND OF REPORT x");
    expect(screen.getByText("12,034 characters of content, 210 lines")).toBeInTheDocument();
    expect(screen.getByText("1 character of content, 1 line")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Part 2 of 2" })).toBeInTheDocument();
    expect(screen.getByText(/Built a full report in 2 parts, 12,035 characters of content, build 227bd6a\./)).toBeInTheDocument();
  });

  it("copies the exact text of the part whose button is pressed", async () => {
    const parts = [part(1, 2, "FIRST PART", 10, 1), part(2, 2, "SECOND PART", 11, 1)];
    mockFetch(routes(reply({ detail: "full", parts })));
    renderWithProviders(<DiagnosticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Build report" }));
    await userEvent.click(await screen.findByRole("button", { name: "Copy part 2 of 2" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("SECOND PART");
    expect(await screen.findByText("Copied part 2 of 2.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy part 1 of 2" }));
    expect(writeText).toHaveBeenLastCalledWith("FIRST PART");
  });

  it("tells the user to copy by hand when the browser refuses", async () => {
    mockFetch(routes());
    writeText.mockRejectedValue(new Error("denied"));
    (document as unknown as { execCommand: unknown }).execCommand = () => false;
    renderWithProviders(<DiagnosticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Build report" }));
    await userEvent.click(await screen.findByRole("button", { name: "Copy part 1 of 1" }));
    expect(await screen.findByText("The browser would not copy it. The text is selected: press Ctrl+C.")).toBeInTheDocument();
  });

  it("downloads the report it already holds, as one text, with no further request", async () => {
    const parts = [part(1, 2, "FIRST", 5, 1), part(2, 2, "SECOND", 6, 1)];
    const calls = mockFetch(routes(reply({ detail: "full", parts })));
    const saved: { download: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ download: this.download, href: this.href });
    });
    const toasts = spyToasts();
    renderWithProviders(<DiagnosticsPage />, { toasts: toasts.api });
    await userEvent.click(await screen.findByRole("button", { name: "Build report" }));
    const before = calls.length;
    expect(toasts.calls).toEqual([]);
    await userEvent.click(await screen.findByRole("button", { name: "Download .txt" }));
    expect(calls).toHaveLength(before);
    expect(toasts.calls).toEqual([{ kind: "info", text: "Report downloaded" }]);
    expect(saved).toEqual([{ download: "dcdash-report-227bd6a-full.txt", href: "blob:report" }]);
    const blob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob;
    expect(await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(blob); })).toBe("FIRST\n\nSECOND");
  });

  it("shows the address key only for a masked report, collapsed, and never inside the text", async () => {
    const masked = reply({
      mask: true,
      parts: [part(1, 1, "== SOURCES ==\nHOST-1 online", 27, 2)],
      legend: [{ alias: "HOST-1", original: "scada.example.net" }],
    });
    mockFetch(routes(masked));
    renderWithProviders(<DiagnosticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Build report" }));
    const summary = await screen.findByText("Address key");
    const details = summary.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByRole("cell", { name: "scada.example.net" })).toBeInTheDocument();
    expect(within(details).getByRole("cell", { name: "HOST-1" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Report part 1 of 1" })).not.toHaveValue(expect.stringContaining("scada.example.net"));
    expect(screen.getByText(/host names and addresses hidden/)).toBeInTheDocument();
  });

  it("has no address key for an unmasked report", async () => {
    mockFetch(routes());
    renderWithProviders(<DiagnosticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Build report" }));
    await screen.findByRole("textbox", { name: "Report part 1 of 1" });
    expect(screen.queryByText("Address key")).not.toBeInTheDocument();
  });

  it("says so when a masked report hid nothing", async () => {
    mockFetch(routes(reply({ mask: true, legend: [] })));
    renderWithProviders(<DiagnosticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Build report" }));
    expect(await screen.findByText("No host or address needed hiding in this report.")).toBeInTheDocument();
  });

  it("shows the server's refusal as an error and keeps the form usable", async () => {
    mockFetch(routes(undefined, { "GET /api/diagnostics/report": { status: 500, body: { detail: "report failed" } } }));
    renderWithProviders(<DiagnosticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Build report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The report could not be built (Report failed). Try again; if it keeps failing, run the offline script described in docs/field-debugging.md (scripts/collect-diagnostics.ps1) and paste its output.",
    );
    expect(build()).toBeEnabled();
  });

  it("says in one sentence that only administrators can build a report", async () => {
    mockFetch(routes(undefined, { "GET /api/diagnostics/report": { status: 403, body: { detail: "admin role required" } } }));
    renderWithProviders(<DiagnosticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Build report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Only administrators can build a report\.$/);
  });

  it("says the server could not be reached when the request fails", async () => {
    mockFetch(routes());
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/api/diagnostics/report") ? Promise.reject(new TypeError("Failed to fetch")) : inner(input, init)));
    renderWithProviders(<DiagnosticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Build report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Could not reach the server\.$/);
    expect(build()).toBeEnabled();
  });

  it("replaces the report when it is built again", async () => {
    let n = 0;
    mockFetch(routes(undefined, {
      "GET /api/diagnostics/report": () => ({ body: reply({ parts: [part(1, 1, `REPORT NUMBER ${++n}`, 15, 1)] }) }),
    }));
    renderWithProviders(<DiagnosticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Build report" }));
    expect(await screen.findByDisplayValue("REPORT NUMBER 1")).toBeInTheDocument();
    await userEvent.click(build());
    expect(await screen.findByDisplayValue("REPORT NUMBER 2")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("REPORT NUMBER 1")).not.toBeInTheDocument();
  });
});

describe("DiagnosticsPage connection check", () => {
  it("re-enables Run and says so when the job it follows is gone (404)", async () => {
    mockFetch(routes(undefined, {
      "POST /api/sources/5/check": { status: 409, body: { detail: "a connection check is already running", job_id: 999999 } },
      "GET /api/jobs/999999": { status: 404, body: { detail: "job not found" } },
    }));
    renderWithProviders(<DiagnosticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Run connection check" }));
    expect(await screen.findByText("The check could not be found; run it again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run connection check" })).toBeEnabled();
  });

  it("shows the server's sentence for a 409 that names no job to follow", async () => {
    mockFetch(routes(undefined, {
      "POST /api/sources/5/check": { status: 409, body: { detail: "a connection check for this source is already running" } },
    }));
    renderWithProviders(<DiagnosticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Run connection check" }));
    expect(await screen.findByText("A connection check for this source is already running.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run connection check" })).toBeEnabled();
  });

  it("carries the check panel, which lists the sources", async () => {
    mockFetch(routes());
    renderWithProviders(<DiagnosticsPage />);
    expect(await screen.findByRole("heading", { level: 2, name: "Connection check" })).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "Source" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run connection check" })).toBeInTheDocument();
  });

  it("shows the steps of a check as polls bring them", async () => {
    let polls = 0;
    const step = (id: string, name: string) => ({ id, name, ok: true, ms: 5, summary: "", error: null, hint: null, detail: {} });
    const result = (steps: unknown[], done: boolean) => ({
      source_id: 5, connector_type: "opcua", started_at: "2026-10-12T10:00:00+00:00", finished: done, ok: done ? true : null, first_failed: null, steps,
      clock: { server_time: null, local_time: "2026-10-12T10:00:00+00:00", skew_seconds: null }, names: { hosts: [], uris: [] },
    });
    mockFetch(routes(undefined, {
      "POST /api/sources/5/check": { status: 202, body: { job_id: 9 } },
      "GET /api/jobs/9": () => {
        polls += 1;
        const steps = [step("dns", "DNS resolution"), step("tcp", "TCP connection")].slice(0, polls);
        return { body: { id: 9, kind: "check_connection", status: polls < 2 ? "running" : "done", result: result(steps, polls >= 2), created_at: "t", finished_at: polls >= 2 ? "2026-10-12T10:00:05+00:00" : null } };
      },
    }));
    renderWithProviders(<DiagnosticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Run connection check" }));
    expect(await screen.findByText("DNS resolution")).toBeInTheDocument();
    expect(screen.queryByText("TCP connection")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("TCP connection")).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByText("Every step passed.")).toBeInTheDocument();
  }, 15_000);
});

describe("DiagnosticsPage layout (W7j)", () => {
  const cardOf = (name: string) => screen.getByRole("heading", { level: 2, name }).closest("section.page-card") as HTMLElement;

  it("is two page cards in order, Report then Connection check, each with an icon that is decoration", async () => {
    mockFetch(routes());
    const { container } = renderWithProviders(<DiagnosticsPage />);
    await screen.findByRole("combobox", { name: "Source" });
    const cards = [...container.querySelectorAll("section.diag-page > .page-grid > .page-card.span-all")];
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.querySelector("h2")?.textContent)).toEqual(["Report", "Connection check"]);
    for (const card of cards) {
      const icon = card.querySelector(".page-card-head > svg.i");
      expect(icon, "an icon in the head").not.toBeNull();
      expect(icon).toHaveAttribute("aria-hidden", "true");
    }
    expect(container.querySelector(".form-card")).toBeNull(); // the narrow card is gone; Users and Sources keep theirs
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
  });

  it("puts the detail group, the source select and the mask checkbox in one row, in that order, before the helper line and the Build row", async () => {
    mockFetch(routes());
    renderWithProviders(<DiagnosticsPage />);
    await screen.findByRole("combobox", { name: "Limit to one source" });
    const form = build().closest("form")!;
    expect(form).toHaveClass("report-form");
    const [fields, helper, row] = [...form.children] as HTMLElement[];
    expect(fields).toHaveClass("report-fields");
    expect([...fields.children].map((c) => c.tagName)).toEqual(["FIELDSET", "LABEL", "LABEL"]);
    const [detail, source, mask] = [...fields.children] as HTMLElement[];
    expect(within(detail).getByRole("radio", { name: "Summary" })).toBeInTheDocument();
    expect(within(detail).getByRole("radio", { name: "Full" })).toBeInTheDocument();
    expect(within(source).getByRole("combobox", { name: "Limit to one source" })).toBeInTheDocument();
    expect(within(mask).getByRole("checkbox", { name: "Hide host names and addresses" })).toBeInTheDocument();
    // The host-name explanation is a line of the form, not of the checkbox's narrow column, and the Build row follows it.
    expect(helper.tagName).toBe("P");
    expect(helper).toHaveTextContent(/^A report names the machines of your network\. Tick this to replace every host name and address with HOST-1, HOST-2 and so on; the key stays on this page\. Passwords and keys are never in a report\.$/);
    expect(row).toHaveClass("row");
    expect(within(row).getByRole("button", { name: "Build report" })).toBe(build());
    // the helper line is the checkbox's description (read after its name), though it sits on a line of its own
    const box = within(mask).getByRole("checkbox", { name: "Hide host names and addresses" });
    expect(box).toHaveAttribute("aria-describedby", helper.id);
    expect(helper.id).not.toBe("");
    expect(box).toHaveAccessibleDescription(/^A report names the machines of your network\./);
  });

  it("keeps every helper line as plain text at the card's width: no hint cap, no info tip, the Detail help stays in its group", async () => {
    mockFetch(routes());
    const { container } = renderWithProviders(<DiagnosticsPage />);
    await screen.findByRole("combobox", { name: "Source" });
    expect(container.querySelector(".hint")).toBeNull();
    expect(screen.queryByRole("button", { name: "What does this mean?" })).not.toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Detail" });
    expect(within(group).getByText(/^Summary: one paste with the latest connection check/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Full" }));
    expect(within(group).getByText(/^Full: everything, up to about 60,000 characters/)).toBeInTheDocument();
    expect(within(group).queryByText(/^Summary: one paste/)).not.toBeInTheDocument();
    expect(screen.getByText("Nothing built yet. Choose the detail and press Build report.")).toBeInTheDocument();
  });

  it("gives the connection check card its sentence as the purpose line, with the panel below it", async () => {
    mockFetch(routes());
    renderWithProviders(<DiagnosticsPage />);
    await screen.findByRole("combobox", { name: "Source" });
    const card = cardOf("Connection check");
    const purpose = card.querySelector(".page-card-head > .sect-purpose");
    expect(purpose).toHaveTextContent("Runs the steps one after the other and shows where a connection stops. It only reads from the source.");
    expect(card.querySelector(".check-panel")).not.toBeNull();
    expect(within(cardOf("Report")).queryByRole("combobox", { name: "Source" })).not.toBeInTheDocument();
  });

  it("builds the report inside the Report card: the bar, the parts and the key", async () => {
    mockFetch(routes(reply({
      mask: true,
      parts: [part(1, 2, "FIRST", 5, 1), part(2, 2, "SECOND", 6, 1)],
      legend: [{ alias: "HOST-1", original: "scada.example.net" }],
    })));
    renderWithProviders(<DiagnosticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Build report" }));
    await screen.findByRole("textbox", { name: "Report part 2 of 2" });
    const card = cardOf("Report");
    expect(within(card).getByRole("status", { name: "" })).toHaveTextContent(/^Built a summary report in 2 parts/);
    expect(within(card).getByRole("button", { name: "Download .txt" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Copy part 2 of 2" })).toBeInTheDocument();
    expect(within(card).getByText("Address key")).toBeInTheDocument();
    expect(within(cardOf("Connection check")).queryByRole("textbox")).not.toBeInTheDocument();
  });
});

describe("the Diagnostics styles (W7j)", () => {
  const rules = parseRules(stripComments(readFileSync("src/styles/pages-admin.css", "utf8")));
  const one = (selector: string) => {
    const found = rules.filter((r) => r.selector === selector);
    expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
    return found[0].body;
  };

  it("sets no narrow width on the form or on any description of the page", () => {
    const own = rules.filter((r) => /diag-page|report-/.test(r.selector) && !r.selector.includes(".page-head .sub")); // the shared description rule is tested below
    expect(own.length).toBeGreaterThan(0);
    for (const rule of own) {
      expect(rule.body, `"${rule.selector}"`).not.toMatch(/max-width:\s*(?!none\b|100%)[\d.]+(px|ch|rem|em)/);
    }
    // no rule of its own: `.page-card form` (app.css, tested there) already lifts the global `form { max-width: 480px }` for every card's form
    expect(rules.filter((r) => r.selector === ".diag-page .report-form")).toHaveLength(0);
  });

  it("holds the Detail group to a fixed basis so its two help texts do not move the neighbours", () => {
    const body = one(".report-fields > fieldset");
    expect(body).toMatch(/flex:\s*0 1 [\d.]+(rem|px)/);
    expect(body).toMatch(/min-width:\s*0/); // a fieldset's own min-content would otherwise win over the basis
  });

  it("lets the page description run to about 110 characters, like the other four pages", () => {
    const rule = rules.find((r) => r.selector.split(",").map((s) => s.trim()).includes(".diag-page .page-head .sub"));
    expect(rule, "the shared .page-head .sub rule names .diag-page").toBeDefined();
    expect(rule!.body).toMatch(/max-width:\s*110ch/);
  });
});

describe("DiagnosticsPage follows the permissions of the role (a custom role)", () => {
  const show = async (permissions: PermissionId[]) => {
    mockFetch(routes(reply(), { "GET /api/me": { body: userFor("custom", { permissions: ["diagnostics.view", "sources.view", ...permissions] }) } }));
    renderWithProviders(<><DiagnosticsPage /><SignedIn /></>);
    await screen.findByRole("heading", { level: 1, name: "Diagnostics" });
    await accountKnown();
  };

  it("diagnostics.view and sources.view: the report, and no connection check (that is diagnostics.run)", async () => {
    await show([]);
    expect(screen.getByRole("heading", { level: 2, name: "Report" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Connection check" })).not.toBeInTheDocument();
    await userEvent.click(build());
    await screen.findByRole("textbox", { name: "Report part 1 of 1" });
  });

  it("with diagnostics.run the connection check card follows the report", async () => {
    await show(["diagnostics.run"]);
    expect(await screen.findByRole("heading", { level: 2, name: "Connection check" })).toBeInTheDocument();
  });
});
