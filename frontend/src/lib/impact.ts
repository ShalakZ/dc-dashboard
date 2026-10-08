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

const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const HISTORY = "disappear from Billing and dashboards.";

export const assetLoss = (i: AssetImpact) =>
  `${counted(i.assets, "asset")}, ${counted(i.mappings, "mapping")} and ${counted(i.tariffs, "tariff")} will be deleted; their past energy and cost figures ${HISTORY}`;
export const sourceLoss = (i: SourceImpact) =>
  `${counted(i.points, "mapped point")} and ${counted(i.mappings, "mapping")} will be deleted; the past energy and cost figures that depend on them ${HISTORY}`;
