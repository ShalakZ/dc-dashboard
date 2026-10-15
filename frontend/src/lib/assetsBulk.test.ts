import { ApiError } from "../api/client";
import type { Asset, AssetImpact } from "../api/types";
import {
  MAX_ROOTS, bulkRemoveToast, capMessage, deleteConfirmLabel, deleteMessage, deleteTitle, failureReason, focusAfterDelete, isPlainDelete, leaveTo,
  planDelete, sumImpacts, treeDrift, type DeletePlan, type PlanItem, type RemoveResult,
} from "./assetsBulk";
import { buildTree, descendantIds } from "./tree";
import { indexTree } from "./treeMove";

const asset = (id: number, parent_id: number | null, name: string, sort_order = 0): Asset => ({ id, parent_id, name, kind: "generic", sort_order });

// Hall > (Rack A > (LVP01, LVP02), Rack B), Yard > Tank, Shed
const ASSETS = [
  asset(1, null, "Hall", 0), asset(2, 1, "Rack A", 0), asset(3, 2, "LVP01", 0), asset(4, 2, "LVP02", 1), asset(5, 1, "Rack B", 1),
  asset(6, null, "Yard", 1), asset(7, 6, "Tank"), asset(8, null, "Shed", 2),
];
const NODES = buildTree(ASSETS);
const INDEX = indexTree(NODES);
const nameOf = (id: number) => INDEX.nameOf(id) ?? `#${id}`;
const plan = (...ids: number[]) => planDelete(ids, INDEX, nameOf);

const impact = (assets: number, mappings = 0, tariffs = 0): AssetImpact => ({ assets, mappings, tariffs });
const item = (id: number, name = `A${id}`): PlanItem => ({ id, name });
const fake = (picked: PlanItem[], inside: DeletePlan["inside"] = []): DeletePlan => ({ picked, roots: picked.filter((p) => !inside.some((i) => i.id === p.id)), inside });
const names = (n: number) => Array.from({ length: n }, (_, i) => item(i + 1, `K${i + 1}`));
const result = (over: Partial<RemoveResult> = {}): RemoveResult => ({ deleted: [], gone: [], failed: null, notTried: [], assets: 0, ...over });

describe("planDelete", () => {
  it("lists the picks in tree order, whatever order they come in", () => {
    const p = plan(8, 3, 1);
    expect(p.picked.map((x) => x.name)).toEqual(["Hall", "LVP01", "Shed"]);
    expect(p.picked[0]).toEqual({ id: 1, name: "Hall" });
  });

  it("sends only the top-level picks and names the pick above each one inside another", () => {
    const p = plan(1, 4, 3, 8);
    expect(p.roots.map((x) => x.id)).toEqual([1, 8]);
    expect(p.inside).toEqual([
      { id: 3, name: "LVP01", rootName: "Hall", rootId: 1 },
      { id: 4, name: "LVP02", rootName: "Hall", rootId: 1 },
    ]);
  });

  it("names the picked root even when another pick lies between it and the one inside", () => {
    const p = plan(1, 2, 3);
    expect(p.roots.map((x) => x.id)).toEqual([1]);
    expect(p.inside).toEqual([
      { id: 2, name: "Rack A", rootName: "Hall", rootId: 1 },
      { id: 3, name: "LVP01", rootName: "Hall", rootId: 1 },
    ]);
  });

  it("keeps two picks that are not inside each other as two roots, in tree order", () => {
    const p = plan(7, 3);
    expect(p.roots.map((x) => x.id)).toEqual([3, 7]);
    expect(p.inside).toEqual([]);
  });

  it("ignores an id that is not in the tree and counts a repeated id once", () => {
    const p = planDelete([3, 99, 3, 3], INDEX, nameOf);
    expect(p.picked).toEqual([{ id: 3, name: "LVP01" }]);
    expect(p.roots).toEqual([{ id: 3, name: "LVP01" }]);
  });

  it("is empty for nothing", () => {
    expect(planDelete([], INDEX, nameOf)).toEqual({ picked: [], roots: [], inside: [] });
  });

  it("reads the names from nameOf, as the page shows them", () => {
    const p = planDelete([3], INDEX, (id) => `<${id}>`);
    expect(p.picked[0].name).toBe("<3>");
    expect(p.roots[0].name).toBe("<3>");
  });
});

