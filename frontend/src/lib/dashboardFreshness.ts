import { useQueryClient, type QueryCache } from "@tanstack/react-query";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { keys } from "../api/queries";
import { formatSiteHourMinute } from "./siteTime";

/*
 * "Updated 20:09" and Refresh in the dashboard's header (w27, R12). The answer of POST /api/widget-data carries no time of its own, so the time is the browser's
 * clock at the moment each answer was received (`dataUpdatedAt` of its query), and the header names the OLDEST one on screen: the figure that is furthest behind
 * decides whether the page is current. The server may serve a figure up to its cache lifetime old (30 s), so the text is minute-precise, never second-precise.
 */

/** What the header needs of one widget-data query: a plain copy of the parts of its state that matter. */
export interface AnswerState {
  /** Is there an answer drawn for this query? (A query for a new range or focus has none until it lands: the card draws the previous answer as a placeholder.) */
  hasAnswer: boolean;
  /** When the answer was received, in ms; 0 for none. */
  at: number;
  /** The query has no answer yet. */
  pending: boolean;
  /** A request is out for it. */
  fetching: boolean;
}

export interface Freshness {
  /** The time of the oldest answer on screen, in ms, or null when no active query has one. */
  oldest: number | null;
  /** Some active query is still waiting for its first answer. */
  pending: boolean;
  /** Some active query is being read now. */
  fetching: boolean;
}

/**
 * The rules of D4. The OLDEST answer on screen: a query that failed its last read still draws the answer it had, so it counts with the time of that answer (a
 * failed refetch leaves the old time, which is honest); a query with no answer yet is skipped, so a new range does not claim the page is fresh.
 */
export function summarise(states: readonly AnswerState[]): Freshness {
  let oldest: number | null = null;
  let pending = false;
  let fetching = false;
  for (const state of states) {
    if (state.fetching) fetching = true;
    if (state.pending) pending = true;
    if (!state.hasAnswer || !(state.at > 0)) continue;
    if (oldest === null || state.at < oldest) oldest = state.at;
  }
  return { oldest, pending, fetching };
}

/** `20:09` in the site's zone for a time in ms; null for no time, or a zone the browser does not know (the header then says nothing rather than a wrong time). */
export function updatedClock(at: number | null, timezone: string): string | null {
  return at === null ? null : formatSiteHourMinute(new Date(at), timezone);
}

/** The active widget-data queries of the cache, as the rules above read them. */
function activeAnswers(cache: QueryCache): AnswerState[] {
  return cache.findAll({ queryKey: keys.widgetData, type: "active" }).map(({ state }) => ({
    hasAnswer: state.data !== undefined,
    at: state.dataUpdatedAt,
    pending: state.status === "pending",
    fetching: state.fetchStatus === "fetching",
  }));
}

/** The summary as one string, so `useSyncExternalStore` sees a stable value until something that matters changes. */
const encode = (f: Freshness): string => `${f.oldest ?? ""}|${f.pending ? 1 : 0}|${f.fetching ? 1 : 0}`;
const decode = (text: string): Freshness => {
  const [oldest, pending, fetching] = text.split("|");
  return { oldest: oldest === "" ? null : Number(oldest), pending: pending === "1", fetching: fetching === "1" };
};

export interface DashboardFreshness {
  /** `20:09`, or null before the first answer lands (the header keeps the slot empty). While a new answer is pending it is the previous one. */
  clock: string | null;
  /** An answer is pending: the time is the previous one and is drawn dimmed. */
  waiting: boolean;
  /** Some figure is being read now: Refresh waits. */
  fetching: boolean;
  /** Reads again every widget-data query that is on screen, and no other. */
  refresh: () => void;
}

/** Follows the cache, not the cards: a card that fetches again moves the time without any card passing it on. Used once, by the viewer. */
export function useDashboardFreshness(timezone: string): DashboardFreshness {
  const client = useQueryClient();
  const cache = client.getQueryCache();
  const text = useSyncExternalStore(
    useCallback((notify: () => void) => cache.subscribe(notify), [cache]),
    () => encode(summarise(activeAnswers(cache))),
  );
  const { oldest, pending, fetching } = decode(text);
  // The previous time stays in its slot while the next answer is pending (a new range or focus has no answer yet, and the cards draw the old one meanwhile).
  const kept = useRef<number | null>(null);
  if (oldest !== null) kept.current = oldest;
  const refresh = useCallback(() => {
    void client.refetchQueries({ queryKey: keys.widgetData, type: "active" });
  }, [client]);
  return { clock: updatedClock(oldest ?? kept.current, timezone), waiting: pending, fetching, refresh };
}
