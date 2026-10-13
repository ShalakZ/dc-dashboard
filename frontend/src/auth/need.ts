import type { PermissionId } from "../lib/permissions";

/** What a page or a link needs: one permission, or an array that means ALL OF them. */
export type Need = PermissionId | readonly PermissionId[];

/** True when `can` holds every permission of `need`; nothing needed is always met. */
export const meets = (need: Need | undefined, can: (id: PermissionId) => boolean): boolean =>
  need === undefined || (typeof need === "string" ? can(need) : need.every(can));