describe("the cap", () => {
  it("is 100 top-level assets", () => {
    expect(MAX_ROOTS).toBe(100);
  });

  it("says how many top-level assets the person picked", () => {
    expect(capMessage(140)).toBe("Up to 100 assets can be deleted at once (you picked 140 top-level ones). Pick fewer.");
    expect(capMessage(101)).toBe("Up to 100 assets can be deleted at once (you picked 101 top-level ones). Pick fewer.");
  });
});

describe("sumImpacts", () => {
  it("adds every count", () => {
    expect(sumImpacts([impact(3, 2, 1), impact(1), impact(5, 0, 4)])).toEqual(impact(9, 2, 5));
  });

  it("is zero for nothing", () => {
    expect(sumImpacts([])).toEqual(impact(0));
  });
});

describe("deleteTitle", () => {
  it.each([[1, "Delete 1 asset?"], [2, "Delete 2 assets?"], [3, "Delete 3 assets?"], [41, "Delete 41 assets?"]])("%i", (n, title) => {
    expect(deleteTitle(n)).toBe(title);
  });
});

describe("isPlainDelete and the confirm label", () => {
  it.each([
    // [what it is, picked, sum, plain]
    ["leaves only", [item(1), item(2)], impact(2), true],
    ["leaves, a branch of three picked as three", [item(1), item(2), item(3)], impact(3), true],
    ["a pick with a sub-asset nobody picked", [item(1)], impact(2), false],
    ["a mapping", [item(1)], impact(1, 1), false],
    ["a tariff", [item(1)], impact(1, 0, 1), false],
    ["fewer assets than picks (some went meanwhile)", [item(1), item(2), item(3)], impact(2), true],
    ["nothing at all", [item(1)], impact(0), true],
  ] as const)("%s", (_name, picked, sum, plain) => {
    const p = fake([...picked]);
    expect(isPlainDelete(p, sum)).toBe(plain);
    expect(deleteConfirmLabel(p, sum)).toBe(plain ? "Delete" : "Delete anyway");
  });

  it("reads Delete while the numbers are loading, so the button does not change width when they land", () => {
    expect(deleteConfirmLabel(fake([item(1)]), null)).toBe("Delete");
  });
});

