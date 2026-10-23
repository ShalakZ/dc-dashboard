import { METRICS } from "../api/types";
import { check, created, PENRG_B, POWER, report, shape, VOLTAGE } from "../test/shapesFixtures";
import {
  assetsChanged, parentWords,
  chosenShapes, coveredTags, decide, decisionBody, decisionOptions, derivedAsset, dryRunPath, duplicatesWarning, exampleText, mappedSentence, MAX_DECISIONS,
  mixedUnitsWarning, namePartsWarning, NO_DECISIONS, onExistingAssets, outlierTexts, partsOf, plannerStops, readLink, realRunPath, reviewLabel, rowOf, rowWarnings,
  mergeRules, presetFromRules, ruleChoice, ruleSentence, searchTerm, shapeCountsSentence, shapesPageLink, similarSentence, splitSections, suggestionSentence, tick, tooManyText, wantsRules, withoutRule,
} from "./shapes";

const A = shape();
const B = PENRG_B();
const similar = (key: string) => (key === A.key ? [B.key] : key === B.key ? [A.key] : []);

describe("the words of a row", () => {
  it("puts the suggestion in words, with where the guess comes from", () => {
    expect(suggestionSentence(A)).toBe("kWh counter, a guess from the unit kWh");
    expect(suggestionSentence(POWER())).toBe("kW power reading, a guess from the unit kW");
    expect(suggestionSentence(shape({ unit_hints: [] }))).toBe("kWh counter, a guess from the tag name");
    expect(suggestionSentence(shape({ unit_hints: ["kWh", "Wh"], mixed_units: true, suggestion: { ...A.suggestion, mixed: true } }))).toBe(
      "kWh counter, a guess from the unit kWh and Wh (the tags of this shape do not all agree)",
    );
  });

  it("offers Ignore, then Map as the suggestion, then every other metric once", () => {
    const options = decisionOptions(A);
    expect(options.slice(0, 3)).toEqual([{ value: "", text: "Ignore" }, { value: "energy_kwh", text: "Map as energy counter" }, { value: "active_power_kw", text: "Map as active power" }]);
    expect(options.map((o) => o.value)).toEqual(["", "energy_kwh", ...METRICS.filter((m) => m !== "energy_kwh")]);
    expect(decisionOptions(POWER())[1]).toEqual({ value: "active_power_kw", text: "Map as active power" });
  });

  it("splits a tag at the server's separators and shows the asset name each choice gives for the first example", () => {
    expect(partsOf("PDUA01_PM0_PENRG")).toEqual(["PDUA01", "PM0", "PENRG"]);
    expect(partsOf("HALL2.RK014.PDU-L.kWh")).toEqual(["HALL2", "RK014", "PDU", "L", "kWh"]);
    const example = A.examples[0];
    expect(derivedAsset(example, "part1")).toBe("PDUA01");
    expect(derivedAsset(example, "parts12")).toBe("PDUA01 PM0");
    expect(derivedAsset(example, "part1_part2")).toBe("PDUA01 / PM0");
    expect(derivedAsset({ name: "Solo", address: "a" }, "parts12")).toBeNull();
    expect(derivedAsset(undefined, "part1")).toBeNull();
  });

  it("takes the parts of a name that fell back to its node id from the part after the cluster", () => {
    expect(exampleText({ name: "ns=3;s=20403:Site.PDUA01_PM0_P", address: "ns=3;s=20403:Site.PDUA01_PM0_P" })).toBe("PDUA01_PM0_P");
    expect(exampleText({ name: "i=85", address: "i=85" })).toBe("i=85");
    expect(exampleText({ name: "Meter 1", address: "a1" })).toBe("Meter 1");
  });

  it("warns about mixed units, about renumbered duplicates and about an asset name that needs two parts", () => {
    expect(mixedUnitsWarning(A)).toBeNull();
    expect(mixedUnitsWarning(shape({ unit_hints: ["kWh", "Wh"], mixed_units: true }))).toBe("This shape has the units kWh and Wh, so it can only be mapped as custom.");
    expect(duplicatesWarning(A)).toBeNull();
    // `duplicates` counts the MEMBERS involved (a pair is 2): the sentence counts the tags that appear twice, half of that, rounded down.
    expect(duplicatesWarning(shape({ duplicates: 1200 }))).toMatch(/^600 tags of this shape appear twice \(the SCADA renumbered them\)\. Switch on "Stable tag addresses"/);
    expect(duplicatesWarning(shape({ duplicates: 2 }))).toMatch(/^1 tag of this shape appears twice \(the SCADA renumbered it\)\. Switch on "Stable tag addresses"/);
    expect(duplicatesWarning(shape({ duplicates: 7 }))).toMatch(/^3 tags of this shape appear twice/);
    expect(duplicatesWarning(shape({ duplicates: 1 }))).toMatch(/^1 tag of this shape appears twice/); // never "0 tags" while the server says there are duplicates
    const solo = shape({ examples: [{ name: "Solo", address: "a" }] });
    expect(namePartsWarning(solo, { metric: "energy_kwh", nameFrom: "parts12" })).toBe('The example Solo has only one part, so "parts 1 and 2" does not fit. Choose "part 1".');
    expect(namePartsWarning(solo, { metric: "energy_kwh", nameFrom: "part1" })).toBeNull();
    expect(namePartsWarning(solo, { metric: null, nameFrom: "parts12" })).toBeNull(); // an ignored row says nothing about its asset name
    expect(rowWarnings(shape({ duplicates: 2, unit_hints: ["kWh", "Wh"], mixed_units: true }), { metric: null, nameFrom: "part1" })).toHaveLength(2);
  });
});

