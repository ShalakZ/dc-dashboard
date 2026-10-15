import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { keys } from "../api/queries";
import type { Mapping, Metric } from "../api/types";
import { holdFetch } from "../test/holdFetch";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { spyToasts } from "../test/toasts";
import { userFor } from "../test/users";
import { isBusy } from "../lib/mappingActions";
import { useMappingActions } from "./useMappingActions";

// Room 1 (room)
//   Panel 1, Panel 2
const ASSETS = [
  { id: 1, parent_id: null, name: "Room 1", kind: "room" },
  { id: 2, parent_id: 1, name: "Panel 1", kind: "panel" },
  { id: 3, parent_id: 1, name: "Panel 2", kind: "panel" },
];
const KINDS = [{ id: 1, name: "Room", icon: "room", asset_count: 1, starter: true }];
const mapping = (id: number, over: Partial<Mapping> = {}): Mapping => ({
  id, point_id: id + 1000, asset_id: 1, metric: "active_power_kw", scale: 1, interval_seconds: 10, custom_unit: null, ...over,
});
const ref = (id: number, name = `P${id}`, assetId = 1) => ({ id, name, assetId });
const refM = (id: number, metric: Metric, assetId = 1, name = `P${id}`) => ({ id, name, assetId, metric });

// The seven lists a mapping write moves (probed as one query each: a fetch is counted every time its key is invalidated).
const PROBED = { graph: keys.graph, sources: keys.sources, assets: keys.assets, fleet: keys.fleet, audit: keys.auditAll, billing: keys.billing, widgetData: keys.widgetData } as const;
function Probes() {
  for (const [name, queryKey] of Object.entries(PROBED)) {
    useQuery({ queryKey, queryFn: () => api.get(`/api/probe/${name}`), staleTime: Infinity });
  }
  return null;
}
const probeRoutes: Routes = Object.fromEntries(Object.keys(PROBED).map((name) => [`GET /api/probe/${name}`, { body: {} }]));
const EVERY = (n: number) => Object.fromEntries(Object.keys(PROBED).map((name) => [name, n]));
const fetched = (calls: { path: string }[]) => Object.fromEntries(Object.keys(PROBED).map((name) => [name, calls.filter((c) => c.path === `/api/probe/${name}`).length]));

type Actions = ReturnType<typeof useMappingActions>;
function Harness({ capture, takenFor }: { capture: (actions: Actions) => void; takenFor?: (assetId: number) => ReadonlySet<Metric> }) {
  const actions = useMappingActions({ assets: ASSETS, kinds: KINDS, takenFor });
  capture(actions);
  return <div><Probes />{actions.dialogs}</div>;
}

/** A mapping server over a store, as routes for the fetch mock (ids 1 to 12). `inject` answers a request itself before the store sees it. */
function mappingRoutes(store: Map<number, Mapping>, inject: (method: string, path: string) => { status: number; body?: unknown } | undefined = () => undefined): Routes {
  const routes: Routes = {};
  let nextId = 900;
  for (let id = 1; id <= 12; id += 1) {
    const path = `/api/mappings/${id}`;
    const missing = { status: 404, body: { detail: "mapping not found" } };
    routes[`GET ${path}`] = () => inject("GET", path) ?? (store.has(id) ? { body: store.get(id) } : missing);
    routes[`DELETE ${path}`] = () => {
      const injected = inject("DELETE", path);
      if (injected) return injected;
      if (!store.has(id)) return missing;
      store.delete(id);
      return { status: 204 };
    };
    routes[`PATCH ${path}`] = ({ body }) => {
      const injected = inject("PATCH", path);
      if (injected) return injected;
      if (!store.has(id)) return missing;
      Object.assign(store.get(id)!, body);
      return { body: store.get(id) };
    };
  }
  routes["POST /api/mappings"] = ({ body }) => {
    const injected = inject("POST", "/api/mappings");
    if (injected) return injected;
    const made = { id: nextId++, ...(body as Omit<Mapping, "id">) };
    store.set(made.id, made);
    return { status: 201, body: made };
  };
  return routes;
}

