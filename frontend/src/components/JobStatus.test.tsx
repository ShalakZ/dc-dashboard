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

  it("adds the ambiguous clause, in plain words, when tags were left as they are, and the line takes the warning shape instead of the ok one", async () => {
    await shown(browse({ count: 15180, matched_stored: 15000, ambiguous: 15023 }));
    const line = await screen.findByText("found 15,180 points; 15,023 tags were left as they are (the same stable address was found more than once)");
    expect(line).toHaveClass("job", "st", "st-warn");
    expect(line).not.toHaveClass("st-ok");
  });

  it("uses the singular for one ambiguous tag, in the warning shape too", async () => {
    await shown(browse({ count: 12, matched_stored: 10, ambiguous: 1 }));
    const line = await screen.findByText("found 12 points; 1 tag was left as it is (the same stable address was found more than once)");
    expect(line).toHaveClass("st-warn");
  });

  it("keeps the ok shape for a browse that left nothing alone", async () => {
    await shown(browse({ count: 60, matched_stored: 0, ambiguous: 0 }));
    expect(await screen.findByText("found 60 points")).toHaveClass("st-ok");
  });

  it("leaves the clause out when nothing is ambiguous or the field is absent", async () => {
    await shown(browse({ count: 5, ambiguous: 0 }));
    const line = await screen.findByText("found 5 points");
    expect(line.textContent).not.toMatch(/left as|stable address/);
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
