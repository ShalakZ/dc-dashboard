import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { TagListReport } from "../api/types";
import { UNIT_LABELS, UNIT_SCALES } from "../lib/unitFit";
import { holdFetch } from "../test/holdFetch";
import { mockFetch, type Routes } from "../test/fetchMock";
import { spyToasts } from "../test/toasts";
import { TagListDialog } from "./TagListDialog";

const SOURCE = { id: 5, name: "Meters", connector_type: "file" };
const LIST = "tag,asset,metric,unit\nM01.kWh,Hall 1 / Row A / Meter 01,energy_kwh,kWh\nM01.kW,Hall 1 / Row A / Meter 01,active_power_kw,W";
const PATH = "POST /api/sources/5/tag-list";
const UNDO = "POST /api/tag-lists/77/undo";

const report = (extra: Partial<TagListReport> = {}): TagListReport => ({
  dry_run: true, source_id: 5, sha256: "abc", plan_digest: "digest-1", lines: 217,
  points_to_create: 217, assets_to_create: ["Hall 1", "Hall 1 / Row A"], assets_to_create_total: 12, mappings_to_create: 217,
  units: [{ unit: "kWh", metric: "energy_kwh", scale: 1, count: 100 }, { unit: "W", metric: "active_power_kw", scale: 0.001, count: 117 }],
  problems: [], problems_total: 0, ok: true, text: "Would create 217 mappings, 12 assets and 217 points", audit_id: null, undo_until: null, ...extra,
});
const created = (extra: Partial<TagListReport> = {}) => report({ dry_run: false, text: "Created 217 mappings, 12 assets and 217 points", audit_id: 77, undo_until: "2026-10-22T10:00:00Z", ...extra });

type Seen = { url: string; body: unknown };

/** The dialog over a mocked server. `answer` decides each call to the tag-list route (it sees the query string); every call is recorded in `seen`. */
function setup({ answer, extra = {}, source = SOURCE }: { answer?: (call: Seen) => { status?: number; body?: unknown }; extra?: Routes; source?: typeof SOURCE } = {}) {
  const toasts = spyToasts();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const refreshed = vi.spyOn(client, "invalidateQueries");
  const onClose = vi.fn();
  const seen: Seen[] = [];
  mockFetch({
    [PATH]: (call) => {
      seen.push(call);
      return (answer ?? ((c) => ({ body: c.url.includes("dry_run=1") ? report() : created() })))(call);
    },
    ...extra,
  });
  render(<QueryClientProvider client={client}>{toasts.wrap(<TagListDialog source={source} onClose={onClose} />)}</QueryClientProvider>);
  const dialog = screen.getByRole("dialog");
  const area = () => within(dialog).getByLabelText("Tag list") as HTMLTextAreaElement;
  const button = (name: string) => within(dialog).getByRole("button", { name });
  const create = () => within(dialog).getByRole("button", { name: /^Create / });
  const fill = (value: string) => fireEvent.change(area(), { target: { value } });
  const check = async (value = LIST) => {
    fill(value);
    await userEvent.click(button("Check list"));
    await waitFor(() => expect(dialog.querySelector(".taglist-tiles")).not.toBeNull());
  };
  const refreshedKeys = () => refreshed.mock.calls.map(([filters]) => (filters as { queryKey: readonly unknown[] }).queryKey[0]);
  return { dialog, area, button, create, fill, check, seen, toasts, onClose, refreshedKeys };
}