function setup(store: Map<number, Mapping>, { role = "admin", inject, takenFor }: { role?: string; inject?: Parameters<typeof mappingRoutes>[1]; takenFor?: (assetId: number) => ReadonlySet<Metric> } = {}) {
  const calls = mockFetch({
    "GET /api/me": { body: userFor(role) }, "GET /api/setup": { body: { needed: false } },
    ...probeRoutes, ...mappingRoutes(store, inject),
  });
  const spy = spyToasts();
  let actions!: Actions;
  const view = renderWithProviders(<Harness capture={(a) => { actions = a; }} takenFor={takenFor} />, { toasts: spy.api });
  return { calls, spy, view, actions: () => actions };
}
/** The account is known and every list has been fetched once (so that a later count of fetches counts refreshes only). */
const ready = async (actions: () => Actions, calls: { path: string }[], canEdit = true) => {
  await waitFor(() => expect(actions().canEdit).toBe(canEdit));
  await waitFor(() => expect(isBusy()).toBe(false));
  await waitFor(() => expect(fetched(calls)).toEqual(EVERY(1)));
};
const idle = () => waitFor(() => expect(isBusy()).toBe(false));
const writes = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method !== "GET" && !c.path.startsWith("/api/probe") && c.path !== "/api/me").map((c) => `${c.method} ${c.path}`);
const confirm = async (name: string) => userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name }));
const store = (...mappings: Mapping[]) => new Map(mappings.map((m) => [m.id, m]));
const pressUndo = (spy: ReturnType<typeof spyToasts>, at: number) => {
  const action = spy.calls[at].options?.action;
  expect(action, `toast ${at} has an Undo`).toBeDefined();
  act(() => action!.onAction());
};

