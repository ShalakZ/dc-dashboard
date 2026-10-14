import { ApiError } from "../api/client";
import type { MovedAsset } from "../api/types";
import { MOVE_HINT, RATE_WARNING_TITLE, dragBadge, isStaleMove, moveRefusals, movedToast, pickLine, rateText, rateWarning } from "./moveText";

const AFTER = "Past periods are recalculated at the new place, and the totals of both branches change.";
const plain = (rate: number) => String(rate);

describe("rateText", () => {
  it("writes a rate with its currency, or alone when the site has none", () => {
    expect(rateText(0.18, "USD")).toBe("0.18 USD");
    expect(rateText(0.18, null)).toBe("0.18");
  });

  it("writes it the way Billing does: no trailing zeros, six decimals at most", () => {
    expect(rateText(0.1, null)).toBe("0.1");
    expect(rateText(0.1234567, null)).toBe("0.123457");
    expect(rateText(2, "EUR")).toBe("2 EUR");
  });
});

describe("rateWarning", () => {
  const root = (name: string, before: number | null, after: number | null, today = true, other = false) => ({
    name, rate_before: before, rate_after: after, rate_changes_today: today, rate_changes_other_days: other,
  });

  it("has a title for the confirmation", () => {
    expect(rateWarning([root("Pump 3", 0.18, 0.12)], plain).title).toBe("This changes the rate");
    expect(RATE_WARNING_TITLE).toBe("This changes the rate");
  });

  it("names one root and both rates", () => {
    expect(rateWarning([root("Pump 3", 0.18, 0.12)], plain).message).toBe(
      `Moving "Pump 3" changes its rate from 0.18 to 0.12 per kWh. ${AFTER}`,
    );
  });

  it("gives the rates the formatter writes", () => {
    expect(rateWarning([root("Pump 3", 0.18, 0.12)], (rate) => rateText(rate, "USD")).message).toBe(
      `Moving "Pump 3" changes its rate from 0.18 USD to 0.12 USD per kWh. ${AFTER}`,
    );
  });

  it("says 'no rate' for a side without a tariff", () => {
    expect(rateWarning([root("Pump 3", 0.18, null)], plain).message).toBe(`Moving "Pump 3" changes its rate from 0.18 to no rate. ${AFTER}`);
    expect(rateWarning([root("Pump 3", null, 0.12)], plain).message).toBe(`Moving "Pump 3" changes its rate from no rate to 0.12. ${AFTER}`);
  });

  it("does not quote rates for a root whose rate changes only on other days", () => {
    expect(rateWarning([root("Pump 3", 0.18, 0.18, false, true)], plain).message).toBe(
      `Moving "Pump 3" changes the rate some periods are billed at. ${AFTER}`,
    );
  });

  it("quotes today's rates when the rate changes today and on other days too", () => {
    expect(rateWarning([root("Pump 3", 0.18, 0.12, true, true)], plain).message).toContain("from 0.18 to 0.12 per kWh");
  });

  it("lists two roots with their rates", () => {
    expect(rateWarning([root("Pump 3", 0.18, 0.12), root("Pump 4", 0.18, 0.2)], plain).message).toBe(
      `Moving these assets changes their rates: "Pump 3" from 0.18 to 0.12 per kWh; "Pump 4" from 0.18 to 0.2 per kWh. ${AFTER}`,
    );
  });

  it("lists three roots", () => {
    const roots = [root("A", 1, 2), root("B", 1, 3), root("C", 1, null)];
    expect(rateWarning(roots, plain).message).toBe(
      `Moving these assets changes their rates: "A" from 1 to 2 per kWh; "B" from 1 to 3 per kWh; "C" from 1 to no rate. ${AFTER}`,
    );
  });

  it("lists the first three and counts the rest for four or more", () => {
    const four = [root("A", 1, 2), root("B", 1, 3), root("C", 1, 4), root("D", 1, 5)];
    expect(rateWarning(four, plain).message).toBe(
      `Moving these assets changes their rates: "A" from 1 to 2 per kWh; "B" from 1 to 3 per kWh; "C" from 1 to 4 per kWh; and 1 more. ${AFTER}`,
    );
    const six = [...four, root("E", 1, 6), root("F", 1, 7)];
    expect(rateWarning(six, plain).message).toContain('"C" from 1 to 4 per kWh; and 3 more.');
    expect(rateWarning(six, plain).message).not.toContain('"D"');
  });

  it("counts only the roots whose rate changes", () => {
    const roots = [root("Quiet 1", 0.18, 0.18, false, false), root("Pump 3", 0.18, 0.12), root("Quiet 2", null, null, false, false)];
    expect(rateWarning(roots, plain).message).toBe(`Moving "Pump 3" changes its rate from 0.18 to 0.12 per kWh. ${AFTER}`);
    const five = [root("Q", 1, 1, false, false), root("A", 1, 2), root("B", 1, 3), root("C", 1, 4), root("D", 1, 5)];
    expect(rateWarning(five, plain).message).toContain("; and 1 more.");
  });

  it("words an other-days-only root inside a list", () => {
    const roots = [root("Pump 3", 0.18, 0.12), root("Pump 4", 0.18, 0.18, false, true)];
    expect(rateWarning(roots, plain).message).toBe(
      `Moving these assets changes their rates: "Pump 3" from 0.18 to 0.12 per kWh; "Pump 4" for some periods. ${AFTER}`,
    );
  });

  it("still says something when no root is marked as changing", () => {
    expect(rateWarning([root("Quiet", 1, 1, false, false)], plain).message).toBe(`Moving these assets changes the rate they are billed at. ${AFTER}`);
    expect(rateWarning([], plain).message).toBe(`Moving these assets changes the rate they are billed at. ${AFTER}`);
  });
});

