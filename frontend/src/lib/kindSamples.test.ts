import { readFileSync } from "node:fs";
import { ASSET_ICONS } from "./assetIcons";
import { kindIcon } from "./kindIcon";
import { kindKey } from "./kinds";

// The same file backend/tests/test_asset_kinds_parity.py reads. The server seeds the kinds registry (migration 0010) with a
// Python copy of kindKey and of the keyword matcher, so both languages must give every row the same key and icon. The rows were
// produced by RUNNING the functions below. A wave that changes kindIcon.ts updates the rows (or marks them "as of 0010") here and
// in the Python test, never the frozen migration.
const samples: ReadonlyArray<{ kind: string; key: string; icon: string }> = JSON.parse(
  readFileSync("../backend/tests/fixtures/kind_samples.json", "utf8"), // vitest runs from the frontend directory
);

const catalogueId = (kind: string) => ASSET_ICONS.find((entry) => entry.icon === kindIcon(kind))?.id;
// Invisible characters are written as escapes, so a failure names the row it is about.
const shown = (kind: string) => kind.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).slice(0, 60);

describe("backend/tests/fixtures/kind_samples.json", () => {
  it("has rows to hold the two languages to", () => {
    expect(samples.length).toBeGreaterThan(60);
    expect(samples.every((row) => ASSET_ICONS.some((entry) => entry.id === row.icon))).toBe(true);
  });

  it("gives every kind the key kindKey computes", () => {
    expect(samples.filter((row) => kindKey(row.kind) !== row.key).map((row) => shown(row.kind))).toEqual([]);
  });

  it("gives every kind the catalogue id the keyword matcher answers", () => {
    expect(
      samples.filter((row) => catalogueId(row.kind) !== row.icon).map((row) => `${shown(row.kind)} -> ${catalogueId(row.kind)}, file says ${row.icon}`),
    ).toEqual([]);
  });
});
