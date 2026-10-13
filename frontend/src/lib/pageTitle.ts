export const APP_TITLE = "DC Dashboard";

/** What the browser tab calls each page, by the start of its path (whole segments, so `/audit/12` is the Audit log). */
const TITLES: [path: string, title: string][] = [
  ["/assets", "Assets Tree"],
  ["/dashboards", "Dashboards"],
  ["/billing", "Billing"],
  ["/sources", "Sources"],
  ["/scans", "Scans"],
  ["/discovery", "Discovery"],
  ["/users", "Users & Roles"],
  ["/settings", "Settings"],
  ["/tariffs", "Tariffs"],
  ["/storage", "Storage"],
  ["/audit", "Audit log"],
  ["/diagnostics", "Diagnostics"],
  ["/password", "Change password"],
];

/** The tab title for a route: "<Page> · DC Dashboard", or the application's name alone where the page is not known. */
export function pageTitle(pathname: string): string {
  const found = TITLES.find(([path]) => pathname === path || pathname.startsWith(`${path}/`));
  return found ? `${found[1]} · ${APP_TITLE}` : APP_TITLE;
}
