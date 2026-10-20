/**
 * How a dashboard figure is SHOWN (w27). Pure: no React and no locale API. Rounding is `toFixed` (what every old figure and Billing use, so a card never
 * differs from Billing by a cent) and grouping is a comma every three digits of the integer part, written by a regular expression, so a browser set to
 * German cannot change a digit. A figure has three faces:
 *  - the CARD face (`cardFigure`, `cardText`): compact, scaled (kWh to MWh, a cost to k and M), for stat and gauge figures, both sides of a comparison, the
 *    change line and the breakdown line;
 *  - the TICK face (`tickText`): a chart axis label or a gauge scale end, only the decimals the tick needs;
 *  - the EXACT face (`exactText`): the base unit, two decimals, never scaled, for tables, Details, tooltips and the `title` of every card figure.
 * This module computes nothing about money or energy: it prints a value it is given.
 */

/** The marks a figure carries: `~` when some of it is estimated, `*` when some hours have no rate (a cost). Same fields as `Flags` in `widgetFormat.ts`. */
export interface Marks { estimated: boolean; partial: boolean }

/** energy: kWh, kW, kVA, kvar step by 1,000; cost: the currency code (or none) steps to k and M; plain: everything else never scales. */
export type Family = "energy" | "cost" | "plain";

/**
 * One unit for a group of figures. `divisor` is what a base-unit value is divided by, `unit` what is printed after the figure (the energy unit changes, a
 * cost keeps its currency code), `letter` goes right behind a cost figure, `axisName` names a chart axis drawn in this scale. `family` tells the card face
 * which decimals a figure gets (added to the plan's shape; build scales with `pickScale` or `IDENTITY`, never by hand).
 */
export interface Scale { divisor: number; unit: string | null; letter: "" | "k" | "M"; axisName: string | null; family: Family }

/** What `amountText` returns: the unsigned printed digits, whether every printed digit is 0, and the sign of the raw value. */
export interface Amount { digits: string; zero: boolean; negative: boolean }

type Source = "metric" | "energy" | "cost";

const DASH = "—";

/** The energy-family units and the names they step through, by 1,000 each. kVA and kvar stop at M. */
const ENERGY_CHAINS: ReadonlyMap<string, readonly string[]> = new Map([
  ["kWh", ["kWh", "MWh", "GWh"]],
  ["kW", ["kW", "MW", "GW"]],
  ["kVA", ["kVA", "MVA"]],
  ["kvar", ["kvar", "Mvar"]],
]);

/** The units an energy figure steps through (just itself for a unit that is not in the family). */
const chainOf = (unit: string | null): readonly (string | null)[] => (unit !== null ? ENERGY_CHAINS.get(unit) : undefined) ?? [unit];

const COST_DIVISORS = [1, 1_000, 1_000_000] as const;
const COST_LETTERS = ["", "k", "M"] as const;

/** Energy card face: two decimals below this, none from here (until the next unit takes over at ENERGY_STEP_UP). */
const ENERGY_TWO_DECIMALS_BELOW = 10_000;
/** Energy card face: from this value (after rounding) the figure moves up one unit, when the family has one. */
const ENERGY_STEP_UP = 100_000;
/** Cost card face: below this two decimals as they are, from here k. */
const COST_K_FROM = 100_000;
/** Cost card face: from this many thousands (after rounding) M. */
const COST_M_FROM = 1_000;

const isFigure = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

const unitTail = (unit: string | null): string => (unit ? ` ${unit}` : "");

/** The family of a figure: an energy unit of a metric or energy source, a cost, or one that never scales. */
export function familyOf(unit: string | null, source: Source): Family {
  if (source === "cost") return "cost";
  return unit !== null && ENERGY_CHAINS.has(unit) ? "energy" : "plain";
}

/** "1234567.5" becomes "1,234,567.5": a comma every three digits of the integer part; the decimals and anything that is not digits are left alone. */
export function groupDigits(digits: string): string {
  const dot = digits.indexOf(".");
  const whole = dot < 0 ? digits : digits.slice(0, dot);
  const rest = dot < 0 ? "" : digits.slice(dot);
  return whole.replace(/\B(?=(\d{3})+$)/g, ",") + rest;
}

/** The scale at a step (0 is the base unit) of a family. A step past the family's last is the last. */
function scaleAt(family: Family, unit: string | null, step: number): Scale {
  if (family === "energy") {
    const chain = chainOf(unit);
    const at = Math.max(0, Math.min(step, chain.length - 1));
    return { divisor: 1000 ** at, unit: chain[at], letter: "", axisName: chain[at] || null, family };
  }
  if (family === "cost") {
    const at = Math.max(0, Math.min(step, 2));
    const letter = COST_LETTERS[at];
    const axisName = at === 0 ? unit || null : unit ? `${letter} ${unit}` : at === 1 ? "thousands" : "millions";
    return { divisor: COST_DIVISORS[at], unit, letter, axisName, family };
  }
  return { divisor: 1, unit, letter: "", axisName: unit || null, family };
}

/** A figure in its own base unit: no scaling, two decimals always. The exact face is printed at this scale. */
export const IDENTITY = (unit: string | null): Scale => scaleAt("plain", unit, 0);

