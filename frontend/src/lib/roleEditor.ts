import type { PermissionRow, RoleRow } from "../api/types";
import { roleLabel, visibleGroups } from "../components/navItems";
import { PERMISSIONS, type PermissionId } from "./permissions";

/** One row of the editor's grid: an area with its See and Change checkboxes (a cell may hold several). */
export interface AreaRow { area: string; see: PermissionRow[]; change: PermissionRow[] }

/** The only permission the editor never offers as a checkbox: a custom role cannot hold it (it has its own locked line). */
export const LOCKED_PERMISSION = "roles.manage";

/**
 * The editor's layout from the server's catalogue: one row per area in the order each first appears, the "risky" permissions apart as
 * the sensitive actions, and `roles.manage` nowhere. An area left with nothing to tick (Roles) is left out. An id this build does not
 * know is grouped like any other: the label and the description come from the API row.
 */
export function groupPermissions(list: readonly PermissionRow[]): { areas: AreaRow[]; sensitive: PermissionRow[] } {
  const areas: AreaRow[] = [];
  const sensitive: PermissionRow[] = [];
  for (const entry of list) {
    if (entry.id === LOCKED_PERMISSION) continue;
    let area = areas.find((candidate) => candidate.area === entry.area);
    if (!area) {
      area = { area: entry.area, see: [], change: [] };
      areas.push(area);
    }
    if (entry.kind === "risky") sensitive.push(entry);
    else (entry.kind === "see" ? area.see : area.change).push(entry); // a kind a newer server adds lands with the Change entries
  }
  return { areas: areas.filter((area) => area.see.length + area.change.length > 0), sensitive };
}

/**
 * What a person must hold IN ADDITION for a permission to show anything: the "Needs also" column of the permission audit in the W9b
 * plan. A hint for the administrator, never an automatic tick (the server accepts any combination, and a role may be deliberately odd).
 * The sidebar needs live in navItems.ts (PAGE_NEED); the row-level ones follow the screens (a rate table lists assets, a page lists sources).
 */
export const PERMISSION_NEEDS: Record<PermissionId, readonly PermissionId[]> = {
  "assets.view": [],
  "assets.edit": ["assets.view"],
  "assets.delete": ["assets.view"],
  "dashboards.view": [],
  // the widget editor loads the assets and the discovery graph: without them Add widget stays disabled
  "dashboards.edit": ["dashboards.view", "assets.view", "discovery.view"],
  "dashboards.default": ["dashboards.view"],
  "billing.view": [],
  "billing.export": ["billing.view"],
  "tariffs.view": ["assets.view"],
  "tariffs.edit": ["tariffs.view", "assets.view"],
  "sources.view": [],
  "sources.edit": ["sources.view"],
  "sources.test": ["sources.view"],
  "discovery.view": [],
  "discovery.edit": ["discovery.view"],
  "discovery.scan": ["discovery.view"],
  "discovery.accept": ["discovery.view"],
  "storage.view": [],
  "storage.edit": ["storage.view"],
  "settings.view": [],
  "settings.edit": ["settings.view"],
  "settings.security": ["settings.view"],
  "audit.view": [],
  "audit.export": ["audit.view"],
  "users.view": [],
  "users.edit": ["users.view"],
  "roles.manage": [],
  "diagnostics.view": ["sources.view"],
  "diagnostics.run": ["sources.view"],
};

/** The ticked permissions whose needs are not all ticked, in catalogue order, with what each lacks. Ids this build does not know are skipped. */
export function permissionGaps(ticked: ReadonlySet<string>): { id: PermissionId; missing: PermissionId[] }[] {
  return PERMISSIONS.filter((id) => ticked.has(id))
    .map((id) => ({ id, missing: PERMISSION_NEEDS[id].filter((needed) => !ticked.has(needed)) }))
    .filter((gap) => gap.missing.length > 0);
}

/**
 * A role in plain words: the pages the sidebar would show (the sidebar's own `visibleGroups`, so the two cannot disagree), the Change
 * permissions and the sensitive ones by their server labels. An id with no row in `list` has no label and is left out; an id this build
 * does not know opens no page (the sidebar does not know it either) but is listed by its server label.
 */
export function summarizeRole(list: readonly PermissionRow[], ticked: ReadonlySet<string>): { pages: string[]; changes: string[]; sensitive: string[] } {
  const labelsOf = (kind: PermissionRow["kind"]) => list.filter((entry) => entry.kind === kind && ticked.has(entry.id)).map((entry) => entry.label);
  return {
    pages: visibleGroups((id) => ticked.has(id)).flatMap((group) => group.items.map((item) => item.label)),
    changes: labelsOf("change"),
    sensitive: labelsOf("risky"),
  };
}

/** A built-in role by its written-out name (Administrator), any other role by its own. */
export const roleDisplayName = (role: Pick<RoleRow, "name" | "builtin">) => (role.builtin ? roleLabel(role.name) : role.name);

/** "A", "A and B", "A, B and C": for the hint under the summary. */
export function joinWords(words: readonly string[]): string {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