describe("movedToast", () => {
  const moved = (name: string, to: string | null, over: Partial<MovedAsset> = {}): MovedAsset => ({
    id: 1, name, from_parent_id: 9, to_parent_id: to === null ? null : 5, from_parent_name: "Old", to_parent_name: to, change: "parent", ...over,
  });

  it("names one asset and its new place", () => {
    expect(movedToast([moved("Pump 3", "Row A")])).toBe("Moved Pump 3 to Row A");
  });

  it("counts several assets that go to one place", () => {
    expect(movedToast([moved("A", "Row A"), moved("B", "Row A"), moved("C", "Row A")])).toBe("Moved 3 assets to Row A");
    expect(movedToast([moved("A", "Row A"), moved("B", "Row A")])).toBe("Moved 2 assets to Row A");
  });

  it("says 'the top level' for a move out to the top", () => {
    expect(movedToast([moved("Pump 3", null)])).toBe("Moved Pump 3 to the top level");
    expect(movedToast([moved("A", null), moved("B", null)])).toBe("Moved 2 assets to the top level");
  });

  it("says 'Reordered' when every root only changed its position", () => {
    expect(movedToast([moved("Pump 3", "Row A", { change: "order" })])).toBe("Reordered Pump 3");
    expect(movedToast([moved("A", "Row A", { change: "order" }), moved("B", "Row A", { change: "order" })])).toBe("Reordered 2 assets");
  });

  it("says 'Moved' when some roots changed parent and some only position", () => {
    expect(movedToast([moved("A", "Row A"), moved("B", "Row A", { change: "order" })])).toBe("Moved 2 assets to Row A");
  });

  it("leaves the place out when the roots went to different places (an undo with several groups)", () => {
    const other = moved("B", "Row B", { to_parent_id: 6 });
    expect(movedToast([moved("A", "Row A"), other])).toBe("Moved 2 assets");
  });

  it("does not make up a name for a place the answer did not name", () => {
    expect(movedToast([moved("Pump 3", null, { to_parent_id: 5 })])).toBe("Moved Pump 3 to a new place");
  });

  it("copes with an answer that moved nothing", () => {
    expect(movedToast([])).toBe("Nothing moved");
  });
});

