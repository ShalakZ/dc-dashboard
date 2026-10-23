import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ShapeDecision, ShapeLinesAnswer } from "../../api/shapes";
import { holdFetch } from "../../test/holdFetch";
import { mockFetch } from "../../test/fetchMock";
import { check, created, linesAnswer, report } from "../../test/shapesFixtures";
import { spyToasts } from "../../test/toasts";
import { ReviewShapesDialog } from "./ReviewShapesDialog";

const LINES = "POST /api/sources/5/shapes/lines";
const TAGLIST = "POST /api/sources/5/tag-list";
const UNDO = "POST /api/tag-lists/91/undo";
const DECISIONS: ShapeDecision[] = [{ shape: "pdua#_pm#_penrg", metric: "energy_kwh", name_from: "part1" }];

type Seen = { url: string; body: unknown };
interface Setup {
  lines?: ShapeLinesAnswer | ((call: Seen) => { status?: number; body?: unknown });
  tagList?: (call: Seen) => { status?: number; body?: unknown };
  createAssets?: boolean;
  parentId?: number | null;
  parentLabel?: string | null;
  /** Hold the lines call until `release()` (the dialog is asked, the answer comes later). */
  holdLines?: boolean;
}

/** The dialog over a mocked server; an opener button holds the focus first, as the page's Review button does. */
function setup({ lines = linesAnswer(), tagList, createAssets = true, parentId = 1, parentLabel = "Hall 1", holdLines = false }: Setup = {}) {
  const toasts = spyToasts();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const refreshed = vi.spyOn(client, "invalidateQueries");
  const onClose = vi.fn();
  const onMapped = vi.fn();
  const linesSeen: Seen[] = [];
  const listSeen: Seen[] = [];
  const calls = mockFetch({
    [LINES]: (call) => { linesSeen.push(call); return typeof lines === "function" ? lines(call) : { body: lines }; },
    [TAGLIST]: (call) => {
      listSeen.push(call);
      return (tagList ?? ((c) => ({ body: c.url.includes("dry_run=1") ? report() : created() })))(call);
    },
    [UNDO]: { body: { mappings: 400, assets: 398, points_removed: 0, points_kept: 0 } },
  });
  const hold = holdLines ? holdFetch((method, path) => method === "POST" && path === "/api/sources/5/shapes/lines") : null;
  const shell = document.createElement("div");
  shell.className = "shell";
  const opener = document.createElement("button");
  opener.textContent = "Review 400 mappings...";
  shell.append(opener);
  document.body.append(shell);
  opener.focus();
  const ui = () => (
    <QueryClientProvider client={client}>
      {toasts.wrap(
        <ReviewShapesDialog
          sourceId={5} sourceName="Plant SCADA" decisions={DECISIONS} parentId={parentId} parentLabel={parentLabel} createAssets={createAssets}
          labelOf={(key) => key} onClose={onClose} onMapped={onMapped}
        />,
      )}
    </QueryClientProvider>
  );
  const view = render(ui());
  const dialog = () => screen.getByRole("dialog");
  const map = () => within(dialog()).getByRole("button", { name: /^Map / });
  const refreshedKeys = () => refreshed.mock.calls.map(([filters]) => (filters as { queryKey: readonly unknown[] }).queryKey[0]);
  return { ...view, dialog, map, shell, opener, onClose, onMapped, linesSeen, listSeen, toasts, calls, refreshedKeys, hold };
}

/** Waits until the planner's report is on screen (lines and dry run are done). */
const loaded = () => screen.findByText("What the tag list planner says");

afterEach(() => {
  cleanup();
  document.querySelectorAll(".shell").forEach((el) => el.remove());
});

describe("ReviewShapesDialog: what it asks", () => {
  it("opens with focus on Cancel, named for the source, and sends the decisions, the parent and the option to the lines route", async () => {
    const { dialog, linesSeen } = setup();
    expect(dialog()).toHaveAccessibleName("Review mappings by shape: Plant SCADA");
    expect(within(dialog()).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await loaded();
    expect(linesSeen).toHaveLength(1);
    expect(linesSeen[0].body).toEqual({ decisions: DECISIONS, parent_id: 1, create_assets: true });
    expect(dialog()).toHaveTextContent("New assets go under Hall 1");
  });

  it("says where new assets go at the top level, and that a missing asset is a problem without the option", async () => {
    const { dialog } = setup({ parentId: null, parentLabel: null, createAssets: false });
    await loaded();
    expect(dialog()).toHaveTextContent("New assets go at the top level, and an asset that is missing is a problem");
  });

  it("makes the page behind inert while it is open and gives it back with the focus when it goes away", async () => {
    const { shell, opener, onClose, rerender } = setup();
    expect(shell).toHaveAttribute("inert");
    await loaded();
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<p>gone</p>);
    expect(shell).not.toHaveAttribute("inert");
    expect(opener).toHaveFocus();
  });
});

