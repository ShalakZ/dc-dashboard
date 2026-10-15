import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAssets, useGraph, useSources } from "../../api/queries";
import type { GraphModel, Metric } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { mockFetch } from "../../test/fetchMock";
import { model, point, source } from "../../test/graphFixtures";
import { renderWithProviders } from "../../test/render";
import { spyToasts } from "../../test/toasts";
import { userFor } from "../../test/users";
import { BulkCreateDialog } from "./BulkCreateDialog";

const suggest = (metric: Metric, over: { scale?: number; interval_seconds?: number; custom_unit?: string | null } = {}) =>
  ({ metric, scale: 1, interval_seconds: 5, custom_unit: null, ...over });

// Source 1 has five groups: LVP01 (three clean guesses, one in Wh), LVP02 (a repeated voltage_v), TEMPS (a custom guess with its unit),
// NOUNIT (a custom guess with no unit: nothing in it can be mapped without a decision) and DONE (everything already mapped).
const graph = (assets?: GraphModel["assets"]): GraphModel => model({
  sources: [
    source(1, {
      clusters: [
        { key: "LVP01", points: [
          point(1, "LVP01 kW", { unit_hint: "kW", suggestion: suggest("active_power_kw") }),
          point(2, "LVP01 kWh", { unit_hint: "Wh", suggestion: suggest("energy_kwh", { scale: 0.001, interval_seconds: 60 }) }),
          point(3, "LVP01 V", { suggestion: suggest("voltage_v") }),
        ] },
        { key: "LVP02", points: [
          point(4, "LVP02 kW", { suggestion: suggest("active_power_kw") }),
          point(5, "LVP02 V", { suggestion: suggest("voltage_v") }),
          point(6, "LVP02 V2", { suggestion: suggest("voltage_v") }),
        ] },
        { key: "TEMPS", points: [point(7, "T a", { suggestion: suggest("custom", { custom_unit: "degC" }) })] },
        { key: "NOUNIT", points: [point(8, "N a", { suggestion: suggest("custom") })] },
        { key: "DONE", points: [point(9, "D a", { asset_id: 10, mapping_id: 1, mapped_metric: "voltage_v" })] },
      ],
    }),
  ],
  ...(assets ? { assets } : {}),
});

const created = (id = 20) => ({ status: 201, body: { asset_id: id, mapping_ids: [1] } });
type Accept = NonNullable<Parameters<typeof mockFetch>[0][string]>;
const routes = (accept: Accept = created(), assets?: GraphModel["assets"]) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor("admin", { username: "admin" }) },
  "GET /api/discovery/graph": { body: graph(assets) },
  "GET /api/sources": { body: [] },
  "GET /api/assets": { body: [] },
  "POST /api/discovery/accept": accept,
});

/** Mounts the graph query next to the dialog, as the page does, so the refetch after the batch is observable. */
function Harness({ onClose }: { onClose: () => void }) {
  const { loading } = useAuth();
  const { data } = useGraph();
  useAssets();
  useSources();
  if (loading || !data) return null;
  return <BulkCreateDialog model={data} source={data.sources[0]} onClose={onClose} />;
}

async function open(accept?: Accept, assets?: GraphModel["assets"]) {
  const toasts = spyToasts();
  const calls = mockFetch(routes(accept, assets));
  const onClose = vi.fn();
  const view = renderWithProviders(<Harness onClose={onClose} />, { toasts: toasts.api });
  const dialog = await screen.findByRole("dialog", { name: "Create an asset for each group" });
  return { calls, onClose, dialog, toasts: toasts.calls, ...view };
}
const accepts = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/discovery/accept");
const gets = (calls: { method: string; path: string }[], path: string) => calls.filter((c) => c.method === "GET" && c.path === path).length;
const box = (group: string) => screen.getByRole("checkbox", { name: `Include ${group}` });
const nameInput = (group: string) => screen.getByLabelText(`Asset name for ${group}`);
const rowOf = (group: string) => box(group).closest("tr")!;
const go = (label: string) => screen.getByRole("button", { name: label });

