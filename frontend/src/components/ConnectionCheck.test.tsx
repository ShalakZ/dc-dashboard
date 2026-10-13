import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { userFor } from "../test/users";
import { ConnectionCheck } from "./ConnectionCheck";

const auth = (role = "operator"): Routes => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor(role, { username: "o" }) },
  "GET /api/site": { body: { timezone: "UTC", currency: null } },
  "GET /api/sources": { body: [
    { id: 5, name: "Main SCADA", connector_type: "opcua", enabled: true },
    { id: 6, name: "Backup", connector_type: "opcua", enabled: true },
  ] },
});

const step = (id: string, name: string, over: Record<string, unknown> = {}) =>
  ({ id, name, ok: true, ms: 12, summary: "", error: null, hint: null, detail: {}, ...over });
const check = (steps: unknown[], over: Record<string, unknown> = {}) => ({
  source_id: 5, connector_type: "opcua", started_at: "2026-10-12T10:00:00+00:00", finished: false, ok: null, first_failed: null, steps,
  clock: { server_time: null, local_time: "2026-10-12T10:00:00+00:00", skew_seconds: null }, names: { hosts: [], uris: [] }, ...over,
});
const job = (id: number, status: string, result: unknown, finished_at: string | null = null) =>
  ({ body: { id, kind: "check_connection", status, result, created_at: "t", finished_at } });

/** A job route that answers each poll with the next reply (the last one repeats). */
const sequence = (...replies: ReturnType<typeof job>[]) => {
  let n = 0;
  return () => replies[Math.min(n++, replies.length - 1)];
};

const run = () => screen.getByRole("button", { name: "Run connection check" });

