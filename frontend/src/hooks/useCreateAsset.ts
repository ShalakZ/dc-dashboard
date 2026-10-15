import { api } from "../api/client";
import { keys, useCreateAssetKind, useInvalidate } from "../api/queries";
import type { Asset, AssetIn } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useToast } from "../components/Toasts";
import { kindIconId } from "../lib/assetIcons";

/**
 * Saves a new asset the way the Assets page always has, for every place that opens the asset form (the Add dialog, Discovery's New asset):
 * the request, the one toast, then the lists. `registerKind` is the form's answer to "will this kind be added to the registry"; it is acted on
 * only for a person with assets.kinds (the form says false for everyone else, and the check is repeated so that no 403 is ever sent and swallowed).
 *
 * The toast comes right after the request, before any refresh: a failing refresh must not swallow the one confirmation the person gets.
 * Registering the kind is best effort and comes after the asset is saved (never a kind with no asset behind it): the asset is saved either way
 * and falls back to the keyword guess, so every failure (a 409 from a race included) is swallowed. That request refreshes the assets, the fleet
 * and the audit log itself, whether it worked or not, so the hook does not ask again; without a kind to register it refreshes them itself.
 * `also`: other lists the caller's page shows (Discovery's graph), refreshed after either of those.
 *
 * The answer is the created asset; a failed asset request rejects with the server's sentence (the form shows it) and changes nothing.
 */
export function useCreateAsset(options?: { also?: readonly (readonly unknown[])[] }): (body: AssetIn, registerKind: boolean) => Promise<Asset> {
  const { can } = useAuth();
  const createKind = useCreateAssetKind();
  const invalidate = useInvalidate();
  const toast = useToast();
  const also = options?.also ?? [];
  return async (body, registerKind) => {
    const asset = await api.post<Asset>("/api/assets", body);
    toast.success("Asset created");
    if (registerKind && can("assets.kinds")) {
      try { await createKind.mutateAsync({ name: body.kind, icon: kindIconId(body.kind) }); } catch { /* see above */ }
      if (also.length > 0) await invalidate(...also);
    } else {
      await invalidate(keys.assets, keys.fleet, ...also);
    }
    return asset;
  };
}
