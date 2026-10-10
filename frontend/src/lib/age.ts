/**
 * "12 s", "3 min", "5 h", "2 d"; "—" for no value. Ages come from the server (the database's clock), never the browser's;
 * the browser only adds the time that has elapsed since the answer (see `ageNow`).
 */
export function formatSpan(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, seconds);
  if (s < 60) return `${Math.floor(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** "12 s ago" ...; "—" for no value. */
export function formatAge(seconds: number | null | undefined): string {
  const span = formatSpan(seconds);
  return span === "—" ? span : `${span} ago`;
}

/** Seconds from `since` (epoch ms, such as a query's `dataUpdatedAt`) to `now`; never negative, and 0 when nothing was received yet (`since` 0). */
export function secondsSince(since: number, now: number): number {
  return since > 0 ? Math.max(0, (now - since) / 1000) : 0;
}

/**
 * An age the server gave in an answer received at `since`, grown by the time that has elapsed since then, so that it keeps counting
 * while no new answer arrives. Only elapsed time is measured here, never the browser's clock against the server's. No age stays no age.
 */
export function ageNow(age: number | null | undefined, since: number, now: number): number | null | undefined {
  return age === null || age === undefined ? age : age + secondsSince(since, now);
}