describe("treeDrift: does the server's tree still match the picture the dialog was built from", () => {
  const sizeIn = (list: Asset[], id: number) => descendantIds(buildTree(list), id).size;
  /** What the server would answer for each root of `p` on the tree `list`. */
  const countsOf = (list: Asset[], p: DeletePlan): Map<number, AssetImpact | null> => new Map(p.roots.map((r) => [r.id, impact(sizeIn(list, r.id))]));
  const drift = (p: DeletePlan, list: Asset[], impacts: Map<number, AssetImpact | null> = countsOf(list, p)) => treeDrift(p, list, impacts);
  const without = (...ids: number[]) => ASSETS.filter((a) => !ids.includes(a.id));
  const moved = (id: number, parent: number | null) => ASSETS.map((a) => (a.id === id ? { ...a, parent_id: parent } : a));

  // The review's scenarios: the cached list shows Rack A > (LVP01, LVP02), the person picks Rack A and LVP01.
  const SMALL = [asset(1, null, "Hall"), asset(2, 1, "Rack A"), asset(3, 2, "LVP01")];
  const smallPlan = planDelete([2, 3], indexTree(buildTree(SMALL)), (id) => SMALL.find((a) => a.id === id)?.name ?? "?");

  it.each([
    ["leaves", plan(3, 4, 7)],
    ["a branch picked whole", plan(1, 2, 3, 4)],
    ["a branch and a leaf of another", plan(1, 7)],
    ["a pick inside another pick", plan(1, 3)],
  ])("is null when the list is the one the picture was built from, and the counts are the subtrees: %s", (_name, p) => {
    expect(drift(p, ASSETS)).toBeNull();
  });

  it("is null when the subtree holds more than was picked, as long as the list shows it (the dialog counts those)", () => {
    expect(drift(plan(2), ASSETS)).toBeNull(); // Rack A's two LVPs are not picked: the message says so
  });

  it("is null when only the order of the picks differs from the order of the roots", () => {
    expect(drift(plan(7, 3, 1), ASSETS)).toBeNull();
  });

  it("is null on the empty plan with no roots", () => {
    expect(treeDrift({ picked: [], roots: [], inside: [] }, ASSETS, new Map())).toBeNull();
  });

  describe("a pick that is not in the fresh list any more", () => {
    it("a leaf", () => {
      expect(drift(plan(3, 7), without(3))).toMatch(/no longer in the list/);
    });

    it("the review's scenario (a): A and B picked, B deleted on the server, the server counts A's subtree as 2 (the old rule calls it plain)", () => {
      // Rack A (2) > LVP01 (3), LVP02 (4); Rack A and LVP01 picked; LVP01 was deleted by someone else, so Rack A holds 2 assets: Rack A and LVP02.
      const p = plan(2, 3);
      const serverSays = new Map<number, AssetImpact | null>([[2, impact(2)]]);
      expect(isPlainDelete(p, impact(2))).toBe(true); // 2 picks, 2 assets: the count alone would let it through, and delete LVP02 unseen
      expect(drift(p, without(3), serverSays)).toMatch(/no longer in the list/);
    });

    it("a root", () => {
      expect(drift(plan(1, 7), without(7))).toMatch(/no longer in the list/);
    });
  });

  describe("the top-level picks changed", () => {
    it("the review's scenario (b), a net-zero swap: LVP01 moved out of Rack A and LVP09 added under it; the count still equals the pick count", () => {
      const fresh = [asset(1, null, "Hall"), asset(2, 1, "Rack A"), asset(3, 1, "LVP01"), asset(9, 2, "LVP09")];
      const serverSays = new Map<number, AssetImpact | null>([[2, impact(2)]]); // Rack A + LVP09
      expect(isPlainDelete(smallPlan, impact(2))).toBe(true); // 2 picks, 2 assets: plain by the count alone, and LVP09 would go unseen
      expect(treeDrift(smallPlan, fresh, serverSays)).toMatch(/top-level picks changed/);
    });

    it("a pick moved out of its root becomes a root of its own", () => {
      expect(drift(plan(1, 3), moved(3, 8))).toMatch(/top-level picks changed/);
    });

    it("a pick moved inside another pick is no longer a root", () => {
      expect(drift(plan(3, 6), moved(3, 6))).toMatch(/top-level picks changed/);
    });

    it("a root moved inside an unpicked asset is still a root: no change there", () => {
      expect(drift(plan(6), moved(6, 8))).toBeNull(); // Yard under Shed: Yard is still the top of what is picked, and its subtree is the same
    });

    it("the roots come in another order (a sibling was reordered)", () => {
      const reordered = ASSETS.map((a) => (a.id === 1 ? { ...a, sort_order: 5 } : a)); // Hall now sorts after Yard and Shed
      expect(drift(plan(1, 6), reordered)).toMatch(/top-level picks changed/);
    });
  });

  describe("a pick inside a root moved to a different root", () => {
    it("is caught by the map from pick to root, though the roots, the counts and the picks are the same", () => {
      // LVP01 (3) was inside Hall (1) through Rack A; now it hangs under Yard (6). Both Hall and Yard are still roots.
      const p = plan(1, 3, 6);
      const fresh = moved(3, 6);
      expect(p.inside).toEqual([{ id: 3, name: "LVP01", rootName: "Hall", rootId: 1 }]);
      expect(drift(p, fresh)).toMatch(/moved to another/);
    });

    it("tells two roots with the same name apart", () => {
      // two racks both called "Rack": the pick moves from the first to the second, and the names say nothing changed
      const list = [asset(1, null, "Rack"), asset(2, null, "Rack", 1), asset(3, 1, "Sled")];
      const p = planDelete([1, 2, 3], indexTree(buildTree(list)), (id) => list.find((a) => a.id === id)?.name ?? "?");
      expect(p.inside).toEqual([{ id: 3, name: "Sled", rootName: "Rack", rootId: 1 }]);
      expect(treeDrift(p, list.map((a) => (a.id === 3 ? { ...a, parent_id: 2 } : a)), new Map([[1, impact(1)], [2, impact(2)]]))).toMatch(/moved to another/);
    });
  });

  describe("the server's count of a root against the fresh list's subtree", () => {
    it("the server counts more than the list shows", () => {
      expect(drift(plan(1), ASSETS, new Map([[1, impact(7)]]))).toMatch(/counts/);
    });

    it("the server counts fewer than the list shows", () => {
      expect(drift(plan(1), ASSETS, new Map([[1, impact(4)]]))).toMatch(/counts/);
    });

    it("counts the root and every level below it in the fresh list", () => {
      // Hall > Rack A > LVP01, LVP02 and Hall > Rack B: 5 assets with the root
      expect(drift(plan(1), ASSETS, new Map([[1, impact(5)]]))).toBeNull();
      expect(drift(plan(1), ASSETS, new Map([[1, impact(4)]]))).not.toBeNull();
      expect(drift(plan(1), ASSETS, new Map([[1, impact(1)]]))).not.toBeNull();
    });

    it("takes the size from the FRESH list, not from the list the plan was built from", () => {
      // LVP02 was deleted on the server: the old list says 5, the fresh one 4, and so does the server
      expect(drift(plan(1), without(4), new Map([[1, impact(4)]]))).toBeNull();
      expect(drift(plan(1), without(4), new Map([[1, impact(5)]]))).toMatch(/counts/);
    });

    it("a root that gained an asset nobody saw: the list and the server agree, so the dialog will count it", () => {
      const grown = [...ASSETS, asset(9, 7, "Pump")];
      expect(drift(plan(6), grown, new Map([[6, impact(3)]]))).toBeNull(); // Yard, Tank, Pump
    });

    it("checks every root, not only the first", () => {
      expect(drift(plan(1, 6), ASSETS, new Map([[1, impact(5)], [6, impact(3)]]))).toMatch(/counts/);
    });

    it("mappings and tariffs are not compared, they are the server's alone", () => {
      expect(drift(plan(7), ASSETS, new Map([[7, impact(1, 4, 2)]]))).toBeNull();
    });
  });

  describe("a root the server does not know", () => {
    it("a null impact (it answered 404) is a drift whatever the list says", () => {
      expect(drift(plan(3, 7), ASSETS, new Map([[3, impact(1)], [7, null]]))).toMatch(/already deleted/);
    });

    it("an impact that was never asked for is a drift too", () => {
      expect(drift(plan(3, 7), ASSETS, new Map([[3, impact(1)]]))).toMatch(/already deleted/);
    });
  });
});

