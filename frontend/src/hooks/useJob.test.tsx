import { screen } from "@testing-library/react";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { JobStatus } from "../components/JobStatus";

const auth = { "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "o", role: "operator" } } };
const job = (status: string, result: unknown) => ({ id: 5, kind: "test_source", status, result, created_at: "t", finished_at: null });

describe("JobStatus", () => {
  it("polls until done and shows status", async () => {
    let polls = 0;
    mockFetch({ ...auth, "GET /api/jobs/5": () => ({ body: ++polls < 3 ? job("running", null) : job("done", { ok: true, status: "ok", latency_ms: 12, message: "" }) }) });
    renderWithProviders(<JobStatus jobId={5} />);
    expect(await screen.findByText("running…")).toBeInTheDocument();
    expect(await screen.findByText(/ok/, {}, { timeout: 5000 })).toBeInTheDocument();
    const settled = polls;
    await new Promise((r) => setTimeout(r, 1500));
    expect(polls).toBe(settled);
  }, 10_000);

  it("stops polling after the cap and reports the job as still running", async () => {
    let polls = 0;
    mockFetch({ ...auth, "GET /api/jobs/5": () => { polls++; return { body: job("running", null) }; } });
    renderWithProviders(<JobStatus jobId={5} maxWaitMs={1500} />);
    expect(await screen.findByText("running…")).toBeInTheDocument();
    expect(await screen.findByText(/still running/, {}, { timeout: 5000 })).toBeInTheDocument();
    const settled = polls;
    await new Promise((r) => setTimeout(r, 1500));
    expect(polls).toBe(settled);
  }, 10_000);

  it("shows error from failed job", async () => {
    mockFetch({ ...auth, "GET /api/jobs/5": { body: job("failed", { error: "collector restarted" }) } });
    renderWithProviders(<JobStatus jobId={5} />);
    expect(await screen.findByText(/collector restarted/)).toHaveClass("error");
  });
});