describe("ReviewShapesDialog: what it shows", () => {
  it("shows per shape the counts, the samples and the planner's own report", async () => {
    const { dialog } = setup();
    await loaded();
    const d = dialog();
    expect(within(d).getByRole("heading", { name: "PDUA#_PM0_PENRG" })).toBeInTheDocument();
    expect(d).toHaveTextContent("400 tags on 400 assets, 12 already mapped, left as they are");
    const samples = within(d).getAllByRole("row").filter((row) => row.textContent?.includes("PDUA01_PM0_PENRG"));
    expect(samples).toHaveLength(1);
    expect(samples[0]).toHaveTextContent("Hall 1/PDUA01");
    expect(samples[0]).toHaveTextContent("kWh");
    expect(samples[0]).toHaveTextContent("energy_kwh");
    expect(d).toHaveTextContent("Would create 400 mappings and 398 assets");
    expect(within(d).getByText("Mappings to create").nextSibling).toHaveTextContent("400");
    expect(d).toHaveTextContent("2 tags go onto assets that already exist."); // 400 lines less 398 assets to create
  });

  it("says nothing about assets that exist when every tag brings a new one", async () => {
    const { dialog } = setup({ tagList: (c) => ({ body: c.url.includes("dry_run=1") ? report({ assets_to_create_total: 800 }) : created() }) });
    await loaded();
    expect(dialog()).not.toHaveTextContent("go onto assets that already exist");
  });

  it("sends the CSV to the tag-list route as a dry run, as text/csv, with the option", async () => {
    const { listSeen, calls } = setup({ createAssets: false });
    await loaded();
    expect(listSeen).toHaveLength(1);
    expect(listSeen[0].url).toContain("/api/sources/5/tag-list?dry_run=1&create_assets=0");
    expect(listSeen[0].body).toBe(linesAnswer().csv);
    const sent = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes("tag-list"))!;
    expect((sent[1]!.headers as Record<string, string>)["content-type"]).toBe("text/csv");
    expect(calls.map((c) => c.path)).toEqual(["/api/sources/5/shapes/lines", "/api/sources/5/tag-list"]);
  });

  it("shows warnings in the warning style and keeps Map open", async () => {
    const { dialog, map } = setup({ lines: linesAnswer({ checks: [check()] }) });
    await loaded();
    const item = within(dialog()).getByText(/198 of 200 like PDUA01 have this tag; PDUA17 and PDUA44 do not/);
    expect(item.closest("li")).toHaveAttribute("data-severity", "warning");
    expect(item.closest("li")).toHaveTextContent("Warning");
    expect(map()).not.toHaveAttribute("aria-disabled");
  });

  it("names the shape of a check by the label the answer gives it", async () => {
    const { dialog } = setup({ lines: linesAnswer({ checks: [check()] }) });
    await loaded();
    expect(within(dialog()).getByText(/198 of 200/).closest("li")).toHaveTextContent("PDUA#_PM0_PENRG");
  });
});