describe("deleteMessage", () => {
  const LOSS =(a: number, m: number, t: number) =>
    `${a} ${a === 1 ? "asset" : "assets"}, ${m} ${m === 1 ? "mapping" : "mappings"} and ${t} ${t === 1 ? "tariff" : "tariffs"} will be deleted; their past energy and cost figures disappear from Billing and dashboards.`;
  const LAST = "This can't be undone.";

  it("is empty while the numbers load", () => {
    expect(deleteMessage(fake([item(1)]), null)).toBe("");
  });

  it.each([
    ["one leaf", fake([item(1, "LVP01")]), impact(1), `LVP01. ${LAST}`],
    ["two leaves", fake([item(1, "LVP02"), item(2, "LVP03")]), impact(2), `LVP02, LVP03. ${LAST}`],
    ["names as written, commas and all", fake([item(1, "Rack, 42U"), item(2, "UPS")]), impact(2), `Rack, 42U, UPS. ${LAST}`],
    ["eight names are all listed", fake(names(8)), impact(8), `K1, K2, K3, K4, K5, K6, K7, K8. ${LAST}`],
    ["nine names: the eighth, then how many more", fake(names(9)), impact(9), `K1, K2, K3, K4, K5, K6, K7, K8 and 1 more. ${LAST}`],
    ["twelve names", fake(names(12)), impact(12), `K1, K2, K3, K4, K5, K6, K7, K8 and 4 more. ${LAST}`],
    ["sub-assets nobody picked", fake([item(1, "Hall")]), impact(41, 2, 1), `Hall. ${LOSS(41, 2, 1)} ${LAST}`],
    ["one mapping", fake([item(1, "LVP01")]), impact(1, 1), `LVP01. ${LOSS(1, 1, 0)} ${LAST}`],
    ["one tariff", fake([item(1, "LVP01")]), impact(1, 0, 1), `LVP01. ${LOSS(1, 0, 1)} ${LAST}`],
    ["two picks and a child nobody picked", fake([item(1, "A"), item(2, "B")]), impact(3), `A, B. ${LOSS(3, 0, 0)} ${LAST}`],
  ])("%s", (_name, p, sum, text) => {
    expect(deleteMessage(p, sum)).toBe(text);
  });

  it("says, for a pick inside another pick, that it goes with it", () => {
    const p = fake([item(1, "Data_Hall_1"), item(2, "LVP02")], [{ id: 2, name: "LVP02", rootName: "Data_Hall_1", rootId: 1 }]);
    expect(deleteMessage(p, impact(2))).toBe(`Data_Hall_1, LVP02. LVP02 is inside Data_Hall_1, which is also picked, so it goes with it. ${LAST}`);
  });

  it("says it for the first three, then counts the rest", () => {
    const inside = (n: number) => Array.from({ length: n }, (_, i) => ({ id: 10 + i, name: `C${i + 1}`, rootName: "Hall", rootId: 1 }));
    const picked = (n: number) => [item(1, "Hall"), ...inside(n).map((c) => item(c.id, c.name))];
    const three = deleteMessage(fake(picked(3), inside(3)), impact(4));
    expect(three).toContain("C1 is inside Hall, which is also picked, so it goes with it. C2 is inside Hall, which is also picked, so it goes with it. C3 is inside Hall, which is also picked, so it goes with it. This can't be undone.");
    expect(three).not.toContain("more");
    const four = deleteMessage(fake(picked(4), inside(4)), impact(5));
    expect(four).toContain("C3 is inside Hall, which is also picked, so it goes with it, and 1 more is inside another picked asset, so it goes with it. This can't be undone.");
    expect(four).not.toContain("C4 is inside");
    const nine = deleteMessage(fake(picked(9), inside(9)), impact(10));
    expect(nine).toContain("C3 is inside Hall, which is also picked, so it goes with it, and 6 more are inside other picked assets, so they go with them. This can't be undone.");
  });

  it("puts the notes before the billing warning", () => {
    const p = fake([item(1, "Hall"), item(2, "Rack")], [{ id: 2, name: "Rack", rootName: "Hall", rootId: 1 }]);
    expect(deleteMessage(p, impact(6, 1, 0))).toBe(`Hall, Rack. Rack is inside Hall, which is also picked, so it goes with it. ${LOSS(6, 1, 0)} ${LAST}`);
  });

  it("works on a real plan", () => {
    expect(deleteMessage(plan(1, 3), impact(5))).toBe(`Hall, LVP01. LVP01 is inside Hall, which is also picked, so it goes with it. ${LOSS(5, 0, 0)} ${LAST}`);
  });
});

