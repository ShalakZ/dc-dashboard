import { ApiError } from "../api/client";
import type { AssetImpact, SourceImpact } from "../api/types";

/** The named counts of a 409 reply, or null if this is not that kind of 409 (any other error, or a count missing). */
function counts<K extends string>(error: unknown, names: readonly K[]): Record<K, number> | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body as Record<string, unknown> | null | undefined;
  const found = {} as Record<K, number>;
  for (const name of names) {
    const value = body?.[name];
    if (typeof value !== "number") return null;
    found[name] = value;
  }
  return found;
}

/** DELETE /api/assets/{id} wants confirmation: what it would delete, otherwise null. */
export const assetImpact = (error: unknown): AssetImpact | null => counts(error, ["assets", "mappings", "tariffs"]);
/** DELETE /api/sources/{id} wants confirmation: what it would delete, otherwise null. */
export const sourceImpact = (error: unknown): SourceImpact | null => counts(error, ["points", "mappings"]);

/**
 * The confirmed DELETE of an asset. `seen` is what the dialog showed: the server refuses (409 with the new counts) when more than that
 * would go now, so a child added while the dialog was open is never deleted unseen. Zeros are sent too; an absent count would be unchecked.
 */
export const assetDeletePath = (id: number, seen: AssetImpact) =>
  `/api/assets/${id}?confirm=true&expect_assets=${seen.assets}&expect_mappings=${seen.mappings}&expect_tariffs=${seen.tariffs}`;
/** The confirmed DELETE of a source, with the counts the dialog showed (see `assetDeletePath`). */
export const sourceDeletePath = (id: number, seen: SourceImpact) =>
  `/api/sources/${id}?confirm=true&expect_points=${seen.points}&expect_mappings=${seen.mappings}`;

const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const HISTORY = "disappear from Billing and dashboards, except in closed months, which keep their billed figures.";

export const assetLoss = (i: AssetImpact) =>
  `${counted(i.assets, "asset")}, ${counted(i.mappings, "mapping")} and ${counted(i.tariffs, "tariff")} will be deleted; their past energy and cost figures ${HISTORY}`;
export const sourceLoss = (i: SourceImpact) =>
  `${counted(i.points, "mapped point")} and ${counted(i.mappings, "mapping")} will be deleted; the past energy and cost figures that depend on them ${HISTORY}`;

/** PUT /api/settings/storage wants confirmation: the server's description of what saving would delete and whether anything is
 * deleted now (false = the limit is only shorter), otherwise null. */
export const storageLoss = (error: unknown): { detail: string; deletesNow: boolean } | null => {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body as { detail?: unknown; deletes_now?: unknown } | null | undefined;
  return typeof body?.detail === "string" && typeof body.deletes_now === "boolean"
    ? { detail: body.detail, deletesNow: body.deletes_now }
    : null;
};