describe("ReviewShapesDialog: what stops it", () => {
  const blocked = () => linesAnswer({
    csv: "", lines: 0, blocking: true,
    checks: [check({ kind: "collision", severity: "blocking", text: '3 tags of this shape would land on each asset (PDUA01 gets PL1, PL2, PL3); choose "parts 1 and 2" or map them as custom' })],
  });

  it("a blocking check is shown in the error style, Map is aria-disabled, and the tag-list route is never called", async () => {
    const { dialog, map, listSeen } = setup({ lines: blocked() });
    await within(dialog()).findByText(/3 tags of this shape would land on each asset/);
    const item = within(dialog()).getByText(/3 tags of this shape would land/).closest("li")!;
    expect(item).toHaveAttribute("data-severity", "blocking");
    expect(item).toHaveTextContent("Blocking");
    expect(map()).toHaveAttribute("aria-disabled", "true");
    expect(map()).not.toBeDisabled();
    expect(dialog()).toHaveTextContent("Some checks block this");
    await userEvent.click(map());
    expect(listSeen).toHaveLength(0);
  });

  it("a planner problem stops Map and shows the problem line", async () => {
    const problem = report({ ok: false, problems: [{ line: 3, tag: "ns=3;s=1:Site.X", reason: "the asset already has this metric" }], problems_total: 1 });
    const { dialog, map, listSeen } = setup({ tagList: () => ({ body: problem }) });
    await loaded();
    expect(dialog()).toHaveTextContent("the asset already has this metric");
    expect(map()).toHaveAttribute("aria-disabled", "true");
    expect(dialog()).toHaveTextContent("The tag list planner found problems");
    await userEvent.click(map());
    expect(listSeen).toHaveLength(1); // the dry run only
  });

  it("everything mapped already: nothing to map, no dry run", async () => {
    const { dialog, map, listSeen } = setup({ lines: linesAnswer({ csv: "", lines: 0, by_shape: [{ shape: "pdua#_pm#_penrg", label: "PDUA#_PM0_PENRG", lines: 0, assets: 0, skipped_mapped: 200, skipped_twins: 0 }], samples: [] }) });
    await within(dialog()).findByText("Nothing is left to map: every tag of these shapes is mapped already.");
    expect(map()).toHaveAttribute("aria-disabled", "true");
    expect(listSeen).toHaveLength(0);
  });

  it("a failed lines call shows the server's sentence and leaves Map closed", async () => {
    const { dialog, map } = setup({ lines: () => ({ status: 422, body: { detail: "decisions: at most 60" } }) });
    await within(dialog()).findByText(/decisions: at most 60/);
    expect(map()).toHaveAttribute("aria-disabled", "true");
  });

  it("waits with aria-disabled, never native disabled, while the calls are in flight", async () => {
    const { dialog, map } = setup();
    expect(map()).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog()).getByRole("status")).toHaveTextContent("Asking the server what these decisions would map...");
    await loaded();
    expect(within(dialog()).getAllByRole("button").some((button) => (button as HTMLButtonElement).disabled)).toBe(false);
    expect(map()).not.toHaveAttribute("aria-disabled");
  });
});