describe("failureReason", () => {
  const api = (status: number, detail: unknown, body?: unknown) => new ApiError(status, detail, body);

  it.each([
    ["a 409 (more was added under it)", api(409, "More than you were shown would be deleted now: 3 assets, 0 mappings and 0 tariffs.", { assets: 3, mappings: 0, tariffs: 0 }), "More was added under it since the numbers were shown."],
    ["a 409 without counts", api(409, "conflict"), "More was added under it since the numbers were shown."],
    ["a lost session", api(401, "not authenticated"), "Your session has ended. Sign in again."],
    ["a role that may not", api(403, "insufficient permission"), "Your role does not allow this."],
    ["a server detail in lower case", api(500, "database is locked"), "Database is locked."],
    ["a detail that is a sentence already", api(500, "Something broke."), "Something broke."],
    ["no connection", api(0, "Can't reach the server. Check the network and try again."), "Can't reach the server. Check the network and try again."],
    ["the server is restarting", api(502, "502 Bad Gateway"), "The server is not answering (status 502). It may be restarting; try again in a moment."],
    ["a plain Error", new Error("boom"), "Boom."],
    ["something that is not an error", "odd", "Odd."],
  ])("%s", (_name, error, reason) => {
    expect(failureReason(error)).toBe(reason);
  });
});

