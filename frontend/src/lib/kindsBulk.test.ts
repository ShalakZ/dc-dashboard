import type { BulkDeleteResult } from "../api/queries";
import { blockedMessage, bulkToast, deleteTitle, firstReason, namesLine, removedIds, unusedMessage, usedMessage } from "./kindsBulk";

const names = (n: number) => Array.from({ length: n }, (_, i) => `K${i + 1}`);
const result = (over: Partial<BulkDeleteResult> = {}): BulkDeleteResult => ({ deleted: [], gone: [], failed: [], notTried: [], moved: null, ...over });
const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);

describe("deleteTitle", () => {
  it.each([[1, "Delete 1 kind?"], [2, "Delete 2 kinds?"], [12, "Delete 12 kinds?"]])("%i", (total, title) => {
    expect(deleteTitle(total)).toBe(title);
  });
});

describe("namesLine: the first eight names, then how many more", () => {
  it.each([
    [1, "K1"],
    [2, "K1, K2"],
    [8, "K1, K2, K3, K4, K5, K6, K7, K8"],
    [9, "K1, K2, K3, K4, K5, K6, K7, K8 and 1 more"],
    [12, "K1, K2, K3, K4, K5, K6, K7, K8 and 4 more"],
    [51, "K1, K2, K3, K4, K5, K6, K7, K8 and 43 more"],
  ])("%i names", (count, line) => {
    expect(namesLine(names(count))).toBe(line);
  });

  it("keeps the names as they are written (commas and all)", () => {
    expect(namesLine(["Rack, 42U", "UPS"])).toBe("Rack, 42U, UPS");
  });
});

describe("unusedMessage: none of the kinds is in use", () => {
  it.each([
    [["Pump"], "Pump. Assets that carry this name later get an automatic icon."],
    [["Pump", "Rack"], "Pump, Rack. Assets that carry these names later get an automatic icon."],
    [names(12), "K1, K2, K3, K4, K5, K6, K7, K8 and 4 more. Assets that carry these names later get an automatic icon."],
  ])("%j", (list, text) => {
    expect(unusedMessage(list)).toBe(text);
  });
});

describe("usedMessage: some of the kinds are in use", () => {
  it.each([
    // [total, used, assets, name]
    [12, 3, 7, "3 of these kinds are used by 7 assets. Move those assets to another kind, then delete the 12."],
    [12, 1, 7, "1 of these kinds is used by 7 assets. Move those assets to another kind, then delete the 12."],
    [3, 1, 1, "1 of these kinds is used by 1 asset. Move that asset to another kind, then delete the 3."],
    [2, 2, 40, "2 of these kinds are used by 40 assets. Move those assets to another kind, then delete both."],
    [1, 1, 5, '5 assets use "Pump". Move them to another kind, then delete "Pump".'],
    [1, 1, 1, '1 asset uses "Pump". Move it to another kind, then delete "Pump".'],
  ])("%i kinds, %i in use, %i assets", (total, used, assets, text) => {
    expect(usedMessage({ total, used, assets, name: "Pump" })).toBe(text);
  });
});

describe("blockedMessage: some are in use and no kind is left to move them to", () => {
  it.each([
    [12, 7, "Every kind is selected, and 7 assets use some of them. Keep at least one kind to move them to."],
    [3, 1, "Every kind is selected, and 1 asset uses one of them. Keep at least one kind to move it to."],
    [1, 5, '5 assets use "Pump". Create another kind to move them to first.'],
    [1, 1, '1 asset uses "Pump". Create another kind to move it to first.'],
  ])("%i kinds, %i assets", (total, assets, text) => {
    expect(blockedMessage({ total, assets, name: "Pump" })).toBe(text);
  });
});

