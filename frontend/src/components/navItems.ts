import type { Role } from "../api/types";
import type { IconName } from "./Icon";

/** The role written out next to the user's name. Lives here, not in Layout, so the profile menu can import it without a cycle. */
export const ROLE_LABEL: Record<Role, string> = { admin: "Administrator", operator: "Operator", viewer: "Viewer" };

export interface NavItem { to: string; label: string; icon: IconName }
export interface NavGroup { id: string; title: string; min?: Role; items: NavItem[] }

// Role gating is the old bar's, link for link; a group whose links are all gated away is not rendered.
export const GROUPS: NavGroup[] = [
  {
    id: "nav-monitor", title: "Monitor",
    items: [
      { to: "/assets", label: "Assets", icon: "assets" },
      { to: "/dashboards", label: "Dashboards", icon: "dashboards" },
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
    ],
  },
];
