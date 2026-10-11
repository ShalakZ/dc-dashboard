import { addDays, isSiteDay } from "./siteTime";

/** "" and [] mean "not set". */
export interface AuditFilters { user: string; actions: string[]; from: string; to: string; q: string }

export const NO_FILTERS: AuditFilters = { user: "", actions: [], from: "", to: "", q: "" };

export const PAGE_SIZES = [25, 50, 100, 200] as const;
export const DEFAULT_SIZE = 50;

export interface AuditUrlState { filters: AuditFilters; offset: number; size: number; view: "friendly" | "raw" }

const hasText = (q: string) => q.trim() !== "";

// What the API accepts (backend/dcdash/api/audit.py); anything else in an address is dropped instead of becoming an error page.
const USER_VALUE = /^(none|\d{1,9})$/;
const ACTION_VALUE = /^\*?[a-z0-9_.]+\*?$/;
const MAX_ACTION_LENGTH = 60;
const MAX_ACTIONS = 20;
/** The API refuses days outside these years (a browser date box accepts year 275760). */
export const FIRST_DAY = "1970-01-01";
export const LAST_DAY = "2100-12-31";

/** The state held in the page's URL. Anything unusable falls back to its default instead of failing. */
export function readUrl(params: URLSearchParams): AuditUrlState {
  const day = (key: string) => {
    const value = params.get(key) ?? "";
    return isSiteDay(value) && value >= FIRST_DAY && value <= LAST_DAY ? value : "";
  };
  const rawOffset = params.get("offset") ?? "";
  const offset = /^\d+$/.test(rawOffset) && Number.isSafeInteger(Number(rawOffset)) ? Number(rawOffset) : 0;
  const rawSize = Number(params.get("size"));
  const q = params.get("q") ?? "";
  const user = params.get("user") ?? "";
  return {
    filters: {
      user: USER_VALUE.test(user) ? user : "",
      actions: params
        .getAll("action")
        .filter((action) => action.length <= MAX_ACTION_LENGTH && ACTION_VALUE.test(action))
        .slice(0, MAX_ACTIONS),
      from: day("from"),
      to: day("to"),
      q: hasText(q) ? q : "",
    },
    offset,
    size: (PAGE_SIZES as readonly number[]).includes(rawSize) ? rawSize : DEFAULT_SIZE,
    view: params.get("view") === "raw" ? "raw" : "friendly",
  };
}

/** The URL's query for `state`; every default is left out, so the plain page has a plain URL. */
export function writeUrl(state: AuditUrlState): URLSearchParams {
  const { filters } = state;
  const params = new URLSearchParams();
  if (filters.user) params.set("user", filters.user);
  for (const action of filters.actions) params.append("action", action);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (hasText(filters.q)) params.set("q", filters.q);
  if (state.offset > 0) params.set("offset", String(state.offset));
  if (state.size !== DEFAULT_SIZE) params.set("size", String(state.size));
  if (state.view === "raw") params.set("view", "raw");
  return params;
}

/** The text after "?" for /api/audit, /api/audit.csv and /api/audit/position: the filters, then `extra`. Empty values are skipped. */
export function apiQuery(filters: AuditFilters, extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams();
  if (filters.user) params.set("user", filters.user);
  for (const action of filters.actions) params.append("action", action);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (hasText(filters.q)) params.set("q", filters.q);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== "") params.set(key, String(value));
  }
  return params.toString();
}

export function isFiltered(filters: AuditFilters): boolean {
  return Boolean(filters.user || filters.actions.length || filters.from || filters.to || hasText(filters.q));
}

export interface QuickFilter { id: string; label: string; patch: (today: string) => Partial<AuditFilters> }

const SIGN_IN_PROBLEMS = ["login.failed", "login.locked", "password.change_failed"];

export const QUICK_FILTERS: QuickFilter[] = [
  { id: "today", label: "Today", patch: (today) => ({ from: today, to: today }) },
  { id: "week", label: "Last 7 days", patch: (today) => ({ from: addDays(today, -6), to: today }) },
  { id: "deletions", label: "Deletions", patch: () => ({ actions: ["*.deleted"] }) },
  { id: "signin", label: "Sign-in problems", patch: () => ({ actions: [...SIGN_IN_PROBLEMS] }) },
];

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((item) => b.includes(item));

/** True when every filter the quick filter sets holds exactly its value (the others are not looked at). */
export function quickActive(quick: QuickFilter, filters: AuditFilters, today: string): boolean {
  const patch = quick.patch(today);
  return (Object.keys(patch) as (keyof AuditFilters)[]).every((key) => {
    const want = patch[key];
    const have = filters[key];
    return Array.isArray(want) && Array.isArray(have) ? sameSet(have, want) : have === want;
  });
}

// Pager arithmetic. An offset need not be a multiple of the page size ("Go to a date" lands anywhere),
// so a page is counted from the start by whole sizes and Previous/Next move by exactly one size.

export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, size)));
}

export function pageOf(offset: number, size: number): number {
  return Math.floor(offset / Math.max(1, size)) + 1;
}

/** The aligned offset of page `page`, the page clamped into 1..pageCount. */
export function offsetOfPage(page: number, size: number, total: number): number {
  const wanted = Number.isFinite(page) ? Math.floor(page) : 1;
  return (Math.min(Math.max(wanted, 1), pageCount(total, size)) - 1) * size;
}

export function previousOffset(offset: number, size: number): number {
  return Math.max(0, offset - size);
}

/** `offset + size`, or null when that is not below `total`. */
export function nextOffset(offset: number, size: number, total: number): number | null {
  return offset + size < total ? offset + size : null;
}

/** The aligned offset of the last page. */
export function lastOffset(size: number, total: number): number {
  return (pageCount(total, size) - 1) * size;
}