describe("bulkToast", () => {
  const MOVED = { assets: 7, to: "UPS" };

  it.each([
    ["one kind", result({ deleted: [1] }), "Deleted 1 kind"],
    ["several kinds", result({ deleted: ids(12) }), "Deleted 12 kinds"],
    ["with a move", result({ deleted: ids(12), moved: MOVED }), "Deleted 12 kinds, 7 assets moved to UPS"],
    ["with a move of one asset", result({ deleted: ids(2), moved: { assets: 1, to: "UPS" } }), "Deleted 2 kinds, 1 asset moved to UPS"],
    ["a kind another tab deleted counts as gone", result({ deleted: ids(11), gone: [12] }), "Deleted 12 kinds"],
    ["only kinds that were gone already", result({ gone: [1] }), "Deleted 1 kind"],
  ])("all gone, %s: a plain success", (_name, answer, text) => {
    expect(bulkToast(answer)).toEqual({ tone: "success", text });
  });

  it.each([
    ["one failure names its kind", result({ deleted: ids(11), failed: [{ id: 12, name: "Pump", reason: "1 asset uses it now." }] }),
      'Deleted 11 kinds. "Pump" could not be deleted: 1 asset uses it now.'],
    ["one kind deleted, one failed", result({ deleted: [1], failed: [{ id: 2, name: "Pump", reason: "Database is locked" }] }),
      'Deleted 1 kind. "Pump" could not be deleted: Database is locked.'],
    ["several failures name the first", result({ deleted: ids(10), failed: [{ id: 11, name: "Pump", reason: "3 assets use it now." }, { id: 12, name: "Fan", reason: "Boom." }] }),
      'Deleted 10 kinds. 2 could not be deleted, the first is "Pump": 3 assets use it now.'],
    ["the move is still reported", result({ deleted: ids(3), moved: MOVED, failed: [{ id: 4, name: "Pump", reason: "1 asset uses it now." }] }),
      'Deleted 3 kinds, 7 assets moved to UPS. "Pump" could not be deleted: 1 asset uses it now.'],
    ["nothing was deleted", result({ failed: [{ id: 4, name: "Pump", reason: "Boom" }] }),
      'No kinds were deleted. "Pump" could not be deleted: Boom.'],
  ])("failures are an error that says which kind: %s", (_name, answer, text) => {
    expect(bulkToast(answer)).toEqual({ tone: "error", text });
  });

  it.each([
    ["no connection", result({ deleted: ids(3), notTried: ids(9, 4), stoppedBy: "Can't reach the server. Check the network and try again." }),
      "Deleted 3 kinds. Stopped: Can't reach the server. Check the network and try again. 9 were not tried."],
    ["a reason without a full stop", result({ deleted: ids(3), notTried: ids(9, 4), stoppedBy: "Your role does not allow this" }),
      "Deleted 3 kinds. Stopped: Your role does not allow this. 9 were not tried."],
    ["one left", result({ deleted: ids(11), notTried: [12], stoppedBy: "Your session has ended. Sign in again." }),
      "Deleted 11 kinds. Stopped: Your session has ended. Sign in again. 1 was not tried."],
    ["nothing deleted yet", result({ notTried: ids(5), stoppedBy: "Your role does not allow this." }),
      "No kinds were deleted. Stopped: Your role does not allow this. 5 were not tried."],
    ["a failure before the stop", result({ deleted: [1, 2], failed: [{ id: 3, name: "Pump", reason: "1 asset uses it now." }], notTried: ids(4, 4), stoppedBy: "The server is not answering (status 503)." }),
      'Deleted 2 kinds. "Pump" could not be deleted: 1 asset uses it now. Stopped: The server is not answering (status 503). 4 were not tried.'],
  ])("a stop is an error that says why and how many were left: %s", (_name, answer, text) => {
    expect(bulkToast(answer)).toEqual({ tone: "error", text });
  });
});

describe("removedIds and firstReason", () => {
  it("lists the kinds that left the registry, deleted here or gone already, and not the others", () => {
    const answer = result({ deleted: [1, 2], gone: [3], failed: [{ id: 4, name: "x", reason: "r" }], notTried: [5] });
    expect(removedIds(answer)).toEqual([1, 2, 3]);
  });

  it("firstReason is the first refusal, else why it stopped", () => {
    expect(firstReason(result({ failed: [{ id: 1, name: "a", reason: "First." }, { id: 2, name: "b", reason: "Second." }], stoppedBy: "Stopped." }))).toBe("First.");
    expect(firstReason(result({ notTried: [1], stoppedBy: "Stopped." }))).toBe("Stopped.");
    expect(firstReason(result())).toBe("");
  });
});
