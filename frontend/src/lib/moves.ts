import { ApiError, api } from "../api/client";
import { keys } from "../api/queries";
import type { Source, SourceMoveCandidateForOld, SourceMoveDone, SourceMoveIn, SourceMovePreview } from "../api/types";

/**
 * Moving a source to the address where its device turned up (w33): the two calls, the query keys a move makes stale, and every sentence the move dialog, the
 * Sources banner and the toast say. Pure apart from the two calls; the dialog is components/MoveSourceDialog.tsx.
 */

/**
 * What a move makes stale: the sources (their rows, and so their points, which sit under the same `["sources", ...]` prefix: the old source answers again, the
 * duplicate is gone), the graph (Discovery's cards), the scans (the duplicate's findings now point at the old source), the audit log and the System events.
 * They are read again after a real run that worked AND after one that was refused: a refusal means the lists on screen are out of date too.
 */
export const MOVE_REFRESHED = [keys.sources, keys.graph, keys.scans, keys.auditAll, keys.eventsAll] as const;

/** Shown while a scan is queued or running: the dry run says so, and the real run would be refused. */
export const SCAN_RUNNING_TEXT = "A scan is running; you can move when it has finished";
/** On the row, the banner and the card of a source that two new servers look like: no move is offered. */
export const TWO_SERVERS_TEXT = "Two servers could be this one; edit the address by hand";

const num = (n: number) => n.toLocaleString("en-US");

/** The dry run: what moving source `oldId` to the source `body.to` would do. Changes nothing on the server. */
export const previewMove = (oldId: number, body: { to: number; address: "as_found" | "name" }) =>
  api.post<SourceMovePreview>(`/api/sources/${oldId}/move?dry_run=1`, body);

/** The real run. `dry_run=0` is sent on purpose rather than left out. The body is `moveRequest(preview)`. */
export const runMove = (oldId: number, body: SourceMoveIn) => api.post<SourceMoveDone>(`/api/sources/${oldId}/move?dry_run=0`, body);

/** The real request for the preview the person saw: the numbers and the texts it showed are sent back, and the server refuses if anything differs now. */
export function moveRequest(preview: SourceMovePreview): SourceMoveIn & { expect: NonNullable<SourceMoveIn["expect"]> } {
  return {
    to: preview.target.id,
    address: preview.address,
    expect: {
      mappings: preview.mappings,
      address_before: hostPort(preview.from),
      address_after: hostPort(preview.to),
      name_after: preview.rename?.to ?? null,
    },
  };
}

/** The server's 409 for a move whose preview is out of date (counts, addresses or the new name differ now): the dialog asks again and the person confirms the new numbers. */
export const isChangedSincePreview = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409 && /changed since the preview/i.test(error.message);

/** `172.20.0.5:4840`, as the preview shows an address and as `expect` sends it back. */
export const hostPort = (address: { host: string; port: number }) => `${address.host}:${address.port}`;

/**
 * `172.20.0.5:4840` out of a display endpoint (`opc.tcp://172.20.0.5:4840/dcdash/`), user info left out. A regular expression and not `new URL`: a URL parser
 * drops a default port and treats a scheme it does not know in its own way. A text that is not an endpoint is given back as it is.
 */
export function hostPortOfEndpoint(endpoint: string): string {
  const found = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/@?#]*@)?(\[[^\]]+\]|[^/:?#@]+)(?::(\d+))?/.exec(endpoint);
  return found ? `${found[1]}${found[2] ? `:${found[2]}` : ""}` : endpoint;
}

/** True for an IPv4 or IPv6 address (a bracketed one too), false for a host name. */
export function isIpAddress(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (v4) return v4.slice(1).every((part) => Number(part) <= 255);
  return bare.includes(":") && /^[0-9a-fA-F:.]+$/.test(bare);
}

/** The offer on a Sources row, or null (a source with no candidate, with `two`, or from an older API). */
export const offerOf = (source: Pick<Source, "move_candidate">): SourceMoveCandidateForOld | null =>
  source.move_candidate?.kind === "offer" ? source.move_candidate : null;

/** `From opc.tcp://172.20.0.3:4840/dcdash/ to opc.tcp://172.20.0.5:4840/dcdash/` (the endpoints carry no user name or password). */
export const fromToLine = (preview: SourceMovePreview) => `From ${preview.from.endpoint} to ${preview.to.endpoint}`;