describe("ReviewShapesDialog: Map", () => {
  it("makes the real run with the numbers and the digest of the dry run, shows the Undo toast, reads the lists again and closes", async () => {
    const { map, listSeen, toasts, onMapped, onClose, refreshedKeys } = setup({ lines: linesAnswer({ checks: [check()] }) });
    await loaded();
    expect(map()).toHaveTextContent("Map 400 points");
    await userEvent.click(map());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(listSeen).toHaveLength(2);
    const real = new URL(`http://x${listSeen[1].url}`);
    expect(real.pathname).toBe("/api/sources/5/tag-list");
    expect(Object.fromEntries(real.searchParams)).toEqual({
      dry_run: "0", create_assets: "1", expect_points: "0", expect_assets: "398", expect_mappings: "400", expect_plan: "digest-1",
    });
    expect(listSeen[1].body).toBe(linesAnswer().csv);
    expect(onMapped).toHaveBeenCalledTimes(1);
    expect(toasts.calls).toHaveLength(1);
    expect(toasts.calls[0].kind).toBe("success");
    expect(toasts.calls[0].text).toBe("Created 400 mappings. Check: 198 of 200 like PDUA01 have this tag; PDUA17 and PDUA44 do not.");
    expect(toasts.calls[0].options?.action?.label).toBe("Undo");
    expect(refreshedKeys()).toEqual(expect.arrayContaining(["sources", "assets", "graph"]));
  });

  it("the Undo of the toast calls the undo route and reads the lists again", async () => {
    const { map, toasts, calls, refreshedKeys, onClose } = setup();
    await loaded();
    await userEvent.click(map());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const before = refreshedKeys().length;
    act(() => toasts.calls[0].options!.action!.onAction());
    await waitFor(() => expect(calls.some((c) => c.path === "/api/tag-lists/91/undo")).toBe(true));
    await waitFor(() => expect(toasts.calls).toHaveLength(2));
    expect(toasts.calls[1].text).toMatch(/Removed 400 mappings/);
    expect(refreshedKeys().length).toBeGreaterThan(before);
  });

  it("while the real run is in flight Map and Cancel wait, Escape closes nothing, and the dialog stays", async () => {
    const { map, dialog, onClose, linesSeen } = setup();
    await loaded();
    const hold = holdFetch((method, path) => method === "POST" && path === "/api/sources/5/tag-list" && vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("dry_run=0")));
    await userEvent.click(map());
    await waitFor(() => expect(map()).toHaveAttribute("aria-disabled", "true"));
    expect(within(dialog()).getByRole("status")).toHaveTextContent("Mapping the tags...");
    expect(within(dialog()).getByRole("button", { name: "Cancel" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(linesSeen).toHaveLength(1);
    hold.release();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("a second press while the run is in flight does not send a second run", async () => {
    const { map, listSeen, onClose } = setup();
    await loaded();
    const hold = holdFetch((method, path) => method === "POST" && path === "/api/sources/5/tag-list" && vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("dry_run=0")));
    await userEvent.click(map());
    await userEvent.click(map());
    hold.release();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(listSeen.filter((c) => c.url.includes("dry_run=0"))).toHaveLength(1);
  });

  it("reads the lists again after a failure too", async () => {
    const { map, dialog, refreshedKeys, onClose } = setup({ tagList: (c) => (c.url.includes("dry_run=1") ? { body: report() } : { status: 500, body: { detail: "the database is busy" } }) });
    await loaded();
    await userEvent.click(map());
    await within(dialog()).findByText(/the database is busy/);
    expect(refreshedKeys()).toEqual(expect.arrayContaining(["sources", "assets", "graph"]));
    expect(onClose).not.toHaveBeenCalled();
    expect(map()).not.toHaveAttribute("aria-disabled"); // the dry run still stands: the person may try again
  });

  it("a 409 shows the server's sentence and reads the lines and the dry run again", async () => {
    let real = 0;
    const { map, dialog, linesSeen, listSeen, onClose, toasts } = setup({
      tagList: (c) => {
        if (c.url.includes("dry_run=1")) return { body: report() };
        real += 1;
        return { status: 409, body: { detail: "the list changed since the check: it now creates 399 mappings", points: 0, assets: 397, mappings: 399 } };
      },
    });
    await loaded();
    await userEvent.click(map());
    await waitFor(() => expect(linesSeen).toHaveLength(2));
    expect(await within(dialog()).findByText(/the list changed since the check: it now creates 399 mappings/)).toBeInTheDocument();
    expect(within(dialog()).getByRole("status")).toHaveTextContent("check the new numbers before you press Map");
    await waitFor(() => expect(listSeen.filter((c) => c.url.includes("dry_run=1"))).toHaveLength(2));
    expect(real).toBe(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(toasts.calls).toHaveLength(0);
  });
});

describe("ReviewShapesDialog: the frame", () => {
  it("closes on Escape, and only this dialog (the opener keeps the focus afterwards)", async () => {
    const { onClose, dialog } = setup();
    await loaded();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeInTheDocument(); // the page owns the unmounting
  });

  it("wraps Tab from the last control to the first and Shift+Tab back", async () => {
    const { dialog, map } = setup();
    await loaded();
    const first = within(dialog()).getByRole("button", { name: "Cancel" });
    map().focus();
    await userEvent.tab();
    const controls = Array.from(dialog().querySelectorAll<HTMLElement>('button, [tabindex="0"]'));
    expect(document.activeElement).toBe(controls[0]);
    controls[0].focus();
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(controls[controls.length - 1]);
    expect(first).toBeInTheDocument();
  });

  it("pulls a focus that lands behind the dialog back in", async () => {
    const { dialog, opener } = setup();
    await loaded();
    opener.focus();
    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it("every button is type=button, there is one live region, and the result box is a named tab stop", async () => {
    const { dialog } = setup();
    await loaded();
    for (const button of within(dialog()).getAllByRole("button")) expect(button).toHaveAttribute("type", "button");
    expect(within(dialog()).getAllByRole("status")).toHaveLength(1);
    expect(within(dialog()).getByRole("region", { name: "Result of the review" })).toHaveAttribute("tabindex", "0");
  });

  it("ignores an answer that arrives after the dialog has gone: no dry run is sent and nothing is shown", async () => {
    const { unmount, hold, listSeen, linesSeen } = setup({ holdLines: true });
    unmount();
    hold!.release();
    await waitFor(() => expect(linesSeen).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listSeen).toHaveLength(0);
  });
});
