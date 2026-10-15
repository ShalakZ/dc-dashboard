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
 * Sources the scan recognised. `progress.claimed` counts every service a connector claimed, including those that then rejected the
 * credentials (`progress.needs_credentials`), so those are taken out. It says nothing about a read: a source added by hand that the scan
 * only matched (`existing source`) and a browse that failed are counted too, hence "recognised" and never "read".
 */
export function claimedCount(progress: ScanCounters): number {
  return Math.max(0, (progress.claimed ?? 0) - (progress.needs_credentials ?? 0));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The same without the name, for the muted line under the scope's name in Recent scans (the cell cuts it with an ellipsis and keeps all of
 * it in its title, so a mistyped port is still there to be seen): `172.20.0.0/24, ports 9000, 4840, 5020`.
 */
export function scopeDetail(targets: readonly string[], ports: readonly number[]): string {
  return [
    targets.join(", "),
    ports.length > 0 ? `${ports.length === 1 ? "port" : "ports"} ${ports.join(", ")}` : "",
  ].filter(Boolean).join(", ");
}

/**
 * What a scan covered, in one line that wraps: `Simulator: 172.20.0.0/24, ports 9000, 4840, 5020`. The name alone when the scan has neither
 * targets nor ports (an old scan whose snapshot did not keep them). Never cut: the drawer is the details view and has the room, and a list
 * that ends in "and 46 more" hides the very port a typo would be in.
 */
export function scopeLine(name: string, targets: readonly string[], ports: readonly number[]): string {
  const detail = scopeDetail(targets, ports);
  return detail ? `${name}: ${detail}` : name;
}

/** `1 source, 60 points`: the sources the scan recognised, and the points found in them. */
export function sourcesAndPoints(progress: ScanCounters): string {
  return `${plural(claimedCount(progress), "source")}, ${plural(progress.points ?? 0, "point")}`;
}

/** The longer wording of the same figures, for a tooltip: `1 source recognised, 60 points found`. */
export function recognisedText(progress: ScanCounters): string {
  return `${plural(claimedCount(progress), "source")} recognised, ${plural(progress.points ?? 0, "point")} found`;
}

/**
 * How many checks a scan made (one per host and port): `762 checks (254 hosts × 3 ports)` once it is done and the checks are exactly
 * hosts times a whole number of ports, else just `762 checks`. While it has not finished (`running`: also a failed scan, which stopped
 * part way) it is how far it got, `310 of 762 checks`: the host and port split would claim more than was done.
 */
export function checksText(progress: ScanCounters, running: boolean): string {
  const pairs = progress.pairs ?? 0;
  const hosts = progress.hosts ?? 0;
  if (running) return pairs > 0 ? `${progress.checked ?? 0} of ${plural(pairs, "check")}` : "0 checks";
  const ports = hosts > 0 ? pairs / hosts : 0;
  if (hosts > 0 && Number.isInteger(ports) && ports > 0) return `${plural(pairs, "check")} (${plural(hosts, "host")} × ${plural(ports, "port")})`;
  return plural(pairs, "check");
}

/** The figures of the drawer's stats row after the checks, in words: `3 open`, `1 source recognised`, `60 points`, `2 need credentials`, `0 unidentified`. */
export function statWords(progress: ScanCounters): string[] {
  const locked = progress.needs_credentials ?? 0;
  return [
    `${progress.open ?? 0} open`,
    `${plural(claimedCount(progress), "source")} recognised`,
    plural(progress.points ?? 0, "point"),
    `${locked} ${locked === 1 ? "needs" : "need"} credentials`,
    `${progress.unidentified ?? 0} unidentified`,
  ];
}
