import { NO_EVENT_FILTERS } from "../api/queries";
import type { EventFilters, EventLevel } from "../api/types";
import { FIRST_DAY, LAST_DAY } from "./auditFilters";
import { isSiteDay } from "./siteTime";

export { FIRST_DAY, LAST_DAY };

/** The three levels, in the order the toggles and the address keep them. */
export const LEVELS: readonly EventLevel[] = ["info", "warning", "error"];

/** Nothing set: the same value the query hooks use for the plain page. */
export const NO_FILTERS: EventFilters = NO_EVENT_FILTERS;

/** What the address of the System events page holds: the filters and which view (friendly sentences or the stored rows). */
export interface EventsUrlState { filters: EventFilters; view: "friendly" | "raw" }

// What the API accepts (backend/dcdash/api/events.py); anything else in an address is dropped instead of becoming an error page.
const SOURCE_VALUE = /^\d{1,9}$/;
const KIND_VALUE = /^[a-z][a-z0-9_.]*$/;
const MAX_KIND_LENGTH = 60;
const MAX_KINDS = 20;

/** The state held in the page's address. Anything unusable falls back to its default. */
export function readUrl(params: URLSearchParams): EventsUrlState {
  const day = (key: string) => {
    const value = params.get(key) ?? "";
    return isSiteDay(value) && value >= FIRST_DAY && value <= LAST_DAY ? value : "";
  };
  const source = params.get("source") ?? "";
  const asked = new Set(params.getAll("level"));
  const kinds = [...new Set(params.getAll("kind").filter((kind) => kind.length <= MAX_KIND_LENGTH && KIND_VALUE.test(kind)))].slice(0, MAX_KINDS);
  return {
    filters: {
      source: SOURCE_VALUE.test(source) ? source : "",
      levels: LEVELS.filter((level) => asked.has(level)),
      kinds,
      from: day("from"),
      to: day("to"),
      open: params.get("open") === "1",
    },
    view: params.get("view") === "raw" ? "raw" : "friendly",
  };
}

/** The address's query for `state`; every default is left out, so the plain page has a plain address. */
export function writeUrl(state: EventsUrlState): URLSearchParams {
  const { filters } = state;
  const params = new URLSearchParams();
  if (filters.source) params.set("source", filters.source);
  for (const level of filters.levels) params.append("level", level);
  for (const kind of filters.kinds) params.append("kind", kind);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.open) params.set("open", "1");
  if (state.view === "raw") params.set("view", "raw");
  return params;
}

export function isFiltered(filters: EventFilters): boolean {
  return Boolean(filters.source || filters.levels.length || filters.kinds.length || filters.from || filters.to || filters.open);
}