describe("pickLine", () => {
  it("says what was picked and how many are picked in all", () => {
    expect(pickLine({ kind: "on", name: "Pump 3" }, 3, false)).toBe("Pump 3 picked, 3 picked in all");
  });

  it("does not repeat itself for the first pick", () => {
    expect(pickLine({ kind: "on", name: "Pump 3" }, 1, false)).toBe("Pump 3 picked");
  });

  it("says what was un-picked and what is left", () => {
    expect(pickLine({ kind: "off", name: "Pump 3" }, 2, false)).toBe("Pump 3 unpicked, 2 picked in all");
    expect(pickLine({ kind: "off", name: "Pump 3" }, 1, false)).toBe("Pump 3 unpicked, 1 picked");
    expect(pickLine({ kind: "off", name: "Pump 3" }, 0, false)).toBe("Pump 3 unpicked, none picked");
  });

  it("says how many a range picked", () => {
    expect(pickLine({ kind: "range", count: 5 }, 5, false)).toBe("5 picked");
  });

  it("says when the picks were cleared", () => {
    expect(pickLine({ kind: "clear" }, 0, false)).toBe("Picks cleared");
  });

  it("tells about the M key the first time something is picked, and only then", () => {
    expect(MOVE_HINT).toBe("Press M to move");
    expect(pickLine({ kind: "on", name: "Pump 3" }, 1, true)).toBe("Pump 3 picked. Press M to move");
    expect(pickLine({ kind: "range", count: 4 }, 4, true)).toBe("4 picked. Press M to move");
    expect(pickLine({ kind: "off", name: "Pump 3" }, 0, true)).not.toContain("Press M");
    expect(pickLine({ kind: "clear" }, 0, true)).not.toContain("Press M");
  });

  it("never says 'selected': that word means the open asset", () => {
    for (const event of [{ kind: "on", name: "A" }, { kind: "off", name: "A" }, { kind: "range", count: 2 }, { kind: "clear" }] as const) {
      expect(pickLine(event, 2, true)).not.toMatch(/select/i);
    }
  });
});

describe("dragBadge", () => {
  it("shows the name for one asset and a count for several", () => {
    expect(dragBadge(["Pump 3"])).toBe("Pump 3");
    expect(dragBadge(["Pump 3", "Pump 4"])).toBe("2 assets");
    expect(dragBadge(["a", "b", "c"])).toBe("3 assets");
  });
});

describe("moveRefusals", () => {
  const refusal = { id: 3, name: "Pump 3", reason: 'Row A would have two assets named "Pump 3".', code: "name_clash" };

  it("reads the list out of a 422 body", () => {
    const error = new ApiError(422, refusal.reason, { detail: refusal.reason, refusals: [refusal, { ...refusal, id: 4, name: "Pump 4" }] });
    expect(moveRefusals(error)).toEqual([refusal, { ...refusal, id: 4, name: "Pump 4" }]);
  });

  it("keeps the entries that are well formed and fills in what is missing", () => {
    const error = new ApiError(422, "x", { detail: "x", refusals: [refusal, { id: 5, reason: "Only a reason." }, { reason: "no id" }, null, "text", { id: 6 }] });
    expect(moveRefusals(error)).toEqual([refusal, { id: 5, name: "", reason: "Only a reason.", code: "" }]);
  });

  it.each([
    ["a 422 without a list (already there, or a validation error)", new ApiError(422, "already there", { detail: "already there" })],
    ["a 422 whose list is empty", new ApiError(422, "x", { detail: "x", refusals: [] })],
    ["a 422 whose list is not a list", new ApiError(422, "x", { detail: "x", refusals: "no" })],
    ["a 422 with no body", new ApiError(422, "x")],
    ["a different status", new ApiError(409, "x", { refusals: [refusal] })],
    ["a plain error", new Error("x")],
    ["nothing", null],
  ])("is null for %s", (_name, error) => {
    expect(moveRefusals(error)).toBeNull();
  });
});

describe("isStaleMove", () => {
  it("is true for a 409 that says stale", () => {
    expect(isStaleMove(new ApiError(409, "an asset was deleted", { detail: "an asset was deleted", stale: true }))).toBe(true);
  });

  it.each([
    ["a 409 that is not stale", new ApiError(409, "x", { detail: "x" })],
    ["a 409 whose stale is not true", new ApiError(409, "x", { stale: "yes" })],
    ["a 422 that says stale", new ApiError(422, "x", { stale: true })],
    ["a 409 without a body", new ApiError(409, "x")],
    ["a plain error", new Error("x")],
    ["nothing", undefined],
  ])("is false for %s", (_name, error) => {
    expect(isStaleMove(error)).toBe(false);
  });
});
