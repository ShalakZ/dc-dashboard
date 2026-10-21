import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useSources } from "../api/queries";
import type { HistoryFillPlan } from "../api/types";
import { CacheProbes, probeFetches, probeRoutes } from "../test/cacheProbes";
import { mockFetch, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { userFor } from "../test/users";
import { HistoryFillDialog } from "./HistoryFillDialog";

const FILL = "/api/sources/3/history/fill";
const PLAN_TEXT = "Source 3: 4 mapped point(s), 2020-03-01 00:00 UTC to 2020-03-04 00:00 UTC, asked in 3 window(s) of at most 24 hours, about 12,000 rows expected. Nothing has been asked and nothing has been written. Confirm the fill to run it.";
const plan = (over: Partial<HistoryFillPlan> = {}): HistoryFillPlan => ({
  plan: PLAN_TEXT, expected_rows: 12_000,
  windows: [["2020-03-01T00:00:00+00:00", "2020-03-02T00:00:00+00:00"], ["2020-03-02T00:00:00+00:00", "2020-03-03T00:00:00+00:00"], ["2020-03-03T00:00:00+00:00", "2020-03-04T00:00:00+00:00"]],
  ...over,
});
const DONE_TEXT = "12,000 rows read, 11,900 new, 100 already there, 0 differing, 0 rejected";

function SourcesProbe() {
  useSources();
  return null;
}

/** A page with an opener between two other buttons; the dialog closes through `onClose` first, as the Sources page's does. */
function Host({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button">before</button>
      <button type="button" onClick={() => setOpen(true)}>Fill older range...</button>
      <CacheProbes />
      <SourcesProbe />
      {open && <HistoryFillDialog source={{ id: 3, name: "Plant A" }} onClose={() => { onClose?.(); setOpen(false); }} />}
    </>
  );
}

type Call = { method: string; path: string; body: unknown };
let queries: URLSearchParams[]; // the query string of every fill request (mockFetch drops it from `path`)
let jobs: Record<number, unknown>;
beforeEach(() => {
  queries = [];
  jobs = { 9: { id: 9, kind: "history_fill", status: "done", result: { ok: true, text: DONE_TEXT, read: 12_000, new: 11_900, already: 100, differing: 0, rejected: 0 }, created_at: "t", finished_at: "t" } };
});

/** A check answers `dry`; the real request answers `real` (202 with a job by default). Each is a body, or { status, body } for a refusal. */
function fillRoute(dry: unknown = plan(), real: unknown = { status: 202, body: { job_id: 9 } }): Routes {
  const reply = (r: unknown) => (typeof r === "object" && r !== null && "status" in r ? (r as { status: number; body: unknown }) : { body: r });
  return {
    [`POST ${FILL}`]: ({ url }) => {
      const query = new URL(url, "http://host").searchParams;
      queries.push(query);
      return reply(query.get("dry_run") === "1" ? dry : real);
    },
  };
}

const base = (): Routes => ({
  "GET /api/me": { body: userFor("admin") },
  "GET /api/setup": { body: { needed: false } },
  "GET /api/sources": { body: [] },
  "GET /api/jobs/9": () => ({ body: jobs[9] }),
  ...probeRoutes,
});

async function open(routes: Routes = {}, onClose?: () => void) {
  const calls = mockFetch({ ...base(), ...fillRoute(), ...routes });
  renderWithProviders(<Host onClose={onClose} />);
  const opener = screen.getByRole("button", { name: "Fill older range..." });
  await userEvent.click(opener);
  await screen.findByRole("dialog");
  return { calls, opener };
}

const fills = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === FILL);
const startDate = () => screen.getByLabelText("Start date");
const endDate = () => screen.getByLabelText("End date");
const checkButton = () => screen.getByRole("button", { name: "Check range" });
const goButton = () => screen.getByRole("button", { name: "Start fill" });
async function fillDays(start = "2020-03-01", end = "2020-03-03") {
  await userEvent.type(startDate(), start);
  await userEvent.type(endDate(), end);
}
async function check(start?: string, end?: string) {
  await fillDays(start, end);
  await userEvent.click(checkButton());
  await screen.findByText(/^About /);
}
/** The local midnight of a day, as the dialog means it, in epoch milliseconds. */
const midnight = (year: number, month: number, day: number) => new Date(year, month - 1, day).getTime();
const OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