describe("TagListDialog: the frame", () => {
  it("is a dialog called Map tag list: <source>, with the textarea first and the columns and the accepted units told", () => {
    const { dialog, area } = setup();
    expect(dialog).toHaveAccessibleName("Map tag list: Meters");
    expect(area()).toHaveFocus();
    expect(dialog).toHaveTextContent("tag, asset, metric, unit, scale, interval_seconds, kind, reading");
    expect(dialog).toHaveTextContent("tag, asset and metric are required");
    expect(dialog).toHaveTextContent("Hall 1 / Row A / Rack 01");
    expect(dialog).toHaveTextContent("W, kW, MW for active power; Wh, kWh, MWh for energy; the other metrics take their base unit only");
    // the units told are the ones the server takes
    expect(Object.keys(UNIT_SCALES.active_power_kw)).toEqual(["w", "kw", "mw"]);
    expect(UNIT_LABELS.active_power_kw).toBe("W, kW, MW");
    expect(UNIT_LABELS.energy_kwh).toBe("Wh, kWh, MWh");
    expect(within(dialog).getByRole("button", { name: "What does this mean?" })).toBeInTheDocument();
  });

  it("says a file source's tags become points of it", () => {
    const first = setup();
    expect(first.dialog).toHaveTextContent("The tags become points of this source.");
    expect(first.dialog).not.toHaveTextContent("run Browse first");
  });

  it("tells a source that is not a file that Browse comes first", () => {
    const { dialog } = setup({ source: { id: 5, name: "Gateway", connector_type: "modbus_tcp" } });
    expect(dialog).toHaveTextContent("The tags must already be points of this source: run Browse first.");
  });

  it("has Create mappings waiting (aria-disabled, never native disabled) until a check has been made, and pressing it sends nothing", async () => {
    const { create, seen } = setup();
    expect(create()).toHaveTextContent("Create mappings");
    expect(create()).toHaveAttribute("aria-disabled", "true");
    expect(create()).not.toBeDisabled();
    await userEvent.click(create());
    expect(seen).toEqual([]);
  });

  it("keeps Tab inside, from the last control to the first and back", async () => {
    const { dialog, area, create } = setup();
    create().focus();
    await userEvent.tab();
    expect(area()).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(create()).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("closes on Escape and on Cancel", async () => {
    const first = setup();
    await userEvent.keyboard("{Escape}");
    expect(first.onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(first.button("Cancel"));
    expect(first.onClose).toHaveBeenCalledTimes(2);
  });

  it("closes only the tip when Escape is pressed with a tip open", async () => {
    const { dialog, onClose } = setup();
    await userEvent.click(within(dialog).getByRole("button", { name: "What does this mean?" }));
    expect(screen.getByRole("note")).toHaveTextContent("Without this, a missing asset is a problem line.");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("note")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("gives the focus back to what opened it when it closes", async () => {
    mockFetch({});
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <QueryClientProvider client={new QueryClient()}>
          <button type="button" onClick={() => setOpen(true)}>Map tag list...</button>
          {open && <TagListDialog source={SOURCE} onClose={() => setOpen(false)} />}
        </QueryClientProvider>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Map tag list..." });
    await userEvent.click(opener);
    expect(screen.getByLabelText("Tag list")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("gives every button that is not a submit type=button", () => {
    const { dialog } = setup();
    for (const button of within(dialog).getAllByRole("button")) expect(button, button.textContent ?? "").toHaveAttribute("type", "button");
  });
});

describe("TagListDialog: checking the list", () => {
  it("posts the text unchanged as the raw body, as a dry run, and shows the report in place", async () => {
    const { check, seen, dialog, create } = setup();
    await check();
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain("/api/sources/5/tag-list?dry_run=1&create_assets=0");
    expect(seen[0].body).toBe(LIST);
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["content-type"]).toBe("text/csv");
    const tiles = [...dialog.querySelectorAll(".taglist-tiles > div")].map((tile) => tile.textContent);
    expect(tiles).toEqual(["Points to create217", "Assets to create12", "Mappings to create217"]);
    expect(within(dialog).getByRole("status")).toHaveTextContent("Would create 217 mappings, 12 assets and 217 points. Nothing is created until you press Create.");
    expect(create()).toHaveTextContent("Create 217 mappings");
    expect(create()).not.toHaveAttribute("aria-disabled");
  });

  it("shows the units table (unit, metric, scale, count) and the new assets with 'and N more' past the 50 listed", async () => {
    const paths = Array.from({ length: 50 }, (_, i) => `Hall 1 / Row ${i}`);
    const { check, dialog } = setup({ answer: () => ({ body: report({ assets_to_create: paths, assets_to_create_total: 61 }) }) });
    await check();
    const units = within(dialog).getByRole("heading", { name: "Units" }).parentElement!;
    const rows = [...units.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent));
    expect(rows).toEqual([["kWh", "energy_kwh", "1", "100"], ["W", "active_power_kw", "0.001", "117"]]);
    expect([...units.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["Unit", "Metric", "Scale", "Count"]);
    const assets = within(dialog).getByRole("heading", { name: "New assets" }).parentElement!;
    expect(assets.querySelectorAll("li")).toHaveLength(50);
    expect(assets).toHaveTextContent("and 11 more");
  });

  it("sends create_assets=1 when the box is ticked, and a changed box takes the report away", async () => {
    const { check, dialog, create, seen } = setup();
    await check();
    expect(create()).toHaveTextContent("Create 217 mappings");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Create missing assets" }));
    expect(create()).toHaveTextContent("Create mappings");
    expect(create()).toHaveAttribute("aria-disabled", "true");
    expect(dialog.querySelector(".taglist-tiles")).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Check list" }));
    await waitFor(() => expect(create()).toHaveTextContent("Create 217 mappings"));
    expect(seen[1].url).toContain("create_assets=1");
  });

  it("takes the report away when the text is changed, and the Create button with it", async () => {
    const { check, fill, dialog, create } = setup();
    await check();
    expect(create()).not.toHaveAttribute("aria-disabled");
    fill(`${LIST}\nM02.kWh,Hall 1 / Row A / Meter 02,energy_kwh,kWh`);
    expect(dialog.querySelector(".taglist-tiles")).toBeNull();
    expect(create()).toHaveAttribute("aria-disabled", "true");
    expect(dialog).toHaveTextContent("Press Check list to see what the list would create.");
  });

  it("shows the problem lines (line, tag, reason) with 'and N more' and keeps Create off", async () => {
    const problems = [{ line: 3, tag: "M01.kW", reason: "the unit kW does not fit the metric energy_kwh" }, { line: 9, tag: "X9", reason: "no asset Hall 9" }];
    const { check, dialog, create } = setup({
      answer: () => ({ body: report({ ok: false, problems, problems_total: 52, mappings_to_create: 215, text: "52 lines to fix; nothing is created until the list has no problems" }) }),
    });
    await check();
    const table = within(dialog).getByRole("heading", { name: "Problem lines" }).parentElement!;
    expect([...table.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent))).toEqual([
      ["3", "M01.kW", "the unit kW does not fit the metric energy_kwh"],
      ["9", "X9", "no asset Hall 9"],
    ]);
    expect(table).toHaveTextContent("and 50 more");
    expect(within(dialog).getByRole("status")).toHaveTextContent("52 lines to fix; nothing is created until the list has no problems.");
    expect(create()).toHaveTextContent("Create mappings");
    expect(create()).toHaveAttribute("aria-disabled", "true");
  });

  it("does not offer to create when the list would create nothing", async () => {
    const { check, create } = setup({ answer: () => ({ body: report({ mappings_to_create: 0, points_to_create: 0, assets_to_create: [], assets_to_create_total: 0, units: [] }) }) });
    await check();
    expect(create()).toHaveAttribute("aria-disabled", "true");
  });

  it("shows every cell as text, never as markup", async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const { check, dialog } = setup({
      answer: () => ({
        body: report({
          ok: false, assets_to_create: [`${hostile} / Row`], assets_to_create_total: 1,
          units: [{ unit: hostile, metric: "custom", scale: 1, count: 1 }],
          problems: [{ line: 2, tag: hostile, reason: `<b>${hostile}</b>` }], problems_total: 1,
        }),
      }),
    });
    await check();
    expect(dialog.querySelector("img, b")).toBeNull();
    expect(dialog).toHaveTextContent(hostile);
  });

  it("says the server's sentence when the check is refused", async () => {
    const { button, fill, dialog } = setup({ answer: () => ({ status: 415, body: { detail: "the file is UTF-16; save it as UTF-8" } }) });
    fill(LIST);
    await userEvent.click(button("Check list"));
    expect(await within(dialog).findByText("the file is UTF-16; save it as UTF-8")).toBeInTheDocument();
  });

  it("refuses an empty list and a list of more than 1,000 lines before anything is sent", async () => {
    const { button, fill, dialog, seen } = setup();
    await userEvent.click(button("Check list"));
    expect(within(dialog).getByRole("status")).toHaveTextContent("Paste a tag list or load a file first.");
    fill(`tag,asset,metric\n${Array.from({ length: 1001 }, (_, i) => `T${i},A,custom`).join("\n")}`);
    await userEvent.click(button("Check list"));
    expect(within(dialog).getByRole("status")).toHaveTextContent("The list has 1,001 lines; a list holds at most 1,000: split it into smaller lists.");
    expect(seen).toEqual([]);
  });

  it("lets a list of exactly 1,000 data lines through", async () => {
    const { check, seen } = setup();
    await check(`tag,asset,metric\n${Array.from({ length: 1000 }, (_, i) => `T${i},A,custom`).join("\n")}`);
    expect(seen).toHaveLength(1);
  });

  it("refuses a list over 1 MB before anything is sent", async () => {
    const { button, fill, dialog, seen } = setup();
    fill(`tag,asset,metric\n${"a".repeat(1024 * 1024)}`);
    await userEvent.click(button("Check list"));
    expect(within(dialog).getByRole("status")).toHaveTextContent("The list is larger than 1 MB; split it into smaller lists.");
    expect(seen).toEqual([]);
  });

  it("loads a chosen file into the text field and tells its name; a file over 1 MB is refused without being read", async () => {
    const { dialog, area } = setup();
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, new File([LIST], "tags.csv", { type: "text/csv" }));
    await waitFor(() => expect(area().value).toBe(LIST));
    expect(dialog).toHaveTextContent("tags.csv, 1 KB");
    const big = new File(["x"], "huge.csv", { type: "text/csv" });
    Object.defineProperty(big, "size", { value: 1024 * 1024 + 1 });
    await userEvent.upload(input, big);
    expect(within(dialog).getByRole("status")).toHaveTextContent("huge.csv is larger than 1 MB; split it into smaller lists.");
    expect(area().value).toBe(LIST);
  });

  it("waits while the check runs: Check list does nothing twice and the field cannot be edited", async () => {
    const { button, fill, area, seen } = setup();
    fill(LIST);
    const held = holdFetch((method, path) => method === "POST" && path === "/api/sources/5/tag-list");
    await userEvent.click(button("Check list"));
    expect(screen.getByRole("status")).toHaveTextContent("Checking the list...");
    expect(button("Check list")).toHaveAttribute("aria-disabled", "true");
    expect(area()).toHaveAttribute("readonly");
    await userEvent.click(button("Check list"));
    held.release();
    await waitFor(() => expect(document.querySelector(".taglist-tiles")).not.toBeNull());
    expect(seen).toHaveLength(1);
  });
});

describe("TagListDialog: creating", () => {
  it("posts the checked text with the numbers and the digest of the check, then closes and raises ONE toast with an Undo for 10 seconds", async () => {
    const { check, create, seen, toasts, onClose, refreshedKeys } = setup();
    await check();
    await userEvent.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const real = seen[1];
    expect(real.body).toBe(LIST);
    const query = new URL(real.url, "http://x").searchParams;
    expect(Object.fromEntries(query)).toEqual({
      dry_run: "0", create_assets: "0", expect_points: "217", expect_assets: "12", expect_mappings: "217", expect_plan: "digest-1",
    });
    expect(toasts.calls).toHaveLength(1);
    expect(toasts.calls[0]).toMatchObject({ kind: "success", text: "Created 217 mappings", options: { durationMs: 10_000, action: { label: "Undo" } } });
    expect(refreshedKeys()).toEqual(expect.arrayContaining(["sources", "assets", "graph", "billing", "widget-data", "tariffs", "audit"]));
  });

  it("sends the true number of assets, not the 50 listed", async () => {
    const paths = Array.from({ length: 50 }, (_, i) => `Hall ${i}`);
    const { check, create, seen } = setup({ answer: (c) => ({ body: c.url.includes("dry_run=1") ? report({ assets_to_create: paths, assets_to_create_total: 61 }) : created() }) });
    await check();
    await userEvent.click(create());
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(new URL(seen[1].url, "http://x").searchParams.get("expect_assets")).toBe("61");
  });

  it("says one mapping in the singular", async () => {
    const { check, create, toasts, onClose } = setup({ answer: (c) => ({ body: c.url.includes("dry_run=1") ? report({ mappings_to_create: 1 }) : created({ mappings_to_create: 1 }) }) });
    await check();
    expect(create()).toHaveTextContent("Create 1 mapping");
    await userEvent.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toasts.calls[0].text).toBe("Created 1 mapping");
  });

  it("makes the toast's Undo post the Undo of that run, and says the server's sentence", async () => {
    const sentence = "Removed 217 mappings, 12 assets and 0 points. 217 points stay because they hold readings.";
    const { check, create, toasts, onClose, refreshedKeys } = setup({ extra: { [UNDO]: { body: { mappings: 217, assets: 12, points_removed: 0, points_kept: 217, text: sentence } } } });
    await check();
    await userEvent.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const before = refreshedKeys().length;
    toasts.calls[0].options!.action!.onAction();
    await waitFor(() => expect(toasts.calls).toHaveLength(2));
    expect(toasts.calls[1]).toEqual({ kind: "success", text: sentence });
    const undoCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/tag-lists/77/undo")!;
    expect((undoCall[1] as RequestInit).method).toBe("POST");
    expect(refreshedKeys().length).toBeGreaterThan(before);
  });

  it("says the counts and the kept points in words when the server sends no sentence", async () => {
    const { check, create, toasts, onClose } = setup({ extra: { [UNDO]: { body: { mappings: 10, assets: 2, points_removed: 7, points_kept: 3 } } } });
    await check();
    await userEvent.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    toasts.calls[0].options!.action!.onAction();
    await waitFor(() => expect(toasts.calls).toHaveLength(2));
    expect(toasts.calls[1].text).toBe("Removed 10 mappings, 2 assets and 7 points. 3 points stay because they hold readings.");
  });

  it("shows the server's refusal of the Undo as an error toast, and reads the lists again", async () => {
    const { check, create, toasts, onClose, refreshedKeys } = setup({
      extra: { [UNDO]: { status: 409, body: { detail: 'the asset "Hall 1" was renamed or moved after the list created it; the list cannot be undone as a whole' } } },
    });
    await check();
    await userEvent.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const before = refreshedKeys().length;
    toasts.calls[0].options!.action!.onAction();
    await waitFor(() => expect(toasts.calls).toHaveLength(2));
    expect(toasts.calls[1]).toEqual({ kind: "error", text: 'the asset "Hall 1" was renamed or moved after the list created it; the list cannot be undone as a whole' });
    await waitFor(() => expect(refreshedKeys().length).toBeGreaterThan(before));
  });

  it("answers a 409 with the server's sentence and the new numbers, drops the report, keeps the dialog open and reads the lists again", async () => {
    const { check, create, seen, dialog, toasts, onClose, refreshedKeys } = setup({
      answer: (c) =>
        c.url.includes("dry_run=1")
          ? { body: report() }
          : { status: 409, body: { detail: "something moved", points: 200, assets: 11, mappings: 200, plan_digest: "digest-2" } },
    });
    await check();
    await userEvent.click(create());
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("something moved"));
    expect(within(dialog).getByRole("status")).toHaveTextContent("Now it would create 200 points, 11 assets and 200 mappings.");
    expect(within(dialog).getByRole("status")).toHaveTextContent('Press "Check list" again.');
    expect(within(dialog).getByRole("status")).toHaveAttribute("data-tone", "error");
    expect(dialog.querySelector(".taglist-tiles")).toBeNull();
    expect(create()).toHaveAttribute("aria-disabled", "true");
    expect(onClose).not.toHaveBeenCalled();
    expect(toasts.calls).toEqual([]);
    expect(seen).toHaveLength(2);
    expect(refreshedKeys()).toContain("sources");
  });

  it("does not repeat the new numbers when the server's sentence carries them", async () => {
    const detail = "The list now creates 200 points, 11 assets and 200 mappings, not the 217, 12 and 217 you were shown. Check the list again.";
    const { check, create, dialog } = setup({
      answer: (c) => (c.url.includes("dry_run=1") ? { body: report() } : { status: 409, body: { detail, points: 200, assets: 11, mappings: 200 } }),
    });
    await check();
    await userEvent.click(create());
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("The list now creates 200 points"));
    expect(within(dialog).getByRole("status").textContent).toBe(detail);
  });

  it("sends a 422 (a problem line under the locks) back to Check list too", async () => {
    const { check, create, dialog } = setup({
      answer: (c) =>
        c.url.includes("dry_run=1")
          ? { body: report() }
          : { status: 422, body: { detail: "line 4: the point is already mapped; nothing was created", problems_total: 1, problems: [{ line: 4, tag: "T", reason: "the point is already mapped" }] } },
    });
    await check();
    await userEvent.click(create());
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("line 4: the point is already mapped; nothing was created. Press \"Check list\" again."));
    expect(dialog.querySelector(".taglist-tiles")).toBeNull();
  });

  it("keeps the report when the create call fails for another reason (the server's words are shown)", async () => {
    const { check, create, dialog } = setup({
      answer: (c) => (c.url.includes("dry_run=1") ? { body: report() } : { status: 403, body: { detail: "insufficient permission" } }),
    });
    await check();
    await userEvent.click(create());
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("Your role does not allow this."));
    expect(dialog.querySelector(".taglist-tiles")).not.toBeNull();
    expect(create()).not.toHaveAttribute("aria-disabled");
  });

  it("sends nothing twice: a second press while the call runs does nothing, and Escape and Cancel wait for it", async () => {
    const { check, create, seen, onClose, button } = setup();
    await check();
    const held = holdFetch((method, path) => method === "POST" && path === "/api/sources/5/tag-list");
    await userEvent.click(create());
    expect(screen.getByRole("status")).toHaveTextContent("Creating the mappings...");
    expect(create()).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(create());
    await userEvent.keyboard("{Escape}");
    await userEvent.click(button("Cancel"));
    expect(onClose).not.toHaveBeenCalled();
    held.release();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(seen).toHaveLength(2);
  });
});