/** Why the two are thought to be one server, in words; a server known by its URI (or instance id) alone says so. */
export function whyLines(preview: SourceMovePreview): string[] {
  const { match } = preview;
  if (match.kind === "possibly") {
    return [match.addresses === 1
      ? "The only mapped address and its name exist on the new server."
      : `All ${num(match.addresses)} mapped addresses and their names exist on the new server.`];
  }
  const lines = match.evidence === "instance"
    ? [`Both are DCDash simulator instance "${match.value ?? ""}".`]
    : [match.value ? `Both answer with the application URI ${match.value}.` : "Both answer with the same application URI."];
  if (preview.needs_tick) lines.push(match.evidence === "instance" ? "It is identified by its instance id only." : "It is identified by its application URI only.");
  return lines;
}

/** Addresses of the old source that the new server lacks (their values will read as bad), or that could not be checked at all (null). */
export function warningLines(preview: SourceMovePreview): string[] {
  const { match } = preview;
  if (match.missing_addresses === null) return ["The new address could not be browsed without credentials; this source's credentials will be used."];
  if (match.missing_addresses > 0) {
    const total = num(match.addresses + match.missing_addresses);
    return [match.missing_addresses === 1
      ? `1 of ${total} mapped addresses was not found on the new server; its value will read as bad until it exists.`
      : `${num(match.missing_addresses)} of ${total} mapped addresses were not found on the new server; their values will read as bad until they exist.`];
  }
  return [];
}

/** What else happens: the mappings stay where they are, the scan's duplicate goes, the name follows the address or stays, and what an Undo does not undo. */
export function effectLines(preview: SourceMovePreview): string[] {
  const { mappings, assets, target } = preview;
  const kept = `Its ${num(mappings)} ${mappings === 1 ? "mapping" : "mappings"}${assets > 0 ? ` on ${num(assets)} ${assets === 1 ? "asset" : "assets"}` : ""} ${mappings === 1 ? "keeps its point" : "keep their points"} and readings.`;
  const removed = target.points === 0
    ? "The new source found by the scan is removed; it has no points."
    : `The new source found by the scan (${num(target.points)} ${target.points === 1 ? "point" : "points"}) is removed; ${target.points === 1 ? "its point was" : "its points were"} never mapped.`;
  const name = preview.rename
    ? `The name changes from "${preview.rename.from}" to "${preview.rename.to}".`
    : `The name stays "${preview.source.name}".`;
  return [kept, removed, name, "Readings taken after the move stay after an Undo."];
}

/** When the old source is configured by a host NAME (not an address), the move replaces that name: say so. Null when the old host is an address. */
export function hostNameLine(preview: SourceMovePreview): string | null {
  if (isIpAddress(preview.from.host)) return null;
  return `This source uses the name ${preview.from.host}; the move replaces it with ${isIpAddress(preview.to.host) ? "the address" : "the name"} ${preview.to.host}.`;
}

/** The label of the box the person ticks before the move may go on, or null when the preview asks for none. */
export function tickLabel(preview: SourceMovePreview): string | null {
  if (!preview.needs_tick) return null;
  return preview.match.kind === "possibly" ? "I checked that this is the same device" : "I checked that this is the same server";
}

/** The Move button: `Move 12 mappings`, `Move 1 mapping`, and plain `Move` while no preview is there. */
export const moveButtonLabel = (mappings: number | null) => (mappings === null ? "Move" : `Move ${num(mappings)} ${mappings === 1 ? "mapping" : "mappings"}`);

/**
 * The choice of address when the new one has a Docker name: the name first (the default; it keeps working when Docker gives the container a new address) and
 * the address the scan found as the other way. `foundHost` is the address of the as-found preview. No choice at all without a name.
 */
export function addressOptions(preview: SourceMovePreview, foundHost: string | null): { value: "as_found" | "name"; label: string }[] {
  if (!preview.name_hint) return [];
  return [
    { value: "name", label: `Use the name ${preview.name_hint} (it keeps working when Docker gives the container a new address)` },
    { value: "as_found", label: foundHost ? `Use the address ${foundHost}` : "Use the address found by the scan" },
  ];
}

/** The toast after a finished move. */
export const movedSentence = (done: SourceMoveDone) => `Moved "${done.source.name}" to ${hostPort(done.to)}`;