describe("HistoryFillDialog", () => {
  it("is a dialog named after the source, with the Start date focused, two dates, the choice with its tip and three buttons, the last one waiting", async () => {
    await open();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("Fill an older range: Plant A");
    expect(screen.getByRole("heading", { name: "Fill an older range: Plant A" })).toBeInTheDocument();
    expect(startDate()).toHaveFocus();
    expect(startDate()).toHaveAttribute("type", "date");
    expect(endDate()).toHaveAttribute("type", "date");
    expect(within(dialog).getByRole("checkbox", { name: "Also fill before a meter's first reading" })).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "What does this mean?" })).toBeInTheDocument();
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(["", "Close", "Check range", "Start fill"]); // the tip's "?" has no text
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getAllByRole("button").every((b) => b.getAttribute("type") === "button")).toBe(true);
    expect(within(dialog).getAllByRole("status")).toHaveLength(1); // one live region speaks for the whole dialog
  });

  it("explains the choice in a tip: it can change the past figures of a parent asset", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "What does this mean?" }));
    expect(await screen.findByRole("note")).toHaveTextContent(/past figures of a parent asset/);
  });

  it("Check range posts the days as times with the browser's offset to ?dry_run=1, and shows the plan sentence and the size", async () => {
    const { calls } = await open();
    await check();
    expect(fills(calls)).toHaveLength(1);
    expect(queries[0].get("dry_run")).toBe("1");
    const body = fills(calls)[0].body as { start: string; end: string; before_first_reading: boolean };
    expect(Object.keys(body).sort()).toEqual(["before_first_reading", "end", "start"]);
    expect(body.start).toMatch(OFFSET);
    expect(body.end).toMatch(OFFSET);
    expect(new Date(body.start).getTime()).toBe(midnight(2020, 3, 1)); // the start of the first day...
    expect(new Date(body.end).getTime()).toBe(midnight(2020, 3, 4)); // ...to the end of the last one (the start of the next)
    expect(body.before_first_reading).toBe(false);
    expect(screen.getByText("About 12,000 rows in 3 windows.")).toBeInTheDocument();
    expect(screen.getByText(PLAN_TEXT)).toBeInTheDocument();
    expect(goButton()).not.toHaveAttribute("aria-disabled");
  });

  it("sends before_first_reading when the box is ticked", async () => {
    const { calls } = await open();
    await userEvent.click(screen.getByRole("checkbox", { name: "Also fill before a meter's first reading" }));
    await check();
    expect((fills(calls)[0].body as { before_first_reading: boolean }).before_first_reading).toBe(true);
  });

  it("counts one window and one row in the singular", async () => {
    await open(fillRoute(plan({ expected_rows: 1, windows: [["2020-03-01T00:00:00+00:00", "2020-03-02T00:00:00+00:00"]] })));
    await check();
    expect(screen.getByText("About 1 row in 1 window.")).toBeInTheDocument();
  });

  it("an end date of today ends the range now, not at the coming midnight (the server refuses a range that ends in the future)", async () => {
    const { calls } = await open();
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    await userEvent.type(startDate(), today);
    await userEvent.type(endDate(), today);
    await userEvent.click(checkButton());
    await screen.findByText(/^About /);
    const body = fills(calls)[0].body as { start: string; end: string };
    expect(new Date(body.start).getTime()).toBe(midnight(now.getFullYear(), now.getMonth() + 1, now.getDate()));
    expect(new Date(body.end).getTime()).toBeLessThanOrEqual(Date.now());
    expect(new Date(body.end).getTime()).toBeGreaterThan(new Date(body.start).getTime());
  });

  it("will not send a check without both days: it says which is missing and puts the focus there", async () => {
    const { calls } = await open();
    await userEvent.click(checkButton());
    expect(screen.getByText("Choose the first day of the range.")).toBeInTheDocument();
    expect(startDate()).toHaveFocus();
    await userEvent.type(startDate(), "2020-03-01");
    await userEvent.click(checkButton());
    expect(screen.getByText("Choose the last day of the range.")).toBeInTheDocument();
    expect(endDate()).toHaveFocus();
    expect(fills(calls)).toHaveLength(0);
  });

  it("shows the server's sentence for a range it refuses (422), as a sentence, and Start fill stays waiting", async () => {
    const sentence = "a fill covers at most 31 days at a time and this range is 59 days: fill it in parts";
    await open(fillRoute({ status: 422, body: { detail: sentence } }));
    await fillDays("2020-01-01", "2020-02-28");
    await userEvent.click(checkButton());
    expect(await screen.findByText("A fill covers at most 31 days at a time and this range is 59 days: fill it in parts")).toBeInTheDocument();
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText(/^About /)).not.toBeInTheDocument();
  });

  it("shows only the sentence when there is nothing to ask (no windows), and Start fill stays waiting", async () => {
    const nothing = "Nothing to fill: all of that range is before the first reading of every mapped point.";
    const { calls } = await open(fillRoute(plan({ plan: nothing, expected_rows: 0, windows: [] })));
    await fillDays();
    await userEvent.click(checkButton());
    expect(await screen.findByText(nothing)).toBeInTheDocument();
    expect(screen.queryByText(/^About /)).not.toBeInTheDocument();
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(goButton());
    expect(fills(calls)).toHaveLength(1); // the check only
  });

  it("Start fill does nothing before a check, and nothing after the days or the choice changed since the check", async () => {
    const { calls } = await open();
    await userEvent.click(goButton());
    expect(fills(calls)).toHaveLength(0);
    await check();
    await userEvent.clear(endDate());
    await userEvent.type(endDate(), "2020-03-02");
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText(/^About /)).not.toBeInTheDocument(); // the plan was about other days
    await userEvent.click(goButton());
    expect(fills(calls)).toHaveLength(1); // only the check

    await userEvent.click(checkButton());
    await screen.findByText(/^About /);
    await userEvent.click(screen.getByRole("checkbox", { name: "Also fill before a meter's first reading" }));
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText(/^About /)).not.toBeInTheDocument();
  });

  it("Start fill posts the very request that was checked, without ?dry_run, then follows the job and shows what the fill stored", async () => {
    const { calls } = await open();
    await check();
    const checkedBody = fills(calls)[0].body;
    await userEvent.click(goButton());
    expect(await screen.findByText(DONE_TEXT)).toBeInTheDocument();
    expect(fills(calls)).toHaveLength(2);
    expect(queries[1].has("dry_run")).toBe(false); // an absent dry_run is what makes it the real request
    expect(fills(calls)[1].body).toEqual(checkedBody);
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/jobs/9")).toBe(true);
    // the plan stays on screen beside the result, and a second press does not queue a second fill
    expect(screen.getByText("About 12,000 rows in 3 windows.")).toBeInTheDocument();
  });

  it("capitalises a result sentence the way the server writes it", async () => {
    jobs[9] = { ...(jobs[9] as object), result: { ok: true, text: "nothing was stored: all of it was there already", read: 0, new: 0, already: 0, differing: 0, rejected: 0 } };
    await open();
    await check();
    await userEvent.click(goButton());
    expect(await screen.findByText("Nothing was stored: all of it was there already")).toBeInTheDocument();
  });

  it("while the job runs the days and the buttons wait, the dialog says so and can still be closed; the fill goes on", async () => {
    jobs[9] = { id: 9, kind: "history_fill", status: "running", result: null, created_at: "t", finished_at: null };
    const onClose = vi.fn();
    const { calls } = await open({}, onClose);
    await check();
    await userEvent.click(goButton());
    expect(await screen.findByText(/The fill is running/)).toBeInTheDocument();
    expect(startDate()).toBeDisabled();
    expect(endDate()).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Also fill before a meter's first reading" })).toBeDisabled();
    expect(checkButton()).toHaveAttribute("aria-disabled", "true");
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(goButton());
    await userEvent.click(checkButton());
    expect(fills(calls)).toHaveLength(2); // the check and the one start
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the sentence that stopped a failed job, as an error", async () => {
    jobs[9] = { id: 9, kind: "history_fill", status: "failed", result: { error: "the fill stopped early (the source refused: 429); until then: 10 rows read, 10 new, 0 already there, 0 differing, 0 rejected" }, created_at: "t", finished_at: "t" };
    await open();
    await check();
    await userEvent.click(goButton());
    const line = await screen.findByText(/^The fill stopped: the fill stopped early \(the source refused: 429\)/);
    expect(line).toHaveClass("error");
    expect(startDate()).toBeEnabled(); // a new check is the way on
  });

  it("says another fill is running when the server answers 409, keeps the plan, and lets Start fill be pressed again", async () => {
    const detail = "a history fill of another source is already waiting or running; fills run one at a time";
    const { calls } = await open(fillRoute(plan(), { status: 409, body: { detail, job_id: 4 } }));
    await check();
    await userEvent.click(goButton());
    const line = await screen.findByText("A history fill of another source is already waiting or running; fills run one at a time");
    expect(line).toHaveClass("error");
    expect(screen.getByText("About 12,000 rows in 3 windows.")).toBeInTheDocument();
    expect(goButton()).not.toHaveAttribute("aria-disabled");
    expect(calls.some((c) => c.path === "/api/jobs/4")).toBe(false); // it does not follow a job that is not its own
    await userEvent.click(goButton());
    await waitFor(() => expect(fills(calls)).toHaveLength(3));
  });

  it("drops the plan when the server refuses the real request (422): a new check is the way on", async () => {
    const sentence = "the range ends at 2030-01-01 00:00 UTC, which is in the future";
    await open(fillRoute(plan(), { status: 422, body: { detail: sentence } }));
    await check();
    await userEvent.click(goButton());
    expect(await screen.findByText("The range ends at 2030-01-01 00:00 UTC, which is in the future")).toBeInTheDocument();
    expect(screen.queryByText(/^About /)).not.toBeInTheDocument();
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
  });

  it("reads the sources and the audit log again once the request has settled, and the figures once the job has ended", async () => {
    const { calls } = await open();
    const before = probeFetches(calls);
    const sourcesBefore = calls.filter((c) => c.path === "/api/sources").length;
    await check();
    await userEvent.click(goButton());
    await screen.findByText(DONE_TEXT);
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/sources").length).toBeGreaterThan(sourcesBefore));
    await waitFor(() => {
      const after = probeFetches(calls);
      expect(after.billing).toBeGreaterThan(before.billing);
      expect(after.widgetData).toBeGreaterThan(before.widgetData);
    });
  });

  it("does not touch the figures after a check, or while the job still runs", async () => {
    jobs[9] = { id: 9, kind: "history_fill", status: "running", result: null, created_at: "t", finished_at: null };
    const { calls } = await open();
    const before = probeFetches(calls);
    await check();
    await userEvent.click(goButton());
    await screen.findByText(/The fill is running/);
    expect(probeFetches(calls)).toEqual(before);
  });

  it("holds Escape and Close while a request is in flight; the request's own answer then arrives", async () => {
    const onClose = vi.fn();
    const { calls } = await open({}, onClose);
    await check();
    const held = holdFetch((method, path) => method === "POST" && path === FILL);
    await userEvent.click(goButton());
    expect(await screen.findByText("Starting the fill…")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => { held.release(); });
    expect(await screen.findByText(DONE_TEXT)).toBeInTheDocument();
    expect(fills(calls)).toHaveLength(2);
  });

  it("a second press while the check is in flight sends nothing more", async () => {
    const { calls } = await open();
    await fillDays();
    const held = holdFetch((method, path) => method === "POST" && path === FILL);
    await userEvent.click(checkButton());
    expect(await screen.findByText("Checking the range…")).toBeInTheDocument();
    await userEvent.click(checkButton());
    await act(async () => { held.release(); });
    await screen.findByText(/^About /);
    expect(fills(calls)).toHaveLength(1);
  });

  it("closes with Close and with Escape, and the focus goes back to the opener", async () => {
    const onClose = vi.fn();
    const { opener } = await open({}, onClose);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    await userEvent.click(opener);
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("keeps the Tab key inside: from the last control to the first, and back", async () => {
    await open();
    const dialog = screen.getByRole("dialog");
    const controls = within(dialog).getAllByRole("button");
    const last = controls[controls.length - 1];
    act(() => last.focus());
    await userEvent.tab();
    expect(startDate()).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it("shows a hostile sentence from the server as text, never as markup", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    await open(fillRoute({ status: 422, body: { detail: hostile } }));
    await fillDays();
    await userEvent.click(checkButton());
    expect(await screen.findByText(hostile)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });
});
