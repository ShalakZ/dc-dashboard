import { ApiError } from "../api/client";
import { ASSET_KEEP_NOTE, SOURCE_KEEP_NOTE, assetDeletePath, assetImpact, assetLoss, assetNote, sourceDeletePath, sourceImpact, sourceLoss, sourceNote, storageLoss } from "./impact";

const conflict = (body: unknown) => new ApiError(409, "needs confirmation", body);

describe("assetImpact", () => {
  it("reads the counts of a 409 reply", () => {
    expect(assetImpact(conflict({ detail: "x", assets: 4, mappings: 3, tariffs: 1 }))).toEqual({ assets: 4, mappings: 3, tariffs: 1 });
  });
  it("is null for anything that is not a 409 with the three counts", () => {
    expect(assetImpact(new ApiError(403, "no", { detail: "no", assets: 1, mappings: 0, tariffs: 0 }))).toBeNull();
    expect(assetImpact(conflict({ detail: "name taken" }))).toBeNull();
    expect(assetImpact(conflict({ assets: 1, mappings: 0 }))).toBeNull();
    expect(assetImpact(conflict({ assets: "1", mappings: 0, tariffs: 0 }))).toBeNull();
    expect(assetImpact(conflict(null))).toBeNull();
    expect(assetImpact(new Error("boom"))).toBeNull();
  });
});

describe("sourceImpact", () => {
  it("reads the counts of a 409 reply", () => {
    expect(sourceImpact(conflict({ detail: "x", points: 2, mappings: 2 }))).toEqual({ points: 2, mappings: 2 });
  });
  it("is null without both counts", () => {
    expect(sourceImpact(conflict({ detail: "x", points: 2 }))).toBeNull();
    expect(sourceImpact(new ApiError(404, "gone", { points: 2, mappings: 2 }))).toBeNull();
  });
});

describe("loss texts", () => {
  it("name every count and say the history disappears", () => {
    expect(assetLoss({ assets: 4, mappings: 3, tariffs: 2 })).toBe(
      "4 assets, 3 mappings and 2 tariffs will be deleted; their past energy and cost figures disappear from Billing and dashboards, except in closed months, which keep their billed figures.",
    );
    expect(sourceLoss({ points: 2, mappings: 2 })).toBe(
      "2 mapped points and 2 mappings will be deleted; the past energy and cost figures that depend on them disappear from Billing and dashboards, except in closed months, which keep their billed figures.",
    );
  });
  it("uses the singular for one", () => {
    expect(assetLoss({ assets: 1, mappings: 1, tariffs: 1 })).toContain("1 asset, 1 mapping and 1 tariff will be deleted");
    expect(sourceLoss({ points: 1, mappings: 1 })).toContain("1 mapped point and 1 mapping will be deleted");
  });
});

// W18 R4: what the loss sentence does not say. A month that is not closed follows today's tree, closing first keeps its bill, and the readings stay
// stored. It is a text of its own (the loss sentences above are unchanged) and it is only for a delete that has mappings, that is, energy figures.
describe("keep notes", () => {
  it("say that months which are not closed lose the figures, that closing first keeps them, and that the readings stay", () => {
    expect(ASSET_KEEP_NOTE).toBe(
      "Billing for every month that is not closed is worked out from today's assets, so those months lose these figures. To keep a finished month's bill, close that month before you delete. The readings stay stored: retention removes the raw and 1-minute ones later, and the hourly summaries stay.",
    );
    expect(SOURCE_KEEP_NOTE).toBe(
      "Billing for every month that is not closed is worked out from today's mappings, so those months lose the figures of these points. To keep a finished month's bill, close that month before you delete. The readings stay stored: retention removes the raw and 1-minute ones later, and the hourly summaries stay.",
    );
  });
  it("assetNote is the asset note when there are mappings, and null when there are none (a branch of empty assets, a tariff only)", () => {
    expect(assetNote({ assets: 1, mappings: 2, tariffs: 0 })).toBe(ASSET_KEEP_NOTE);
    expect(assetNote({ assets: 4, mappings: 0, tariffs: 0 })).toBeNull();
    expect(assetNote({ assets: 1, mappings: 0, tariffs: 2 })).toBeNull();
  });
  it("sourceNote is the source note when there are mappings, and null when there are none", () => {
    expect(sourceNote({ points: 3, mappings: 3 })).toBe(SOURCE_KEEP_NOTE);
    expect(sourceNote({ points: 0, mappings: 0 })).toBeNull();
  });
});

describe("storageLoss", () => {
  it("returns the detail of the storage confirmation 409 only", () => {
    const storage = new ApiError(409, "text", { detail: "text", deletes_now: true, shorter: false });
    expect(storageLoss(storage)).toEqual({ detail: "text", deletesNow: true });
    expect(storageLoss(new ApiError(409, "x", { detail: "x" }))).toBeNull(); // another kind of 409
    expect(storageLoss(new ApiError(422, "x", { detail: "x", deletes_now: true }))).toBeNull();
    expect(storageLoss(new Error("boom"))).toBeNull();
  });
});

describe("the delete paths", () => {
  it("carry confirm=true and the counts the dialog showed, so the server can refuse a delete that grew", () => {
    expect(assetDeletePath(5, { assets: 3, mappings: 0, tariffs: 1 })).toBe("/api/assets/5?confirm=true&expect_assets=3&expect_mappings=0&expect_tariffs=1");
    expect(sourceDeletePath(2, { points: 4, mappings: 4 })).toBe("/api/sources/2?confirm=true&expect_points=4&expect_mappings=4");
  });
  it("send zeros too (a count of 0 is an expectation, not an absent one)", () => {
    expect(assetDeletePath(7, { assets: 1, mappings: 0, tariffs: 0 })).toBe("/api/assets/7?confirm=true&expect_assets=1&expect_mappings=0&expect_tariffs=0");
    expect(sourceDeletePath(7, { points: 0, mappings: 0 })).toBe("/api/sources/7?confirm=true&expect_points=0&expect_mappings=0");
  });
});
