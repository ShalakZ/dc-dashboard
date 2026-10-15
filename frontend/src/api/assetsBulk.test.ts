import type { AssetImpact } from "./types";
import { deleteAssetsOneByOne, loadImpacts, type RemoveItem } from "./assetsBulk";
import { ApiError } from "./client";

interface Reply { status: number; body?: unknown }
const ok: Reply = { status: 204 };
const impact = (assets: number, mappings = 0, tariffs = 0): AssetImpact => ({ assets, mappings, tariffs });
const item = (id: number, seen: AssetImpact = impact(1)): RemoveItem => ({ id, name: `Asset ${id}`, seen });

/** Replaces fetch: `handler` answers each request (it may wait, or throw to fail like a dead network). Every request is logged as it is sent and as it is answered. */
function stubServer(handler: (req: { method: string; id: number; url: string }) => Reply | Promise<Reply>) {
  const events: string[] = [];
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const id = Number(/\/api\/assets\/(\d+)/.exec(url)?.[1]);
      urls.push(`${method} ${url}`);
      events.push(`${method} ${id} sent`);
      const reply = await handler({ method, id, url });
      events.push(`${method} ${id} answered`);
      if (reply.status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { "content-type": "application/json" } });
    }),
  );
  return { events, urls };
}

const later = (reply: Reply) => new Promise<Reply>((resolve) => setTimeout(() => resolve(reply), 0));

describe("loadImpacts", () => {
  it("asks for the impact of each root and returns them keyed by root, in the order asked", async () => {
    const { urls } = stubServer(({ id }) => ({ status: 200, body: impact(id, id * 2, 0) }));
    const answer = await loadImpacts([5, 3, 9]);
    expect(urls.sort()).toEqual(["GET /api/assets/3/impact", "GET /api/assets/5/impact", "GET /api/assets/9/impact"]);
    expect([...answer.keys()]).toEqual([5, 3, 9]);
    expect(answer.get(3)).toEqual(impact(3, 6, 0));
  });

  it("asks for nothing when there are no roots", async () => {
    const { urls } = stubServer(() => ok);
    expect((await loadImpacts([])).size).toBe(0);
    expect(urls).toEqual([]);
  });

  it("answers null for a root whose impact is 404 (somebody deleted it already) and carries on with the rest", async () => {
    stubServer(({ id }) => (id === 4 ? { status: 404, body: { detail: "asset not found" } } : { status: 200, body: impact(1) }));
    const answer = await loadImpacts([3, 4, 5]);
    expect([...answer.entries()]).toEqual([[3, impact(1)], [4, null], [5, impact(1)]]);
  });

  it.each([
    ["a 500", { status: 500, body: { detail: "database is locked" } }, 500],
    ["a lost session", { status: 401, body: { detail: "not authenticated" } }, 401],
    ["a role that may not", { status: 403, body: { detail: "insufficient permission" } }, 403],
  ])("rejects with the error for %s, whichever root it came from", async (_name, reply, status) => {
    stubServer(({ id }) => (id === 2 ? reply : { status: 200, body: impact(1) }));
    await expect(loadImpacts([1, 2, 3])).rejects.toMatchObject({ status });
    await expect(loadImpacts([1, 2, 3])).rejects.toBeInstanceOf(ApiError);
  });

  it("starts no more requests once one has failed", async () => {
    const { urls } = stubServer(({ id }) => (id === 2 ? { status: 500, body: { detail: "boom" } } : { status: 200, body: impact(1) }));
    await expect(loadImpacts(Array.from({ length: 40 }, (_, i) => i + 1))).rejects.toMatchObject({ status: 500 });
    expect(urls.length).toBeLessThanOrEqual(12); // the six that were in flight, and at most a handful more before the failure was noticed
  });

  it("has at most six requests in flight, and keeps six going until the roots run out", async () => {
    let inFlight = 0;
    let peak = 0;
    const held: (() => void)[] = [];
    stubServer(() => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<Reply>((resolve) => held.push(() => { inFlight -= 1; resolve({ status: 200, body: impact(1) }); }));
    });
    const ids = Array.from({ length: 15 }, (_, i) => i + 1);
    const done = loadImpacts(ids);
    await vi.waitFor(() => expect(held).toHaveLength(6)); // six asked for, nine waiting
    let released = 0;
    while (released < ids.length) {
      held[released]();
      released += 1;
      await vi.waitFor(() => expect(inFlight).toBe(Math.min(6, ids.length - released))); // the pool refills as one answers
    }
    const answer = await done;
    expect(peak).toBe(6);
    expect(answer.size).toBe(15);
  });

  it("asks for all of a few roots at once", async () => {
    let peak = 0;
    let inFlight = 0;
    stubServer(() => { inFlight += 1; peak = Math.max(peak, inFlight); return later({ status: 200, body: impact(1) }).then((r) => { inFlight -= 1; return r; }); });
    await loadImpacts([1, 2, 3]);
    expect(peak).toBe(3);
  });
});

