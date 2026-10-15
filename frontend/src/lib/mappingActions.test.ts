import { ApiError } from "../api/client";
import type { AssetKind, Mapping, Metric } from "../api/types";
import {
  BUSY_TEXT, GONE_TEXT, UNDO_MS, containerNote, deleteMappings, enqueue, isBusy, isContainerKind, moveBack, moveConflictText, moveConflicts,
  moveMappings, moveMessage, moveOutcome, moveTitle, reasonOf, restoreMappings, staysText, undoOutcome, unmapMappings, unmapOutcome, unmapPrompt,
  type MappingRef,
} from "./mappingActions";

const mapping = (id: number, over: Partial<Mapping> = {}): Mapping => ({
  id, point_id: id + 1000, asset_id: 1, metric: "active_power_kw", scale: 1, interval_seconds: 10, custom_unit: null, ...over,
});
const ref = (id: number, name = `P${id}`, assetId = 1): MappingRef => ({ id, name, assetId });
const NOT_ANSWERING = "The server is not answering (status 504). It may be restarting; try again in a moment.";

type Call = { method: string; path: string; body: unknown };
const reply = (status: number, body?: unknown) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status, headers: { "content-type": "application/json" } });

/**
 * A small mapping server: GET, PATCH and DELETE on /api/mappings/{id} and POST /api/mappings against a store, so a runner is tested against
 * what the server would be left holding. `fail` answers a request itself (a status to inject) before the store sees it.
 */
