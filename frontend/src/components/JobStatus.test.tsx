import { screen } from "@testing-library/react";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { userFor } from "../test/users";
import { JobStatus } from "./JobStatus";

const auth = { "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: userFor("operator", { username: "o" }) } };
const browse = (result: unknown, status = "done") => ({ id: 7, kind: "browse_source", status, result, created_at: "t", finished_at: "t" });
const check = (result: unknown) => ({ id: 8, kind: "test_source", status: "done", result, created_at: "t", finished_at: "t" });

async function shown(job: unknown, jobId = 7) {
  mockFetch({ ...auth, [`GET /api/jobs/${jobId}`]: { body: job } });
  renderWithProviders(<JobStatus jobId={jobId} />);
}

describe("JobStatus (w34 browse line)", () => {
  it("says found N points for a small browse", async () => {
    await shown(browse({ count: 60, matched_stored: 0, ambiguous: 0 }));
    expect(await screen.findByText("found 60 points")).toBeInTheDocument();
  });

  it("puts a thousands separator on a large count", async () => {
    await shown(browse({ count: 15180, matched_stored: 15000, ambiguous: 0 }));
    expect(await screen.findByText("found 15,180 points")).toBeInTheDocument();
  });

  it("reads an old result without a count as zero points", async () => {
    await shown(browse({}));
    expect(await screen.findByText("found 0 points")).toBeInTheDocument();
  });

  it("adds the ambiguous clause when tags match two stored points", async () => {
    await shown(browse({ count: 15180, matched_stored: 15000, ambiguous: 3 }));
    expect(await screen.findByText("found 15,180 points; 3 tags match two stored points and were left as they are")).toBeInTheDocument();
  });

  it("uses the singular for one ambiguous tag", async () => {
    await shown(browse({ count: 12, matched_stored: 10, ambiguous: 1 }));
    expect(await screen.findByText("found 12 points; 1 tag matches two stored points and was left as it is")).toBeInTheDocument();
  });

  it("leaves the clause out when nothing is ambiguous or the field is absent", async () => {
    await shown(browse({ count: 5, ambiguous: 0 }));
    const line = await screen.findByText("found 5 points");
    expect(line.textContent).not.toMatch(/match/);
  });

  it("still shows a failed browse as an error", async () => {
    await shown(browse({ error: "no route" }, "failed"));
    expect(await screen.findByText(/failed: no route/)).toHaveClass("error");
  });

  it("still shows a Test line with its message", async () => {
    await shown(check({ ok: true, status: "ok", latency_ms: 12, message: "10 of 10 tags read the same both ways" }), 8);
    expect(await screen.findByText("ok 12 ms — 10 of 10 tags read the same both ways")).toHaveClass("st-ok");
  });
});