describe("bulkRemoveToast", () => {
  const nameFor = (id: number) => `N${id}`;
  const failed = (over: Partial<NonNullable<RemoveResult["failed"]>> = {}) => ({ id: 3, name: "LVP03", reason: "More was added under it since the numbers were shown.", ...over });

  it.each([
    ["one asset", result({ deleted: [1], assets: 1 }), "Deleted 1 asset"],
    ["three assets", result({ deleted: [1, 2, 3], assets: 3 }), "Deleted 3 assets"],
    ["branches: the counts the dialog showed", result({ deleted: [1, 2], assets: 41 }), "Deleted 41 assets"],
    ["one was already gone", result({ deleted: [1, 2], gone: [3], assets: 2 }), "Deleted 2 assets. 1 was already gone."],
    ["several were already gone", result({ deleted: [1], gone: [2, 3], assets: 5 }), "Deleted 5 assets. 2 were already gone."],
  ])("all done, %s: a success", (_name, answer, text) => {
    expect(bulkRemoveToast(answer, nameFor)).toEqual({ tone: "success", text });
  });

  it.each([
    ["one", result({ gone: [1] })],
    ["several", result({ gone: [1, 2, 3] })],
    ["nothing at all", result()],
  ])("every root was gone already (%s): an info toast, never 'Deleted 0 assets'", (_name, answer) => {
    expect(bulkRemoveToast(answer, nameFor)).toEqual({ tone: "info", text: "Those assets were already deleted." });
  });

  it.each([
    ["the last one failed", result({ deleted: [1, 2], assets: 2, failed: failed() }),
      'Deleted 2 assets. "LVP03" could not be deleted: More was added under it since the numbers were shown.'],
    ["one deleted, the rest not tried", result({ deleted: [1], assets: 1, failed: failed(), notTried: [4] }),
      'Deleted 1 asset. "LVP03" could not be deleted: More was added under it since the numbers were shown. 1 was not tried.'],
    ["some not tried", result({ deleted: [1, 2], assets: 9, failed: failed({ reason: "Your role does not allow this." }), notTried: [4, 5, 6] }),
      'Deleted 9 assets. "LVP03" could not be deleted: Your role does not allow this. 3 were not tried.'],
    ["with roots that were gone", result({ deleted: [1, 2], gone: [7], assets: 2, failed: failed() }),
      'Deleted 2 assets, 1 was already gone. "LVP03" could not be deleted: More was added under it since the numbers were shown.'],
    ["with several gone and some not tried", result({ deleted: [1], gone: [7, 8], assets: 1, failed: failed({ reason: "Database is locked." }), notTried: [4] }),
      'Deleted 1 asset, 2 were already gone. "LVP03" could not be deleted: Database is locked. 1 was not tried.'],
    ["a reason without a full stop gets one", result({ deleted: [1], assets: 1, failed: failed({ reason: "Database is locked" }) }),
      'Deleted 1 asset. "LVP03" could not be deleted: Database is locked.'],
  ])("a failure after something went: %s", (_name, answer, text) => {
    expect(bulkRemoveToast(answer, nameFor)).toEqual({ tone: "error", text });
  });

  it.each([
    ["the first root failed", result({ failed: failed(), notTried: [4, 5] }),
      '"LVP03" could not be deleted: More was added under it since the numbers were shown. 2 were not tried.'],
    ["the first root failed and nothing is left", result({ failed: failed() }),
      '"LVP03" could not be deleted: More was added under it since the numbers were shown.'],
    ["deleted 0, gone 1, then a failure", result({ gone: [7], failed: failed(), notTried: [4] }),
      '1 was already gone. "LVP03" could not be deleted: More was added under it since the numbers were shown. 1 was not tried.'],
    ["deleted 0, gone 2, then a failure", result({ gone: [7, 8], failed: failed({ reason: "Your role does not allow this." }) }),
      '2 were already gone. "LVP03" could not be deleted: Your role does not allow this.'],
  ])("a failure with nothing deleted never says 'Deleted 0 assets': %s", (_name, answer, text) => {
    const toast = bulkRemoveToast(answer, nameFor);
    expect(toast).toEqual({ tone: "error", text });
    expect(toast.text).not.toMatch(/Deleted 0/);
  });

  it("asks nameOf for a failure whose name is blank", () => {
    const toast = bulkRemoveToast(result({ deleted: [1], assets: 1, failed: failed({ id: 3, name: "" }) }), nameFor);
    expect(toast.text).toBe('Deleted 1 asset. "N3" could not be deleted: More was added under it since the numbers were shown.');
  });

  it("names the failure as the person picked it, not as the list calls it now", () => {
    const toast = bulkRemoveToast(result({ deleted: [1], assets: 1, failed: failed({ name: "Picked name" }) }), () => "Renamed");
    expect(toast.text).toContain('"Picked name" could not be deleted');
  });
});