describe("useMappingActions: unmap", () => {
  it("asks first, in words that never lie about billing; Cancel does nothing at all", async () => {
    const { calls, actions, spy } = setup(store(mapping(1), mapping(2)));
    await ready(actions, calls);
    act(() => actions().unmap([ref(1, "kW"), ref(2, "V")]));
    const dialog = await screen.findByRole("dialog", { name: "Unmap 2 points from Room 1?" });
    expect(dialog).toHaveTextContent("Billing for months that are still open is recalculated without them; closed months keep their billed figures.");
    expect(within(dialog).getByRole("button", { name: "Unmap" })).toHaveClass("danger");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(writes(calls)).toEqual([]);
    expect(spy.calls).toEqual([]);
  });

  it("unmaps, toasts with an Undo for 10 seconds, refreshes the seven lists, and runs after() once they have refreshed", async () => {
    const after = vi.fn();
    const seen: Record<string, number>[] = [];
    const { calls, actions, spy } = setup(store(mapping(1), mapping(2)));
    await ready(actions, calls);
    await waitFor(() => expect(fetched(calls).graph).toBe(1));
    act(() => actions().unmap([ref(1, "kW"), ref(2, "V")], { after: () => { seen.push(fetched(calls)); after(); } }));
    await confirm("Unmap");
    await waitFor(() => expect(after).toHaveBeenCalledTimes(1));
    expect(writes(calls)).toEqual(["DELETE /api/mappings/1", "DELETE /api/mappings/2"]);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toMatchObject({
      kind: "success", text: "Unmapped 2 points from Room 1.", options: { durationMs: 10_000, action: { label: "Undo", title: "Undo" } },
    });
    expect(seen[0], "every list was fetched again before after() ran").toEqual({ graph: 2, sources: 2, assets: 2, fleet: 2, audit: 2, billing: 2, widgetData: 2 });
  });

  it("Undo puts back exactly the values that were read: a custom mapping in MW at scale 0.001 and interval 1, and a plain one", async () => {
    const custom = mapping(1, { point_id: 41, metric: "custom", scale: 0.001, interval_seconds: 1, custom_unit: "MW" });
    const plain = mapping(2, { point_id: 42, metric: "voltage_v", scale: 2, interval_seconds: 60 });
    const { calls, actions, spy } = setup(store(custom, plain));
    await ready(actions, calls);
    act(() => actions().unmap([ref(1, "kW"), ref(2, "V")]));
    await confirm("Unmap");
    await waitFor(() => expect(spy.calls).toHaveLength(1));
    pressUndo(spy, 0);
    await waitFor(() => expect(spy.calls).toHaveLength(2));
    const posts = calls.filter((c) => c.method === "POST" && c.path === "/api/mappings");
    expect(posts.map((p) => p.body)).toEqual([
      { point_id: 41, asset_id: 1, metric: "custom", scale: 0.001, interval_seconds: 1, custom_unit: "MW" },
      { point_id: 42, asset_id: 1, metric: "voltage_v", scale: 2, interval_seconds: 60, custom_unit: null },
    ]);
    expect(spy.calls[1]).toEqual({ kind: "success", text: "Put back 2 mappings." });
  });

  it("a request that fails part-way: an error naming the point and the ones not tried, with an Undo for the one that went", async () => {
    const { calls, actions, spy } = setup(store(mapping(1), mapping(2), mapping(3)), { inject: (method, path) => (method === "DELETE" && path === "/api/mappings/2" ? { status: 500, body: { detail: "database is busy" } } : undefined) });
    await ready(actions, calls);
    act(() => actions().unmap([ref(1, "Alpha"), ref(2, "Beta"), ref(3, "Gamma")]));
    await confirm("Unmap");
    await waitFor(() => expect(spy.calls).toHaveLength(1));
    expect(spy.calls[0]).toMatchObject({
      kind: "error", text: 'Unmapped 1 of 3. "Beta" could not be unmapped: Database is busy. 1 was not tried.',
      options: { durationMs: 10_000, action: { label: "Undo" } },
    });
  });

  it("a failure with nothing removed is a plain error with no Undo, and the lists are refreshed all the same", async () => {
    const { calls, actions, spy } = setup(store(mapping(1)), { inject: (method) => (method === "DELETE" ? { status: 500, body: { detail: "database is busy" } } : undefined) });
    await ready(actions, calls);
    await waitFor(() => expect(fetched(calls).graph).toBe(1));
    act(() => actions().unmap([ref(1, "Alpha")]));
    await confirm("Unmap");
    await waitFor(() => expect(spy.calls).toHaveLength(1));
    expect(spy.calls[0]).toEqual({ kind: "error", text: '"Alpha" could not be unmapped: Database is busy.' });
    await waitFor(() => expect(fetched(calls)).toEqual({ graph: 2, sources: 2, assets: 2, fleet: 2, audit: 2, billing: 2, widgetData: 2 }));
  });

  it("mappings that are already gone say so, with no Undo", async () => {
    const { calls, actions, spy } = setup(store());
    await ready(actions, calls);
    act(() => actions().unmap([ref(1), ref(2)]));
    await confirm("Unmap");
    await waitFor(() => expect(spy.calls).toHaveLength(1));
    expect(spy.calls[0]).toEqual({ kind: "info", text: "Those mappings were already gone." });
  });

  it("points on several assets: the title says how many assets, and the toast does too", async () => {
    const { calls, actions, spy } = setup(store(mapping(1, { asset_id: 2 }), mapping(2, { asset_id: 3 })));
    await ready(actions, calls);
    act(() => actions().unmap([ref(1, "kW", 2), ref(2, "V", 3)]));
    await screen.findByRole("dialog", { name: "Unmap 2 points from 2 assets?" });
    await confirm("Unmap");
    await waitFor(() => expect(spy.calls).toHaveLength(1));
    expect(spy.calls[0].text).toBe("Unmapped 2 points from 2 assets.");
  });

  it("a group is named by the caller", async () => {
    const { calls, actions } = setup(store(mapping(1)));
    await ready(actions, calls);
    act(() => actions().unmap([ref(1)], { what: 'the group "LVP01"' }));
    await screen.findByRole("dialog", { name: 'Unmap the group "LVP01" from Room 1?' });
  });

  it("does nothing without assets.edit: no dialog, no request, no toast", async () => {
    const { calls, actions, spy } = setup(store(mapping(1)), { role: "operator" });
    await ready(actions, calls, false);
    act(() => { actions().unmap([ref(1)]); actions().move([refM(1, "voltage_v")]); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(writes(calls)).toEqual([]);
    expect(spy.calls).toEqual([]);
  });

  it("refuses a new unmap while one is still running, and does not ask", async () => {
    const { calls, actions, spy } = setup(store(mapping(1), mapping(2)));
    await ready(actions, calls);
    const gate = holdFetch((method, path) => method === "DELETE" && path === "/api/mappings/1");
    act(() => actions().unmap([ref(1)]));
    await confirm("Unmap");
    await waitFor(() => expect(isBusy()).toBe(true));
    act(() => { actions().unmap([ref(2)]); actions().move([refM(2, "voltage_v")]); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(spy.calls).toEqual([
      { kind: "info", text: "Still working on the last change." },
      { kind: "info", text: "Still working on the last change." },
    ]);
    gate.release();
    await waitFor(() => expect(spy.calls).toHaveLength(3));
    expect(spy.calls[2].text).toBe("Unmapped 1 point from Room 1.");
    await idle();
  });
});

describe("useMappingActions: move", () => {
  const chooseAsset = async (id: number) => userEvent.selectOptions(within(screen.getByRole("dialog")).getByLabelText("Move to"), String(id));

  it("opens the Move dialog; moving asks the server for one change at a time, toasts with an Undo, and refreshes", async () => {
    const { calls, actions, spy } = setup(store(mapping(1, { asset_id: 2 }), mapping(2, { asset_id: 2 })));
    await ready(actions, calls);
    act(() => actions().move([refM(1, "active_power_kw", 2, "kW"), refM(2, "voltage_v", 2, "V")]));
    await screen.findByRole("dialog", { name: "Move 2 points to another asset" });
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Move" })).toBeDisabled();
    await chooseAsset(3);
    await confirm("Move");
    await waitFor(() => expect(spy.calls).toHaveLength(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(writes(calls)).toEqual(["PATCH /api/mappings/1", "PATCH /api/mappings/2"]);
    expect(spy.calls[0]).toMatchObject({ kind: "success", text: "Moved 2 points to Panel 2.", options: { durationMs: 10_000, action: { label: "Undo", title: "Undo" } } });
    await waitFor(() => expect(fetched(calls).graph).toBe(2));
  });

  it("Undo of a move patches each mapping back to where it was", async () => {
    const { calls, actions, spy } = setup(store(mapping(1, { asset_id: 2 }), mapping(2, { asset_id: 1 })));
    await ready(actions, calls);
    act(() => actions().move([refM(1, "active_power_kw", 2, "kW"), refM(2, "voltage_v", 1, "V")]));
    await screen.findByRole("dialog");
    await chooseAsset(3);
    await confirm("Move");
    await waitFor(() => expect(spy.calls).toHaveLength(1));
    pressUndo(spy, 0);
    await waitFor(() => expect(spy.calls).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PATCH").map((c) => [c.path, c.body])).toEqual([
      ["/api/mappings/1", { asset_id: 3 }], ["/api/mappings/2", { asset_id: 3 }],
      ["/api/mappings/1", { asset_id: 2 }], ["/api/mappings/2", { asset_id: 1 }],
    ]);
    expect(spy.calls[1]).toEqual({ kind: "success", text: "Put back 2 mappings." });
  });

  it("Undo leaves a mapping that was changed since alone and says so", async () => {
    const s = store(mapping(1, { asset_id: 2 }), mapping(2, { asset_id: 2 }));
    const { calls, actions, spy } = setup(s);
    await ready(actions, calls);
    act(() => actions().move([refM(1, "active_power_kw", 2, "kW"), refM(2, "voltage_v", 2, "V")]));
    await screen.findByRole("dialog");
    await chooseAsset(3);
    await confirm("Move");
    await waitFor(() => expect(spy.calls).toHaveLength(1));
    s.get(2)!.asset_id = 1; // somebody moved V on, meanwhile
    pressUndo(spy, 0);
    await waitFor(() => expect(spy.calls).toHaveLength(2));
    expect(spy.calls[1]).toEqual({ kind: "info", text: 'Put back 1 mapping. "V" was changed since, so nothing was undone for it.' });
    expect(s.get(2)!.asset_id).toBe(1);
  });

  it("a single move that the server refuses for a clash names the asset and the metric", async () => {
    const { calls, actions, spy } = setup(store(mapping(1, { asset_id: 2, metric: "voltage_v" })), {
      inject: (method) => (method === "PATCH" ? { status: 409, body: { detail: "this point is already mapped, or the asset already has this metric" } } : undefined),
    });
    await ready(actions, calls);
    act(() => actions().move([refM(1, "voltage_v", 2, "V")]));
    await screen.findByRole("dialog", { name: 'Move "V" to another asset' });
    await chooseAsset(3);
    await confirm("Move");
    await waitFor(() => expect(spy.calls).toHaveLength(1));
    expect(spy.calls[0]).toEqual({ kind: "error", text: '"V" could not be moved: Panel 2 already has voltage_v.' });
  });

  it("gets takenFor and the kinds: a clash keeps Move off, a room gets its note", async () => {
    const { calls, actions } = setup(store(mapping(1, { asset_id: 2 })), { takenFor: (assetId) => new Set<Metric>(assetId === 3 ? ["voltage_v"] : []) });
    await ready(actions, calls);
    act(() => actions().move([refM(1, "voltage_v", 2, "V")]));
    await screen.findByRole("dialog");
    await chooseAsset(3);
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Move" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent('"V" would clash: Panel 2 already has that metric.');
    await chooseAsset(1);
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Move" })).toBeEnabled();
    expect(screen.getByText("Room 1 is a room; meters usually belong to a Panel or Rack. Move here anyway?")).toBeInTheDocument();
  });

  it("Cancel closes the dialog and moves nothing", async () => {
    const { calls, actions } = setup(store(mapping(1, { asset_id: 2 })));
    await ready(actions, calls);
    act(() => actions().move([refM(1, "voltage_v", 2)]));
    await screen.findByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(writes(calls)).toEqual([]);
  });
});

describe("useMappingActions: mappedToast", () => {
  it("with assets.edit the toast carries an Undo that deletes the mappings it made, if they are still where they were made", async () => {
    const s = store(mapping(1, { asset_id: 1 }), mapping(2, { asset_id: 1 }), mapping(3, { asset_id: 1 }));
    const { calls, actions, spy } = setup(s);
    await ready(actions, calls);
    act(() => actions().mappedToast({ text: "Mapped 3 points to Room 1.", mappings: [{ id: 1, assetId: 1, name: "kW" }, { id: 2, assetId: 1, name: "V" }, { id: 3, assetId: 1, name: "A" }], newAssets: ["Room 1"] }));
    expect(spy.calls[0]).toMatchObject({ kind: "success", text: "Mapped 3 points to Room 1.", options: { durationMs: 10_000, action: { label: "Undo", title: "Undo" } } });
    s.get(2)!.asset_id = 2; // V was moved to a panel since
    pressUndo(spy, 0);
    await waitFor(() => expect(spy.calls).toHaveLength(2));
    expect(writes(calls)).toEqual(["DELETE /api/mappings/1", "DELETE /api/mappings/3"]);
    expect(spy.calls[1]).toEqual({
      kind: "info", text: 'Unmapped 2 points. Room 1 stays; delete it from Assets Tree if you do not need it. "V" was changed since, so nothing was undone for it.',
    });
    await waitFor(() => expect(fetched(calls).graph).toBe(2));
  });

  it("an Undo with no new asset does not say anything stays", async () => {
    const { calls, actions, spy } = setup(store(mapping(1)));
    await ready(actions, calls);
    act(() => actions().mappedToast({ text: "Mapped 1 point to Room 1.", mappings: [{ id: 1, assetId: 1 }], newAssets: [] }));
    pressUndo(spy, 0);
    await waitFor(() => expect(spy.calls).toHaveLength(2));
    expect(spy.calls[1]).toEqual({ kind: "success", text: "Unmapped 1 point." });
  });

  it("without assets.edit (discovery.accept alone) the toast has no Undo at all", async () => {
    const { calls, actions, spy } = setup(store(mapping(1)), { role: "operator" });
    await ready(actions, calls, false);
    act(() => actions().mappedToast({ text: "Mapped 1 point to Room 1.", mappings: [{ id: 1, assetId: 1 }], newAssets: [] }));
    expect(spy.calls).toEqual([{ kind: "success", text: "Mapped 1 point to Room 1." }]);
  });
});

describe("useMappingActions: an Undo outlives the page", () => {
  it("still sends its requests, and still says what happened, after the page that raised it is gone", async () => {
    const { calls, actions, spy, view } = setup(store(mapping(1, { point_id: 41, metric: "custom", scale: 0.001, interval_seconds: 1, custom_unit: "MW" })));
    await ready(actions, calls);
    act(() => actions().unmap([ref(1, "kW")]));
    await confirm("Unmap");
    await waitFor(() => expect(spy.calls).toHaveLength(1));
    view.unmount();
    pressUndo(spy, 0);
    await waitFor(() => expect(spy.calls).toHaveLength(2));
    expect(calls.filter((c) => c.method === "POST" && c.path === "/api/mappings").map((c) => c.body)).toEqual([
      { point_id: 41, asset_id: 1, metric: "custom", scale: 0.001, interval_seconds: 1, custom_unit: "MW" },
    ]);
    expect(spy.calls[1]).toEqual({ kind: "success", text: "Put back 1 mapping." });
    await idle();
  });

  it("two Undos pressed together run one after the other: neither is dropped", async () => {
    const { calls, actions, spy } = setup(store(mapping(1, { point_id: 41 }), mapping(2, { point_id: 42 })));
    await ready(actions, calls);
    act(() => actions().unmap([ref(1, "A")]));
    await confirm("Unmap");
    await waitFor(() => expect(spy.calls).toHaveLength(1));
    act(() => actions().unmap([ref(2, "B")]));
    await confirm("Unmap");
    await waitFor(() => expect(spy.calls).toHaveLength(2));
    pressUndo(spy, 0);
    pressUndo(spy, 1);
    await waitFor(() => expect(spy.calls).toHaveLength(4));
    expect(calls.filter((c) => c.method === "POST" && c.path === "/api/mappings").map((c) => (c.body as { point_id: number }).point_id)).toEqual([41, 42]);
    await idle();
  });
});