describe("the decisions", () => {
  it("start as Ignore with part 1 and nothing ticked", () => {
    expect(NO_DECISIONS).toEqual({ choices: {}, ticks: {} });
    expect(chosenShapes(NO_DECISIONS, new Map([[A.key, A]]))).toEqual([]);
  });

  it("change one row and leave the similar one alone while its tick is off", () => {
    const state = decide(NO_DECISIONS, A.key, { metric: "energy_kwh" }, similar);
    expect(state.choices[A.key]).toEqual({ metric: "energy_kwh", nameFrom: "part1" });
    expect(state.choices[B.key]).toBeUndefined();
  });

  it("copy the decision to the similar shapes when the tick goes on, and keep them in step while it stays on", () => {
    let state = decide(NO_DECISIONS, A.key, { metric: "energy_kwh", nameFrom: "parts12" }, similar);
    state = tick(state, A.key, true, similar);
    expect(state.choices[B.key]).toEqual({ metric: "energy_kwh", nameFrom: "parts12" });
    state = decide(state, A.key, { metric: "voltage_v" }, similar);
    expect(state.choices[B.key]).toEqual({ metric: "voltage_v", nameFrom: "parts12" });
    state = decide(state, A.key, { metric: null }, similar); // back to Ignore: the twin follows
    expect(state.choices[B.key].metric).toBeNull();
  });

  it("stop following when the tick goes off: the similar shape keeps what it had", () => {
    let state = tick(decide(NO_DECISIONS, A.key, { metric: "energy_kwh" }, similar), A.key, true, similar);
    state = tick(state, A.key, false, similar);
    state = decide(state, A.key, { metric: "current_a" }, similar);
    expect(state.choices[B.key].metric).toBe("energy_kwh");
    expect(state.ticks[A.key]).toBe(false);
  });

  it("follow a chain of ticks once and survive a tick that points back (no endless copying)", () => {
    const c = shape({ key: "pdub#_pm#_p", label: "PDUB#_PM0_P" });
    const chain = (key: string) => (key === A.key ? [B.key] : key === B.key ? [A.key, c.key] : []);
    let state = tick(NO_DECISIONS, B.key, true, chain);
    state = tick(state, A.key, true, chain);
    state = decide(state, A.key, { metric: "frequency_hz" }, chain);
    expect(state.choices[B.key].metric).toBe("frequency_hz");
    expect(state.choices[c.key].metric).toBe("frequency_hz");
  });

  it("only count the shapes that have a metric, in the order the page saw them, with the tags they cover", () => {
    const known = new Map([A, B, POWER(), VOLTAGE()].map((s) => [s.key, s]));
    let state = decide(NO_DECISIONS, VOLTAGE().key, { metric: "voltage_v" }, similar);
    state = decide(state, A.key, { metric: "energy_kwh" }, similar);
    const chosen = chosenShapes(state, known);
    expect(chosen.map((c) => c.shape.key)).toEqual([A.key, VOLTAGE().key]);
    expect(coveredTags(chosen)).toBe(800);
    expect(decisionBody(chosen)).toEqual([
      { shape: A.key, metric: "energy_kwh", name_from: "part1" },
      { shape: VOLTAGE().key, metric: "voltage_v", name_from: "part1" },
    ]);
    expect(Object.keys(decisionBody(chosen)[0])).not.toContain("scale");
  });

  it("words the tick for one, two or many similar shapes, naming a shape the page has no label for by its key", () => {
    const label = (key: string) => (key === B.key ? B.label : key);
    expect(similarSentence([B.key], label)).toBe("Same decision for PDUB#_PM0_PENRG");
    expect(similarSentence([B.key, "x#"], label)).toBe("Same decision for PDUB#_PM0_PENRG and x#");
    expect(similarSentence([B.key, "x#", "y#"], label)).toBe("Same decision for PDUB#_PM0_PENRG, x# and 1 more");
  });

  it("says why a review of more than the limit is refused, and labels the button with the tags covered", () => {
    expect(MAX_DECISIONS).toBe(60);
    expect(tooManyText(61)).toBe("You chose 61 shapes; one review takes at most 60. Ignore some of them and map them in a second round.");
    expect(reviewLabel(0)).toBe("Review mappings...");
    expect(reviewLabel(1)).toBe("Review 1 mapping...");
    expect(reviewLabel(15000)).toBe("Review 15,000 mappings...");
  });
});

