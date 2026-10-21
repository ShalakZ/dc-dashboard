import { readFileSync } from "node:fs";
import { METRICS, type Metric } from "../api/types";
import { UNIT_LABELS, UNIT_SCALES, scaleForUnit } from "./unitFit";

// The same file backend/tests/test_ingest_normalise.py reads. The server decides which spellings of a unit a metric accepts and the factor to its base
// unit (ingest/normalise.UNITS); the tag-list dialog explains and previews the same rule, so both languages are held to one list of cases.
// vitest runs from the frontend directory.
interface Fixture {
  cases: { metric: Metric; unit: string | null; scale: number }[];
  refused: { metric: Metric; unit: string | null }[];
}
const fixture: Fixture = JSON.parse(readFileSync("../backend/tests/fixtures/unit_samples.json", "utf8"));

// Lower case, ASCII space and tab removed: the fixture's own rule (its `_about`).
const spelling = (unit: string) => unit.toLowerCase().replace(/[ \t]/g, "");
const shown = (unit: string | null) => JSON.stringify(unit);
const named = METRICS.filter((metric): metric is Exclude<Metric, "custom"> => metric !== "custom");

describe("backend/tests/fixtures/unit_samples.json", () => {
  it("has cases for every metric and a refused sample for most of them", () => {
    expect(fixture.cases.length).toBeGreaterThan(20);
    expect(new Set(fixture.cases.map((row) => row.metric))).toEqual(new Set(METRICS));
    expect(fixture.refused.length).toBeGreaterThan(20);
    expect(new Set(fixture.refused.map((row) => row.metric)).size).toBeGreaterThanOrEqual(8);
  });

  it.each(fixture.cases.map((row) => [row.metric, shown(row.unit), row] as const))("%s accepts %s with the factor the server uses", (_metric, _unit, row) => {
    expect(scaleForUnit(row.metric, row.unit)).toBe(row.scale);
  });

  it.each(fixture.refused.map((row) => [row.metric, shown(row.unit), row] as const))("%s refuses %s", (_metric, _unit, row) => {
    expect(scaleForUnit(row.metric, row.unit)).toBeNull();
  });

  // The cases list every spelling a metric accepts (the backend test checks that it is complete), so the front end's table must hold exactly those and no other.
  it.each(named)("%s: UNIT_SCALES holds exactly the spellings of the cases, each with the case's factor", (metric) => {
    const cases = fixture.cases.filter((row) => row.metric === metric);
    const spellings = [...new Set(cases.map((row) => spelling(row.unit ?? "")))].sort();
    expect(Object.keys(UNIT_SCALES[metric]).sort()).toEqual(spellings);
    for (const row of cases) expect(UNIT_SCALES[metric][spelling(row.unit ?? "")], shown(row.unit)).toBe(row.scale);
  });

  it("the help text of every metric names exactly the spellings of UNIT_SCALES", () => {
    for (const metric of named) {
      const labelled = UNIT_LABELS[metric].split(",").map((part) => spelling(part));
      expect(labelled.sort(), metric).toEqual(Object.keys(UNIT_SCALES[metric]).sort());
    }
  });
});
