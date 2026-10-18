import type { BillingClosed, BillingLive } from "../api/types";
import { formatSiteDay, siteDay } from "./siteTime";

/** `2026-01` moved by `delta` months, as plain `YYYY-MM` string maths (no Date, so no timezone can shift it). */
export function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split("-").map(Number);
  const index = year * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** `October 2026` for `2026-10`. */
export function monthLabel(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(year, m - 1, 1)));
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
] as const;

const yearOf = (month: string) => Number(month.slice(0, 4));
const monthOf = (month: string) => Number(month.slice(5, 7));

/** Every year from the lowest month's to the current month's, oldest first (both are `YYYY-MM`). */
export function yearsBetween(lowest: string, current: string): number[] {
  const first = yearOf(lowest);
  return Array.from({ length: Math.max(0, yearOf(current) - first + 1) }, (_, i) => first + i);
}

/** The month numbers (1 to 12) of `year` that lie inside [lowest, current]; empty for a year outside them. */
export function monthsOfYear(year: number, lowest: string, current: string): number[] {
  if (year < yearOf(lowest) || year > yearOf(current)) return [];
  const from = year === yearOf(lowest) ? monthOf(lowest) : 1;
  const to = year === yearOf(current) ? monthOf(current) : 12;
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** `month` pulled into [lowest, current]; plain string compares are right for `YYYY-MM`. */
export const clampMonth = (month: string, lowest: string, current: string) =>
  month < lowest ? lowest : month > current ? current : month;

export const fmtKwh = (kwh: number) => kwh.toFixed(1);
export const fmtCost = (cost: number) => cost.toFixed(2);
/** A rate with up to six decimals and no trailing zeros; a dash when there is none (never zero). */
export const fmtRate = (rate: number | null) => (rate === null ? "—" : String(Number(rate.toFixed(6))));

/** A change with its sign: `+12.50`, `-3.00`. Rounds to `digits` first, so a change that rounds to nothing reads `0.00` and has no sign. */
export function fmtSigned(value: number, digits: number): string {
  const text = Math.abs(value).toFixed(digits);
  return Number(text) === 0 ? text : `${value < 0 ? "-" : "+"}${text}`;
}
/** A kWh change: up to three decimals, none of them trailing zeros, because the server counts a change of a thousandth as a change. */
export function fmtSignedKwh(value: number): string {
  const text = String(Number(Math.abs(value).toFixed(3)));
  return text === "0" ? text : `${value < 0 ? "-" : "+"}${text}`;
}

/** `1 asset differs`, `3 assets differ`. */
const assetsDiffer = (n: number) => (n === 1 ? "1 asset differs" : `${n} assets differ`);

/** What the line under a closed month's banner says when nothing differs, and (in the Reopen dialog) when today's tree cannot be priced. */
export const SAME_FIGURES_TEXT = "Today's tree and rates give the same figures.";
export const UNPRICED_TEXT = "Today's tree and rates cannot be priced right now.";

/**
 * The quiet line under a closed month's banner: what today's tree and rates would give, as the server's `live` says. Null when there is nothing to
 * say (`live` is null or null-like, or `differs` is false: the page words those two itself). `closed` supplies the frozen cost, because
 * `live.delta_cost` is null both when one side has no cost and when neither has one, and the two read differently. `frozenCurrency` is the currency the
 * month was closed in (`costs.currency` of a closed month is the stored one): when today's differs (a null is "no currency"), the two amounts are in
 * different units, so the line gives today's total with both currencies and no signed change. The totals are the roots' sums (R4), so a move or an
 * unmap under a metered parent leaves them alone: `changed_assets` says how many assets' own figures or place changed.
 */
export function liveDeltaText(
  live: BillingLive | null | undefined, closed: Pick<BillingClosed, "total_cost">, frozenCurrency: string | null,
): string | null {
  if (!live?.differs) return null;
  const unit = live.currency ? ` ${live.currency}` : "";
  const assets = live.changed_assets > 0 ? assetsDiffer(live.changed_assets) : null;
  const costDelta = live.total_cost !== null && closed.total_cost !== null ? live.delta_cost : null;
  const kwhDiffers = Math.round(live.delta_kwh * 1000) !== 0;
  const otherCurrency = (live.currency ?? null) !== (frozenCurrency ?? null);
  let total: string | null = null;
  if (otherCurrency && live.total_cost !== null && closed.total_cost !== null) {
    // Two units, so no signed change; a bare number beside "closed in USD" would read as dollars, so a removed currency is said in words.
    total = `${fmtCost(live.total_cost)}${live.currency ? ` ${live.currency}` : " with no currency"} (closed ${frozenCurrency ? `in ${frozenCurrency}` : "with no currency"})`;
  } else if (live.total_cost === null && closed.total_cost !== null) {
    total = "no cost, because there is no rate today"; // the frozen month had a cost; today there is no rate to price it with
  } else if (costDelta !== null && Math.round(costDelta * 100) !== 0) {
    total = `${fmtCost(live.total_cost!)}${unit} (${fmtSigned(costDelta, 2)})`;
  } else if (live.total_cost !== null && closed.total_cost === null) {
    total = `${fmtCost(live.total_cost)}${unit} (the closed figures have no cost)`; // today there is a rate; the frozen month had none
  } else if (kwhDiffers) {
    total = `${fmtKwh(live.total_kwh)} kWh (${fmtSignedKwh(live.delta_kwh)})`; // the cost did not change (or neither side has one)
  }
  if (total === null) {
    return assets ? `Today's tree and rates give the same total, but ${assets}.` : "Today's tree and rates would give different figures.";
  }
  return `Today's tree and rates would give ${total}${assets ? `, ${assets}` : ""}.`;
}

/** The day a month was closed, on the site's wall clock: `Thu 15 Oct 2026`. The instant's own text when it cannot be read. */
export function closedOnText(closedAt: string, timezone: string): string {
  const day = siteDay(new Date(closedAt), timezone);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${formatSiteDay(day)} ${day.slice(0, 4)}` : closedAt;
}
