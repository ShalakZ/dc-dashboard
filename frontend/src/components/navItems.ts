import type { Role } from "../api/types";
import type { IconName } from "./Icon";

/** The role written out next to the user's name. Lives here, not in Layout, so the profile menu can import it without a cycle. */
export const ROLE_LABEL: Record<Role, string> = { admin: "Administrator", operator: "Operator", viewer: "Viewer" };

/** `match`: the item is the current page on this path and everything below it (whole segments), not only on `to`. */
export interface NavItem { to: string; label: string; icon: IconName; match?: string }
export interface NavGroup { id: string; title: string; min?: Role; items: NavItem[] }

/** The list of dashboards; the Dashboards item opens the default dashboard instead when one is set (Layout). */
export const DASHBOARDS_PATH = "/dashboards";

// Role gating is the old bar's, link for link; a group whose links are all gated away is not rendered.
export const GROUPS: NavGroup[] = [
  {
    id: "nav-monitor", title: "Monitor",
    items: [
      { to: "/assets", label: "Assets", icon: "assets" },
      { to: DASHBOARDS_PATH, label: "Dashboards", icon: "dashboards", match: DASHBOARDS_PATH },
      { to: "/billing", label: "Billing", icon: "billing" },
    ],
  },
  {
    id: "nav-operate", title: "Operate", min: "operator",
    items: [
      { to: "/sources", label: "Sources", icon: "sources" },
      { to: "/scans", label: "Scans", icon: "scans" },
      { to: "/discovery", label: "Discovery", icon: "discovery" },
    ],
  },
  {
    id: "nav-administer", title: "Administer", min: "admin",
    items: [
      { to: "/users", label: "Users", icon: "users" },
      { to: "/settings", label: "Settings", icon: "settings" },
      { to: "/tariffs", label: "Tariffs", icon: "tariffs" },
      { to: "/storage", label: "Storage", icon: "storage" },
      { to: "/audit", label: "Audit", icon: "audit" },
      { to: "/diagnostics", label: "Diagnostics", icon: "diagnostics" },
    ],
  },
];
