import type { PermissionId } from "../lib/permissions";

/**
 * What a page or a link needs: one permission; an array, which means ALL OF them; or `{ any: [...] }`, which means ANY ONE of them (the
 * Users & Roles page opens for `users.view` or for `roles.manage`).
 */
export type Need = PermissionId | readonly PermissionId[] | { readonly any: readonly PermissionId[] };

/** True when `can` holds what `need` asks for; nothing needed is always met, and an any-of list with nothing in it never is. */
export const meets = (need: Need | undefined, can: (id: PermissionId) => boolean): boolean => {
  if (need === undefined) return true;
  if (typeof need === "string") return can(need);
  return "any" in need ? need.any.some(can) : need.every(can);
};
