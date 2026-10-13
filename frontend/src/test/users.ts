import type { User } from "../api/types";
import { PERMISSIONS, type PermissionId } from "../lib/permissions";

/** The three built-in roles, for a test that signs one in. */
export type BuiltinRole = "viewer" | "operator" | "admin";

const VIEWER: PermissionId[] = ["assets.view", "dashboards.view", "billing.view", "billing.export"];
/**
 * What each built-in role holds, copied from Appendix A of the W9a plan (the server's list is backend/dcdash/core/permissions.py). Viewer
 * and Operator are typed out here and not imported from the app; Admin is the whole catalogue by definition, and the backend parity test
 * (test_permissions_parity.py) guards that list against drifting from the server's.
 */
export const BUILTIN_PERMISSIONS: Record<BuiltinRole, PermissionId[]> = {
  viewer: VIEWER,
  operator: [...VIEWER, "dashboards.edit", "tariffs.view", "sources.view", "sources.test", "diagnostics.run", "discovery.view"],
  admin: [...PERMISSIONS],
};

/**
 * The signed-in user the server would answer for `role` ("u" with id 1 unless `extra` says otherwise). A built-in role gets its
 * permissions; any other name gets none, unless `extra` gives them.
 */
export function userFor(role: string, extra: Partial<User> = {}): User {
  const permissions = Object.hasOwn(BUILTIN_PERMISSIONS, role) ? BUILTIN_PERMISSIONS[role as BuiltinRole] : [];
  return { id: 1, username: "u", role, permissions, preferences: { mode: "light", theme: "navy-gold" }, ...extra };
}