describe("the sections, the search and the address", () => {
  it("splits the billing guesses from the rest and keeps the server's order inside each", () => {
    const { billing, rest } = splitSections([POWER(), A, VOLTAGE(), B]);
    expect(billing.map((s) => s.key)).toEqual([POWER().key, A.key, B.key]);
    expect(rest.map((s) => s.key)).toEqual([VOLTAGE().key]);
  });

  it("sends no search for fewer than 2 characters, and clips to 100", () => {
    expect(searchTerm("")).toBe("");
    expect(searchTerm("P")).toBe("");
    expect(searchTerm("  P ")).toBe("");
    expect(searchTerm(" PENRG ")).toBe("PENRG");
    expect(searchTerm("x".repeat(150))).toHaveLength(100);
  });

  it("builds the deep link with URLSearchParams: a shape key holds # and a search may hold & or %", () => {
    expect(shapesPageLink(5)).toBe("/sources/5/shapes");
    expect(shapesPageLink(5, { q: "PENRG" })).toBe("/sources/5/shapes?q=PENRG");
    const link = shapesPageLink(5, { q: "a&b 100%", focus: "pdua#_pm#_penrg" });
    expect(link).toBe("/sources/5/shapes?q=a%26b+100%25&focus=pdua%23_pm%23_penrg");
    expect(readLink(new URL(`http://x${link}`).searchParams)).toEqual({ q: "a&b 100%", focus: "pdua#_pm#_penrg" });
    expect(readLink(new URLSearchParams())).toEqual({ q: "", focus: "" });
    expect(readLink(new URLSearchParams({ q: "y".repeat(120) })).q).toHaveLength(100);
  });

  it("finds a row by comparing its data-shape value, so a key with # needs no selector", () => {
    document.body.innerHTML = '<ul><li data-shape="pdua#_pm#_penrg"></li><li data-shape="pdub#_pm#_penrg" id="second"></li></ul>';
    expect(rowOf(document.body, "pdub#_pm#_penrg")?.id).toBe("second");
    expect(rowOf(document.body, "nope")).toBeNull();
    document.body.innerHTML = "";
  });
});

