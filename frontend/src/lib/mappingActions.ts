import { api, ApiError, isUnreachable } from "../api/client";
import type { Mapping, Metric } from "../api/types";
import { iconIdFor } from "./assetIcons";
import { kindIconForName } from "./kinds";
import { upperFirst } from "./upperFirst";

/**
 * Taking a mapping off an asset, moving it to another asset, and putting either back (W12a). These requests change what billing figures are
 * made of, so every runner here works ONE request at a time, in the order given, reads a mapping before it writes it, and STOPS at the first
 * request that fails: what was done, what failed (with a sentence for a person) and how many were not tried are all in the result, and nothing is
 * ever half-moved. No React in this file: hooks/useMappingActions.tsx raises the dialogs and toasts and calls these.
 */

/** How long an Undo toast stays. */
export const UNDO_MS = 10_000;
export const BUSY_TEXT = "Still working on the last change.";
export const GONE_TEXT = "Those mappings were already gone.";

/** One mapping a person acted on. `name` is what a sentence calls it (a point's name, or a metric); `assetId` is where the page believes it is. */
export interface MappingRef { id: number; name: string; assetId: number }
/** `reason` is a full sentence ending in a full stop. */
export interface Failure { name: string; reason: string; status?: number }
interface Stop { failed: Failure | null; notTried: number }

export interface UnmapResult extends Stop { removed: Mapping[]; gone: number }
export interface MovedOne { id: number; name: string; from: number; to: number }
export interface MoveResult extends Stop { moved: MovedOne[]; unchanged: number; gone: number }
/** The result of an Undo. `skipped` are the names of mappings that were changed since, so nothing was undone for them. */
export interface PutBackResult extends Stop { done: number; skipped: string[]; gone: number }

// ---- one queue for everything -------------------------------------------------------------------------------------------------------

let tail: Promise<unknown> = Promise.resolve();
let waiting = 0;

/** True from the moment work is queued until it has finished (the pages refuse a NEW unmap or move meanwhile; an Undo is never refused, it waits its turn). */
export const isBusy = (): boolean => waiting > 0;

/**
 * The ONE chain every batch and every Undo goes through, so that two never write at the same time and an Undo raised on a page that is gone
 * still runs (it holds no component state). A rejection reaches the caller of that work and never breaks the chain.
 */
export function enqueue<T>(work: () => Promise<T>): Promise<T> {
  waiting += 1;
  const run = async () => {
    try {
      return await work();
    } finally {
      waiting -= 1;
    }
  };
  const result = tail.then(run);
  tail = result.then(() => undefined, () => undefined);
  return result;
}

// ---- the sentences for a failed request ---------------------------------------------------------------------------------------------

type Step = "create" | "move" | "other";

