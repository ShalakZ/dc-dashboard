import type { ScanCounters } from "../api/types";

/** Outcomes as the operator reads them. `claimed` stays as is: the end-to-end test looks for that word. */
const OUTCOME_WORDS: Record<string, string> = {
  claimed: "claimed",
  needs_credentials: "needs credentials",
  unclaimed: "unidentified",
};

export function outcomeLabel(outcome: string): string {
  return OUTCOME_WORDS[outcome] ?? outcome.replace(/_/g, " ");
}

/**
 * Sources the scan identified and could read. `progress.claimed` counts every service a connector claimed, including
 * those that then rejected the credentials (`progress.needs_credentials`), so those are taken out.
 */
export function claimedCount(progress: ScanCounters): number {
  return Math.max(0, (progress.claimed ?? 0) - (progress.needs_credentials ?? 0));
}