describe("leaveTo: where the page goes when the open asset is deleted", () => {
  it.each([
    ["nothing is open", null, [3], null],
    ["nothing was removed", 4, [], null],
    ["another branch was removed", 4, [7], null],
    ["a sibling was removed", 4, [3], null],
    ["a child of the open asset was removed (the open asset stays)", 2, [3], null],
    ["the open asset was removed: its parent", 3, [3], "/assets/2"],
    ["the open asset was removed and has no parent: the list", 6, [6], "/assets"],
    ["the open asset sits below a removed root: that root's parent", 4, [2], "/assets/1"],
    ["the open asset sits deep below a removed top-level root: the list", 4, [1], "/assets"],
    ["the open asset is below one of several removed roots", 7, [3, 6, 8], "/assets"],
    ["the open asset is not in the tree any more but was a removed root", 99, [99], "/assets"],
    ["the open asset is not affected, whatever else went", 5, [3, 7, 8], null],
  ])("%s", (_name, openId, removed, to) => {
    expect(leaveTo({ openId, removed, index: INDEX })).toBe(to);
  });

  it("goes to the parent of the topmost removed asset above it", () => {
    expect(leaveTo({ openId: 3, removed: [3, 2], index: INDEX })).toBe("/assets/1");
    expect(leaveTo({ openId: 3, removed: [2, 3], index: INDEX })).toBe("/assets/1");
  });
});

describe("focusAfterDelete: which row takes the focus when the picked rows are gone", () => {
  const none: ReadonlySet<number> = new Set();
  const focus = (pickedIds: number[], collapsed: ReadonlySet<number> = none, visible: ReadonlySet<number> | null = null) =>
    focusAfterDelete({ nodes: NODES, collapsed, visible, pickedIds });

  it.each([
    ["the first row after the picked one", [3], 4],
    ["after the whole run of picked rows", [3, 4], 5],
    ["a picked row takes its sub-assets with it", [2], 5],
    ["a picked top-level row takes its whole branch", [1], 6],
    ["the row after the first picked row, whatever order the picks come in", [8, 3], 4],
    ["the next row is picked too, and a picked row takes its branch: the one after those", [5, 6], 8],
    ["the last row picked: the last one before it", [8], 7],
    ["the last rows picked: the last survivor before the first one", [6, 8], 5],
    ["everything is picked", [1, 2, 3, 4, 5, 6, 7, 8], null],
    ["every top-level row is picked", [1, 6, 8], null],
    ["nothing is picked", [], null],
    ["an id that is not in the tree", [99], null],
  ])("%s", (_name, picked, to) => {
    expect(focus(picked)).toBe(to);
  });

  it("does not choose a row inside a folded branch", () => {
    // Hall is folded: the rows on screen are Hall, Yard, Tank, Shed. Yard is picked, its Tank goes with it.
    expect(focus([6], new Set([1]))).toBe(8);
    // Rack A is folded, LVP01 is hidden: picking Rack A gives Rack B.
    expect(focus([2], new Set([2]))).toBe(5);
  });

  it("does not choose a row inside a folded branch when going backwards", () => {
    // Hall folded: the rows on screen are Hall, Yard, Tank, Shed; Tank and Shed are picked, so the last row left before them is Yard (not Rack B, which is hidden).
    expect(focus([7, 8], new Set([1]))).toBe(6);
  });

  it("does not choose a row a filter hides", () => {
    const visible = new Set([1, 2, 3, 4, 6, 7]);
    expect(focus([4], none, visible)).toBe(6); // Rack B (5) is hidden: the next shown row is Yard
    expect(focus([6], none, visible)).toBe(4); // nothing shown after Yard and its Tank: the last shown row before them (Rack B is hidden)
  });

  it("lets a filter show rows under a folded branch, as the tree does", () => {
    expect(focus([3], new Set([2]), new Set([1, 2, 3, 4]))).toBe(4);
  });

  it("has no row to choose when the filter shows only picked rows, or none of them", () => {
    expect(focus([3, 4], none, new Set([1, 2, 3, 4]))).toBe(2);
    expect(focus([1], none, new Set([1, 2, 3, 4]))).toBeNull();
    expect(focus([5], none, new Set([1, 2, 3, 4]))).toBeNull(); // the picked row is not on screen
  });
});