describe("deleteAssetsOneByOne", () => {
  it("deletes each root with the counts its dialog showed, zeros included, and says what went", async () => {
    const { urls } = stubServer(() => ok);
    const answer = await deleteAssetsOneByOne([item(3, impact(1)), item(1, impact(41, 2, 1)), item(2, impact(5, 0, 4))]);
    expect(urls).toEqual([
      "DELETE /api/assets/3?confirm=true&expect_assets=1&expect_mappings=0&expect_tariffs=0",
      "DELETE /api/assets/1?confirm=true&expect_assets=41&expect_mappings=2&expect_tariffs=1",
      "DELETE /api/assets/2?confirm=true&expect_assets=5&expect_mappings=0&expect_tariffs=4",
    ]);
    expect(answer).toEqual({ deleted: [3, 1, 2], gone: [], failed: null, notTried: [], assets: 47 });
  });

  it("sends nothing for nothing", async () => {
    const { urls } = stubServer(() => ok);
    expect(await deleteAssetsOneByOne([])).toEqual({ deleted: [], gone: [], failed: null, notTried: [], assets: 0 });
    expect(urls).toEqual([]);
  });

  it("waits for each answer before it sends the next request", async () => {
    const { events } = stubServer(() => later(ok));
    await deleteAssetsOneByOne([item(1), item(2), item(3)]);
    expect(events).toEqual(["DELETE 1 sent", "DELETE 1 answered", "DELETE 2 sent", "DELETE 2 answered", "DELETE 3 sent", "DELETE 3 answered"]);
  });

  it("counts a root that is gone already (404) as gone, not as a failure, and goes on with the rest", async () => {
    const { urls } = stubServer(({ id }) => (id === 2 ? { status: 404, body: { detail: "asset not found" } } : ok));
    const answer = await deleteAssetsOneByOne([item(1, impact(3)), item(2, impact(7)), item(3, impact(2))]);
    expect(urls).toHaveLength(3);
    expect(answer).toEqual({ deleted: [1, 3], gone: [2], failed: null, notTried: [], assets: 5 }); // the gone root's 7 are not counted
  });

  it("stops at the first failure: that root is failed, the roots after it were not tried", async () => {
    const { urls } = stubServer(({ id }) => (id === 2 ? { status: 500, body: { detail: "database is locked" } } : ok));
    const answer = await deleteAssetsOneByOne([item(1, impact(4)), item(2, impact(9)), item(3), item(4)]);
    expect(urls).toHaveLength(2); // nothing was sent for 3 and 4
    expect(answer).toEqual({
      deleted: [1],
      gone: [],
      failed: { id: 2, name: "Asset 2", reason: "Database is locked." },
      notTried: [3, 4], // the roots AFTER the failing one: not the failing one itself
      assets: 4, // the failed root's 9 are not counted
    });
    expect(answer.failed).not.toHaveProperty("now");
  });

  it("fails on the first root: nothing is deleted and every other root is not tried", async () => {
    stubServer(() => ({ status: 500, body: { detail: "boom" } }));
    const answer = await deleteAssetsOneByOne([item(1), item(2), item(3)]);
    expect(answer).toMatchObject({ deleted: [], gone: [], failed: { id: 1 }, notTried: [2, 3], assets: 0 });
  });

  it("fails on the last root: nothing is left untried", async () => {
    stubServer(({ id }) => (id === 3 ? { status: 500, body: { detail: "boom" } } : ok));
    const answer = await deleteAssetsOneByOne([item(1), item(2), item(3)]);
    expect(answer).toMatchObject({ deleted: [1, 2], failed: { id: 3 }, notTried: [] });
  });

  it("keeps the gone roots before a failure, and the roots after it untried", async () => {
    stubServer(({ id }) => (id === 1 ? { status: 404, body: { detail: "asset not found" } } : id === 2 ? { status: 500, body: { detail: "boom" } } : ok));
    const answer = await deleteAssetsOneByOne([item(1), item(2), item(3)]);
    expect(answer).toMatchObject({ deleted: [], gone: [1], failed: { id: 2 }, notTried: [3], assets: 0 });
  });

  it("reads a 409 as 'more was added' and carries the new counts, so the dialog can show them", async () => {
    stubServer(({ id }) => (id === 2
      ? { status: 409, body: { detail: "More than you were shown would be deleted now: 6 assets, 1 mapping and 0 tariffs. Check the new numbers and repeat the request.", assets: 6, mappings: 1, tariffs: 0 } }
      : ok));
    const answer = await deleteAssetsOneByOne([item(1), item(2, impact(2)), item(3)]);
    expect(answer.deleted).toEqual([1]);
    expect(answer.failed).toEqual({ id: 2, name: "Asset 2", reason: "More was added under it since the numbers were shown.", now: impact(6, 1, 0) });
    expect(answer.notTried).toEqual([3]);
  });

  it("reads a 409 that carries no counts the same way, with no newer numbers", async () => {
    stubServer(() => ({ status: 409, body: { detail: "conflict" } }));
    const answer = await deleteAssetsOneByOne([item(1)]);
    expect(answer.failed).toEqual({ id: 1, name: "Asset 1", reason: "More was added under it since the numbers were shown." });
    expect(answer.failed).not.toHaveProperty("now");
  });

  it.each([
    ["a lost session", { status: 401, body: { detail: "not authenticated" } }, "Your session has ended. Sign in again."],
    ["a role that may not", { status: 403, body: { detail: "insufficient permission" } }, "Your role does not allow this."],
    ["a server error", { status: 500, body: { detail: "Internal Server Error" } }, "Internal Server Error."],
    ["a server that is restarting", { status: 502, body: "502 Bad Gateway" }, "The server is not answering (status 502). It may be restarting; try again in a moment."],
    ["a refusal in lower case", { status: 422, body: { detail: "asset is locked" } }, "Asset is locked."],
  ])("stops with the reason as a sentence: %s", async (_name, reply, reason) => {
    const { urls } = stubServer(({ id }) => (id === 2 ? reply : ok));
    const answer = await deleteAssetsOneByOne([item(1), item(2), item(3)]);
    expect(urls).toHaveLength(2);
    expect(answer).toMatchObject({ deleted: [1], failed: { id: 2, reason }, notTried: [3] });
  });

  it("stops when the network is gone", async () => {
    stubServer(({ id }) => {
      if (id === 2) throw new TypeError("Failed to fetch");
      return ok;
    });
    const answer = await deleteAssetsOneByOne([item(1), item(2), item(3)]);
    expect(answer).toMatchObject({ deleted: [1], failed: { id: 2, reason: "Can't reach the server. Check the network and try again." }, notTried: [3] });
  });

  it("calls onRemoved after each root that was deleted or found gone, in order, right before the next request", async () => {
    const { events } = stubServer(({ id }) => (id === 2 ? { status: 404, body: { detail: "asset not found" } } : ok));
    const removed: number[] = [];
    await deleteAssetsOneByOne([item(1), item(2), item(3)], {
      onRemoved: (id) => { removed.push(id); events.push(`removed ${id}`); },
    });
    expect(removed).toEqual([1, 2, 3]);
    expect(events).toEqual([
      "DELETE 1 sent", "DELETE 1 answered", "removed 1",
      "DELETE 2 sent", "DELETE 2 answered", "removed 2",
      "DELETE 3 sent", "DELETE 3 answered", "removed 3",
    ]);
  });

  it("never calls onRemoved for the root that failed or for the roots after it", async () => {
    stubServer(({ id }) => (id === 2 ? { status: 409, body: { detail: "x", assets: 3, mappings: 0, tariffs: 0 } } : ok));
    const removed: number[] = [];
    await deleteAssetsOneByOne([item(1), item(2), item(3)], { onRemoved: (id) => removed.push(id) });
    expect(removed).toEqual([1]);
  });

  it("does not let a failing onRemoved lose the rest of the delete or its report", async () => {
    const { urls } = stubServer(() => ok);
    const answer = await deleteAssetsOneByOne([item(1), item(2)], { onRemoved: () => { throw new Error("navigate failed"); } });
    expect(urls).toHaveLength(2);
    expect(answer).toMatchObject({ deleted: [1, 2], failed: null });
  });
});
