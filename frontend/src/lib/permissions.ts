/**
 * The permission ids and labels. The server owns the list (backend/dcdash/core/permissions.py); this file mirrors it, and
 * backend/tests/test_permissions_parity.py fails when the ids, their order or the labels drift apart.
 */
export const PERMISSIONS = [
  "assets.view",
  "assets.edit",
  "assets.delete",
  "dashboards.view",
  "dashboards.edit",
  "dashboards.default",
  "billing.view",
  "billing.export",
  "tariffs.view",
  "tariffs.edit",
  "sources.view",
  "sources.edit",
  "sources.test",
  "discovery.view",
  "discovery.edit",
  "discovery.scan",
  "discovery.accept",
  "storage.view",
  "storage.edit",
  "settings.view",
  "settings.edit",
  "audit.view",
  "audit.export",
  "users.view",
  "users.edit",
  "roles.manage",
  "diagnostics.view",
  "diagnostics.run",
] as const;

export type PermissionId = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<PermissionId, string> = {
  "assets.view": "See the Assets Tree",
  "assets.edit": "Change assets",
  "assets.delete": "Delete assets",
  "dashboards.view": "See dashboards",
  "dashboards.edit": "Change dashboards",
  "dashboards.default": "Choose the default dashboard",
  "billing.view": "See billing",
  "billing.export": "Export billing as CSV",
  "tariffs.view": "See tariffs",
  "tariffs.edit": "Change tariffs",
  "sources.view": "See sources",
  "sources.edit": "Change sources",
  "sources.test": "Test source connections",
  "discovery.view": "See scans and the graph",
  "discovery.edit": "Change scan scopes and the graph layout",
  "discovery.scan": "Run network scans",
  "discovery.accept": "Accept scan results",
  "storage.view": "See storage",
  "storage.edit": "Change storage settings",
  "settings.view": "See settings",
  "settings.edit": "Change settings",
  "audit.view": "See the audit log",
  "audit.export": "Export the audit log",
  "users.view": "See users",
  "users.edit": "Change users",
  "roles.manage": "Manage roles",
  "diagnostics.view": "See diagnostics",
  "diagnostics.run": "Run the connection check",
};

/** True for an id this build knows. A newer server may send ids an older page has never seen: they are kept and ignored. */
export const isPermissionId = (value: unknown): value is PermissionId =>
  typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
