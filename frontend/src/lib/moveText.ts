import { ApiError } from "../api/client";
import type { MovedAsset, MovePreviewRoot, MoveRefusal } from "../api/types";
import { fmtRate } from "./billing";

/** A rate as the warning writes it: the way Billing prints it, then the site currency when it has one ("0.18 USD"). */
export const rateText = (rate: number, currency: string | null) => (currency ? `${fmtRate(rate)} ${currency}` : fmtRate(rate));

export const RATE_WARNING_TITLE = "This changes the rate";
// What a move does to billing, in one sentence (verified in the plan: billing reads the live tree on every request).
const BILLING_NOTE = "Past periods are recalculated at the new place, and the totals of both branches change.";

type RateRoot = Pick<MovePreviewRoot, "name" | "rate_before" | "rate_after" | "rate_changes_today" | "rate_changes_other_days">;

/**
 * The confirmation shown when a move changes the rate an asset is billed at: from a drag in the confirm dialog, from "Move to..." inside
 * the move dialog. Only the roots whose rate changes are counted. One root gets both rates; several get only the FIRST one, with its rates,
 * then "and N more": the text stays the same length however many assets move, because the dialog shows it in a box of a fixed height (a
 * longer text would move the button that the person presses twice, Move and then Move anyway). `formatRate` writes one rate (see
 * `rateText`); a missing rate is written "no rate" here, because nothing then applies and the asset's energy shows without cost. A root
 * whose rate changes only on other days (a dated tariff row) is named without rates.
 */
export function rateWarning(roots: readonly RateRoot[], formatRate: (rate: number) => string): { title: string; message: string } {
  const changing = roots.filter((root) => root.rate_changes_today || root.rate_changes_other_days);
  const side = (rate: number | null) => (rate === null ? "no rate" : formatRate(rate));
  const pair = (root: RateRoot) =>
    `from ${side(root.rate_before)} to ${side(root.rate_after)}${root.rate_before !== null && root.rate_after !== null ? " per kWh" : ""}`;
  let lead: string;
  if (changing.length === 0) {
    lead = "Moving these assets changes the rate they are billed at.";
  } else if (changing.length === 1) {
    const [root] = changing;
    lead = root.rate_changes_today
      ? `Moving "${root.name}" changes its rate ${pair(root)}.`
      : `Moving "${root.name}" changes the rate some periods are billed at.`;
  } else {
    const [first] = changing;
    lead = `Moving these assets changes their rates ("${first.name}" ${first.rate_changes_today ? pair(first) : "for some periods"}, and ${changing.length - 1} more).`;
  }
  return { title: RATE_WARNING_TITLE, message: `${lead} ${BILLING_NOTE}` };
}

/**
 * The toast after a move: "Moved Pump 3 to Row A", "Moved 3 assets to Row A", "Moved Pump 3 to the top level", "Reordered Pump 3". It counts
 * the roots that moved (what the person dragged), not the assets below them. When the roots went to different places (an undo with several
 * groups) the place is left out.
 */
export function movedToast(moved: readonly Pick<MovedAsset, "name" | "to_parent_id" | "to_parent_name" | "change">[]): string {
  if (moved.length === 0) return "Nothing moved";
  const subject = moved.length === 1 ? moved[0].name : `${moved.length} assets`;
  if (moved.every((root) => root.change === "order")) return `Reordered ${subject}`;
  const [first] = moved;
  if (moved.some((root) => root.to_parent_id !== first.to_parent_id)) return `Moved ${subject}`;
  const place = first.to_parent_id === null ? "the top level" : (first.to_parent_name ?? "a new place");
  return `Moved ${subject} to ${place}`;
}

export const MOVE_HINT = "Press M to move";

export type PickEvent = { kind: "on" | "off"; name: string } | { kind: "range"; count: number } | { kind: "clear" };

/**
 * The text of the tree's one polite live line for a change of the picks ("Pump 3 picked, 2 picked in all"). `total` is how many are picked
 * now. `firstPick` adds the hint about the M key to a pick; the caller passes true once, the first time something is picked.
 */
export function pickLine(event: PickEvent, total: number, firstPick: boolean): string {
  if (event.kind === "clear") return "Picks cleared";
  if (event.kind === "off") {
    const left = total === 0 ? "none picked" : total === 1 ? "1 picked" : `${total} picked in all`;
    return `${event.name} unpicked, ${left}`;
  }
  const line = event.kind === "range" ? `${event.count} picked` : total <= 1 ? `${event.name} picked` : `${event.name} picked, ${total} picked in all`;
  return firstPick ? `${line}. ${MOVE_HINT}` : line;
}

/** The text on the small image that follows the pointer during a drag: the asset's name, or how many. */
export const dragBadge = (names: readonly string[]) => (names.length === 1 ? names[0] : `${names.length} assets`);

/**
 * The refusals of a 422 from the move routes (each says which asset and why, in names), or null if this is not that: another status, no
 * `refusals` list, or none of its entries has an id and a reason. Then the error's own message ("already there" and the like) is the text.
 */
export function moveRefusals(error: unknown): MoveRefusal[] | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  const list = (error.body as { refusals?: unknown } | null | undefined)?.refusals;
  if (!Array.isArray(list)) return null;
  const out: MoveRefusal[] = [];
  for (const entry of list) {
    const item = entry as Partial<Record<keyof MoveRefusal, unknown>> | null;
    if (item === null || typeof item !== "object" || typeof item.id !== "number" || typeof item.reason !== "string") continue;
    out.push({
      id: item.id,
      name: typeof item.name === "string" ? item.name : "",
      reason: item.reason,
      code: typeof item.code === "string" ? item.code : "",
    });
  }
  return out.length > 0 ? out : null;
}

/** A 409 from the move routes that says the tree changed since the person looked (an asset or place is gone, or a count or parent differs). */
export const isStaleMove = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409 && (error.body as { stale?: unknown } | null | undefined)?.stale === true;