const withStop = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** The asset or point a 404 on a write names (the api's own words: "asset not found", "point not found"). */
function goneThing(detail: unknown): string {
  if (detail === "asset not found") return "The asset no longer exists.";
  if (detail === "point not found") return "The point no longer exists.";
  return "The point or the asset no longer exists.";
}

/** Why a request failed, as a full sentence for a person. `step` says which write it was: a clash (409) only means something on a create or a move. */
export function reasonOf(error: unknown, step: Step = "other"): string {
  if (!(error instanceof ApiError)) return withStop(upperFirst(error instanceof Error ? error.message : String(error)));
  // No answer, or a proxy's: the client's own wording (both are full sentences already).
  if (isUnreachable(error)) return withStop(error.message);
  if (error.status === 401) return "Your session has ended. Sign in again.";
  if (error.status === 403) return "Your role may not change mappings.";
  if (error.status === 409 && step !== "other") return "It is mapped again, or the asset already has that metric.";
  if (error.status === 404 && step !== "other") return goneThing(error.detail);
  return withStop(upperFirst(error.message));
}

const failure = (name: string, error: unknown, step: Step): Failure => ({
  name, reason: reasonOf(error, step), ...(error instanceof ApiError ? { status: error.status } : {}),
});

/** The reply, or null when the server says the thing is not there. `isGone` decides which 404 means that. */
async function attempt<T>(call: () => Promise<T>, isGone: (error: ApiError) => boolean = (error) => error.status === 404): Promise<{ value: T } | null> {
  try {
    return { value: await call() };
  } catch (error) {
    if (error instanceof ApiError && isGone(error)) return null;
    throw error;
  }
}
/** A PATCH answers 404 for the mapping AND for the asset it is moved to: only the first means "already gone". */
const mappingGone = (error: ApiError) => error.status === 404 && error.detail === "mapping not found";

/** Runs `work` for each item in order and stops at the first that throws: the failure is named and the rest counted. */
async function eachOne<T>(items: readonly T[], nameOf: (item: T) => string, step: Step, work: (item: T) => Promise<void>): Promise<Stop> {
  for (let at = 0; at < items.length; at += 1) {
    try {
      await work(items[at]);
    } catch (error) {
      return { failed: failure(nameOf(items[at]), error, step), notTried: items.length - at - 1 };
    }
  }
  return { failed: null, notTried: 0 };
}

const readOne = (id: number) => api.get<Mapping>(`/api/mappings/${id}`);

// ---- the runners --------------------------------------------------------------------------------------------------------------------

/** Takes each mapping off its asset: GET, then DELETE. `removed` holds the mappings AS READ, the values an Undo needs. */
export async function unmapMappings(refs: readonly MappingRef[]): Promise<UnmapResult> {
  const removed: Mapping[] = [];
  let gone = 0;
  const stop = await eachOne(refs, (r) => r.name, "other", async (item) => {
    const read = await attempt(() => readOne(item.id));
    if (read === null) { gone += 1; return; }
    const deleted = await attempt(() => api.del(`/api/mappings/${item.id}`));
    if (deleted === null) { gone += 1; return; }
    removed.push(read.value);
  });
  return { removed, gone, ...stop };
}

/** Undo of an unmap: creates each mapping again with exactly the values read before it was deleted (the id is a new one). */
export async function restoreMappings(removed: readonly Mapping[], nameOf: (m: Mapping) => string): Promise<PutBackResult> {
  let done = 0;
  const stop = await eachOne(removed, nameOf, "create", async (m) => {
    await api.post<Mapping>("/api/mappings", {
      point_id: m.point_id, asset_id: m.asset_id, metric: m.metric, scale: m.scale, interval_seconds: m.interval_seconds, custom_unit: m.custom_unit,
    });
    done += 1;
  });
  return { done, skipped: [], gone: 0, ...stop };
}

/** Moves each mapping to `toAssetId`: GET, then PATCH asset_id unless it is there already. A clash (409) changes nothing for that mapping and stops the batch. */
export async function moveMappings(refs: readonly MappingRef[], toAssetId: number): Promise<MoveResult> {
  const moved: MovedOne[] = [];
  let unchanged = 0;
  let gone = 0;
  const stop = await eachOne(refs, (r) => r.name, "move", async (item) => {
    const read = await attempt(() => readOne(item.id));
    if (read === null) { gone += 1; return; }
    if (read.value.asset_id === toAssetId) { unchanged += 1; return; }
    const patched = await attempt(() => api.patch<Mapping>(`/api/mappings/${item.id}`, { asset_id: toAssetId }), mappingGone);
    if (patched === null) { gone += 1; return; }
    moved.push({ id: item.id, name: item.name, from: read.value.asset_id, to: toAssetId });
  });
  return { moved, unchanged, gone, ...stop };
}

/** Undo of a move: a mapping goes back only if it is still on the asset the move put it on; one that has changed since is named and left alone. */
export async function moveBack(moved: readonly MovedOne[]): Promise<PutBackResult> {
  let done = 0;
  let gone = 0;
  const skipped: string[] = [];
  const stop = await eachOne(moved, (m) => m.name, "move", async (item) => {
    const read = await attempt(() => readOne(item.id));
    if (read === null) { gone += 1; return; }
    if (read.value.asset_id !== item.to) { skipped.push(item.name); return; }
    const patched = await attempt(() => api.patch<Mapping>(`/api/mappings/${item.id}`, { asset_id: item.from }), mappingGone);
    if (patched === null) { gone += 1; return; }
    done += 1;
  });
  return { done, skipped, gone, ...stop };
}

/**
 * Undo of mappings that Discovery made (the review or the bulk create): each is read first and deleted only if it is still on the asset it was
 * made on. `name` is how a sentence calls it when it was changed since (the point's name; made up from the id when not given).
 */
export async function deleteMappings(made: readonly { id: number; assetId: number; name?: string }[]): Promise<PutBackResult> {
  let done = 0;
  let gone = 0;
  const skipped: string[] = [];
  const nameOf = (m: { id: number; name?: string }) => m.name ?? `mapping ${m.id}`;
  const stop = await eachOne(made, nameOf, "other", async (item) => {
    const read = await attempt(() => readOne(item.id));
    if (read === null) { gone += 1; return; }
    if (read.value.asset_id !== item.assetId) { skipped.push(nameOf(item)); return; }
    const deleted = await attempt(() => api.del(`/api/mappings/${item.id}`));
    if (deleted === null) { gone += 1; return; }
    done += 1;
  });
  return { done, skipped, gone, ...stop };
}

// ---- clashes on the target ----------------------------------------------------------------------------------------------------------

interface ConflictRow { id: number; name: string; metric: Metric }

/** An asset has each metric once, `custom` any number of times. */
function conflictGroups(rows: readonly ConflictRow[], taken: ReadonlySet<Metric>): { onTarget: ConflictRow[]; shared: ConflictRow[] } {
  const counts = new Map<Metric, number>();
  for (const r of rows) if (r.metric !== "custom") counts.set(r.metric, (counts.get(r.metric) ?? 0) + 1);
  const plain = rows.filter((r) => r.metric !== "custom");
  return {
    onTarget: plain.filter((r) => taken.has(r.metric)),
    shared: plain.filter((r) => !taken.has(r.metric) && (counts.get(r.metric) ?? 0) > 1),
  };
}

/** Names of the rows that would put a non-custom metric on the target twice: the target has it already, or two of the rows share it. */
export function moveConflicts(rows: readonly ConflictRow[], taken: ReadonlySet<Metric>): string[] {
  const { onTarget, shared } = conflictGroups(rows, taken);
  const clash = new Set([...onTarget, ...shared]);
  return rows.filter((r) => clash.has(r)).map((r) => r.name);
}

const quoted = (names: readonly string[]) => {
  const shown = names.slice(0, 3).map((name) => `"${name}"`).join(", ");
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
};

/** The sentence that says why a move cannot go ahead (it keeps Move off), or null when nothing clashes. */
export function moveConflictText(rows: readonly ConflictRow[], taken: ReadonlySet<Metric>, assetName: string): string | null {
  const { onTarget, shared } = conflictGroups(rows, taken);
  const parts: string[] = [];
  if (onTarget.length > 0) parts.push(`${quoted(onTarget.map((r) => r.name))} would clash: ${assetName} already has ${onTarget.length === 1 ? "that metric" : "those metrics"}.`);
  if (shared.length > 0) parts.push(`${quoted(shared.map((r) => r.name))} would clash: they map the same metric, and an asset can have each metric once.`);
  return parts.length > 0 ? parts.join(" ") : null;
}

// ---- containers ---------------------------------------------------------------------------------------------------------------------

/** The catalogue icons of the places that hold equipment. A rack is also Structure but is where meters belong, so it is not one. */
const CONTAINER_ICONS: ReadonlySet<string> = new Set(["site", "building", "hall", "room", "row"]);

/**
 * Whether a kind is a place (a site, building, hall, room, row) rather than equipment: by the icon of its kind in the registry, else by the keyword
 * guess that draws the node. The same rule as an asset's icon, so the note appears for the assets that are drawn as places.
 */
export function isContainerKind(kind: string, kinds: ReadonlyArray<{ name: string; icon: string }> | undefined): boolean {
  return CONTAINER_ICONS.has(iconIdFor(kindIconForName(kind, kinds)));
}

/** "Room 1 is a room; meters usually belong to a Panel or Rack. Map here anyway?" for an asset that is a place; null for any other. Never blocks. */
export function containerNote(asset: { name: string; kind: string }, kinds: ReadonlyArray<{ name: string; icon: string }> | undefined, verb: "Map" | "Move"): string | null {
  if (!isContainerKind(asset.kind, kinds)) return null;
  const noun = asset.kind.trim().replace(/\s+/g, " ").toLowerCase();
  return `${asset.name} is ${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun}; meters usually belong to a Panel or Rack. ${verb} here anyway?`;
}

// ---- the words ----------------------------------------------------------------------------------------------------------------------

const points = (n: number) => `${n} point${n === 1 ? "" : "s"}`;
const wasWere = (n: number) => (n === 1 ? "was" : "were");
const notTriedText = (n: number) => (n > 0 ? ` ${n} ${wasWere(n)} not tried.` : "");
const goneText = (n: number) => (n > 0 ? ` ${n} ${wasWere(n)} already gone.` : "");

export interface Outcome { kind: "success" | "info" | "error"; text: string }

/** The confirmation before an unmap. It says what billing, charts and dashboards do, and that a closed month keeps what it billed. */
export function unmapPrompt({ count, name, asset, assetCount, what }: { count: number; name: string; asset: string | null; assetCount: number; what?: string }): { title: string; message: string } {
  const subject = what ?? (count === 1 ? `"${name}"` : points(count));
  const theAsset = asset ?? "their assets";
  const them = count === 1 ? "it" : "them";
  return {
    title: `Unmap ${subject} from ${asset ?? `${assetCount} assets`}?`,
    message:
      `${count === 1 ? "This point stops" : "These points stop"} counting toward ${theAsset}. ` +
      `Billing for months that are still open is recalculated without ${them}; closed months keep their billed figures. ` +
      `Charts and dashboards show ${asset === null ? "their assets" : "the asset"} without ${count === 1 ? "this point" : "these points"}.`,
  };
}

/** The title of the Move dialog. */
export function moveTitle(count: number, name: string, what?: string): string {
  return `Move ${what ?? (count === 1 ? `"${name}"` : points(count))} to another asset`;
}

/** The billing sentence of the Move dialog. Without an asset it says "the asset you choose" (the dialog's text does not change with the choice: that would be read out again with every arrow key). */
export function moveMessage(count: number, asset?: string): string {
  return `Billing for months that are still open is recalculated with ${count === 1 ? "it" : "them"} under ${asset ?? "the asset you choose"}; closed months keep their billed figures.`;
}

/** What an unmap toast says. `total` is how many mappings were asked for; `where` is "Room 1" or "2 assets". */
export function unmapOutcome(result: UnmapResult, where: string, total: number): Outcome {
  const done = result.removed.length;
  if (result.failed) {
    const head = done > 0 ? `Unmapped ${done} of ${total}. ` : "";
    return { kind: "error", text: `${head}"${result.failed.name}" could not be unmapped: ${result.failed.reason}${notTriedText(result.notTried)}` };
  }
  if (done === 0) return { kind: "info", text: GONE_TEXT };
  return { kind: "success", text: `Unmapped ${points(done)} from ${where}.${goneText(result.gone)}` };
}

/**
 * What a move toast says. A single move that the server refused with a 409 can name both sides (`metric`: the metric of the one mapping); a batch
 * says the module's own sentence, which does not know them.
 */
export function moveOutcome(result: MoveResult, total: number, target: string, metric?: Metric): Outcome {
  const done = result.moved.length;
  if (result.failed) {
    const clash = result.failed.status === 409 && metric !== undefined && metric !== "custom";
    const reason = clash ? `${target} already has ${metric}.` : result.failed.reason;
    const head = done > 0 ? `Moved ${done} of ${total}. ` : "";
    return { kind: "error", text: `${head}"${result.failed.name}" could not be moved: ${reason}${notTriedText(result.notTried)}` };
  }
  if (done > 0) {
    const there = result.unchanged > 0 ? ` ${result.unchanged} ${wasWere(result.unchanged)} already there.` : "";
    return { kind: "success", text: `Moved ${points(done)} to ${target}.${there}${goneText(result.gone)}` };
  }
  if (result.unchanged > 0 && result.gone === 0) return { kind: "info", text: `Already on ${target}. Nothing changed.` };
  if (result.unchanged > 0) return { kind: "info", text: `Nothing changed: ${result.unchanged} already on ${target}, ${result.gone} already gone.` };
  return { kind: "info", text: GONE_TEXT };
}

/** "Room 1 stays; delete it from Assets Tree if you do not need it." (a mapping to an asset made in the same step never deletes the asset). */
export function staysText(names: readonly string[]): string {
  if (names.length === 1) return `${names[0]} stays; delete it from Assets Tree if you do not need it.`;
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} stay; delete them from Assets Tree if you do not need them.`;
  return `${names.length} new assets stay; delete them from Assets Tree if you do not need them.`;
}

const changedSince = (names: readonly string[]) =>
  names.length === 0 ? "" : ` ${quoted(names)} ${wasWere(names.length)} changed since, so nothing was undone for ${names.length === 1 ? "it" : "them"}.`;

export type UndoKind = "restore" | "moveBack" | "deleteMade";

/** What an Undo's toast says: the honest count (`total` is how many it was asked to undo), the one that failed with its reason, the ones changed since. */
export function undoOutcome(kind: UndoKind, result: PutBackResult, total: number, newAssets: readonly string[] = []): Outcome {
  const unmapping = kind === "deleteMade";
  const head = (n: number) => (unmapping ? `Unmapped ${points(n)}` : `Put back ${n} mapping${n === 1 ? "" : "s"}`);
  const tail = `${changedSince(result.skipped)}${goneText(result.gone)}`;
  if (result.failed) {
    const verbed = kind === "restore" ? "restored" : unmapping ? "unmapped" : "moved back";
    const lead = result.done > 0 ? `${unmapping ? "Unmapped" : "Put back"} ${result.done} of ${total}. ` : "";
    return { kind: "error", text: `${lead}"${result.failed.name}" could not be ${verbed}: ${result.failed.reason}${notTriedText(result.notTried)}${tail}` };
  }
  if (result.done > 0) {
    const stays = unmapping && newAssets.length > 0 ? ` ${staysText(newAssets)}` : "";
    return { kind: result.skipped.length > 0 ? "info" : "success", text: `${head(result.done)}.${stays}${tail}` };
  }
  if (result.skipped.length > 0) return { kind: "info", text: tail.trim() };
  return { kind: "info", text: GONE_TEXT };
}