describe("BulkCreateDialog", () => {
  afterEach(cleanup);

  it("lists the groups an asset can be made from, and says what is left out", async () => {
    const { dialog } = await open();
    for (const group of ["LVP01", "LVP02", "TEMPS"]) expect(box(group)).toBeChecked();
    // A fully mapped group is not a group any more; a group that needs a decision is named, not offered.
    expect(screen.queryByRole("checkbox", { name: "Include DONE" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Include NOUNIT" })).toBeNull();
    expect(within(dialog).getByText(/Left out/)).toHaveTextContent("NOUNIT");
    expect(go("Create 3 assets")).toBeInTheDocument();
  });

  it("focuses the parent select on open and offers (root) first, then the assets in tree order", async () => {
    await open();
    const parent = screen.getByLabelText("Parent asset");
    expect(parent).toHaveFocus();
    expect(within(parent).getAllByRole("option").map((o) => o.textContent?.trim())).toEqual(["(root)", "Site", "Panel 1"]);
  });

  it("shows, before any click, the metric and the scale of each point, the unit it must bridge and what stays unmapped", async () => {
    await open();
    const lvp01 = rowOf("LVP01").textContent ?? "";
    expect(lvp01).toContain("LVP01 kWh: energy_kwh ×0.001");
    expect(lvp01).toContain("point unit Wh");
    expect(lvp01).toContain("LVP01 kW: active_power_kw ×1");
    // kW is the metric's own unit: nothing to bridge, so nothing to say.
    expect(lvp01).not.toContain("point unit kW");
    // The second voltage_v of LVP02 would be a second mapping of one metric on one asset: it stays out, and the row says so.
    const lvp02 = rowOf("LVP02").textContent ?? "";
    expect(lvp02).toContain("LVP02 V: voltage_v ×1");
    expect(lvp02).toContain("LVP02 V2 stays unmapped. Another point in this list already maps voltage_v.");
    expect(lvp02).not.toContain("LVP02 V2: voltage_v");
    // A custom guess shows its unit.
    expect(rowOf("TEMPS").textContent).toContain("T a: custom (degC) ×1");
    expect(rowOf("LVP02").textContent).toContain("2 of 3");
  });

  it("says once that these are the scan's guesses and where to change them", async () => {
    const { dialog } = await open();
    expect(within(dialog).getAllByText("These are the scan's guesses. To change a metric or a scale first, use New asset... on the group instead.")).toHaveLength(1);
  });

  it("creates one asset per ticked group, in order, at the root, with only the points it listed as mapped", async () => {
    const user = userEvent.setup();
    const { calls, onClose, toasts } = await open();
    await user.click(go("Create 3 assets"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const sent = accepts(calls).map((c) => c.body);
    expect(sent).toEqual([
      { source_id: 1, new_asset: { name: "LVP01", parent_id: null }, points: [
        { point_id: 1, metric: "active_power_kw", scale: 1, interval_seconds: 5, custom_unit: null },
        { point_id: 2, metric: "energy_kwh", scale: 0.001, interval_seconds: 60, custom_unit: null },
        { point_id: 3, metric: "voltage_v", scale: 1, interval_seconds: 5, custom_unit: null },
      ] },
      { source_id: 1, new_asset: { name: "LVP02", parent_id: null }, points: [
        { point_id: 4, metric: "active_power_kw", scale: 1, interval_seconds: 5, custom_unit: null },
        { point_id: 5, metric: "voltage_v", scale: 1, interval_seconds: 5, custom_unit: null },
      ] },
      { source_id: 1, new_asset: { name: "TEMPS", parent_id: null }, points: [
        { point_id: 7, metric: "custom", scale: 1, interval_seconds: 5, custom_unit: "degC" },
      ] },
    ]);
    expect(toasts).toEqual([{ kind: "success", text: "Created 3 assets" }]);
  });

  it("puts the assets under the chosen parent, sends a trimmed edited name, and skips an unticked group", async () => {
    const user = userEvent.setup();
    const { calls, onClose } = await open();
    await user.selectOptions(screen.getByLabelText("Parent asset"), "10");
    await user.click(box("LVP02"));
    expect(go("Create 2 assets")).toBeInTheDocument();
    const input = nameInput("TEMPS");
    await user.clear(input);
    await user.type(input, "  Cold   aisle  ");
    await user.click(go("Create 2 assets"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(accepts(calls).map((c) => (c.body as { new_asset: unknown }).new_asset)).toEqual([
      { name: "LVP01", parent_id: 10 },
      { name: "Cold   aisle", parent_id: 10 },
    ]);
  });

  it("refreshes the graph, the sources and the assets once for the whole batch", async () => {
    const user = userEvent.setup();
    const { calls, onClose } = await open();
    await waitFor(() => expect(gets(calls, "/api/sources")).toBe(1));
    await user.click(go("Create 3 assets"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(accepts(calls)).toHaveLength(3);
    expect(gets(calls, "/api/discovery/graph")).toBe(2);
    expect(gets(calls, "/api/sources")).toBe(2);
    expect(gets(calls, "/api/assets")).toBe(2);
  });

  it("when one group fails midway: the others are created, the failed row keeps the server's words, and the dialog stays", async () => {
    const user = userEvent.setup();
    let n = 0;
    const clash = 'an asset named "LVP02" already exists at the top level; choose another name';
    const { calls, onClose, toasts } = await open(() => {
      n += 1;
      return n === 2 ? { status: 409, body: { detail: clash } } : created(20 + n);
    });
    await user.click(go("Create 3 assets"));
    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(accepts(calls).map((c) => (c.body as { new_asset: { name: string } }).new_asset.name)).toEqual(["LVP01", "LVP02", "TEMPS"]); // it went on past the failure
    expect(toasts).toEqual([{ kind: "error", text: "Created 2 of 3 assets" }]);
    expect(onClose).not.toHaveBeenCalled();
    // The created rows left the list; the failed one is still there, marked, with the words of the server.
    expect(screen.queryByRole("checkbox", { name: "Include LVP01" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Include TEMPS" })).toBeNull();
    expect(box("LVP02")).toBeChecked();
    expect(nameInput("LVP02")).toHaveAttribute("aria-invalid", "true");
    expect(nameInput("LVP02")).toHaveAccessibleDescription(clash);
    // The button counts what is left, and Cancel now closes something that already happened.
    expect(go("Create 1 asset")).not.toHaveAttribute("aria-disabled");
    expect(go("Close")).toBeInTheDocument();
    expect(gets(calls, "/api/discovery/graph")).toBe(2); // refreshed once, after the loop
    // Fixing the name clears the mark, and a second press creates only that group.
    const input = nameInput("LVP02");
    await user.clear(input);
    await user.type(input, "LVP02 b");
    expect(input).not.toHaveAttribute("aria-invalid");
    await user.click(go("Create 1 asset"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(accepts(calls)).toHaveLength(4);
    expect(toasts.at(-1)).toEqual({ kind: "success", text: "Created 1 asset" });
  });

  it("when nothing could be created it says so and keeps every row", async () => {
    const user = userEvent.setup();
    const { dialog, onClose, toasts } = await open({ status: 500, body: { detail: "boom" } });
    await user.click(go("Create 3 assets"));
    await waitFor(() => expect(toasts).toHaveLength(1));
    // The line under the list names no group (the rows that are left are the failed ones; a list of names would have no length limit).
    expect(dialog).toHaveTextContent("Created 0 of 3. The groups still listed were not created");
    expect(within(dialog).getByText(/The groups still listed/).textContent).not.toMatch(/LVP|TEMPS/);
    expect(toasts).toEqual([{ kind: "error", text: "Created 0 of 3 assets" }]);
    expect(onClose).not.toHaveBeenCalled();
    for (const group of ["LVP01", "LVP02", "TEMPS"]) expect(nameInput(group)).toHaveAttribute("aria-invalid", "true");
    expect(go("Create 3 assets")).not.toHaveAttribute("aria-disabled");
    expect(go("Cancel")).toBeInTheDocument();
  });

  it("refuses two groups with the same name before sending anything, whatever the case or spacing", async () => {
    const user = userEvent.setup();
    const { calls, dialog } = await open();
    const input = nameInput("LVP02");
    await user.clear(input);
    await user.type(input, "  lvp01 ");
    expect(nameInput("LVP01")).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getAllByText(/Another group in this batch has the same name/, { selector: ".bulk-name-note" })).toHaveLength(2);
    expect(go("Create 3 assets")).toHaveAttribute("aria-disabled", "true");
    expect(dialog).toHaveTextContent(/LVP01: Another group in this batch has the same name/);
    await user.click(go("Create 3 assets"));
    expect(accepts(calls)).toHaveLength(0);
    // Unticking one of the two lifts the refusal: only ticked groups are compared.
    await user.click(box("LVP02"));
    expect(go("Create 2 assets")).not.toHaveAttribute("aria-disabled");
  });

  it("refuses an empty name", async () => {
    const user = userEvent.setup();
    const { calls } = await open();
    await user.clear(nameInput("TEMPS"));
    expect(go("Create 3 assets")).toHaveAttribute("aria-disabled", "true");
    expect(nameInput("TEMPS")).toHaveAccessibleDescription("Enter a name.");
    // The button that waits says why to a screen reader too (it is aria-disabled, not disabled, so it can be reached).
    expect(go("Create 3 assets")).toHaveAccessibleDescription("TEMPS: Enter a name.");
    await user.click(go("Create 3 assets"));
    expect(accepts(calls)).toHaveLength(0);
  });

  it("refuses a name an asset under the chosen parent already has, and looks again when the parent changes", async () => {
    const user = userEvent.setup();
    // "lvp01" is at the root; "Temps" is under Site.
    const assets: GraphModel["assets"] = [
      { id: 10, parent_id: null, name: "Site", kind: "generic" },
      { id: 11, parent_id: null, name: " lvp01 ", kind: "generic" },
      { id: 12, parent_id: 10, name: "Temps", kind: "generic" },
    ];
    const { calls } = await open(undefined, assets);
    expect(nameInput("LVP01")).toHaveAttribute("aria-invalid", "true");
    expect(nameInput("LVP01")).toHaveAccessibleDescription('"LVP01" already exists at the top level.');
    expect(nameInput("TEMPS")).not.toHaveAttribute("aria-invalid");
    expect(go("Create 3 assets")).toHaveAttribute("aria-disabled", "true");
    await user.click(go("Create 3 assets"));
    expect(accepts(calls)).toHaveLength(0);
    await user.selectOptions(screen.getByLabelText("Parent asset"), "10");
    expect(nameInput("LVP01")).not.toHaveAttribute("aria-invalid");
    expect(nameInput("TEMPS")).toHaveAccessibleDescription('"TEMPS" already exists under "Site".');
    expect(go("Create 3 assets")).toHaveAttribute("aria-disabled", "true");
  });

  it("needs at least one ticked group", async () => {
    const user = userEvent.setup();
    const { dialog } = await open();
    for (const group of ["LVP01", "LVP02", "TEMPS"]) await user.click(box(group));
    expect(go("Create 0 assets")).toHaveAttribute("aria-disabled", "true");
    expect(dialog).toHaveTextContent("Tick at least one group.");
  });

  it("closes on Escape and on Cancel when idle", async () => {
    const user = userEvent.setup();
    const { onClose } = await open();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(go("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("does not close on Escape or Cancel while the batch is being written", async () => {
    const user = userEvent.setup();
    const { calls, onClose } = await open();
    // The first accept never answers until the test lets it.
    const answer = globalThis.fetch;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if ((init?.method ?? "GET") === "POST" && url.endsWith("/api/discovery/accept")) await held;
      return answer(input, init);
    }));
    await user.click(go("Create 3 assets"));
    await waitFor(() => expect(go("Cancel")).toHaveAttribute("aria-disabled", "true"));
    expect(screen.getByText(/Creating 1 of 3/)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(go("Cancel"));
    expect(onClose).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(accepts(calls)).toHaveLength(3);
  });

  it("keeps Tab inside the dialog and does not give the focus back to the opener when it goes away", async () => {
    const user = userEvent.setup();
    const { unmount } = await open();
    const parent = screen.getByLabelText("Parent asset");
    expect(parent).toHaveFocus();
    await user.tab({ shift: true }); // from the first control to the last one: the primary button
    expect(go("Create 3 assets")).toHaveFocus();
    await user.tab();
    expect(parent).toHaveFocus();
    unmount();
    expect(document.activeElement).toBe(document.body); // the page decides where focus goes (the dialog must not pull it back to a stale opener)
  });

  it("does not take focus back to what had it before it opened", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = await open();
    expect(opener).not.toHaveFocus();
    unmount();
    expect(opener).not.toHaveFocus();
    opener.remove();
  });
});
