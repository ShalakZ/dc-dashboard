import type { PermissionRow, RoleRow } from "../api/types";
import { PERMISSION_LABELS, PERMISSIONS, type PermissionId } from "../lib/permissions";
import { BUILTIN_PERMISSIONS } from "./users";

type Kind = PermissionRow["kind"];

/** The server's area and kind of every id, typed out here (the backend is not imported): the same table as backend/dcdash/core/permissions.py. */
export const AREA_AND_KIND: Record<PermissionId, [string, Kind]> = {
  "assets.view": ["Assets Tree", "see"],
  "assets.edit": ["Assets Tree", "change"],
  "assets.delete": ["Assets Tree", "risky"],
  "assets.kinds": ["Assets Tree", "risky"],
  "dashboards.view": ["Dashboards", "see"],
  "dashboards.edit": ["Dashboards", "change"],
  "dashboards.default": ["Dashboards", "risky"],
  "billing.view": ["Billing and tariffs", "see"],
  "billing.export": ["Billing and tariffs", "risky"],
  "billing.close": ["Billing and tariffs", "risky"],
  "tariffs.view": ["Billing and tariffs", "see"],
  "tariffs.edit": ["Billing and tariffs", "change"],
  "sources.view": ["Sources and discovery", "see"],
  "sources.edit": ["Sources and discovery", "change"],
  "sources.test": ["Sources and discovery", "change"],
  "discovery.view": ["Sources and discovery", "see"],
  "discovery.edit": ["Sources and discovery", "change"],
  "discovery.scan": ["Sources and discovery", "risky"],
  "discovery.accept": ["Sources and discovery", "risky"],
  "storage.view": ["Storage and settings", "see"],
  "storage.edit": ["Storage and settings", "change"],
  "settings.view": ["Storage and settings", "see"],
  "settings.edit": ["Storage and settings", "change"],
  "settings.security": ["Storage and settings", "risky"],
  "audit.view": ["Audit log", "see"],
  "audit.export": ["Audit log", "risky"],
  "users.view": ["Users", "see"],
  "users.edit": ["Users", "change"],
  "roles.manage": ["Roles", "risky"],
  "diagnostics.view": ["Diagnostics", "see"],
  "diagnostics.run": ["Diagnostics", "change"],
};

/** GET /api/permissions as the server answers it: all 31 ids in catalogue order. */
export const catalogue = (): PermissionRow[] =>
  PERMISSIONS.map((id) => ({ id, area: AREA_AND_KIND[id][0], kind: AREA_AND_KIND[id][1], label: PERMISSION_LABELS[id], description: `About ${id}.` }));

/** A role as GET /api/roles answers it for an administrator (permissions listed). */
export const roleRow = (over: Partial<RoleRow> = {}): RoleRow => ({
  id: 7, name: "Executive", description: "", builtin: false, user_count: 0, assignable: true, permissions: ["assets.view"], ...over,
});

/** The three built-in rows with the permissions the server gives them. */
export const builtinRoles = (): RoleRow[] => [
  roleRow({ id: 1, name: "viewer", description: "Reads the pages.", builtin: true, user_count: 2, permissions: [...BUILTIN_PERMISSIONS.viewer] }),
  roleRow({ id: 2, name: "operator", description: "Runs the plant.", builtin: true, user_count: 1, permissions: [...BUILTIN_PERMISSIONS.operator] }),
  roleRow({ id: 3, name: "admin", description: "Everything.", builtin: true, user_count: 1, permissions: [...BUILTIN_PERMISSIONS.admin] }),
];
