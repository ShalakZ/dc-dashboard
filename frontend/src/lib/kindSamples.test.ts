import { readFileSync } from "node:fs";
import { ASSET_ICONS } from "./assetIcons";
import { kindIcon } from "./kindIcon";
import { kindKey } from "./kinds";

// The same file backend/tests/test_asset_kinds_parity.py reads. The server seeds the kinds registry (migration 0010) with a
// Python copy of kindKey and of the keyword matcher, so both languages must give every row the same key and icon. The rows were
// produced by RUNNING the functions below. A wave that changes kindIcon.ts updates the rows (or marks them "as of 0010") here and
// in the Python test, never the frozen migration. `icon` is what the frozen 0010 matcher answers (the Python test holds the migration
// to it, and it never changes); a row whose answer here moved on carries `now`, the id this matcher gives today (W7o).
const samples: ReadonlyArray<{ kind: string; key: string; icon: string; now?: string }> = JSON.parse(
  readFileSync("../backend/tests/fixtures/kind_samples.json", "utf8"), // vitest runs from the frontend directory
);

const catalogueId = (kind: string) => ASSET_ICONS.find((entry) => entry.icon === kindIcon(kind))?.id;
// Invisible characters are written as escapes, so a failure names the row it is about.
const shown = (kind: string) => kind.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).slice(0, 60);

describe("backend/tests/fixtures/kind_samples.json", () => {
  it("has rows to hold the two languages to", () => {
    expect(samples.length).toBeGreaterThan(60);
    expect(samples.every((row) => ASSET_ICONS.some((entry) => entry.id === row.icon))).toBe(true);
    expect(samples.every((row) => row.now === undefined || (ASSET_ICONS.some((entry) => entry.id === row.now) && row.now !== row.icon))).toBe(true);
  });

  // Pinned on purpose: a row moves from the frozen answer to a new one only by being listed here, in a commit that says why. Of the 76 rows
  // written before W7o only ATS-1 moved (circuit -> ats); the others are the rows that came with the data-centre pack.
  it("marks exactly these rows as answered differently from the frozen 0010 matcher", () => {
    expect(samples.filter((row) => row.now !== undefined).map((row) => `${row.kind} ${row.icon}>${row.now}`)).toEqual([
      "ATS-1 circuit>ats",
      "Busway circuit>busway",
      "RPP pdu>rpp",
      "ATS circuit>ats",
      "STS circuit>sts",
      "Switchgear panel>switchgear",
      "RMU generic>rmu",
      "Cooling Tower 2 crac>coolingtower",
      "Dry Cooler crac>drycooler",
      "AHU crac>ahu",
      "Cooling distribution unit pdu>cdu",
      "Coolant distribution units pdu>cdu",
      "Air handling unit generic>ahu",
      "Ring main unit generic>rmu",
      "Variable frequency drive generic>vfd",
      "VFD generic>vfd",
      "Remote power panel panel>rpp",
      "Automatic Transfer Switch circuit>ats",
      "Static Transfer Switch circuit>sts",
      "Heat Exchangers generic>heatexchanger",
      "Patch Panel panel>patchpanel",
      "Cable Trays generic>cabletray",
      "Smoke Detector generic>smokedetector",
      "Humidity Sensor sensor>humidity",
      "Router generic>router",
      "Firewall generic>firewall",
      "Valve generic>valve",
      "Data Hall A room>hall",
      "ATS Panel circuit>ats",
    ]);
  });

  it("gives every kind the key kindKey computes", () => {
    expect(samples.filter((row) => kindKey(row.kind) !== row.key).map((row) => shown(row.kind))).toEqual([]);
  });

  it("gives every kind the catalogue id the keyword matcher answers (`now` where the row has one, else `icon`)", () => {
    expect(
      samples
        .filter((row) => catalogueId(row.kind) !== (row.now ?? row.icon))
        .map((row) => `${shown(row.kind)} -> ${catalogueId(row.kind)}, file says ${row.now ?? row.icon}`),
    ).toEqual([]);
  });
});