describe("ConnectionCheck", () => {
  it("posts the check for the fixed source and shows the steps as they arrive", async () => {
    const calls = mockFetch({
      ...auth(),
      "POST /api/sources/5/check": { status: 202, body: { job_id: 41 } },
      "GET /api/jobs/41": sequence(
        job(41, "pending", null),
        job(41, "running", check([step("dns", "DNS resolution", { ms: 8, summary: "resolved to 1 address" })])),
        job(41, "done", check([step("dns", "DNS resolution", { ms: 8, summary: "resolved to 1 address" }), step("tcp", "TCP connection", { ms: 1234 })], { finished: true, ok: true }), "2026-10-12T10:00:05+00:00"),
      ),
    });
    renderWithProviders(<ConnectionCheck sourceId={5} />);
    await userEvent.click(run());
    expect(await screen.findByText("Queued: waiting for the collector to start the check.")).toBeInTheDocument();
    expect(await screen.findByText("DNS resolution", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText("8 ms")).toBeInTheDocument();
    expect(screen.getByText("Running…")).toBeInTheDocument();
    expect(screen.queryByText("TCP connection")).not.toBeInTheDocument(); // not reported yet
    expect(await screen.findByText("TCP connection", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText("1.2 s")).toBeInTheDocument();
    expect(screen.getByText("Every step passed.")).toBeInTheDocument();
    expect(screen.getByText("Checked at 2026-10-12 10:00:05")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/api/sources/5/check"]);
  }, 15_000);

  it("shows a failed step in full: the exact error and its hint, with the steps that did not run muted", async () => {
    mockFetch({
      ...auth(),
      "POST /api/sources/5/check": { status: 202, body: { job_id: 42 } },
      "GET /api/jobs/42": job(42, "done", check([
        step("dns", "DNS resolution"),
        step("tcp", "TCP connection", { ok: false, ms: null, summary: "refused", error: { class: "ConnectionRefusedError", status_name: null, status_hex: null, message: "[Errno 111] refused" }, hint: "Nothing listens on that port: ask the network team for the port." }),
        step("endpoints", "Server endpoints", { ok: null, ms: null, summary: "skipped: tcp failed" }),
      ], { finished: true, ok: false, first_failed: "tcp" }), "2026-10-12T10:00:05+00:00"),
    });
    renderWithProviders(<ConnectionCheck sourceId={5} />);
    await userEvent.click(run());
    expect(await screen.findByText("The check failed at: TCP connection.")).toBeInTheDocument();
    const steps = within(screen.getByRole("list", { name: "Check steps" })).getAllByRole("listitem");
    expect(steps.map((li) => li.getAttribute("data-state"))).toEqual(["ok", "failed", "skipped"]);
    expect(within(steps[1]).getByText("ConnectionRefusedError: [Errno 111] refused")).toHaveClass("error");
    expect(within(steps[1]).getByText("Nothing listens on that port: ask the network team for the port.")).toBeInTheDocument();
    expect(within(steps[1]).getByText("(failed)")).toHaveClass("sr-only");
    expect(within(steps[2]).getByText("skipped: tcp failed")).toHaveClass("muted");
    expect(within(steps[2]).queryByText(/ms$/)).not.toBeInTheDocument();
  });

  it("follows the check that is already running when the answer is 409, and says it is queued while the collector has not started it", async () => {
    const calls = mockFetch({
      ...auth(),
      "POST /api/sources/5/check": { status: 409, body: { detail: "a connection check is already running for this source", job_id: 40 } },
      "GET /api/jobs/40": sequence(
        job(40, "pending", null),
        job(40, "running", check([step("dns", "DNS resolution")])),
      ),
    });
    renderWithProviders(<ConnectionCheck sourceId={5} />);
    await userEvent.click(run());
    expect(await screen.findByText("A connection check for this source is already queued. It is shown here.")).toBeInTheDocument();
    expect(await screen.findByText("A connection check for this source is already running. It is shown here.", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText("DNS resolution")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // a plain sentence, not a fault
    expect(calls.some((c) => c.path === "/api/jobs/40")).toBe(true);
    expect(run()).toBeDisabled(); // it is running: no second request
  }, 15_000);

  it("shows the 429 answer as a plain sentence and polls nothing", async () => {
    const calls = mockFetch({
      ...auth(),
      "POST /api/sources/5/check": { status: 429, body: { detail: "a connection check for this source finished a moment ago; try again in a few seconds" } },
    });
    renderWithProviders(<ConnectionCheck sourceId={5} />);
    await userEvent.click(run());
    expect(await screen.findByText("A connection check for this source finished a moment ago; try again in a few seconds.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith("/api/jobs/"))).toBe(false);
    expect(run()).toBeEnabled();
  });

  it("shows another refusal as an error", async () => {
    mockFetch({ ...auth(), "POST /api/sources/5/check": { status: 404, body: { detail: "source not found" } } });
    renderWithProviders(<ConnectionCheck sourceId={5} />);
    await userEvent.click(run());
    expect(await screen.findByRole("alert")).toHaveTextContent("source not found");
  });

  it("reports a failed job by its error, not by steps", async () => {
    mockFetch({
      ...auth(),
      "POST /api/sources/5/check": { status: 202, body: { job_id: 43 } },
      "GET /api/jobs/43": job(43, "failed", { error: "collector restarted" }, "2026-10-12T10:00:05+00:00"),
    });
    renderWithProviders(<ConnectionCheck sourceId={5} />);
    await userEvent.click(run());
    expect(await screen.findByRole("alert")).toHaveTextContent("The check failed: collector restarted");
    expect(screen.queryByRole("list", { name: "Check steps" })).not.toBeInTheDocument();
    expect(run()).toBeEnabled();
  });

  it("offers the sources when none is fixed, and checks the one chosen", async () => {
    const calls = mockFetch({
      ...auth(),
      "POST /api/sources/6/check": { status: 202, body: { job_id: 44 } },
      "GET /api/jobs/44": job(44, "done", check([step("dns", "DNS resolution")], { finished: true, ok: true }), "2026-10-12T10:00:05+00:00"),
    });
    renderWithProviders(<ConnectionCheck />);
    const select = await screen.findByRole("combobox", { name: "Source" });
    await waitFor(() => expect(select).toHaveValue("5")); // the first source is chosen to begin with
    await userEvent.selectOptions(select, "Backup");
    await userEvent.click(run());
    expect(await screen.findByText("Every step passed.")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/api/sources/6/check"]);
  });

  it("clears the shown check when another source is chosen", async () => {
    mockFetch({
      ...auth(),
      "POST /api/sources/5/check": { status: 202, body: { job_id: 45 } },
      "GET /api/jobs/45": job(45, "done", check([step("dns", "DNS resolution")], { finished: true, ok: true }), "2026-10-12T10:00:05+00:00"),
    });
    renderWithProviders(<ConnectionCheck />);
    const select = await screen.findByRole("combobox", { name: "Source" });
    await waitFor(() => expect(select).toHaveValue("5"));
    await userEvent.click(run());
    expect(await screen.findByText("DNS resolution")).toBeInTheDocument();
    await userEvent.selectOptions(select, "Backup");
    expect(screen.queryByText("DNS resolution")).not.toBeInTheDocument();
  });

  it("with no sources there is nothing to run", async () => {
    mockFetch({ ...auth(), "GET /api/sources": { body: [] } });
    renderWithProviders(<ConnectionCheck />);
    expect(await screen.findByRole("option", { name: "No sources yet" })).toBeInTheDocument();
    expect(run()).toBeDisabled();
  });

  it("starts by itself once with autoStart, also under StrictMode", async () => {
    const calls = mockFetch({
      ...auth(),
      "POST /api/sources/5/check": { status: 202, body: { job_id: 46 } },
      "GET /api/jobs/46": job(46, "done", check([step("dns", "DNS resolution")], { finished: true, ok: true }), "2026-10-12T10:00:05+00:00"),
    });
    renderWithProviders(<StrictMode><ConnectionCheck sourceId={5} autoStart /></StrictMode>);
    expect(await screen.findByText("Every step passed.")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("keeps one live region from the start, so the first step is announced when it is added", async () => {
    mockFetch({
      ...auth(),
      "POST /api/sources/5/check": { status: 202, body: { job_id: 47 } },
      "GET /api/jobs/47": job(47, "done", check([step("test", "Connection test")], { finished: true, ok: true }), "2026-10-12T10:00:05+00:00"),
    });
    const { container } = renderWithProviders(<ConnectionCheck sourceId={5} />);
    const region = container.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region!.querySelector("ol")).toBeNull(); // nothing in it yet
    await userEvent.click(run());
    const list = await screen.findByRole("list", { name: "Check steps" });
    expect(container.querySelector('[aria-live="polite"]')).toBe(region); // the same element, now holding the step
    expect(region!.contains(list)).toBe(true);
  });

  it("has no select for a fixed source", async () => {
    mockFetch(auth());
    renderWithProviders(<ConnectionCheck sourceId={5} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