/** The unsigned digits of |value| at a scale, rounded by `toFixed`, not yet grouped. The decimals follow the figure's own size at that scale. */
function printed(abs: number, scale: Scale): string {
  const x = abs / scale.divisor;
  if (scale.family === "energy") {
    const twoDecimals = x.toFixed(2);
    return Number(twoDecimals) < ENERGY_TWO_DECIMALS_BELOW ? twoDecimals : x.toFixed(0);
  }
  return x.toFixed(2);
}

/** The step a figure of this size is shown in: the unit is chosen AFTER rounding, at every step. */
function stepFor(family: Family, unit: string | null, abs: number): number {
  if (family === "energy") {
    const last = chainOf(unit).length - 1;
    for (let step = 0; step < last; step += 1) {
      const x = abs / 1000 ** step;
      if (Number(x.toFixed(2)) < ENERGY_TWO_DECIMALS_BELOW || Number(x.toFixed(0)) < ENERGY_STEP_UP) return step;
    }
    return last;
  }
  if (family === "cost") {
    if (Number(abs.toFixed(2)) < COST_K_FROM) return 0;
    return Number((abs / 1_000).toFixed(2)) < COST_M_FROM ? 1 : 2;
  }
  return 0;
}

/**
 * The scale one GROUP of figures shares (both sides of a comparison; a gauge's value, min and max): the largest |value| decides, after rounding, so 9,999.996 kWh
 * is 10,000 kWh, 99,999.5 kWh is 100.00 MWh and a cost of 99,999.996 is 100.00k. If a non-zero member would print all zeros in that unit (4 kWh beside 500,000 kWh
 * would read 0.00 MWh) the group steps down until it shows a non-zero digit: the unit stays shared ("500,000 kWh" and "4.00 kWh"). Null, NaN and infinite members
 * are ignored; with none the scale is the base unit. For a chart axis pass the largest |value| the chart draws, not every point: a tiny point must not demote the axis.
 */
export function pickScale(family: Family, unit: string | null, values: readonly (number | null | undefined)[]): Scale {
  let top = 0;
  let smallest = Infinity;
  for (const value of values) {
    if (!isFigure(value)) continue;
    const abs = Math.abs(value);
    if (abs > top) top = abs;
    if (abs > 0 && abs < smallest) smallest = abs;
  }
  let step = stepFor(family, unit, top);
  while (step > 0 && smallest !== Infinity && Number(printed(smallest, scaleAt(family, unit, step))) === 0) step -= 1;
  return scaleAt(family, unit, step);
}

/**
 * The amount at a scale: `digits` are the grouped digits without sign, scale letter or marks; `zero` is true iff every printed digit is 0 (a zero never
 * prints a minus, and a change that prints as zero is "no change"); `negative` is the sign of the raw value. A missing figure is a dash that is not zero.
 */
export function amountText(value: number | null | undefined, scale: Scale): Amount {
  if (!isFigure(value)) return { digits: DASH, zero: false, negative: false };
  const text = printed(Math.abs(value), scale);
  return { digits: groupDigits(text), zero: Number(text) === 0, negative: value < 0 };
}

function withMarks(amount: Amount, letter: string, marks: Marks): string {
  const sign = amount.negative && !amount.zero ? "-" : "";
  return `${marks.estimated ? "~" : ""}${sign}${amount.digits}${letter}${marks.partial ? "*" : ""}`;
}

/** The card face without its unit: "~275.43*", "-562.82", "275.43k*". A missing figure is a dash with no marks. */
export function cardFigure(value: number | null | undefined, scale: Scale, marks: Marks): string {
  if (!isFigure(value)) return DASH;
  return withMarks(amountText(value, scale), scale.letter, marks);
}

/** `cardFigure` and the scale's unit: "~-562.82 kWh", "275.43k* QAR". A dash gets no unit. */
export function cardText(value: number | null | undefined, scale: Scale, marks: Marks): string {
  if (!isFigure(value)) return DASH;
  return `${cardFigure(value, scale, marks)}${unitTail(scale.unit)}`;
}

/** The exact face: the base unit, grouped, two decimals, never scaled: "~275,430.26 kWh". A dash gets no unit and no marks. */
export function exactText(value: number | null | undefined, unit: string | null, marks: Marks): string {
  if (!isFigure(value)) return DASH;
  return `${withMarks(amountText(value, IDENTITY(unit)), "", marks)}${unitTail(unit)}`;
}

/**
 * The tick face: the value in the axis unit (divided by `divisor`), grouped, with only the decimals it needs (at most two): "18,000", "0", "0.5". A tick that
 * rounds to zero is "0" with no minus.
 */
export function tickText(value: number, divisor = 1): string {
  if (!isFigure(value) || !(divisor > 0)) return DASH;
  const fixed = (Math.abs(value) / divisor).toFixed(2);
  if (Number(fixed) === 0) return "0";
  return `${value < 0 ? "-" : ""}${groupDigits(fixed.replace(/\.?0+$/, ""))}`;
}

/** A percentage as the change line prints it: one decimal, grouped, without sign (the words up and down carry the direction): "0.2", "1,234.6". */
export const percentDigits = (value: number): string => groupDigits(Math.abs(value).toFixed(1));
