/** "12 s", "3 min", "5 h", "2 d"; "—" for no value. Ages come from the server (the database's clock), never the browser's. */
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
