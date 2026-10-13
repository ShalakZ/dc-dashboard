import { useSite, useTlsStatus } from "../api/queries";
import { formatSiteDateTime } from "../lib/siteTime";

/** "29 days left", "1 day left" or "less than a day left" for the whole days the API counts. */
export function daysLeftText(days: number): string {
  if (days <= 0) return "less than a day left";
  return days === 1 ? "1 day left" : `${days} days left`;
}

// Inline SVG, 24-unit viewBox, decoration only (the sentence next to it says everything).
const WarnIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 10v4.5M12 17.5h.01" /></svg>
);

/**
 * The HTTPS certificate warning in the app shell. For whoever may see Settings (the status endpoint needs settings.view), and only for the states that need
 * action: expiring, expired and unreadable. Nothing for ok, for "not checked lately" (the collector may simply be down, and the
 * Sources page says so) or when HTTPS is not configured. A failed fetch shows nothing: the notice is an extra, not a gate.
 */
export function CertificateNotice() {
  const tls = useTlsStatus();
  const site = useSite();
  const status = tls.data;
  // Hold the notice until the site time zone is known (or has failed), so the date does not flip from UTC to the site clock.
  if (!status?.enabled || site.isPending) return null;
  const on = status.not_after ? ` on ${formatSiteDateTime(status.not_after, site.data?.timezone ?? "UTC")}` : "";
  const left = status.days_left === null ? "" : ` (${daysLeftText(status.days_left)})`;
  switch (status.state) {
    case "expiring":
      return (
        <div role="status" className="banner banner-warn warning">
          <WarnIcon />
          <span>{`The HTTPS certificate expires${on}${left}. Renew it before then: once it expires, browsers warn everyone who opens the dashboard.`}</span>
        </div>
      );
    case "expired":
      return (
        <div role="status" className="banner banner-bad error">
          <WarnIcon />
          <span>{`The HTTPS certificate expired${on}. Browsers already warn everyone who opens the dashboard. Replace the certificate and restart the web service.`}</span>
        </div>
      );
    case "unreadable":
      return (
        <div role="status" className="banner banner-warn warning">
          <WarnIcon />
          <span>{`The HTTPS certificate file cannot be read${status.error ? `: ${status.error}` : ""}. Its expiry is not being watched until that is fixed.`}</span>
        </div>
      );
    default:
      return null;
  }
}