function server(initial: Mapping[], fail: (call: Call) => Response | undefined = () => undefined) {
  const store = new Map(initial.map((m) => [m.id, { ...m }]));
  const calls: Call[] = [];
  let nextId = 500;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const injected = fail(call);
    if (injected) return injected;
    if (call.method === "POST" && call.path === "/api/mappings") {
      const body = call.body as Omit<Mapping, "id">;
      const made = { id: nextId++, ...body };
      store.set(made.id, made);
      return reply(201, made);
    }
    const one = /^\/api\/mappings\/(\d+)$/.exec(call.path);
    const found = one ? store.get(Number(one[1])) : undefined;
    if (!found) return reply(404, { detail: "mapping not found" });
    if (call.method === "GET") return reply(200, found);
    if (call.method === "DELETE") { store.delete(found.id); return reply(204); }
    if (call.method === "PATCH") { Object.assign(found, call.body); return reply(200, found); }
    return reply(500, { detail: "unexpected" });
  }));
  return { store, calls, writes: () => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`) };
}
const status = (code: number, detail: string) => (match: (call: Call) => boolean) => (call: Call) => (match(call) ? reply(code, { detail }) : undefined);
const is = (method: string, path: string) => (call: Call) => call.method === method && call.path === path;

describe("enqueue and isBusy", () => {
  it("runs work one after the other, in the order given, whatever each takes", async () => {
    const order: string[] = [];
    const slow = enqueue(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); order.push("slow"); return 1; });
    const quick = enqueue(async () => { order.push("quick"); return 2; });
    expect(await Promise.all([slow, quick])).toEqual([1, 2]);
    expect(order).toEqual(["slow", "quick"]);
  });

  it("a rejection reaches its own caller and never breaks the chain", async () => {
    const failing = enqueue(async () => { throw new Error("boom"); });
    const after = enqueue(async () => "still runs");
    await expect(failing).rejects.toThrow("boom");
    await expect(after).resolves.toBe("still runs");
  });

  it("is busy from the moment work is queued until it has finished", async () => {
    expect(isBusy()).toBe(false);
    let release!: () => void;
    const held = enqueue(() => new Promise<void>((resolve) => { release = resolve; }));
    expect(isBusy()).toBe(true); // queued, not yet started
    const second = enqueue(async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0)); // the first work has started by now and handed over its release
    release();
    await held;
    expect(isBusy()).toBe(true); // the second is still queued
    await second;
    expect(isBusy()).toBe(false);
  });

  it("is not busy any more after work that threw", async () => {
    await expect(enqueue(async () => { throw new Error("x"); })).rejects.toThrow();
    expect(isBusy()).toBe(false);
  });

  it("gives the Undo window and the busy sentence the plan fixes", () => {
    expect(UNDO_MS).toBe(10_000);
    expect(BUSY_TEXT).toBe("Still working on the last change.");
  });
});

describe("unmapMappings", () => {
  it("reads each mapping, then deletes it, one at a time in the given order; removed holds the mappings as read", async () => {
    const s = server([mapping(1, { scale: 0.5 }), mapping(2), mapping(3)]);
    const result = await unmapMappings([ref(1), ref(2), ref(3)]);
    expect(s.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/mappings/1", "DELETE /api/mappings/1", "GET /api/mappings/2", "DELETE /api/mappings/2", "GET /api/mappings/3", "DELETE /api/mappings/3",
    ]);
    expect(result).toEqual({ removed: [mapping(1, { scale: 0.5 }), mapping(2), mapping(3)], skipped: [], gone: 0, failed: null, notTried: 0 });
    expect(s.store.size).toBe(0);
  });

  it("leaves alone a mapping that is no longer on the asset the person confirmed: it is named in skipped and nothing is deleted for it", async () => {
    const s = server([mapping(1, { asset_id: 1 }), mapping(2, { asset_id: 7 }), mapping(3, { asset_id: 1 })]);
    const result = await unmapMappings([ref(1, "A", 1), ref(2, "kW", 1), ref(3, "C", 1)]);
    expect(s.writes()).toEqual(["DELETE /api/mappings/1", "DELETE /api/mappings/3"]);
    expect(result).toEqual({ removed: [mapping(1), mapping(3)], skipped: ["kW"], gone: 0, failed: null, notTried: 0 });
    expect(s.store.get(2)!.asset_id).toBe(7);
  });

  it("stops at the first failed request: the second DELETE fails, the third is not tried", async () => {
    const s = server([mapping(1), mapping(2), mapping(3)], status(500, "database is busy")(is("DELETE", "/api/mappings/2")));
    const result = await unmapMappings([ref(1, "Alpha"), ref(2, "Beta"), ref(3, "Gamma")]);
    expect(result.removed).toEqual([mapping(1)]);
    expect(result.failed).toEqual({ name: "Beta", reason: "Database is busy.", status: 500 });
    expect(result.notTried).toBe(1);
    expect(s.calls.some((c) => c.path === "/api/mappings/3")).toBe(false);
    expect([...s.store.keys()]).toEqual([2, 3]);
  });

  it("a 404 on the read, or on the delete, counts the mapping as already gone and goes on", async () => {
    server([mapping(2), mapping(3)], status(404, "mapping not found")(is("DELETE", "/api/mappings/3")));
    const result = await unmapMappings([ref(1), ref(2), ref(3)]); // 1 was never there: its read answers 404
    expect(result).toEqual({ removed: [mapping(2)], skipped: [], gone: 2, failed: null, notTried: 0 });
  });

  it.each([
    [401, "Your session has ended. Sign in again."],
    [403, "Your role may not change mappings."],
  ])("a %i is told in a full sentence", async (code, sentence) => {
    server([mapping(1)], status(code, "insufficient permission")(is("GET", "/api/mappings/1")));
    const result = await unmapMappings([ref(1, "Alpha")]);
    expect(result.failed).toEqual({ name: "Alpha", reason: sentence, status: code });
  });

  it("an unreachable server (the request never completes) and a bad gateway use the repo's own wording", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("failed to fetch"); }));
    const down = await unmapMappings([ref(1, "Alpha"), ref(2)]);
    expect(down.failed).toEqual({ name: "Alpha", reason: "Can't reach the server. Check the network and try again.", status: 0 });
    expect(down.notTried).toBe(1);
    server([mapping(1)], status(502, "bad gateway")(is("GET", "/api/mappings/1")));
    const gateway = await unmapMappings([ref(1)]);
    expect(gateway.failed?.reason).toBe("The server is not answering (status 502). It may be restarting; try again in a moment.");
  });
});

describe("restoreMappings", () => {
  const nameOf = (m: Mapping) => `P${m.id}`;

  it("posts exactly the values read for a custom mapping: unit MW, scale 0.001, interval 1", async () => {
    const s = server([]);
    const removed = mapping(7, { point_id: 41, asset_id: 3, metric: "custom", scale: 0.001, interval_seconds: 1, custom_unit: "MW" });
    const result = await restoreMappings([removed], nameOf);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toEqual({
      method: "POST", path: "/api/mappings",
      body: { point_id: 41, asset_id: 3, metric: "custom", scale: 0.001, interval_seconds: 1, custom_unit: "MW" },
    });
    expect(result).toEqual({ done: 1, skipped: [], gone: 0, failed: null, notTried: 0 });
  });

  it("posts the default interval of a plain metric as it was read, and a null unit as null", async () => {
    const s = server([]);
    await restoreMappings([mapping(8, { point_id: 42, asset_id: 4, metric: "voltage_v", scale: 1, interval_seconds: 60 })], nameOf);
    expect(s.calls[0].body).toEqual({ point_id: 42, asset_id: 4, metric: "voltage_v", scale: 1, interval_seconds: 60, custom_unit: null });
  });

  it("stops at a 409 and reports what was put back, the failed one by name, and how many were not tried", async () => {
    const s = server([], status(409, "this point is already mapped, or the asset already has this metric")((c) => c.method === "POST" && (c.body as { point_id: number }).point_id === 1002));
    const result = await restoreMappings([mapping(1), mapping(2), mapping(3)], nameOf);
    expect(result.done).toBe(1);
    expect(result.failed).toEqual({ name: "P2", reason: "It is mapped again, or the asset already has that metric.", status: 409 });
    expect(result.notTried).toBe(1);
    expect(s.calls).toHaveLength(2);
  });

  it("a point or an asset that is gone (404) stops with a sentence for that", async () => {
    server([], status(404, "asset not found")(is("POST", "/api/mappings")));
    const result = await restoreMappings([mapping(1)], nameOf);
    expect(result.failed).toEqual({ name: "P1", reason: "The asset no longer exists.", status: 404 });
  });

  it("a point that is gone (404 naming the point) says so; a 404 that names neither says both could be gone", async () => {
    server([], status(404, "point not found")(is("POST", "/api/mappings")));
    expect((await restoreMappings([mapping(1)], nameOf)).failed).toEqual({ name: "P1", reason: "The point no longer exists.", status: 404 });
    server([], status(404, "not found")(is("POST", "/api/mappings")));
    expect((await restoreMappings([mapping(1)], nameOf)).failed?.reason).toBe("The point or the asset no longer exists.");
  });

  it("a request that got no answer cannot be read back (the new mapping has no id yet): it stops as unknown, and nothing is counted done for it", async () => {
    const s = server([], status(504, "gateway timeout")(is("POST", "/api/mappings")));
    const result = await restoreMappings([mapping(1), mapping(2)], nameOf);
    expect(result).toEqual({ done: 0, skipped: [], gone: 0, failed: { name: "P1", reason: NOT_ANSWERING, status: 504, unknown: true }, notTried: 1 });
    expect(s.calls.filter((c) => c.method === "GET")).toEqual([]);
  });
});

describe("moveMappings", () => {
  it("reads each mapping, moves the ones that are elsewhere with PATCH asset_id, and says where each came from", async () => {
    const s = server([mapping(1, { asset_id: 1 }), mapping(2, { asset_id: 2 })]);
    const result = await moveMappings([ref(1, "A", 1), ref(2, "B", 2)], 9);
    expect(s.writes()).toEqual(["PATCH /api/mappings/1", "PATCH /api/mappings/2"]);
    expect(s.calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ asset_id: 9 }, { asset_id: 9 }]);
    expect(result).toEqual({ moved: [{ id: 1, name: "A", from: 1, to: 9 }, { id: 2, name: "B", from: 2, to: 9 }], unchanged: 0, gone: 0, failed: null, notTried: 0 });
  });

  it("a mapping already on the target is unchanged and is not written", async () => {
    const s = server([mapping(1, { asset_id: 9 }), mapping(2, { asset_id: 1 })]);
    const result = await moveMappings([ref(1), ref(2)], 9);
    expect(s.writes()).toEqual(["PATCH /api/mappings/2"]);
    expect(result.unchanged).toBe(1);
    expect(result.moved).toEqual([{ id: 2, name: "P2", from: 1, to: 9 }]);
  });

  it("a 409 leaves that mapping where it was, stops the batch and counts what was not tried", async () => {
    const s = server([mapping(1), mapping(2), mapping(3)], status(409, "this point is already mapped, or the asset already has this metric")(is("PATCH", "/api/mappings/2")));
    const result = await moveMappings([ref(1, "A"), ref(2, "B"), ref(3, "C")], 9);
    expect(result.moved).toEqual([{ id: 1, name: "A", from: 1, to: 9 }]);
    expect(result.failed).toEqual({ name: "B", reason: "The asset already has that metric.", status: 409 });
    expect(result.notTried).toBe(1);
    expect(s.store.get(2)!.asset_id).toBe(1); // untouched
    expect(s.store.get(3)!.asset_id).toBe(1);
  });

  it("a mapping that is gone (404 on the read, or on the PATCH naming the mapping) is counted, and the batch goes on", async () => {
    server([mapping(2), mapping(3)], status(404, "mapping not found")(is("PATCH", "/api/mappings/3")));
    const result = await moveMappings([ref(1), ref(2), ref(3)], 9);
    expect(result.gone).toBe(2);
    expect(result.moved.map((m) => m.id)).toEqual([2]);
    expect(result.failed).toBeNull();
  });

  it("a target asset that is gone (404 naming the asset) is a failure, not a mapping that was already gone", async () => {
    server([mapping(1), mapping(2)], status(404, "asset not found")(is("PATCH", "/api/mappings/1")));
    const result = await moveMappings([ref(1, "A"), ref(2, "B")], 9);
    expect(result.gone).toBe(0);
    expect(result.failed).toEqual({ name: "A", reason: "The asset no longer exists.", status: 404 });
    expect(result.notTried).toBe(1);
  });
});

describe("moveBack", () => {
  const moved = [{ id: 1, name: "A", from: 1, to: 9 }, { id: 2, name: "B", from: 2, to: 9 }, { id: 3, name: "C", from: 1, to: 9 }];

  it("puts each mapping back on the asset it came from", async () => {
    const s = server([mapping(1, { asset_id: 9 }), mapping(2, { asset_id: 9 }), mapping(3, { asset_id: 9 })]);
    const result = await moveBack(moved);
    expect(s.calls.filter((c) => c.method === "PATCH").map((c) => [c.path, c.body])).toEqual([
      ["/api/mappings/1", { asset_id: 1 }], ["/api/mappings/2", { asset_id: 2 }], ["/api/mappings/3", { asset_id: 1 }],
    ]);
    expect(result).toEqual({ done: 3, skipped: [], gone: 0, failed: null, notTried: 0 });
  });

  it("never touches a mapping that has changed since: it is named in skipped and the rest goes on", async () => {
    const s = server([mapping(1, { asset_id: 9 }), mapping(2, { asset_id: 5 }), mapping(3, { asset_id: 9 })]);
    const result = await moveBack(moved);
    expect(s.writes()).toEqual(["PATCH /api/mappings/1", "PATCH /api/mappings/3"]);
    expect(result.skipped).toEqual(["B"]);
    expect(result.done).toBe(2);
    expect(s.store.get(2)!.asset_id).toBe(5);
  });

  it("a mapping that is gone is counted; a 409 stops and says so", async () => {
    server([mapping(2, { asset_id: 9 }), mapping(3, { asset_id: 9 })], status(409, "this point is already mapped, or the asset already has this metric")(is("PATCH", "/api/mappings/3")));
    const result = await moveBack(moved);
    expect(result.gone).toBe(1);
    expect(result.done).toBe(1);
    expect(result.failed).toEqual({ name: "C", reason: "The asset already has that metric.", status: 409 });
  });
});

describe("deleteMappings (the Undo of a mapping made by accept or by the bulk create)", () => {
  it("reads first and deletes only a mapping that is still on the asset it was made on", async () => {
    const s = server([mapping(1, { asset_id: 4 }), mapping(2, { asset_id: 8 }), mapping(3, { asset_id: 4 })]);
    const result = await deleteMappings([{ id: 1, assetId: 4, name: "A" }, { id: 2, assetId: 4, name: "B" }, { id: 3, assetId: 4 }]);
    expect(s.writes()).toEqual(["DELETE /api/mappings/1", "DELETE /api/mappings/3"]);
    expect(result).toEqual({ done: 2, skipped: ["B"], gone: 0, failed: null, notTried: 0 });
    expect(s.store.has(2)).toBe(true);
  });

  it("a mapping already gone is counted; a name is made up from the id when none was given", async () => {
    const s = server([mapping(2, { asset_id: 8 })]);
    const result = await deleteMappings([{ id: 1, assetId: 4 }, { id: 2, assetId: 4 }]);
    expect(result).toEqual({ done: 0, skipped: ["mapping 2"], gone: 1, failed: null, notTried: 0 });
    expect(s.writes()).toEqual([]);
  });

  it("stops at the first failed request", async () => {
    server([mapping(1, { asset_id: 4 }), mapping(2, { asset_id: 4 })], status(500, "disk full")(is("DELETE", "/api/mappings/1")));
    const result = await deleteMappings([{ id: 1, assetId: 4, name: "A" }, { id: 2, assetId: 4, name: "B" }]);
    expect(result.failed).toEqual({ name: "A", reason: "Disk full.", status: 500 });
    expect(result.notTried).toBe(1);
  });
});

describe("a write whose outcome is unknown (no answer, or a proxy's 502/503/504)", () => {
  const lost = (detail = "gateway timeout") => reply(504, { detail });
  const sentence = NOT_ANSWERING;

  it("DELETE lost and the re-read says 404: it went, so the value read BEFORE the delete is in removed and the batch goes on", async () => {
    const s = server([mapping(1, { scale: 0.5 }), mapping(2)], (call) => {
      if (!is("DELETE", "/api/mappings/1")(call)) return undefined;
      s.store.delete(1); // the api committed; only the answer was lost
      return lost();
    });
    const result = await unmapMappings([ref(1, "A"), ref(2, "B")]);
    expect(result).toEqual({ removed: [mapping(1, { scale: 0.5 }), mapping(2)], skipped: [], gone: 0, failed: null, notTried: 0 });
  });

  it("DELETE lost and the mapping is still there: the write failed as it said, nothing is kept for the Undo", async () => {
    server([mapping(1), mapping(2)], status(504, "gateway timeout")(is("DELETE", "/api/mappings/1")));
    const result = await unmapMappings([ref(1, "A"), ref(2, "B")]);
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual({ name: "A", reason: sentence, status: 504 });
    expect(result.notTried).toBe(1);
  });

  it("DELETE lost and the re-read fails too: the mapping is kept for the Undo, the batch stops, and the failure is marked unknown", async () => {
    let reads = 0;
    server([mapping(1), mapping(2)], (call) => {
      if (is("DELETE", "/api/mappings/1")(call)) return lost();
      if (is("GET", "/api/mappings/1")(call)) { reads += 1; return reads === 2 ? lost() : undefined; }
      return undefined;
    });
    const result = await unmapMappings([ref(1, "A"), ref(2, "B")]);
    expect(result.removed).toEqual([mapping(1)]);
    expect(result.failed).toEqual({ name: "A", reason: sentence, status: 504, unknown: true });
    expect(result.notTried).toBe(1);
  });

  it("a refused write (a 500) is not re-read: it did not go", async () => {
    const s = server([mapping(1)], status(500, "database is busy")(is("DELETE", "/api/mappings/1")));
    await unmapMappings([ref(1)]);
    expect(s.calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("a request that never completes counts as unknown too", async () => {
    const s = server([mapping(1)], (call) => {
      if (!is("DELETE", "/api/mappings/1")(call)) return undefined;
      s.store.delete(1);
      throw new TypeError("failed to fetch"); // the fetch rejects: the client calls it status 0
    });
    const result = await unmapMappings([ref(1, "A")]);
    expect(s.calls.filter((c) => c.method === "GET")).toHaveLength(2); // the read before, and the check
    expect(result).toEqual({ removed: [mapping(1)], skipped: [], gone: 0, failed: null, notTried: 0 });
  });

  it("PATCH lost but the stored mapping changed: it is in moved, and the Undo moves it back", async () => {
    let first = true; // only the move loses its answer, not the Undo
    const s = server([mapping(1), mapping(2), mapping(3)], (call) => {
      if (!first || !is("PATCH", "/api/mappings/2")(call)) return undefined;
      first = false;
      s.store.get(2)!.asset_id = 9;
      return lost();
    });
    const result = await moveMappings([ref(1, "A"), ref(2, "B"), ref(3, "C")], 9);
    expect(result.failed).toBeNull();
    expect(result.moved).toEqual([{ id: 1, name: "A", from: 1, to: 9 }, { id: 2, name: "B", from: 1, to: 9 }, { id: 3, name: "C", from: 1, to: 9 }]);
    const back = await moveBack(result.moved);
    expect(back.done).toBe(3);
    expect([...s.store.values()].map((m) => m.asset_id)).toEqual([1, 1, 1]);
  });

  it("PATCH lost and the mapping did not move: the write failed as it said, only the earlier ones are in moved", async () => {
    server([mapping(1), mapping(2), mapping(3)], status(504, "gateway timeout")(is("PATCH", "/api/mappings/2")));
    const result = await moveMappings([ref(1, "A"), ref(2, "B"), ref(3, "C")], 9);
    expect(result.moved.map((m) => m.id)).toEqual([1]);
    expect(result.failed).toEqual({ name: "B", reason: sentence, status: 504 });
    expect(result.notTried).toBe(1);
  });

  it("PATCH lost and the re-read fails too: kept in moved for the Undo (which checks before it writes), failure marked unknown", async () => {
    let reads = 0;
    let first = true;
    const s = server([mapping(1), mapping(2)], (call) => {
      if (first && is("PATCH", "/api/mappings/2")(call)) { first = false; s.store.get(2)!.asset_id = 9; return lost(); }
      if (is("GET", "/api/mappings/2")(call)) { reads += 1; return reads === 2 ? lost() : undefined; } // the read before, then the check that fails
      return undefined;
    });
    const result = await moveMappings([ref(1, "A"), ref(2, "B")], 9);
    expect(result.moved.map((m) => m.id)).toEqual([1, 2]);
    expect(result.failed).toEqual({ name: "B", reason: sentence, status: 504, unknown: true });
    // It had moved, so the Undo puts it back; had it not, the Undo would leave it alone and say so.
    expect((await moveBack(result.moved)).done).toBe(2);
    s.store.get(1)!.asset_id = 9;
    s.store.get(2)!.asset_id = 5;
    expect((await moveBack(result.moved)).skipped).toEqual(["B"]);
  });

  it("an Undo write that is lost is checked the same way: moveBack and deleteMappings count it done when the re-read shows it went", async () => {
    const s = server([mapping(1, { asset_id: 9 }), mapping(2, { asset_id: 4 })], (call) => {
      if (is("PATCH", "/api/mappings/1")(call)) { s.store.get(1)!.asset_id = 1; return lost(); }
      if (is("DELETE", "/api/mappings/2")(call)) { s.store.delete(2); return lost(); }
      return undefined;
    });
    expect(await moveBack([{ id: 1, name: "A", from: 1, to: 9 }])).toEqual({ done: 1, skipped: [], gone: 0, failed: null, notTried: 0 });
    expect(await deleteMappings([{ id: 2, assetId: 4, name: "B" }])).toEqual({ done: 1, skipped: [], gone: 0, failed: null, notTried: 0 });
  });
});

describe("reasonOf", () => {
  it("a throw that is not an ApiError is its message, capitalised, with a stop", () => {
    expect(reasonOf(new Error("boom"))).toBe("Boom.");
    expect(reasonOf(new TypeError("Failed to fetch."))).toBe("Failed to fetch.");
    expect(reasonOf("plain words")).toBe("Plain words.");
  });

  it("a 409 says what a move can clash on, and what a create can clash on", () => {
    expect(reasonOf(new ApiError(409, "x"), "move")).toBe("The asset already has that metric.");
    expect(reasonOf(new ApiError(409, "x"), "create")).toBe("It is mapped again, or the asset already has that metric.");
    expect(reasonOf(new ApiError(409, "something else"))).toBe("Something else.");
  });
});

describe("moveConflicts and moveConflictText", () => {
  const row = (id: number, name: string, metric: Metric, assetId = 1) => ({ id, name, metric, assetId });

  it("names the rows whose metric the target already has", () => {
    expect(moveConflicts([row(1, "kW", "active_power_kw"), row(2, "V", "voltage_v")], new Set<Metric>(["voltage_v"]), 9)).toEqual(["V"]);
  });

  it("names two moved rows that share a metric (both), even when the target has nothing", () => {
    expect(moveConflicts([row(1, "kW 1", "active_power_kw"), row(2, "kW 2", "active_power_kw"), row(3, "V", "voltage_v")], new Set(), 9)).toEqual(["kW 1", "kW 2"]);
  });

  it("never counts custom, not even twice, not even when the target has one", () => {
    expect(moveConflicts([row(1, "X", "custom"), row(2, "Y", "custom")], new Set<Metric>(["custom"]), 9)).toEqual([]);
  });

  it("ignores the rows that are on the target already: they do not move, so they cannot clash with it (its metric still counts as taken)", () => {
    // Panel 9 has voltage_v because V is on it. V is not moved; kW is. Nothing clashes.
    const rows = [row(1, "kW", "active_power_kw", 1), row(2, "V", "voltage_v", 9)];
    const taken = new Set<Metric>(["voltage_v"]);
    expect(moveConflicts(rows, taken, 9)).toEqual([]);
    expect(moveConflictText(rows, taken, 9, "Panel 9")).toBeNull();
    // A third row with the same metric as the one already there does clash.
    const more = [...rows, row(3, "V2", "voltage_v", 1)];
    expect(moveConflicts(more, taken, 9)).toEqual(["V2"]);
    // Two rows that share a metric only count when both would move.
    expect(moveConflicts([row(1, "V1", "voltage_v", 9), row(2, "V2", "voltage_v", 1)], new Set(), 9)).toEqual([]);
  });

  it("says why in a sentence: the target has it, or two of the rows map the same metric", () => {
    const rows = [row(1, "kW", "active_power_kw"), row(2, "V1", "voltage_v"), row(3, "V2", "voltage_v")];
    expect(moveConflictText(rows.slice(0, 1), new Set<Metric>(["active_power_kw"]), 9, "Panel 1")).toBe('"kW" would clash: Panel 1 already has that metric.');
    expect(moveConflictText(rows.slice(1), new Set(), 9, "Panel 1")).toBe('"V1", "V2" would clash: they map the same metric, and an asset can have each metric once.');
    expect(moveConflictText(rows, new Set<Metric>(["active_power_kw"]), 9, "Panel 1")).toBe(
      '"kW" would clash: Panel 1 already has that metric. "V1", "V2" would clash: they map the same metric, and an asset can have each metric once.',
    );
    expect(moveConflictText(rows, new Set(), 9, "Panel 1")).not.toContain("kW");
    expect(moveConflictText([row(1, "kW", "active_power_kw")], new Set(), 9, "Panel 1")).toBeNull();
  });

  it("shortens a long list of names", () => {
    const many = ["a", "b", "c", "d", "e"].map((n, i) => row(i, n, "active_power_kw"));
    expect(moveConflictText(many, new Set(), 9, "P")).toContain('"a", "b", "c" and 2 more would clash');
  });
});

describe("isContainerKind and containerNote", () => {
  const kinds = [
    { name: "Data hall", icon: "hall" },
    { name: "Panel", icon: "panel" },
    { name: "Rack", icon: "rack" },
    { name: "Aisle", icon: "row" },
  ] as Pick<AssetKind, "name" | "icon">[];

  it("a registered kind is a container by the icon the registry gives it: 'Data hall' has the hall icon", () => {
    expect(isContainerKind("Data hall", kinds)).toBe(true);
    expect(isContainerKind("data   HALL", kinds)).toBe(true); // matched by kindKey
  });

  it("an unregistered kind is judged by the keyword guess: 'Room 4' is a room", () => {
    expect(isContainerKind("Room 4", kinds)).toBe(true);
    expect(isContainerKind("Room 4", undefined)).toBe(true);
    expect(isContainerKind("Building", [])).toBe(true);
  });

  it("Panel, Rack and generic are not containers (that is where meters belong)", () => {
    expect(isContainerKind("Panel", kinds)).toBe(false);
    expect(isContainerKind("Rack", kinds)).toBe(false);
    expect(isContainerKind("generic", kinds)).toBe(false);
    expect(isContainerKind("generic", undefined)).toBe(false);
  });

  it("the registry's icon wins over the keyword guess: a kind called 'Room' that was given the panel icon is not a container", () => {
    expect(isContainerKind("Room", [{ name: "Room", icon: "panel" }])).toBe(false);
  });

  it("the note names the asset and its kind with a or an, and ends in the verb's own question", () => {
    expect(containerNote({ name: "Room 1", kind: "room" }, kinds, "Map")).toBe("Room 1 is a room; meters usually belong to a Panel or Rack. Map here anyway?");
    expect(containerNote({ name: "Room 1", kind: "Room" }, kinds, "Move")).toBe("Room 1 is a room; meters usually belong to a Panel or Rack. Move here anyway?");
    expect(containerNote({ name: "Aisle B", kind: "Aisle" }, kinds, "Move")).toBe("Aisle B is an aisle; meters usually belong to a Panel or Rack. Move here anyway?");
  });

  it("keeps the kind as typed, except that a capital first letter is lowered unless the second is a capital too (UPS, LV)", () => {
    const end = "; meters usually belong to a Panel or Rack. Map here anyway?";
    const registry = [...kinds, { name: "UPS room", icon: "room" }, { name: "LV room", icon: "room" }]; // "UPS room" alone would be guessed as a UPS
    expect(containerNote({ name: "R1", kind: "UPS room" }, registry, "Map")).toBe(`R1 is an UPS room${end}`);
    expect(containerNote({ name: "R2", kind: "LV room" }, registry, "Map")).toBe(`R2 is a LV room${end}`);
    expect(containerNote({ name: "R3", kind: "  Server   room " }, kinds, "Map")).toBe(`R3 is a server room${end}`);
  });

  it("is null for a place meters belong", () => {
    expect(containerNote({ name: "Panel 1", kind: "Panel" }, kinds, "Map")).toBeNull();
    expect(containerNote({ name: "Thing", kind: "generic" }, kinds, "Map")).toBeNull();
  });
});

describe("the words", () => {
  it("unmap, one point on one asset: the message never lies about billing and says what charts show", () => {
    expect(unmapPrompt({ count: 1, name: "kW", asset: "Room 1", assetCount: 1 })).toEqual({
      title: 'Unmap "kW" from Room 1?',
      message:
        "This point stops counting toward Room 1. Billing for months that are still open is recalculated without it; closed months keep their billed figures. " +
        "Charts and dashboards show the asset without this point.",
    });
  });

  it("unmap, several points: plural words; the title counts them", () => {
    expect(unmapPrompt({ count: 3, name: "kW", asset: "Room 1", assetCount: 1 })).toEqual({
      title: "Unmap 3 points from Room 1?",
      message:
        "These points stop counting toward Room 1. Billing for months that are still open is recalculated without them; closed months keep their billed figures. " +
        "Charts and dashboards show the asset without these points.",
    });
  });

  it("unmap, points on several assets: 'from N assets' in the title and 'their assets' in the message; a given subject names a group", () => {
    const several = unmapPrompt({ count: 4, name: "kW", asset: null, assetCount: 2 });
    expect(several.title).toBe("Unmap 4 points from 2 assets?");
    expect(several.message).toContain("These points stop counting toward their assets.");
    expect(several.message).toContain("Charts and dashboards show their assets without these points.");
    expect(unmapPrompt({ count: 6, name: "kW", asset: "Room 1", assetCount: 1, what: 'the group "LVP01"' }).title).toBe('Unmap the group "LVP01" from Room 1?');
  });

  it("move: the billing sentence says they are recalculated under the target, and the closed months stay", () => {
    expect(moveMessage(3, "Panel 1")).toBe("Billing for months that are still open is recalculated with them under Panel 1; closed months keep their billed figures.");
    expect(moveMessage(1, "Panel 1")).toBe("Billing for months that are still open is recalculated with it under Panel 1; closed months keep their billed figures.");
    expect(moveMessage(2)).toBe("Billing for months that are still open is recalculated with them under the asset you choose; closed months keep their billed figures.");
    expect(moveTitle(1, "kW")).toBe('Move "kW" to another asset');
    expect(moveTitle(3, "kW")).toBe("Move 3 points to another asset");
    expect(moveTitle(6, "kW", 'the group "LVP01"')).toBe('Move the group "LVP01" to another asset');
  });

  it("unmap results: success, already gone, partial failure and a plain failure", () => {
    const removed = [mapping(1), mapping(2), mapping(3)];
    const clean = { skipped: [], gone: 0, failed: null, notTried: 0 };
    expect(unmapOutcome({ removed, ...clean }, "Room 1", 3)).toEqual({ kind: "success", text: "Unmapped 3 points from Room 1." });
    expect(unmapOutcome({ removed: [mapping(1)], ...clean }, "Room 1", 1)).toEqual({ kind: "success", text: "Unmapped 1 point from Room 1." });
    expect(unmapOutcome({ removed: [mapping(1)], ...clean, gone: 1 }, "Room 1", 2).text).toBe("Unmapped 1 point from Room 1. 1 was already gone.");
    expect(unmapOutcome({ removed: [], ...clean, gone: 2 }, "Room 1", 2)).toEqual({ kind: "info", text: GONE_TEXT });
    expect(GONE_TEXT).toBe("Those mappings were already gone.");
    const failed = { name: "Beta", reason: "Database is busy.", status: 500 };
    expect(unmapOutcome({ removed: [mapping(1)], ...clean, failed, notTried: 2 }, "Room 1", 4)).toEqual({
      kind: "error", text: 'Unmapped 1 of 4. "Beta" could not be unmapped: Database is busy. 2 were not tried.',
    });
    expect(unmapOutcome({ removed: [], ...clean, failed, notTried: 1 }, "Room 1", 2)).toEqual({
      kind: "error", text: '"Beta" could not be unmapped: Database is busy. 1 was not tried.',
    });
  });

  it("unmap results: the failure sentence also says the ones already gone, so the numbers add up", () => {
    const failed = { name: "Beta", reason: "Database is busy.", status: 500 };
    expect(unmapOutcome({ removed: [mapping(1)], skipped: [], gone: 1, failed, notTried: 1 }, "Room 1", 4).text).toBe(
      'Unmapped 1 of 4. "Beta" could not be unmapped: Database is busy. 1 was not tried. 1 was already gone.',
    );
  });

  it("unmap results: a mapping that was moved since is left alone and named; all of them left alone is an info toast, not 'already gone'", () => {
    const clean = { gone: 0, failed: null, notTried: 0 };
    expect(unmapOutcome({ removed: [], skipped: ["kW"], ...clean }, "Room 1", 1)).toEqual({ kind: "info", text: '"kW" was moved since, so it was left alone.' });
    expect(unmapOutcome({ removed: [], skipped: ["A", "B"], ...clean, gone: 1 }, "Room 1", 3).text).toBe(
      '"A", "B" were moved since, so they were left alone. 1 was already gone.',
    );
    expect(unmapOutcome({ removed: [mapping(1)], skipped: ["kW"], ...clean }, "Room 1", 2)).toEqual({
      kind: "info", text: 'Unmapped 1 point from Room 1. "kW" was moved since, so it was left alone.',
    });
    expect(unmapOutcome({ removed: [mapping(1)], skipped: ["kW"], gone: 0, failed: { name: "Beta", reason: "Database is busy.", status: 500 }, notTried: 1 }, "Room 1", 4).text).toBe(
      'Unmapped 1 of 4. "Beta" could not be unmapped: Database is busy. 1 was not tried. "kW" was moved since, so it was left alone.',
    );
  });

  it("unmap results: a write of unknown outcome is 'may or may not', and the count leaves it out", () => {
    const failed = { name: "Beta", reason: NOT_ANSWERING, status: 504, unknown: true as const };
    // removed holds Beta too (kept for the Undo), but only the first was surely unmapped.
    expect(unmapOutcome({ removed: [mapping(1), mapping(2)], skipped: [], gone: 0, failed, notTried: 1 }, "Room 1", 4)).toEqual({
      kind: "error", text: `Unmapped 1 of 4. "Beta" may or may not have been unmapped: ${NOT_ANSWERING} 1 was not tried.`,
    });
  });

  it("move results: success, unchanged and gone, the 409 of a single move names the asset and the metric, partial failure", () => {
    const moved = [{ id: 1, name: "A", from: 1, to: 9 }, { id: 2, name: "B", from: 1, to: 9 }, { id: 3, name: "C", from: 1, to: 9 }];
    const clean = { unchanged: 0, gone: 0, failed: null, notTried: 0 };
    expect(moveOutcome({ moved, ...clean }, 3, "Panel 1")).toEqual({ kind: "success", text: "Moved 3 points to Panel 1." });
    expect(moveOutcome({ moved: moved.slice(0, 1), ...clean, unchanged: 1, gone: 1 }, 3, "Panel 1").text).toBe("Moved 1 point to Panel 1. 1 was already there. 1 was already gone.");
    expect(moveOutcome({ moved: [], ...clean, unchanged: 2 }, 2, "Panel 1")).toEqual({ kind: "info", text: "Already on Panel 1. Nothing changed." });
    expect(moveOutcome({ moved: [], ...clean, gone: 2 }, 2, "Panel 1")).toEqual({ kind: "info", text: GONE_TEXT });
    const conflict = { name: "V", reason: "The asset already has that metric.", status: 409 };
    expect(moveOutcome({ moved: [], unchanged: 0, gone: 0, failed: conflict, notTried: 0 }, 1, "Panel 1", "voltage_v")).toEqual({
      kind: "error", text: '"V" could not be moved: Panel 1 already has voltage_v.',
    });
    expect(moveOutcome({ moved: [], unchanged: 0, gone: 0, failed: conflict, notTried: 0 }, 1, "Panel 1", "custom").text).toContain("The asset already has that metric.");
    expect(moveOutcome({ moved: moved.slice(0, 2), unchanged: 0, gone: 0, failed: conflict, notTried: 1 }, 4, "Panel 1")).toEqual({
      kind: "error", text: 'Moved 2 of 4. "V" could not be moved: The asset already has that metric. 1 was not tried.',
    });
  });

  it("move results: the failure sentence also says the ones already there and the ones already gone, so the numbers add up", () => {
    const moved = [{ id: 1, name: "A", from: 1, to: 9 }];
    const failed = { name: "C", reason: "The asset already has that metric.", status: 409 };
    expect(moveOutcome({ moved, unchanged: 1, gone: 1, failed, notTried: 1 }, 5, "Panel 1").text).toBe(
      'Moved 1 of 5. "C" could not be moved: The asset already has that metric. 1 was not tried. 1 was already there. 1 was already gone.',
    );
    expect(moveOutcome({ moved: [], unchanged: 2, gone: 0, failed, notTried: 0 }, 3, "Panel 1").text).toBe(
      '"C" could not be moved: The asset already has that metric. 2 were already there.',
    );
  });

  it("move results: a write of unknown outcome is 'may or may not', and the count leaves it out", () => {
    const moved = [{ id: 1, name: "A", from: 1, to: 9 }, { id: 2, name: "B", from: 1, to: 9 }];
    const failed = { name: "B", reason: NOT_ANSWERING, status: 504, unknown: true as const };
    expect(moveOutcome({ moved, unchanged: 0, gone: 0, failed, notTried: 1 }, 4, "Panel 1")).toEqual({
      kind: "error", text: `Moved 1 of 4. "B" may or may not have been moved: ${NOT_ANSWERING} 1 was not tried.`,
    });
  });

  it("Undo results: put back, the honest partial sentence, skipped and gone ones named, and the new assets that stay", () => {
    const clean = { skipped: [], gone: 0, failed: null, notTried: 0 };
    expect(undoOutcome("restore", { done: 3, ...clean }, 3)).toEqual({ kind: "success", text: "Put back 3 mappings." });
    expect(undoOutcome("restore", { done: 1, ...clean }, 1).text).toBe("Put back 1 mapping.");
    expect(undoOutcome("restore", { done: 2, ...clean, failed: { name: "X", reason: "It is mapped again, or the asset already has that metric.", status: 409 }, notTried: 1 }, 4)).toEqual({
      kind: "error", text: 'Put back 2 of 4. "X" could not be restored: It is mapped again, or the asset already has that metric. 1 was not tried.',
    });
    expect(undoOutcome("moveBack", { done: 2, ...clean, skipped: ["B"] }, 3)).toEqual({
      kind: "info", text: 'Put back 2 mappings. "B" was changed since, so nothing was undone for it.',
    });
    expect(undoOutcome("moveBack", { done: 0, ...clean, skipped: ["A", "B"] }, 2).text).toBe('"A", "B" were changed since, so nothing was undone for them.');
    expect(undoOutcome("moveBack", { done: 1, ...clean, gone: 1 }, 2).text).toBe("Put back 1 mapping. 1 was already gone.");
    expect(undoOutcome("restore", { done: 0, ...clean, gone: 2 }, 2)).toEqual({ kind: "info", text: GONE_TEXT });
    expect(undoOutcome("deleteMade", { done: 6, ...clean }, 6, [])).toEqual({ kind: "success", text: "Unmapped 6 points." });
    expect(undoOutcome("deleteMade", { done: 6, ...clean }, 6, ["Room 1"]).text).toBe("Unmapped 6 points. Room 1 stays; delete it from Assets Tree if you do not need it.");
    expect(undoOutcome("deleteMade", { done: 4, ...clean, skipped: ["kW"] }, 5, ["Room 1"])).toEqual({
      kind: "info", text: 'Unmapped 4 points. Room 1 stays; delete it from Assets Tree if you do not need it. "kW" was changed since, so nothing was undone for it.',
    });
    expect(undoOutcome("deleteMade", { done: 1, ...clean, failed: { name: "kW", reason: "Disk full.", status: 500 }, notTried: 2 }, 4).text).toBe(
      'Unmapped 1 of 4. "kW" could not be unmapped: Disk full. 2 were not tried.',
    );
  });

  it("Undo of a mapping made in Discovery: the new assets that stay are named on EVERY outcome, a failure and a nothing-done too", () => {
    const clean = { skipped: [], gone: 0, failed: null, notTried: 0 };
    const stays = "Room 1 stays; delete it from Assets Tree if you do not need it.";
    expect(undoOutcome("deleteMade", { done: 1, ...clean, failed: { name: "kW", reason: "Disk full.", status: 500 }, notTried: 2 }, 4, ["Room 1"]).text).toBe(
      `Unmapped 1 of 4. "kW" could not be unmapped: Disk full. 2 were not tried. ${stays}`,
    );
    expect(undoOutcome("deleteMade", { done: 0, ...clean, failed: { name: "kW", reason: "Disk full.", status: 500 } }, 2, ["Room 1"]).text).toBe(
      `"kW" could not be unmapped: Disk full. ${stays}`,
    );
    expect(undoOutcome("deleteMade", { done: 0, ...clean, skipped: ["kW"] }, 1, ["Room 1"])).toEqual({
      kind: "info", text: `${stays} "kW" was changed since, so nothing was undone for it.`,
    });
    expect(undoOutcome("deleteMade", { done: 0, ...clean, gone: 2 }, 2, ["Room 1"])).toEqual({ kind: "info", text: `${GONE_TEXT} ${stays}` });
    expect(undoOutcome("deleteMade", { done: 0, ...clean, gone: 2 }, 2, [])).toEqual({ kind: "info", text: GONE_TEXT });
    // Only an unmap leaves assets behind: the other two Undos say nothing about them.
    expect(undoOutcome("moveBack", { done: 1, ...clean }, 1, ["Room 1"]).text).toBe("Put back 1 mapping.");
  });

  it("Undo results: a write of unknown outcome is 'may or may not'; a restore (nothing to read back) tells the person to look", () => {
    const clean = { skipped: [], gone: 0, notTried: 0 };
    const failed = { name: "B", reason: NOT_ANSWERING, status: 504, unknown: true as const };
    expect(undoOutcome("moveBack", { done: 1, ...clean, failed }, 3).text).toBe(`Put back 1 of 3. "B" may or may not have been moved back: ${NOT_ANSWERING}`);
    expect(undoOutcome("deleteMade", { done: 0, ...clean, failed }, 3).text).toBe(`"B" may or may not have been unmapped: ${NOT_ANSWERING}`);
    expect(undoOutcome("restore", { done: 1, ...clean, failed, notTried: 1 }, 3).text).toBe(
      `Put back 1 of 3. "B" may have been restored: ${NOT_ANSWERING} Check the asset before you try again. 1 was not tried.`,
    );
  });

  it("the unmap prompt for one point in a named group still says 'this point'", () => {
    const one = unmapPrompt({ count: 1, name: "kW", asset: "Room 1", assetCount: 1, what: 'the group "LVP01"' });
    expect(one.title).toBe('Unmap the group "LVP01" from Room 1?');
    expect(one.message).toContain("This point stops counting toward Room 1.");
    expect(one.message).toContain("recalculated without it;");
    expect(one.message).toContain("show the asset without this point.");
  });

  it("names the assets that stay, one or several", () => {
    expect(staysText(["Room 1"])).toBe("Room 1 stays; delete it from Assets Tree if you do not need it.");
    expect(staysText(["Room 1", "Room 2"])).toBe("Room 1 and Room 2 stay; delete them from Assets Tree if you do not need them.");
    expect(staysText(["A", "B", "C"])).toBe("A, B and C stay; delete them from Assets Tree if you do not need them.");
    expect(staysText(["A", "B", "C", "D"])).toBe("4 new assets stay; delete them from Assets Tree if you do not need them.");
  });
});