describe("the Review", () => {
  it("words the counts of a shape and leaves out what is zero", () => {
    expect(shapeCountsSentence({ shape: "k", label: "L", lines: 400, assets: 400, skipped_mapped: 12, skipped_twins: 0 })).toBe("400 tags on up to 400 assets, 12 already mapped, left as they are");
    expect(shapeCountsSentence({ shape: "k", label: "L", lines: 1, assets: 1, skipped_mapped: 0, skipped_twins: 1 })).toBe("1 tag on up to 1 asset, 1 copy of a mapped tag, left as they are");
    expect(shapeCountsSentence({ shape: "k", label: "L", lines: 1200, assets: 3, skipped_mapped: 0, skipped_twins: 0 })).toBe("1,200 tags on up to 3 assets");
  });

  it("says the assets changed only when the server gave a number and the planner's count differs from it", () => {
    expect(assetsChanged(398, report())).toBe(false); // equal
    expect(assetsChanged(400, report())).toBe(true); // the planner now creates 398
    expect(assetsChanged(0, report({ assets_to_create_total: 0 }))).toBe(false);
    expect(assetsChanged(0, report())).toBe(true);
    expect(assetsChanged(null, report())).toBe(false); // the server's planner did not run: nothing to compare
    expect(assetsChanged(undefined, report())).toBe(false); // an older answer without the field
    expect(assetsChanged(398, null)).toBe(false); // no dry run yet
  });

  it("joins the parent path the server used, or says nothing when the answer has none", () => {
    expect(parentWords(["Hall 1", "Row A"], "Hall 1")).toBe("under Hall 1 / Row A");
    expect(parentWords(["Hall 1"], null)).toBe("under Hall 1");
    expect(parentWords([], "Hall 1")).toBe("at the top level"); // the server used the top level (the parent is gone): that is what the sentence says
    expect(parentWords(undefined, "Hall 1")).toBe("under Hall 1"); // an older answer: the label the page chose
    expect(parentWords(undefined, null)).toBe("at the top level");
  });

  it("counts the tags that go onto assets that exist already, never below zero", () => {
    expect(onExistingAssets(400, 398)).toBe(2);
    expect(onExistingAssets(400, 800)).toBe(0);
  });

  it("repeats the outlier warnings in the sentence of the toast", () => {
    const checks = [check(), check({ kind: "collision", severity: "blocking", text: "x" })];
    expect(outlierTexts(checks)).toEqual(["198 of 200 like PDUA01 have this tag; PDUA17 and PDUA44 do not"]);
    expect(mappedSentence(400, [])).toBe("Created 400 mappings.");
    expect(mappedSentence(1, outlierTexts(checks))).toBe("Created 1 mapping. Check: 198 of 200 like PDUA01 have this tag; PDUA17 and PDUA44 do not.");
  });

  it("stops on a planner problem or a report that is not ok", () => {
    expect(plannerStops(report())).toBe(false);
    expect(plannerStops(report({ problems_total: 1 }))).toBe(true);
    expect(plannerStops(report({ ok: false }))).toBe(true);
    expect(plannerStops(created())).toBe(false);
  });

  it("builds the two tag-list calls the way the tag list dialog does", () => {
    expect(dryRunPath(5, true)).toBe("/api/sources/5/tag-list?dry_run=1&create_assets=1");
    expect(dryRunPath(5, false)).toBe("/api/sources/5/tag-list?dry_run=1&create_assets=0");
    const real = new URL(`http://x${realRunPath(5, true, report())}`);
    expect(Object.fromEntries(real.searchParams)).toEqual({
      dry_run: "0", create_assets: "1", expect_points: "0", expect_assets: "398", expect_mappings: "400", expect_plan: "digest-1",
    });
  });
});

