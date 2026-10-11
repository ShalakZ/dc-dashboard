import { useSite } from "../api/queries";
import { useNow } from "../hooks/useNow";
import { formatSiteHourMinute } from "../lib/siteTime";

/** The time at the site (its zone, not the browser's), to the minute; checked every 10 s. Nothing until the zone is known. */
export function SiteClock() {
  const zone = useSite().data?.timezone;
  const now = useNow(10_000);
  const time = zone ? formatSiteHourMinute(new Date(now), zone) : null;
  if (!zone || time === null) return null;
  return (
    <span className="site-time">
      <span className="sr-only">Site time </span>
      <time dateTime={time}>{time}</time>
      <span className="zone">{zone}</span>
    </span>
  );
}
