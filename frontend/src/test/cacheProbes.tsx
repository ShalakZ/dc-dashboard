import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { keys } from "../api/queries";

/** The cache keys whose figures depend on assets and sources (billing, dashboards' widget data, the tariff list). */
const PROBED = { billing: keys.billing, widgetData: keys.widgetData, tariffs: keys.tariffs } as const;
type Name = keyof typeof PROBED;
const NAMES = Object.keys(PROBED) as Name[];

function Probe({ name }: { name: Name }) {
  // never stale by itself: it is fetched again only when something invalidates its key
  useQuery({ queryKey: PROBED[name], queryFn: () => api.get(`/api/probe/${name}`), staleTime: Infinity });
  return null;
}

/** Mount next to a page: one query per probed key, which counts as a fetch each time the page invalidates that key. */
export const CacheProbes = () => <>{NAMES.map((name) => <Probe key={name} name={name} />)}</>;

/** The fetch routes the probes need. */
export const probeRoutes = Object.fromEntries(NAMES.map((name) => [`GET /api/probe/${name}`, { body: {} }]));

/** How many times each probe has been fetched, from the calls `mockFetch` recorded. */
export const probeFetches = (calls: { path: string }[]) =>
  Object.fromEntries(NAMES.map((name) => [name, calls.filter((c) => c.path === `/api/probe/${name}`).length]));