describe("saved rules (T7b)", () => {
  const RULE = { metric: "energy_kwh" as const, name_from: "part1" as const };

  it("words a rule the way the row says it", () => {
    expect(ruleSentence(RULE)).toBe("Saved rule: Map as energy counter, asset name part 1");
    expect(ruleSentence({ metric: "active_power_kw", name_from: "parts12" })).toBe("Saved rule: Map as active power, asset name parts 1 and 2");
    expect(ruleSentence({ metric: "custom", name_from: "part1_part2", unit: "bar", scale: 2 })).toBe("Saved rule: Map as custom, asset name part 1 / part 2");
  });

  it("a rule is the choice of a row", () => {
    expect(ruleChoice({ metric: "voltage_v", name_from: "parts12", interval_seconds: 5 })).toEqual({ metric: "voltage_v", nameFrom: "parts12" });
  });

  it("merges the decisions into the rules already saved: the decided keys are replaced, the others stay exactly as they are", () => {
    const saved = { "other#": { metric: "current_a" as const, name_from: "part1" as const, interval_seconds: 5 }, [A.key]: { metric: "custom" as const, name_from: "part1" as const, unit: "x" } };
    const merged = mergeRules(saved, [
      { shape: A.key, metric: "energy_kwh", name_from: "parts12" },
      { shape: B.key, metric: "energy_kwh", name_from: "part1" },
    ]);
    expect(merged).toEqual({
      "other#": { metric: "current_a", name_from: "part1", interval_seconds: 5 },
      [A.key]: { metric: "energy_kwh", name_from: "parts12" },
      [B.key]: { metric: "energy_kwh", name_from: "part1" },
    });
    expect(Object.keys(merged[A.key]).sort()).toEqual(["metric", "name_from"]); // the decision's own `shape` is not part of a rule (the server refuses an extra key)
    expect(saved[A.key]).toEqual({ metric: "custom", name_from: "part1", unit: "x" }); // the argument is not changed
  });

  it("forgets one key and keeps the rest", () => {
    expect(withoutRule({ a: RULE, b: RULE }, "a")).toEqual({ b: RULE });
    expect(withoutRule({ a: RULE }, "zzz")).toEqual({ a: RULE });
  });

  it("presets only the rows that have a rule AND unmapped tags left (count - mapped - twins)", () => {
    const done = shape({ key: "done#", label: "DONE#", count: 10, mapped: 8, twins: 2, rule: RULE });
    const withTwins = shape({ key: "twins#", label: "TWINS#", count: 10, mapped: 5, twins: 4, rule: RULE });
    const none = shape({ key: "plain#", label: "PLAIN#", count: 10, rule: null });
    const fresh = shape({ key: "fresh#", label: "FRESH#", count: 10, mapped: 9, rule: { metric: "voltage_v", name_from: "parts12", scale: 1 } });
    const preset = presetFromRules([done, withTwins, none, fresh]);
    expect(preset.choices).toEqual({ "twins#": { metric: "energy_kwh", nameFrom: "part1" }, "fresh#": { metric: "voltage_v", nameFrom: "parts12" } });
    expect(preset.ticks).toEqual({});
    expect(presetFromRules([none, done])).toEqual(NO_DECISIONS);
  });

  it("builds the shapes link with ?rules=1 beside q and focus, and reads it back; nothing else counts as on", () => {
    expect(shapesPageLink(5, { rules: true })).toBe("/sources/5/shapes?rules=1");
    expect(shapesPageLink(5, { rules: false })).toBe("/sources/5/shapes");
    expect(shapesPageLink(5, { q: "PENRG", rules: true })).toBe("/sources/5/shapes?q=PENRG&rules=1");
    expect(wantsRules(new URLSearchParams("rules=1"))).toBe(true);
    expect(wantsRules(new URLSearchParams("q=a&rules=1"))).toBe(true);
    expect(wantsRules(new URLSearchParams("rules=0"))).toBe(false);
    expect(wantsRules(new URLSearchParams("rules=true"))).toBe(false);
    expect(wantsRules(new URLSearchParams())).toBe(false);
  });
});
