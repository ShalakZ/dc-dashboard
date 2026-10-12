import { describe, expect, it } from "vitest";
import { FIELDS } from "../pages/StoragePage";
import { FIELD_HELP, TILE_HELP } from "./storageHelp";

describe("storageHelp", () => {
  it("has a sentence for every retention and capacity field of the page", () => {
    expect(FIELDS.length).toBe(5);
    for (const [key] of FIELDS) expect(FIELD_HELP[key].trim().length, key).toBeGreaterThan(20);
  });

  it("has a sentence for each of the five summary tiles", () => {
    expect(Object.keys(TILE_HELP).sort()).toEqual(["database", "growth", "projected", "readings", "rollups"]);
    for (const [key, text] of Object.entries(TILE_HELP)) expect(text.trim().length, key).toBeGreaterThan(20);
  });

  it("states the retention semantics of core/storage.py: whole weeks, the hourly tier kept for good", () => {
    expect(FIELD_HELP.raw_retention_days).toMatch(/daily job/);
    expect(FIELD_HELP.raw_retention_days).toMatch(/kept for good/);
    expect(FIELD_HELP.rollup_1m_retention_days).toMatch(/1-hour averages have no limit/);
  });
});
