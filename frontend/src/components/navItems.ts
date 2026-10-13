import { meets, type Need } from "../auth/need";
import type { PermissionId } from "../lib/permissions";
import type { IconName } from "./Icon";

/** The built-in roles written out next to the user's name. A role an administrator made shows its own name. */
export const BUILTIN_ROLE_LABELS: Record<string, string> = { admin: "Administrator", operator: "Operator", viewer: "Viewer" };
/** Lives here, not in Layout, so the profile menu can import it without a cycle. `hasOwn`: a role may be named "constructor". */
export const roleLabel = (name: string) => (Object.hasOwn(BUILTIN_ROLE_LABELS, name) ? BUILTIN_ROLE_LABELS[name] : name);

/**
 * What each page needs, in one place: the sidebar, the quick find, the landing page and the routes (App) all read it, so they cannot
 * disagree. An array means ALL OF. A page that reads from more than one area names every area it reads (Tariffs lists the assets its
 * rates belong to, Diagnostics the sources it checks); the built-in roles that pass today are the ones that hold them all.
 */
export const PAGE_NEED = {
  assets: "assets.view",
  dashboards: "dashboards.view",
  billing: "billing.view",
  sources: "sources.view",
  sourcePoints: "sources.edit",
  scans: "discovery.view",
  discovery: "discovery.view",
  users: "users.view",
  settings: "settings.view",
  tariffs: ["tariffs.view", "assets.view"], // read-only without tariffs.edit (W9b); the built-in Operator opens it
  storage: "storage.view",
  audit: "audit.view",
  diagnostics: ["diagnostics.view", "sources.view"],
} as const satisfies Record<string, Need>;

/** `match`: the item is the current page on this path and everything below it (whole segments), not only on `to`. `need`: the permissions to see the link. */
export interface NavItem { to: string; label: string; icon: IconName; need: Need; match?: string }
export interface NavGroup { id: string; title: string; items: NavItem[] }

/** The list of dashboards; the Dashboards item opens the default dashboard instead when one is set (Layout). */
export const DASHBOARDS_PATH = "/dashboards";

// A link is shown to whoever may open its page; a group whose links are all gated away is not rendered.
export const GROUPS: NavGroup[] = [
  {
    id: "nav-monitor", title: "Monitor",
    items: [
      { to: "/assets", label: "Assets Tree", icon: "assets", need: PAGE_NEED.assets },
      { to: DASHBOARDS_PATH, label: "Dashboards", icon: "dashboards", match: DASHBOARDS_PATH, need: PAGE_NEED.dashboards },
      { to: "/billing", label: "Billing", icon: "billing", need: PAGE_NEED.billing },
    ],
  },
  {
    id: "nav-operate", title: "Operate",
    items: [
      { to: "/sources", label: "Sources", icon: "sources", need: PAGE_NEED.sources },
      { to: "/scans", label: "Scans", icon: "scans", need: PAGE_NEED.scans },
      { to: "/discovery", label: "Discovery", icon: "discovery", need: PAGE_NEED.discovery },
    ],
  },
  {
    id: "nav-administer", title: "Administer",
    items: [
      { to: "/users", label: "Users", icon: "users", need: PAGE_NEED.users },
      { to: "/settings", label: "Settings", icon: "settings", need: PAGE_NEED.settings },
      { to: "/tariffs", label: "Tariffs", icon: "tariffs", need: PAGE_NEED.tariffs },
      { to: "/storage", label: "Storage", icon: "storage", need: PAGE_NEED.storage },
      { to: "/audit", label: "Audit", icon: "audit", need: PAGE_NEED.audit },
      { to: "/diagnostics", label: "Diagnostics", icon: "diagnostics", need: PAGE_NEED.diagnostics },
    ],
  },
];

/** The sidebar as one person sees it: the groups with only the links they may open, and no group left empty. */
export function visibleGroups(can: (id: PermissionId) => boolean): NavGroup[] {
  return GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => meets(item.need, can)) })).filter((group) => group.items.length > 0);
}
